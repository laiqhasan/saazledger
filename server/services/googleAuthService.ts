import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import db from '../db/database.js';
import { logAudit } from './auditService.js';

const JWT_SECRET = process.env.JWT_SECRET || 'saaz-ledger-enterprise-secure-jwt-key-2026';

/**
 * Get configured Google Client ID from environment or database system settings.
 */
export function getGoogleClientId(): string {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID.trim().length > 0) {
    return process.env.GOOGLE_CLIENT_ID.trim();
  }
  try {
    const setting = db.prepare("SELECT value FROM system_settings WHERE key = 'google_oauth_client_id'").get() as any;
    if (setting && setting.value && setting.value.trim().length > 0) {
      return setting.value.trim();
    }
  } catch {}
  return '';
}

/**
 * Set Google Client ID in database system settings.
 */
export function setGoogleClientId(clientId: string): void {
  const cleanId = clientId.trim();
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('google_oauth_client_id', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(cleanId);
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified?: boolean;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  fullName: string;
  email?: string;
  role: 'admin' | 'manager' | 'clerk';
  avatarUrl?: string;
  authProvider: string;
}

/**
 * Verifies a Google ID token from Google Identity Services.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  const clientId = getGoogleClientId();

  // Test / Development Mock Token support
  if (idToken.startsWith('mock-google-token:')) {
    const parts = idToken.replace('mock-google-token:', '').split('|');
    const email = parts[0] || 'atelier.demo@saazaura.com';
    const name = parts[1] || 'Atelier Master Artisan';
    const googleId = parts[2] || `gid_mock_${Date.now()}`;
    return {
      googleId,
      email,
      name,
      picture: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
      emailVerified: true,
    };
  }

  if (!clientId) {
    throw new Error('Google OAuth Client ID is not configured. Please set GOOGLE_CLIENT_ID in .env or via system settings.');
  }

  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: clientId,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error('Invalid Google ID token payload received.');
  }

  return {
    googleId: payload.sub,
    email: payload.email || '',
    name: payload.name || payload.email?.split('@')[0] || 'Google User',
    picture: payload.picture,
    emailVerified: payload.email_verified,
  };
}

// Designated super administrators
export const SUPER_ADMIN_EMAILS: string[] = [
  'hasan.laiq@gmail.com',
  ...(process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()) : []),
];

export function isSuperAdminEmail(email?: string): boolean {
  if (!email) return false;
  return SUPER_ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * Finds existing user by Google ID or Email, or provisions a new user record.
 */
export function findOrCreateGoogleUser(profile: GoogleProfile, customRole?: 'admin' | 'manager' | 'clerk'): AuthenticatedUser {
  const isSuperAdmin = isSuperAdminEmail(profile.email);

  // 1. Try finding by google_id
  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.googleId) as any;

  // 2. If not found by google_id, try matching by email
  if (!user && profile.email) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email) as any;
    if (user) {
      // Link Google ID and update avatar
      const effectiveRole = isSuperAdmin ? 'admin' : user.role;
      db.prepare(`
        UPDATE users 
        SET google_id = ?, avatar_url = COALESCE(?, avatar_url), auth_provider = 'google', role = ?
        WHERE id = ?
      `).run(profile.googleId, profile.picture || null, effectiveRole, user.id);

      user.google_id = profile.googleId;
      if (profile.picture) user.avatar_url = profile.picture;
      user.auth_provider = 'google';
      user.role = effectiveRole;

      logAudit({
        userId: user.id,
        action: 'link_google_account',
        entityType: 'user',
        entityId: user.id,
        newState: { email: profile.email, googleId: profile.googleId, role: effectiveRole },
      });
    }
  } else if (user && isSuperAdmin && user.role !== 'admin') {
    // If existing google_id user is super admin, enforce admin role
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    user.role = 'admin';
  }

  // 3. If still not found, provision a new user
  if (!user) {
    const totalUsers = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
    // Super admin or first user in the system is automatically granted admin role
    const assignedRole = isSuperAdmin ? 'admin' : (customRole || (totalUsers === 0 ? 'admin' : 'manager'));

    const newUserId = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    
    // Generate base username from email or name
    let baseUsername = (profile.email ? profile.email.split('@')[0] : profile.name)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .substring(0, 30);
    
    // Ensure username uniqueness
    let username = baseUsername;
    let counter = 1;
    while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      username = `${baseUsername}_${counter++}`;
    }

    db.prepare(`
      INSERT INTO users (id, username, password_hash, full_name, role, google_id, email, avatar_url, auth_provider)
      VALUES (?, ?, 'GOOGLE_OAUTH', ?, ?, ?, ?, ?, 'google')
    `).run(
      newUserId,
      username,
      profile.name,
      assignedRole,
      profile.googleId,
      profile.email || null,
      profile.picture || null
    );

    user = {
      id: newUserId,
      username,
      full_name: profile.name,
      role: assignedRole,
      google_id: profile.googleId,
      email: profile.email,
      avatar_url: profile.picture,
      auth_provider: 'google',
    };

    logAudit({
      userId: newUserId,
      action: 'register_google_user',
      entityType: 'user',
      entityId: newUserId,
      newState: user,
    });
  } else if (profile.picture && profile.picture !== user.avatar_url) {
    // Update avatar if changed
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(profile.picture, user.id);
    user.avatar_url = profile.picture;
  }

  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    email: user.email,
    role: user.role,
    avatarUrl: user.avatar_url,
    authProvider: user.auth_provider || 'google',
  };
}

/**
 * Generate standard Saaz Ledger JWT session token.
 */
export function generateUserJwt(user: AuthenticatedUser): string {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      avatarUrl: user.avatarUrl,
      authProvider: user.authProvider,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}
