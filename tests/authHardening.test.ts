/**
 * Authentication / authorization hardening, verified over real HTTP against the real express app on an
 * isolated temp DATA_DIR. No network, no Shopify, no production access.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-auth-hardening-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.LEGACY_UPLOADS_DIR = path.join(tmpRoot, 'legacy-uploads');
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
delete process.env.JWT_SECRET; // exercise the persisted-secret path for the main suite
delete process.env.ALLOW_ANONYMOUS_LOCAL_ADMIN;
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_')) delete process.env[k];

const WEBHOOK_SECRET = 'whsec_test_secret_for_authHardening';
process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
for (const k of ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_CLIENT_ID']) delete process.env[k];

const MASTER = 'hasan.laiq@gmail.com';
const OLD_DEFAULT_SECRETS = ['saaz_atelier_jwt_secret_dev_key_2026', 'saaz-ledger-enterprise-secure-jwt-key-2026'];

let server: Server;
let base = '';
let db: any;
let appMod: any;
let signSessionToken: (p: object, e?: any) => string;
let policyMod: typeof import('../server/auth/routePolicy');

async function boot() {
  vi.resetModules();
  appMod = await import('../server/server');
  ({ db } = await import('../server/db/database'));
  ({ signSessionToken } = await import('../server/auth/jwtSecret'));
  policyMod = await import('../server/auth/routePolicy');
  await new Promise<void>((resolve) => {
    server = appMod.app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function shutdown() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch {}
}

function addUser(id: string, role: string, status = 'active', email?: string) {
  db.prepare(
    `INSERT OR REPLACE INTO users (id, username, password_hash, full_name, role, status, email, auth_provider)
     VALUES (?, ?, 'x', ?, ?, ?, ?, 'google')`
  ).run(id, `${id}_n`, `User ${id}`, role, status, email ?? `${id}@example.test`);
}
const tokenFor = (id: string, extra: object = {}) => signSessionToken({ id, ...extra });

async function call(method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string; redirect?: RequestRedirect } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(base + url, {
    method,
    headers,
    body: opts.raw !== undefined ? opts.raw : opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: opts.redirect,
  });
  let json: any = null;
  try { json = await res.clone().json(); } catch {}
  return { status: res.status, json, res };
}

const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, 'x');
const GATE_DENIED = [401, 403];
const DO_NOT_EXECUTE = [
  /clear-demo-data/, /empty-trash/, /bulk-/, /media-settings/, /\/api\/media\/migrate/, /shopify-proxy/, /migration\/execute/,
  /\/api\/users\//, /\/purge/, /backup\/migrate-browser/, /api\/auth\/google\/config/, /pack\/generate/, /rebuild-isolation/,
  /publish-shopify/, /send-draft/, /shopify\/config/,
];

beforeAll(async () => {
  await boot();
  addUser('u_admin', 'admin');
  addUser('u_manager', 'manager');
  addUser('u_staff', 'staff');
  addUser('u_clerk', 'clerk');
  addUser('u_viewer', 'viewer');
  addUser('u_suspended', 'admin', 'suspended');
  addUser('u_pending', 'staff', 'pending');
  addUser('u_rejected', 'staff', 'rejected');
});
afterAll(async () => {
  await shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('route policy table', () => {
  it('has an entry for EVERY registered route (a new route without a policy fails here)', () => {
    const stack: any[] = (appMod.app as any).router.stack;
    const registered: string[] = [];
    for (const layer of stack) {
      if (!layer.route) continue;
      const rp = layer.route.path as string;
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      // app.all() expands to every HTTP verb in express 5
      if (methods.length > 10) registered.push(`ALL ${rp}`);
      else for (const m of methods) registered.push(`${m === '_all' ? 'ALL' : m.toUpperCase()} ${rp}`);
    }
    expect(registered.length).toBeGreaterThan(90);
    const policyKeys = new Set(policyMod.ROUTE_POLICY.map((p) => `${p.method} ${p.path}`));
    const missing = registered.filter((r) => !policyKeys.has(r));
    expect(missing, `routes without an access policy: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale entries (every policy row is a registered route) and no duplicates', () => {
    const stack: any[] = (appMod.app as any).router.stack;
    const registered = new Set<string>();
    for (const layer of stack) {
      if (!layer.route) continue;
      const ms = Object.keys(layer.route.methods);
      if (ms.length > 10) registered.add(`ALL ${layer.route.path}`);
      else for (const m of ms) registered.add(`${m === '_all' ? 'ALL' : m.toUpperCase()} ${layer.route.path}`);
    }
    const keys = policyMod.ROUTE_POLICY.map((p) => `${p.method} ${p.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => !registered.has(k))).toEqual([]);
  });

  it('every state-changing route requires at least staff; public/webhook/oauth/dev/identity are an explicit short list', () => {
    const open = policyMod.ROUTE_POLICY.filter((p) => ['public', 'dev', 'webhook', 'oauth', 'identity'].includes(p.access)).map((p) => `${p.method} ${p.path} ${p.access}`);
    expect(open.sort()).toEqual([
      'GET /api/auth/google/config public',
      'GET /api/auth/me identity',
      'GET /api/auth/shopify/callback oauth',
      'GET /api/health public',
      'POST /api/auth/google public',
      'POST /api/auth/google/dev-login dev',
      'POST /api/auth/google/sync-pending identity',
      'POST /api/auth/login public',
      'POST /api/webhooks/shopify webhook',
    ]);
    const writesBelowStaff = policyMod.ROUTE_POLICY.filter((p) => p.method !== 'GET' && p.access === 'viewer');
    expect(writesBelowStaff).toEqual([]);
  });
});

describe('anonymous access is gone', () => {
  it('every protected route answers 401 with no credentials (iterating the whole table)', async () => {
    const protectedRoutes = policyMod.ROUTE_POLICY.filter((p) => !['public', 'dev', 'webhook', 'oauth'].includes(p.access));
    expect(protectedRoutes.length).toBeGreaterThan(80);
    for (const p of protectedRoutes) {
      const method = p.method === 'ALL' ? 'GET' : p.method;
      // /api/photos/<x> without a media extension is protected; with an extension it is the public media class.
      const url = concrete(p.path);
      const r = await call(method, url, { body: method === 'GET' ? undefined : {} });
      expect(r.status, `${method} ${url}`).toBe(401);
    }
  });

  it('unknown /api paths do not leak existence to anonymous callers', async () => {
    expect((await call('GET', '/api/does-not-exist')).status).toBe(401);
    expect((await call('GET', '/api/does-not-exist', { token: tokenFor('u_viewer') })).status).toBe(404);
  });

  it('the named bypass classes from the review are all 401 anonymously', async () => {
    for (const [m, u] of [
      ['GET', '/api/inventory'], ['POST', '/api/inventory/next-sku'], ['POST', '/api/photos/upload'], ['POST', '/api/photos/restore'],
      ['POST', '/api/media/crop'], ['POST', '/api/media/pack/generate'], ['POST', '/api/media/pack/publish-shopify'],
      ['POST', '/api/shopify/send-draft'], ['GET', '/api/shopify/config'], ['POST', '/api/shopify/config'],
      ['POST', '/api/shopify/exchange-token'], ['POST', '/api/migration/preview'], ['GET', '/api/settings/ai-config'],
      ['POST', '/api/auth/google/sync-pending'], ['ALL', '/api/shopify-proxy'],
    ] as const) {
      const r = await call(m === 'ALL' ? 'GET' : m, u, { body: m === 'GET' || m === 'ALL' ? undefined : {} });
      expect(r.status, `${m} ${u}`).toBe(401);
    }
  });

  it('public allowlist works anonymously: health, google bootstrap config, login validation', async () => {
    expect((await call('GET', '/api/health')).status).toBe(200);
    expect((await call('GET', '/api/auth/google/config')).status).toBe(200);
    expect((await call('POST', '/api/auth/login', { body: {} })).status).toBe(400);
  });

  it('media files under /api/photos stay public for <img>/<video>, other files and diagnostics do not', async () => {
    expect((await call('GET', '/api/photos/doesnotexist.jpg')).status).toBe(404); // reached the handler, not the gate
    expect((await call('GET', '/api/photos/derivatives/doesnotexist.webp')).status).toBe(404);
    expect((await call('GET', '/api/photos/secrets.json')).status).toBe(401);
    expect((await call('GET', '/api/photos/status')).status).toBe(401);
    expect((await call('POST', '/api/photos/upload.jpg', { body: {} })).status).toBe(401); // only GET/HEAD is public
  });
});

describe('forged / backdoor / unverified credentials are rejected', () => {
  const unsigned = (payload: object) => {
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${h}.${b}.`;
  };
  const forged: Record<string, string> = {
    demo_admin_token: 'demo_admin_token',
    usr_admin_hasan_literal: 'usr_admin_hasan',
    demo_jwt_x: 'demo_jwt_x',
    demo_jwt_prefix_long: `demo_jwt_${Date.now()}`,
    contains_usr_admin_hasan: 'abc.usr_admin_hasan.def',
    alg_none_master_email: unsigned({ email: MASTER, id: 'usr_admin_hasan', role: 'admin' }),
    garbage: 'not-a-jwt',
  };
  for (const old of OLD_DEFAULT_SECRETS) {
    forged[`hs256_old_default_${old.slice(0, 12)}`] = jwt.sign({ id: 'usr_admin_hasan', email: MASTER, role: 'admin' }, old);
  }
  forged['hs256_random_secret_master_email'] = jwt.sign({ id: 'usr_admin_hasan', email: MASTER, role: 'admin' }, 'whatever-secret-123456');
  for (const [name, tok] of Object.entries(forged)) {
    it(`rejects ${name}`, async () => {
      for (const url of ['/api/inventory', '/api/users', '/api/auth/me']) {
        const r = await call('GET', url, { token: tok });
        expect([401, 403], `${url} -> ${r.status}`).toContain(r.status);
        expect(r.status).not.toBe(200);
      }
      const w = await call('POST', '/api/shopify/config', { token: tok, body: { shopDomain: 'evil.myshopify.com', adminAccessToken: 'x' } });
      expect(GATE_DENIED).toContain(w.status);
    });
  }

  it('HS512 signed with the correct secret is refused (algorithm pinned to HS256)', async () => {
    const secret = fs.readFileSync(path.join(dataDir, '.jwt_secret'), 'utf8').trim();
    const t = jwt.sign({ id: 'u_admin' }, secret, { algorithm: 'HS512' });
    expect((await call('GET', '/api/inventory', { token: t })).status).toBe(401);
  });

  it('a correctly signed token for a user id that is not in the DB is rejected', async () => {
    expect((await call('GET', '/api/inventory', { token: tokenFor('usr_ghost') })).status).toBe(401);
  });

  it('master-admin email in a (validly signed) token does NOT elevate: role comes from the DB', async () => {
    addUser('u_fake_master', 'viewer', 'active', 'someone.else@example.test');
    const t = tokenFor('u_fake_master', { email: MASTER, role: 'admin' });
    expect((await call('GET', '/api/users', { token: t })).status).toBe(403);
    expect((await call('POST', '/api/inventory', { token: t, body: {} })).status).toBe(403);
  });

  it('expired tokens are rejected', async () => {
    const t = signSessionToken({ id: 'u_admin' }, -10);
    expect((await call('GET', '/api/inventory', { token: t })).status).toBe(401);
  });
});

describe('account status is enforced on every request', () => {
  it('suspended, pending and rejected users get 403 even with a valid token claiming admin', async () => {
    for (const id of ['u_suspended', 'u_pending', 'u_rejected']) {
      const t = tokenFor(id, { role: 'admin', status: 'active' });
      const r = await call('GET', '/api/inventory', { token: t });
      expect(r.status, id).toBe(403);
      expect(r.json.code).toMatch(/^ACCOUNT_/);
    }
  });

  it('suspending a user takes effect immediately for already-issued tokens', async () => {
    addUser('u_temp', 'staff');
    const t = tokenFor('u_temp');
    expect((await call('GET', '/api/inventory', { token: t })).status).toBe(200);
    db.prepare("UPDATE users SET status='suspended' WHERE id='u_temp'").run();
    expect((await call('GET', '/api/inventory', { token: t })).status).toBe(403);
  });

  it('pending users can still read their own status (identity) and nothing else', async () => {
    const t = tokenFor('u_pending');
    const me = await call('GET', '/api/auth/me', { token: t });
    expect(me.status).toBe(200);
    expect(me.json.user.status).toBe('pending');
    const sp = await call('POST', '/api/auth/google/sync-pending', { token: t, body: { email: MASTER } });
    expect(sp.status).toBe(200);
    expect(sp.json.user.id).toBe('u_pending');
    expect(sp.json.user.role).toBe('staff'); // body is ignored: cannot elevate or register arbitrary emails
    expect((await call('GET', '/api/vendors', { token: t })).status).toBe(403);
  });

  it('sync-pending never creates users from the request body', async () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c;
    await call('POST', '/api/auth/google/sync-pending', { body: { email: 'attacker@example.test' } });
    await call('POST', '/api/auth/google/sync-pending', { token: tokenFor('u_pending'), body: { email: 'attacker2@example.test' } });
    expect((db.prepare('SELECT COUNT(*) c FROM users').get() as any).c).toBe(before);
  });
});

describe('role-based authorization', () => {
  it('viewer is read-only: GET ok, every POST/PUT/PATCH/DELETE is 403', async () => {
    const t = tokenFor('u_viewer');
    expect((await call('GET', '/api/inventory', { token: t })).status).toBe(200);
    expect((await call('GET', '/api/vendors', { token: t })).status).toBe(200);
    expect((await call('POST', '/api/inventory', { token: t, body: {} })).status).toBe(403);
    expect((await call('PUT', '/api/inventory/x', { token: t, body: {} })).status).toBe(403);
    expect((await call('DELETE', '/api/inventory/x', { token: t })).status).toBe(403);
    expect((await call('PATCH', '/api/media/x', { token: t, body: {} })).status).toBe(403);
    expect((await call('POST', '/api/photos/upload', { token: t, body: {} })).status).toBe(403);
    expect((await call('GET', '/api/settings/ai-config', { token: t })).status).toBe(403); // contains provider keys
    for (const p of policyMod.ROUTE_POLICY.filter((x) => x.method !== 'GET' && !['public', 'dev', 'webhook', 'oauth', 'identity'].includes(x.access))) {
      const method = p.method === 'ALL' ? 'POST' : p.method;
      const r = await call(method, concrete(p.path), { token: t, body: {} });
      expect(r.status, `${method} ${p.path}`).toBe(403);
    }
  });

  it('enforces the minimum role for every row of the table (admin passes the gate, lower roles are 403 where below minimum)', async () => {
    const rank: Record<string, number> = { viewer: 1, staff: 2, manager: 3, admin: 4 };
    const users: Array<[string, number]> = [['u_viewer', 1], ['u_staff', 2], ['u_clerk', 2], ['u_manager', 3], ['u_admin', 4]];
    for (const p of policyMod.ROUTE_POLICY.filter((x) => rank[x.access])) {
      const method = p.method === 'ALL' ? 'GET' : p.method;
      for (const [id, r] of users) {
        if (p.path === '/api/photos/:filename' || p.path === '/api/photos/derivatives/:filename') continue; // public media class
        const denied = r < rank[p.access];
        // Never actually EXECUTE destructive / network-touching handlers as an allowed role (clear-demo-data
        // wipes users, S3 routes dial out, the proxy dials Shopify). Denial (403) is still asserted for every row.
        if (!denied && DO_NOT_EXECUTE.some((re) => re.test(`${method} ${p.path}`))) continue;
        const res = await call(method, concrete(p.path), { token: tokenFor(id), body: method === 'GET' ? undefined : {} });
        if (denied) expect(res.status, `${id} ${method} ${p.path}`).toBe(403);
        else expect(res.status, `${id} ${method} ${p.path}`).not.toBe(403);
        expect(res.status).not.toBe(401);
      }
    }
  });

  it('staff cannot send drafts or touch Shopify config; manager can send drafts but not config; admin can configure', async () => {
    const staff = tokenFor('u_staff');
    const mgr = tokenFor('u_manager');
    const adm = tokenFor('u_admin');
    const cfg = { shopDomain: 'unit-test-store.myshopify.com', adminAccessToken: 'shpat_unit_test_token', apiVersion: '2026-07' };

    expect((await call('POST', '/api/shopify/send-draft', { token: staff, body: {} })).status).toBe(403);
    expect((await call('POST', '/api/shopify/config', { token: staff, body: cfg })).status).toBe(403);
    expect((await call('POST', '/api/shopify/exchange-token', { token: staff, body: {} })).status).toBe(403);

    const sd = await call('POST', '/api/shopify/send-draft', { token: mgr, body: {} });
    expect(GATE_DENIED).not.toContain(sd.status); // reaches the handler (400 for the empty body)
    expect((await call('POST', '/api/shopify/config', { token: mgr, body: cfg })).status).toBe(403);
    expect((await call('POST', '/api/shopify/exchange-token', { token: mgr, body: {} })).status).toBe(403);

    const saved = await call('POST', '/api/shopify/config', { token: adm, body: cfg });
    expect(saved.status).toBe(200);

    // The raw Admin token is revealed to admins only.
    expect((await call('GET', '/api/shopify/config', { token: adm })).json.adminAccessToken).toBe('shpat_unit_test_token');
    for (const t of [staff, mgr, tokenFor('u_viewer')]) {
      const g = await call('GET', '/api/shopify/config', { token: t });
      expect(g.status).toBe(200);
      expect(g.json.adminAccessToken).toBe('');
      expect(g.json.hasAdminAccessToken).toBe(true);
    }
    db.prepare("DELETE FROM system_settings WHERE key LIKE 'shopify%'").run();
  });

  it('hard-delete needs manager; staff can create/soft-delete', async () => {
    const staff = tokenFor('u_staff');
    const mgr = tokenFor('u_manager');
    const created = await call('POST', '/api/inventory', { token: staff, body: { title: 'Auth Test Ring', typeCode: 'RG', stoneCode: 'Z', colorCode: '01', buyingPrice: 1, sellingPrice: 2, quantity: 1 } });
    expect(created.status).toBe(201);
    const id = created.json.item?.id ?? created.json.id;
    expect((await call('DELETE', `/api/inventory/${id}?hard=true`, { token: staff })).status).toBe(403);
    expect((await call('DELETE', `/api/inventory/${id}?hard=true`, { token: mgr })).status).toBe(200);
  });

  it('user management is admin-only', async () => {
    expect((await call('GET', '/api/users', { token: tokenFor('u_manager') })).status).toBe(403);
    expect((await call('GET', '/api/users', { token: tokenFor('u_admin') })).status).toBe(200);
    expect((await call('POST', '/api/users/u_staff/role', { token: tokenFor('u_staff'), body: { role: 'admin' } })).status).toBe(403);
  });
});

describe('Shopify webhook (HMAC instead of a session)', () => {
  const body = JSON.stringify({ id: 990001, line_items: [] });
  const sign = (b: string, secret = WEBHOOK_SECRET) => crypto.createHmac('sha256', secret).update(b, 'utf8').digest('base64');
  const post = (b: string, sig?: string) =>
    call('POST', '/api/webhooks/shopify', { raw: b, headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'orders/create', ...(sig !== undefined ? { 'X-Shopify-Hmac-Sha256': sig } : {}) } });

  it('rejects unsigned, wrongly signed and tampered requests with 401', async () => {
    expect((await post(body)).status).toBe(401);
    expect((await post(body, 'bm90LWEtcmVhbC1zaWduYXR1cmU=')).status).toBe(401);
    expect((await post(body, sign(body, 'a-different-secret'))).status).toBe(401);
    expect((await post(body.replace('990001', '990002'), sign(body))).status).toBe(401);
  });
  it('accepts a correctly signed request', async () => {
    const r = await post(body, sign(body));
    expect(r.status).toBe(200);
  });
  it('refuses everything (503) when no webhook/app secret is configured, even unsigned', async () => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    try {
      expect((await post(body)).status).toBe(503);
      expect((await post(body, sign(body, ''))).status).toBe(503);
    } finally {
      process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    }
  });
  it('falls back to SHOPIFY_CLIENT_SECRET (the app secret Shopify signs with)', async () => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    process.env.SHOPIFY_CLIENT_SECRET = 'app-client-secret-123';
    try {
      expect((await post(body, sign(body, 'app-client-secret-123'))).status).toBe(200);
      expect((await post(body, sign(body))).status).toBe(401);
    } finally {
      process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;
      delete process.env.SHOPIFY_CLIENT_SECRET;
    }
  });
});

describe('Shopify OAuth callback and proxy cannot be abused', () => {
  it('callback with a bad/missing HMAC does not call Shopify and redirects to an error', async () => {
    process.env.SHOPIFY_CLIENT_ID = 'cid';
    process.env.SHOPIFY_CLIENT_SECRET = 'csecret';
    try {
      const r = await call('GET', '/api/auth/shopify/callback?code=abc&shop=attacker.example.com&hmac=deadbeef', { redirect: 'manual' });
      expect(r.status).toBe(302);
      expect(r.res.headers.get('location')).toContain('shopify_error=invalid_oauth_signature');
    } finally {
      delete process.env.SHOPIFY_CLIENT_ID;
      delete process.env.SHOPIFY_CLIENT_SECRET;
    }
  });
  it('proxy refuses non-myshopify hosts (no token exfiltration via ?shop=)', async () => {
    const r = await call('GET', '/api/shopify-proxy?shop=attacker.example.com&path=/admin/api/x.json', { token: tokenFor('u_manager') });
    expect(r.status).toBe(400);
  });
});

describe('dev helpers and anonymous local admin are impossible in production', () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    try { await fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
  };

  it('dev-login works only outside production-like environments (NODE_ENV=production or any RAILWAY_*) -> 404', async () => {
    const ok = await call('POST', '/api/auth/google/dev-login', { body: { email: 'dev.user@example.test', name: 'Dev', role: 'staff', status: 'active' } });
    expect(ok.status).toBe(200);
    await withEnv({ NODE_ENV: 'production' }, async () => {
      expect((await call('POST', '/api/auth/google/dev-login', { body: {} })).status).toBe(404);
    });
    await withEnv({ RAILWAY_ENVIRONMENT: 'staging' }, async () => {
      expect((await call('POST', '/api/auth/google/dev-login', { body: {} })).status).toBe(404);
    });
    await withEnv({ RAILWAY_ENVIRONMENT_NAME: 'production' }, async () => {
      expect((await call('POST', '/api/auth/google/dev-login', { body: {} })).status).toBe(404);
    });
  });

  it('mock Google tokens are rejected by /api/auth/google in production-like environments', async () => {
    const cred = `mock-google-token:${MASTER}|Forged Admin|gid_forged`;
    await withEnv({ NODE_ENV: 'production' }, async () => {
      expect((await call('POST', '/api/auth/google', { body: { credential: cred } })).status).toBe(401);
    });
    await withEnv({ RAILWAY_PROJECT_ID: 'p' }, async () => {
      expect((await call('POST', '/api/auth/google', { body: { credential: cred } })).status).toBe(401);
    });
  });

  it('ALLOW_ANONYMOUS_LOCAL_ADMIN is off by default and ignored in production / on Railway', async () => {
    expect((await call('GET', '/api/inventory')).status).toBe(401);
    await withEnv({ ALLOW_ANONYMOUS_LOCAL_ADMIN: 'true' }, async () => {
      const r = await call('GET', '/api/inventory');
      expect(r.status).toBe(200); // explicit opt-in on a non-production, non-Railway host
      expect((await call('GET', '/api/users')).status).toBe(200);
    });
    for (const env of [{ NODE_ENV: 'production' }, { RAILWAY_ENVIRONMENT: 'production' }, { RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }, { RAILWAY_VOLUME_MOUNT_PATH: dataDir }]) {
      await withEnv({ ALLOW_ANONYMOUS_LOCAL_ADMIN: 'true', ...env }, async () => {
        expect((await call('GET', '/api/inventory')).status, JSON.stringify(env)).toBe(401);
        expect((await call('GET', '/api/users')).status).toBe(401);
      });
    }
    await withEnv({ ALLOW_ANONYMOUS_LOCAL_ADMIN: 'yes' }, async () => {
      expect((await call('GET', '/api/inventory')).status).toBe(401); // only the literal "true"
    });
  });

  it('environment helpers agree', async () => {
    const env = await import('../server/auth/environment');
    expect(env.anonymousLocalAdminEnabled({ ALLOW_ANONYMOUS_LOCAL_ADMIN: 'true' } as any)).toBe(true);
    expect(env.anonymousLocalAdminEnabled({ ALLOW_ANONYMOUS_LOCAL_ADMIN: 'true', NODE_ENV: 'production' } as any)).toBe(false);
    expect(env.anonymousLocalAdminEnabled({ ALLOW_ANONYMOUS_LOCAL_ADMIN: 'true', RAILWAY_SERVICE_ID: 's' } as any)).toBe(false);
    expect(env.devHelpersEnabled({ NODE_ENV: 'production' } as any)).toBe(false);
    expect(env.devHelpersEnabled({ RAILWAY_ENVIRONMENT: 'staging' } as any)).toBe(false);
    expect(env.devHelpersEnabled({ NODE_ENV: 'development' } as any)).toBe(true);
  });
});

describe('Google login flow still works against the single secret (no bypass needed)', () => {
  it('mock-token login (test env only) issues a token that verifies with the shared secret and passes the middleware', async () => {
    const r = await call('POST', '/api/auth/google', { body: { credential: `mock-google-token:${MASTER}|Laiq Hasan|gid_master_1` } });
    expect(r.status).toBe(200);
    const secret = fs.readFileSync(path.join(dataDir, '.jwt_secret'), 'utf8').trim();
    expect((jwt.verify(r.json.token, secret) as any).email).toBe(MASTER); // signed with the persisted secret
    for (const old of OLD_DEFAULT_SECRETS) expect(() => jwt.verify(r.json.token, old)).toThrow();
    expect(r.json.user.role).toBe('admin');
    expect((await call('GET', '/api/users', { token: r.json.token })).status).toBe(200);
  });

  it('a new non-admin Google user is pending: can see /me, cannot use the API; after approval it works', async () => {
    const r = await call('POST', '/api/auth/google', { body: { credential: 'mock-google-token:newhire@example.test|New Hire|gid_new_1' } });
    expect(r.status).toBe(200);
    expect(r.json.user.status).toBe('pending');
    const t = r.json.token;
    expect((await call('GET', '/api/auth/me', { token: t })).json.user.status).toBe('pending');
    expect((await call('GET', '/api/inventory', { token: t })).status).toBe(403);
    const admin = (await call('POST', '/api/auth/google', { body: { credential: `mock-google-token:${MASTER}|Laiq Hasan|gid_master_1` } })).json.token;
    expect((await call('POST', `/api/users/${r.json.user.id}/approve`, { token: admin, body: { role: 'staff' } })).status).toBe(200);
    expect((await call('GET', '/api/inventory', { token: t })).status).toBe(200); // same token, now active
  });

  it('a Google ID token that fails verification is rejected (no unverified-decode fallback)', async () => {
    const { OAuth2Client } = await import('google-auth-library');
    const spy = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockRejectedValue(new Error('bad signature'));
    try {
      const forgedGoogle = jwt.sign({ sub: 'x', email: MASTER, email_verified: true, aud: 'whatever' }, 'attacker-key-attacker-key');
      const r = await call('POST', '/api/auth/google', { body: { credential: forgedGoogle } });
      expect(r.status).toBe(401);
      const unsignedGoogle = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x', email: MASTER })).toString('base64url')}.`;
      expect((await call('POST', '/api/auth/google', { body: { credential: unsignedGoogle } })).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('a verified Google token with an unverified email is refused', async () => {
    const { OAuth2Client } = await import('google-auth-library');
    const spy = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({ sub: 'g1', email: MASTER, email_verified: false, name: 'x' }),
    } as any);
    try {
      expect((await call('POST', '/api/auth/google', { body: { credential: 'anything' } })).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('a verified Google token for a known user logs in (the real-Google path, mocked at the library boundary)', async () => {
    const { OAuth2Client } = await import('google-auth-library');
    const spy = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({ sub: 'gid_real_master', email: MASTER, email_verified: true, name: 'Laiq Hasan', picture: 'https://example.test/p.png' }),
    } as any);
    try {
      const r = await call('POST', '/api/auth/google', { body: { credential: 'real-looking-id-token' } });
      expect(r.status).toBe(200);
      expect(r.json.user.role).toBe('admin');
      expect((await call('GET', '/api/inventory', { token: r.json.token })).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('password login', () => {
  it('rejects suspended accounts and the seeded default passwords in production-like environments', async () => {
    const seeded = db.prepare("SELECT id FROM users WHERE id = 'usr_admin_root'").get();
    expect(seeded).toBeTruthy();
    const ok = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    expect(ok.status).toBe(200); // dev/test convenience only
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const blocked = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
      expect(blocked.status).toBe(403);
      expect(blocked.json.code).toBe('DEFAULT_CREDENTIALS_DISABLED');
      expect((await call('POST', '/api/auth/login', { body: { username: 'salesclerk', password: 'clerk123' } })).status).toBe(403);
    } finally {
      process.env.NODE_ENV = prev;
    }
    db.prepare("UPDATE users SET status='suspended' WHERE id='usr_admin_root'").run();
    expect((await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } })).status).toBe(403);
    db.prepare("UPDATE users SET status='active' WHERE id='usr_admin_root'").run();
  });

  it('password-login tokens are verified with the same shared secret', async () => {
    const ok = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    expect((await call('GET', '/api/users', { token: ok.json.token })).status).toBe(200);
  });
});

describe('JWT secret resolver', () => {
  it('generated secret is persisted under DATA_DIR with mode 0600 and is not a known default', () => {
    const f = path.join(dataDir, '.jwt_secret');
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const s = fs.readFileSync(f, 'utf8').trim();
    expect(s.length).toBeGreaterThanOrEqual(48);
    expect(OLD_DEFAULT_SECRETS).not.toContain(s);
  });

  it('is reused across a simulated restart, so sessions survive a redeploy on the same volume', async () => {
    const t = tokenFor('u_admin');
    const secretBefore = fs.readFileSync(path.join(dataDir, '.jwt_secret'), 'utf8');
    await shutdown();
    await boot();
    expect(fs.readFileSync(path.join(dataDir, '.jwt_secret'), 'utf8')).toBe(secretBefore);
    expect((await call('GET', '/api/inventory', { token: t })).status).toBe(200);
  });

  it('JWT_SECRET env takes precedence; rotating invalidates old sessions (users re-login once)', async () => {
    const t = tokenFor('u_admin');
    await shutdown();
    process.env.JWT_SECRET = 'explicit-env-secret-0123456789abcdef';
    try {
      await boot();
      expect((await call('GET', '/api/inventory', { token: t })).status).toBe(401); // old session invalid
      const t2 = tokenFor('u_admin');
      expect((jwt.verify(t2, 'explicit-env-secret-0123456789abcdef') as any).id).toBe('u_admin');
      expect((await call('GET', '/api/inventory', { token: t2 })).status).toBe(200);
      // google service and server use the very same resolver
      const { generateUserJwt } = await import('../server/services/googleAuthService');
      const g = generateUserJwt({ id: 'u_admin', username: 'u_admin_n', fullName: 'x', role: 'admin', status: 'active', authProvider: 'google' } as any);
      expect((jwt.verify(g, 'explicit-env-secret-0123456789abcdef') as any).id).toBe('u_admin');
      expect((await call('GET', '/api/inventory', { token: g })).status).toBe(200);
    } finally {
      delete process.env.JWT_SECRET;
      await shutdown();
      await boot();
    }
  });

  it('a too-short JWT_SECRET is ignored in favour of the persisted secret (never a weak key)', async () => {
    const { resolveJwtSecret, __resetJwtSecretCacheForTests } = await import('../server/auth/jwtSecret');
    process.env.JWT_SECRET = 'short';
    try {
      __resetJwtSecretCacheForTests();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(resolveJwtSecret()).toBe(fs.readFileSync(path.join(dataDir, '.jwt_secret'), 'utf8').trim());
      warn.mockRestore();
    } finally {
      delete process.env.JWT_SECRET;
      __resetJwtSecretCacheForTests();
    }
  });

  it('no hard-coded JWT default remains in server code', () => {
    const root = path.resolve(__dirname, '../server');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(root).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const old of OLD_DEFAULT_SECRETS) expect(src.includes(old), `${f} contains ${old}`).toBe(false);
    }
  });
});
