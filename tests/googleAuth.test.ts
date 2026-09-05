import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { db } from '../server/db/database';
import {
  getGoogleClientId,
  setGoogleClientId,
  verifyGoogleIdToken,
  findOrCreateGoogleUser,
  generateUserJwt,
} from '../server/services/googleAuthService';

const JWT_SECRET = process.env.JWT_SECRET || 'saaz-ledger-enterprise-secure-jwt-key-2026';

describe('Google Authentication Suite (OAuth 2.0 / GIS)', () => {
  it('saves and retrieves the Google OAuth Client ID in system settings', () => {
    const testClientId = '123456789-abc.apps.googleusercontent.com';
    setGoogleClientId(testClientId);
    expect(getGoogleClientId()).toBe(testClientId);
  });

  it('verifies a mock Google identity token and extracts user profile', async () => {
    const mockToken = 'mock-google-token:artisan.jaipur@saazaura.com|Jaipur Master Artisan|gid_jaipur_999';
    const profile = await verifyGoogleIdToken(mockToken);

    expect(profile.googleId).toBe('gid_jaipur_999');
    expect(profile.email).toBe('artisan.jaipur@saazaura.com');
    expect(profile.name).toBe('Jaipur Master Artisan');
    expect(profile.emailVerified).toBe(true);
  });

  it('provisions a new atelier user on first Google sign-in', () => {
    const uniqueGid = `gid_test_${Date.now()}`;
    const testProfile = {
      googleId: uniqueGid,
      email: `cataloger_${Date.now()}@saazaura.com`,
      name: 'Pooja Sharma',
      picture: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150',
      emailVerified: true,
    };

    const user = findOrCreateGoogleUser(testProfile, 'manager');

    expect(user.id).toBeDefined();
    expect(user.fullName).toBe('Pooja Sharma');
    expect(user.email).toBe(testProfile.email);
    expect(user.role).toBe('manager');
    expect(user.authProvider).toBe('google');
    expect(user.avatarUrl).toBe(testProfile.picture);

    // Verify record in database
    const dbUser = db.prepare('SELECT * FROM users WHERE google_id = ?').get(uniqueGid) as any;
    expect(dbUser).toBeDefined();
    expect(dbUser.full_name).toBe('Pooja Sharma');
    expect(dbUser.email).toBe(testProfile.email);
  });

  it('links an existing user account when signing in with a matching email', () => {
    const existingEmail = `artisan_link_${Date.now()}@saazaura.com`;
    const localUserId = `usr_local_${Date.now()}`;

    // Create existing local user
    db.prepare(`
      INSERT INTO users (id, username, password_hash, full_name, role, email, auth_provider)
      VALUES (?, ?, 'dummy_hash', 'Local Artisan', 'clerk', ?, 'local')
    `).run(localUserId, `artisan_${Date.now()}`, existingEmail);

    const googleGid = `gid_link_${Date.now()}`;
    const googleProfile = {
      googleId: googleGid,
      email: existingEmail,
      name: 'Local Artisan',
      picture: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
      emailVerified: true,
    };

    const authenticatedUser = findOrCreateGoogleUser(googleProfile);

    // Should return existing user ID with linked Google ID
    expect(authenticatedUser.id).toBe(localUserId);
    expect(authenticatedUser.email).toBe(existingEmail);
    expect(authenticatedUser.authProvider).toBe('google');

    // Verify database was updated
    const updatedDbUser = db.prepare('SELECT * FROM users WHERE id = ?').get(localUserId) as any;
    expect(updatedDbUser.google_id).toBe(googleGid);
    expect(updatedDbUser.avatar_url).toBe(googleProfile.picture);
  });

  it('generates a valid, cryptographically verifiable JWT session token', () => {
    const user = {
      id: 'usr_jwt_test',
      username: 'jwt_operator',
      fullName: 'JWT Operator',
      email: 'operator@saazaura.com',
      role: 'admin' as const,
      avatarUrl: 'https://example.com/avatar.jpg',
      authProvider: 'google',
    };

    const token = generateUserJwt(user);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    // Decode and verify
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.id).toBe(user.id);
    expect(decoded.username).toBe(user.username);
    expect(decoded.role).toBe(user.role);
    expect(decoded.email).toBe(user.email);
  });

  it('guarantees hasan.laiq@gmail.com is always assigned the admin role', () => {
    const adminProfile = {
      googleId: `gid_hasan_${Date.now()}`,
      email: 'hasan.laiq@gmail.com',
      name: 'Laiq Hasan',
      picture: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150',
      emailVerified: true,
    };

    // Even if clerk role is requested, it MUST force admin
    const user = findOrCreateGoogleUser(adminProfile, 'clerk');
    expect(user.email).toBe('hasan.laiq@gmail.com');
    expect(user.role).toBe('admin');

    const dbRecord = db.prepare("SELECT * FROM users WHERE email = 'hasan.laiq@gmail.com'").get() as any;
    expect(dbRecord).toBeDefined();
    expect(dbRecord.role).toBe('admin');
  });
});
