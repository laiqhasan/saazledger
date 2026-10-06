/**
 * Starts the isolated stack: temp DATA_DIR + real Express app (spawned tsx child) + (fake mode) a localhost fake Shopify.
 * Nothing here touches ./data or ./uploads, production credentials or the internet.
 */
import { spawn, type ChildProcess, execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { FakeShopifyServer } from '../../../tests/helpers/fakeShopifyServer';

import { fileURLToPath } from 'url';
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const ADMIN = { id: 'usr_e2e_admin', username: 'e2e_admin', password: 'E2e-Admin-pass-1!', role: 'admin' };
export const VIEWER = { id: 'usr_e2e_viewer', username: 'e2e_viewer', password: 'E2e-Viewer-pass-1!', role: 'viewer' };
export const FAKE_LOCATION_ID = '7001';

export interface Stack {
  baseUrl: string;
  dataDir: string;
  dbPath: string;
  tmpRoot: string;
  mode: 'fake' | 'real';
  fake?: FakeShopifyServer;
  shopDomainMasked: string;
  locationId: string;
  stop(): Promise<void>;
  serverLog(): string;
}

const STRIP = /^(SHOPIFY_|TEST_SHOPIFY_|PHOTOROOM|PHOTO_ROOM|VITE_PHOTOROOM|REMOVE_?BG|CLIPDROP|GEMINI|GOOGLE_|VITE_GEMINI|OPENAI|VITE_OPENAI|RAILWAY_|AWS_|S3_|DATABASE_URL|PG|JWT_SECRET|ALLOW_ANONYMOUS|BG_REMOVAL|NODE_ENV|PORT$|DATA_DIR|LEGACY_UPLOADS)/;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

/** Store domains known from this repo / docs to be the PRODUCTION store; a test run may never target (or contain) them. */
export const KNOWN_PRODUCTION_SHOPS = ['saazaura.myshopify.com', 'saaz-jewels.myshopify.com'];

export function maskDomain(d: string): string {
  const m = d.match(/^([^.]{0,3})([^.]*)(\.myshopify\.com)$/i);
  return m ? `${m[1]}***${m[3]}` : '***';
}

/** Refuses anything that is not an explicitly supplied dev/test *.myshopify.com store, and never the production one. */
export function assertSafeRealShop(domain: string, productionDomains: string[]): void {
  const d = domain.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) throw new Error('TEST_SHOPIFY_SHOP_DOMAIN must be a <name>.myshopify.com domain.');
  for (const p of productionDomains.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const pn = p.replace(/\.myshopify\.com$/, '');
    if (d === p || d.includes(pn)) throw new Error('REFUSING: TEST_SHOPIFY_SHOP_DOMAIN matches the production store domain.');
  }
}

export async function startStack(opts: { mode: 'fake' | 'real'; outDir: string; log: (s: string) => void; skipBuild?: boolean }): Promise<Stack> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-browser-e2e-'));
  const dataDir = path.join(tmpRoot, 'data');
  const uploads = path.join(tmpRoot, 'legacy-uploads', 'photos');
  fs.mkdirSync(dataDir, { recursive: true });
  if (path.resolve(dataDir).startsWith(path.join(REPO, 'data'))) throw new Error('refusing to use repo data dir');

  if (!opts.skipBuild || !fs.existsSync(path.join(REPO, 'dist', 'index.html'))) {
    opts.log('building SPA (vite build -> dist/, gitignored)');
    execFileSync('npx', ['vite', 'build', '--logLevel', 'error'], { cwd: REPO, stdio: 'inherit' });
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k) && v !== undefined) env[k] = v;
  const port = await freePort();
  Object.assign(env, { DATA_DIR: dataDir, LEGACY_UPLOADS_DIR: uploads, PORT: String(port), JWT_SECRET: 'browser-e2e-jwt-secret-' + path.basename(tmpRoot) + '-0123456789' });

  let fake: FakeShopifyServer | undefined;
  let shopDomain: string;
  let locationId: string;
  if (opts.mode === 'fake') {
    fake = new FakeShopifyServer({ defaultLocationId: Number(FAKE_LOCATION_ID) });
    const base = await fake.start();
    shopDomain = 'fake-dry-run-store.myshopify.com';
    locationId = FAKE_LOCATION_ID;
    Object.assign(env, { NODE_ENV: 'test', SHOPIFY_TEST_BASE_URL: base, SHOPIFY_SHOP_DOMAIN: shopDomain, SHOPIFY_ADMIN_ACCESS_TOKEN: fake.token, SHOPIFY_PRIMARY_LOCATION_ID: locationId });
  } else {
    shopDomain = (process.env.TEST_SHOPIFY_SHOP_DOMAIN || '').trim();
    const token = (process.env.TEST_SHOPIFY_ADMIN_TOKEN || '').trim();
    locationId = (process.env.TEST_SHOPIFY_LOCATION_ID || '').trim();
    if (!shopDomain || !token || !locationId) throw new Error('real mode needs TEST_SHOPIFY_SHOP_DOMAIN, TEST_SHOPIFY_ADMIN_TOKEN and TEST_SHOPIFY_LOCATION_ID in the environment.');
    const prod = [...KNOWN_PRODUCTION_SHOPS, process.env.PRODUCTION_SHOPIFY_SHOP_DOMAIN || '', process.env.SHOPIFY_SHOP_DOMAIN || '', process.env.SHOPIFY_STORE_DOMAIN || ''];
    assertSafeRealShop(shopDomain, prod);
    Object.assign(env, { NODE_ENV: 'development', SHOPIFY_SHOP_DOMAIN: shopDomain, SHOPIFY_ADMIN_ACCESS_TOKEN: token, SHOPIFY_PRIMARY_LOCATION_ID: locationId });
    const pr = (process.env.TEST_PHOTOROOM_API_KEY || '').trim();
    if (pr) env.PHOTOROOM_API_KEY = pr;
  }

  let logBuf = '';
  const child: ChildProcess = spawn(path.join(REPO, 'node_modules/.bin/tsx'), [path.join(REPO, 'scripts/browser-e2e/serverLauncher.ts')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const redact = (s: string) => s.split(env.SHOPIFY_ADMIN_ACCESS_TOKEN || '\u0000').join('[REDACTED]');
  child.stdout!.on('data', (d) => { logBuf += redact(String(d)); });
  child.stderr!.on('data', (d) => { logBuf += redact(String(d)); });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const baseUrl = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error('server exited early:\n' + logBuf.slice(-2000));
    try { const r = await fetch(baseUrl + '/api/health'); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 120_000) throw new Error('server did not start in 120s:\n' + logBuf.slice(-2000));
    await new Promise((r) => setTimeout(r, 300));
  }

  const dbPath = path.join(dataDir, 'saaz_ledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 10000');
  for (const u of [ADMIN, VIEWER]) {
    db.prepare(`INSERT OR REPLACE INTO users (id, username, password_hash, full_name, role, status, auth_provider) VALUES (?, ?, ?, ?, ?, 'active', 'local')`)
      .run(u.id, u.username, bcrypt.hashSync(u.password, 10), `E2E ${u.role}`, u.role);
  }
  db.close();

  return {
    baseUrl, dataDir, dbPath, tmpRoot, mode: opts.mode, fake, shopDomainMasked: opts.mode === 'fake' ? shopDomain : maskDomain(shopDomain), locationId,
    serverLog: () => logBuf,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!exited) child.kill('SIGKILL');
      await fake?.stop();
    },
  };
}

export function openDb(stack: Stack): Database.Database {
  const db = new Database(stack.dbPath, { readonly: true });
  db.pragma('busy_timeout = 10000');
  return db;
}
