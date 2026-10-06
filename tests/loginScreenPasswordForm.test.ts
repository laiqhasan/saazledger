/**
 * Regression (found by the browser E2E): the unauthenticated screen (LoginScreen) had only Google + a
 * dev-only button, and the username/password form lived in AuthModal which only renders AFTER login, so
 * password login was unreachable. Also loginWithCredentials must not flip the global isLoading (App then
 * unmounts the login form and a wrong-password error is lost).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('password login reachable from the logged-out screen', () => {
  it('LoginScreen renders a password form wired to loginWithCredentials', () => {
    const s = read('src/components/LoginScreen.tsx');
    expect(s).toContain('loginWithCredentials(');
    expect(s).toContain('data-testid="login-username"');
    expect(s).toContain('type="password"');
  });
  it('loginWithCredentials does not toggle the global loading spinner (would unmount the form + lose the error)', () => {
    const s = read('src/context/AuthContext.tsx');
    const i = s.indexOf('const loginWithCredentials');
    const body = s.slice(i, s.indexOf('const logout', i));
    expect(body).not.toContain('setIsLoading');
  });
});

describe('server data load is gated on an authenticated session', () => {
  it('App initial-load effect does not run on mount before login and re-runs when the session appears', () => {
    const s = read('src/App.tsx');
    expect(s).toContain('const canLoadServerData = isAuthenticated');
    const i = s.indexOf('// Initial load');
    const eff = s.slice(i, s.indexOf('// Automated background polling for Shopify orders'));
    expect(eff).toContain('if (!canLoadServerData) return;');
    expect(eff).toContain('[canLoadServerData, token]');
    expect(eff).not.toMatch(/\}, \[\]\);/);
  });
});
