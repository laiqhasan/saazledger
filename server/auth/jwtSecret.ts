/**
 * Single JWT secret resolver shared by server.ts and googleAuthService.ts.
 *
 * Resolution order:
 *   1. process.env.JWT_SECRET (if set and at least 16 chars)
 *   2. a random 48-byte secret generated ONCE and persisted at DATA_DIR/.jwt_secret (mode 0600),
 *      so deployments without the env var neither crash nor fall back to a public default.
 *
 * Rotating (changing JWT_SECRET, or deleting DATA_DIR/.jwt_secret) invalidates every session:
 * all users simply sign in again once. There is NO hard-coded default secret anywhere.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { DATA_DIR } from '../db/database';

export const JWT_SECRET_FILENAME = '.jwt_secret';
const MIN_ENV_SECRET_LENGTH = 16;

let cached: { key: string; secret: string } | null = null;

export function jwtSecretFilePath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, JWT_SECRET_FILENAME);
}

export function resolveJwtSecret(): string {
  const fromEnv = (process.env.JWT_SECRET || '').trim();
  const key = `${fromEnv}|${DATA_DIR}`;
  if (cached && cached.key === key) return cached.secret;

  let secret: string;
  if (fromEnv.length >= MIN_ENV_SECRET_LENGTH) {
    secret = fromEnv;
  } else {
    if (fromEnv.length > 0) {
      console.warn('[auth] JWT_SECRET is shorter than 16 characters; ignoring it and using the persisted secret.');
    }
    secret = loadOrCreatePersistedSecret();
  }
  cached = { key, secret };
  return secret;
}

function loadOrCreatePersistedSecret(): string {
  const file = jwtSecretFilePath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // not present yet
  }
  const fresh = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // 'wx' = fail if another process created it in the meantime; then reuse theirs.
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`[auth] Generated a new JWT signing secret at ${file} (set JWT_SECRET to manage it explicitly).`);
    return fresh;
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      const again = fs.readFileSync(file, 'utf8').trim();
      if (again.length >= 32) return again;
      // Corrupt/short file: overwrite it.
    }
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600 });
    return fresh;
  }
}

export function signSessionToken(payload: object, expiresIn: jwt.SignOptions['expiresIn'] = '7d'): string {
  return jwt.sign(payload, resolveJwtSecret(), { algorithm: 'HS256', expiresIn });
}

/** Verifies signature (HS256 only) and expiry. Throws on any failure. Never decodes unverified. */
export function verifySessionToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, resolveJwtSecret(), { algorithms: ['HS256'] });
  if (typeof decoded === 'string') throw new Error('Unexpected token payload');
  return decoded;
}

/** Test hook: forget the in-process cache (simulates a process restart). */
export function __resetJwtSecretCacheForTests(): void {
  cached = null;
}
