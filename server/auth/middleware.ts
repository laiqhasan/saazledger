import type { Request, Response, NextFunction } from 'express';
import { db } from '../db/database';
import { verifySessionToken } from './jwtSecret';
import { anonymousLocalAdminEnabled, devHelpersEnabled } from './environment';
import { roleRank, roleSatisfies, type Role } from './roles';
import { findPolicy, isPublicMediaPath } from './routePolicy';

export interface SessionUser {
  id: string;
  username: string;
  fullName?: string;
  email?: string;
  role: string;
  status: string;
}

const AUTH_DONE = Symbol('saaz.auth.done');

function bearer(req: Request): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

type Outcome = { ok: true; user: SessionUser } | { ok: false; status: number; error: string; code: string };

/** Verified JWT -> DB user. Role and status always come from the database, never from the token. */
function resolveUser(req: Request, requireActive: boolean): Outcome {
  const token = bearer(req);
  if (!token) {
    if (anonymousLocalAdminEnabled()) {
      return { ok: true, user: { id: 'usr_local', username: 'local_admin', role: 'admin', status: 'active' } };
    }
    return { ok: false, status: 401, error: 'Authentication required.', code: 'AUTH_REQUIRED' };
  }
  let payload: any;
  try {
    payload = verifySessionToken(token);
  } catch {
    return { ok: false, status: 401, error: 'Invalid or expired authentication token.', code: 'AUTH_INVALID' };
  }
  if (typeof payload.id !== 'string' || !payload.id) {
    return { ok: false, status: 401, error: 'Invalid authentication token.', code: 'AUTH_INVALID' };
  }
  const row = db
    .prepare('SELECT id, username, full_name, email, role, status FROM users WHERE id = ?')
    .get(payload.id) as any;
  if (!row) {
    return { ok: false, status: 401, error: 'Account no longer exists.', code: 'AUTH_INVALID' };
  }
  const status = row.status || 'active';
  const user: SessionUser = {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email || undefined,
    role: row.role,
    status,
  };
  if (requireActive && status !== 'active') {
    return { ok: false, status: 403, error: `Account is ${status}.`, code: `ACCOUNT_${String(status).toUpperCase()}` };
  }
  return { ok: true, user };
}

function make(requireActive: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if ((req as any)[AUTH_DONE] && (req as any).user && (!requireActive || (req as any).user.status === 'active')) {
      return next();
    }
    const out = resolveUser(req, requireActive);
    if (!out.ok) {
      res.status(out.status).json({ error: out.error, code: out.code });
      return;
    }
    (req as any).user = out.user;
    (req as any)[AUTH_DONE] = true;
    next();
  };
}

/** Verified JWT + active DB user. Used per-route (and by the global gate). */
export const authenticateToken = make(true);
/** Verified JWT + existing DB user in ANY status (only for /api/auth/me and sync-pending). */
export const authenticateIdentity = make(false);

export function requireRole(minimum: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user as SessionUser | undefined;
    if (!user) {
      res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      return;
    }
    if (!roleSatisfies(user.role, minimum)) {
      res.status(403).json({ error: `Requires ${minimum} role or higher.`, code: 'FORBIDDEN_ROLE' });
      return;
    }
    next();
  };
}

export function userHasRole(req: Request, minimum: Role): boolean {
  return roleSatisfies(((req as any).user as SessionUser | undefined)?.role, minimum);
}
export { roleRank };

/**
 * Global gate mounted on /api BEFORE any route and before body parsing: looks the request up in
 * ROUTE_POLICY and enforces it. Unknown /api paths require a session too (anonymous => 401, never a
 * route-existence oracle).
 */
export function policyGate(req: Request, res: Response, next: NextFunction): void {
  const urlPath = req.path.startsWith('/api') ? req.path : `/api${req.path}`;
  const policy = findPolicy(req.method, urlPath);

  if (isPublicMediaPath(req.method, urlPath)) return next();

  if (!policy) {
    return authenticateToken(req, res, next);
  }
  switch (policy.access) {
    case 'public':
    case 'webhook':
    case 'oauth':
      return next();
    case 'dev':
      if (!devHelpersEnabled()) {
        res.status(404).json({ success: false, error: `API endpoint not found: ${req.method} ${req.originalUrl}` });
        return;
      }
      return next();
    case 'identity':
      return authenticateIdentity(req, res, next);
    default: {
      const minimum = policy.access as Role;
      return authenticateToken(req, res, (err?: any) => {
        if (err) return next(err);
        return requireRole(minimum)(req, res, next);
      });
    }
  }
}
