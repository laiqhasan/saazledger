/**
 * Regression: path-variant / case-sensitivity bypass of the route policy gate.
 *
 * Express matches routes case-insensitively by default, but the policy table matched with a
 * case-sensitive regex. `/api/Shopify/Config` therefore found NO policy, fell through to "login
 * required" with NO role check, and still reached the real handler (which has no role check of its own).
 *
 * Verified over real HTTP against the real express app, on an isolated temp DATA_DIR, with obviously
 * fake credentials only. Nothing here talks to the network, Shopify, Google or production.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import http from 'http';
import type { Server } from 'http';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-auth-variants-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.LEGACY_UPLOADS_DIR = path.join(tmpRoot, 'legacy-uploads');
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
delete process.env.JWT_SECRET;
delete process.env.ALLOW_ANONYMOUS_LOCAL_ADMIN;
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_')) delete process.env[k];
for (const k of ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_WEBHOOK_SECRET']) delete process.env[k];

const FAKE_GEMINI = 'FAKE-GEMINI-KEY-NOT-A-SECRET-0001';
const FAKE_OPENAI = 'FAKE-OPENAI-KEY-NOT-A-SECRET-0002';
const FAKE_SHOPIFY = 'FAKE-SHOPIFY-TOKEN-NOT-A-SECRET-0003';
const FAKE_MARKER = 'NOT-A-SECRET';

type Role = 'viewer' | 'staff' | 'clerk' | 'manager' | 'admin';
const ROLES: Role[] = ['viewer', 'staff', 'clerk', 'manager', 'admin'];
const RANK: Record<string, number> = { viewer: 0, staff: 1, clerk: 1, manager: 2, admin: 3 };

let server: Server;
let base = '';
let db: any;
let signSessionToken: (p: object, e?: any) => string;
let policyMod: typeof import('../server/auth/routePolicy');
const tokens: Record<string, string> = {};

beforeAll(async () => {
  vi.resetModules();
  const appMod = await import('../server/server');
  ({ db } = await import('../server/db/database'));
  ({ signSessionToken } = await import('../server/auth/jwtSecret'));
  policyMod = await import('../server/auth/routePolicy');
  await new Promise<void>((resolve) => {
    server = appMod.app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const role of ROLES) {
    const id = `usr_variant_${role}`;
    db.prepare(
      `INSERT OR REPLACE INTO users (id, username, password_hash, full_name, role, status, email, auth_provider)
       VALUES (?, ?, 'x', ?, ?, 'active', ?, 'google')`
    ).run(id, `${id}_n`, `User ${id}`, role, `${id}@example.test`);
    tokens[role] = signSessionToken({ id });
  }
  // fake credentials in the settings table so a leak is detectable without any real secret
  const set = db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)");
  set.run('gemini_api_key', FAKE_GEMINI);
  set.run('openai_api_key', FAKE_OPENAI);
  set.run('photoroom_api_key', 'FAKE-PHOTOROOM-KEY-NOT-A-SECRET-0004');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

async function call(method: string, url: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text };
}


/** Sends the path exactly as given (fetch/URL would normalise `/./`, `/../` and percent-encodings first). */
function rawCall(method: string, rawPath: string, token?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: u.hostname, port: u.port, method, path: rawPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Case / shape variants of a canonical lower-case path that Express may still route. */
function variants(p: string): string[] {
  const mixed = p.replace(/[a-z]+/g, (w, i) => (i % 2 === 0 ? w[0].toUpperCase() + w.slice(1) : w));
  return Array.from(new Set([
    p,
    p.toUpperCase(),
    mixed,
    p.replace('/api/', '/API/'),
    p + '/',
    mixed + '/',
    p.replace(/\/([a-z])/g, (_m, c) => '/' + c.toUpperCase()), // /Api/Shopify/Config
  ]));
}
const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, 'x1');
const isDenied = (s: number) => s === 401 || s === 403 || s === 404;

describe('policy gate vs Express routing: case and path variants (viewer repro + full role matrix)', () => {
  it('REPRO: a viewer cannot read AI provider keys via any case variant', async () => {
    for (const v of variants('/api/settings/ai-config')) {
      const r = await call('GET', v, tokens.viewer);
      expect(isDenied(r.status), `viewer GET ${v} -> ${r.status}`).toBe(true);
      expect(r.text.includes(FAKE_MARKER), `viewer GET ${v} leaked a (fake) key`).toBe(false);
    }
  });

  it('REPRO: a viewer cannot overwrite Shopify credentials via any case variant (and nothing is stored)', async () => {
    for (const v of variants('/api/shopify/config')) {
      const r = await call('POST', v, tokens.viewer, { shopDomain: 'attacker.myshopify.com', adminAccessToken: 'FAKE-ATTACKER-TOKEN' });
      expect(isDenied(r.status), `viewer POST ${v} -> ${r.status}`).toBe(true);
    }
    const stored = db.prepare("SELECT value FROM system_settings WHERE key LIKE 'shopify%'").all() as any[];
    expect(JSON.stringify(stored)).not.toContain('attacker');
    expect(JSON.stringify(stored)).not.toContain('FAKE-ATTACKER-TOKEN');
  });

  it('REPRO: a viewer cannot list users, change roles, or reach Shopify send-draft via case variants', async () => {
    for (const [m, p, b] of [
      ['GET', '/api/users', undefined],
      ['POST', '/api/users/usr_variant_viewer/role', { role: 'admin' }],
      ['POST', '/api/shopify/send-draft', { sku: 'X' }],
      ['POST', '/api/admin/clear-demo-data', {}],
    ] as const) {
      for (const v of variants(p)) {
        const r = await call(m, v, tokens.viewer, b);
        expect(isDenied(r.status), `viewer ${m} ${v} -> ${r.status}`).toBe(true);
      }
    }
    const row = db.prepare("SELECT role FROM users WHERE id = 'usr_variant_viewer'").get() as any;
    expect(row.role).toBe('viewer');
  });

  it('every policy row x every role x every path variant: insufficient role is NEVER served (matrix)', async () => {
    const rows = policyMod.ROUTE_POLICY.filter((p) => RANK[p.access] !== undefined);
    expect(rows.length).toBeGreaterThan(50);
    const failures: string[] = [];
    for (const row of rows) {
      const need = RANK[row.access];
      const methods = row.method === 'ALL' ? ['GET'] : [row.method];
      for (const method of methods) {
        for (const v of variants(concrete(row.path))) {
          // anonymous is always denied
          const anon = await call(method, v, undefined, method === 'GET' ? undefined : {});
          if (anon.status === 200 || anon.status === 201) failures.push(`anon ${method} ${v} -> ${anon.status}`);
          for (const role of ROLES) {
            if (RANK[role] >= need) continue; // sufficient roles may be served (or 404 for a non-canonical case)
            const r = await call(method, v, tokens[role], method === 'GET' ? undefined : {});
            if (!isDenied(r.status)) failures.push(`${role} ${method} ${v} (needs ${row.access}) -> ${r.status}`);
            if (r.text.includes(FAKE_MARKER)) failures.push(`${role} ${method} ${v} leaked a (fake) credential`);
          }
        }
      }
    }
    expect(failures.slice(0, 15), `${failures.length} violations`).toEqual([]);
  }, 300000);

  it('non-canonical paths are not served at all: case-sensitive routing returns 404 even for admin', async () => {
    for (const v of ['/api/Shopify/Config', '/API/shopify/config', '/api/SETTINGS/ai-config']) {
      const r = await call('GET', v, tokens.admin);
      expect(r.status, `admin GET ${v}`).toBe(404);
    }
  });

  it('encoded / odd shapes (sent raw) never reach a handler for an under-privileged caller', async () => {
    for (const v of ['/api/shopify/%63onfig', '/api//shopify/config', '/api/shopify/config%2F', '/api/shopify/./config', '/api/shopify/../shopify/config', '/api/shopify/config%00', '/api/shopify\\config', '/api/shopify/config;x=1', '/api/shopify/config?x=/../']) {
      for (const method of ['GET', 'POST']) {
        const r = await rawCall(method, v, tokens.viewer);
        // a viewer may read the (masked) canonical GET; everything else must be denied or unrouted
        const allowedCanonical = method === 'GET' && /^\/api\/shopify\/config(\?.*)?$/.test(v);
        if (!allowedCanonical) expect(isDenied(r.status), `viewer ${method} ${v} -> ${r.status}`).toBe(true);
        expect(r.text.includes(FAKE_MARKER), `viewer ${method} ${v} leaked a (fake) credential`).toBe(false);
      }
    }
  });

  it('DEFAULT DENY: a registered route with no policy entry is denied for EVERY role, including admin', async () => {
    const { app } = await import('../server/server');
    // add a brand new protected-looking route at runtime; no policy row exists for it
    (app as any).get('/api/zz-new-unlisted-route', (_req: any, res: any) => res.json({ served: true }));
    for (const role of ROLES) {
      const r = await call('GET', '/api/zz-new-unlisted-route', tokens[role]);
      expect(r.status, `${role} on an unlisted route`).toBe(403);
      expect(r.text.includes('served')).toBe(false);
    }
    const anon = await call('GET', '/api/zz-new-unlisted-route');
    expect(anon.status).toBe(401);
  });

  it('HEAD and trailing-slash forms obey the same policy as GET', async () => {
    for (const v of ['/api/settings/ai-config', '/api/settings/ai-config/', '/api/users', '/api/users/']) {
      const need = v.includes('users') ? 'admin' : 'staff';
      const r = await call('HEAD', v, tokens.viewer);
      expect(isDenied(r.status), `viewer HEAD ${v} (needs ${need}) -> ${r.status}`).toBe(true);
    }
  });

  it('percent-encoded traversal cannot turn a protected file into a public media path', async () => {
    for (const v of ['/api/photos/%2e%2e/%2e%2e/package.json.jpg', '/api/photos/..%2fsecret.jpg', '/api/photos/%2E%2E%2F%2E%2E%2Fx.png']) {
      const anon = await call('GET', v);
      expect(anon.status === 401 || anon.status === 403 || anon.status === 404 || anon.status === 400, `anon GET ${v} -> ${anon.status}`).toBe(true);
    }
  });

});
