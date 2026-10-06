/**
 * Shared helpers for the backup / rollback drill scripts.
 * Everything runs against TEMP directories only: never ./data, never production.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');
export const DEPLOYED_COMMIT = process.env.DEPLOYED_COMMIT || '68398e6';

export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function mkTmp(label: string): string {
  return fs.mkdtempSync(path.join(process.env.DRILL_TMP || os.tmpdir(), `saaz-drill-${label}-`));
}

/** Extract a commit with `git archive` into a fresh temp dir and link node_modules. */
export function extractCommit(commit: string, label: string): string {
  const dir = mkTmp(label);
  const tar = execFileSync('git', ['archive', commit], { cwd: REPO_ROOT, maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  const nm = fs.realpathSync(path.join(REPO_ROOT, 'node_modules'));
  fs.symlinkSync(nm, path.join(dir, 'node_modules'));
  return dir;
}

export interface Srv {
  proc: ChildProcess;
  port: number;
  base: string;
  dataDir: string;
  log: () => string;
  stop: () => Promise<void>;
}

let portCounter = 4300 + Math.floor(Math.random() * 400);
export function nextPort(): number { return portCounter++; }

export async function startServer(codeDir: string, dataDir: string, extraEnv: Record<string, string> = {}, fixedPort?: number): Promise<Srv> {
  fs.mkdirSync(dataDir, { recursive: true });
  const port = fixedPort ?? nextPort();
  // Older commits ignore LEGACY_UPLOADS_DIR and use <code>/uploads/photos as a second photo store; wipe it
  // (temp extraction only) so photos can never leak between "volumes" and fake a recovery.
  if (path.basename(codeDir).startsWith('saaz-drill-')) fs.rmSync(path.join(codeDir, 'uploads'), { recursive: true, force: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    LEGACY_UPLOADS_DIR: path.join(dataDir, 'legacy-uploads'),
    NODE_ENV: 'production-drill',
    ...extraEnv,
  };
  delete env.RAILWAY_VOLUME_MOUNT_PATH;
  delete env.DATABASE_URL;
  const proc = spawn(path.join(codeDir, 'node_modules/.bin/tsx'), ['server/server.ts'], { cwd: codeDir, env: env as any, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  proc.stdout!.on('data', (d) => (buf += d));
  proc.stderr!.on('data', (d) => (buf += d));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited early (code ${proc.exitCode}):\n${buf}`);
    try { const r = await fetch(`${base}/api/vendors`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 60000) { proc.kill('SIGKILL'); throw new Error('server start timeout:\n' + buf); }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    proc, port, base, dataDir, log: () => buf,
    stop: () => new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }),
  };
}

export async function api(srv: Srv, method: string, url: string, body?: any, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(srv.base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

/** 1x1-ish real PNG (valid, tiny) generated with sharp so image validation passes. */
export async function makePng(rgb: [number, number, number], size = 64): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

export function openDb(dbPath: string, readonly = true): Database.Database {
  return new Database(dbPath, { readonly, fileMustExist: true });
}

/** Deterministic dump of table rows (sorted, volatile columns dropped) for row-wise diffs. */
export function dumpTables(dbPath: string, tables: string[], dropCols: string[] = []): Record<string, any[]> {
  const db = openDb(dbPath);
  const out: Record<string, any[]> = {};
  for (const t of tables) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!exists) { out[t] = ['<TABLE MISSING>']; continue; }
    const rows = db.prepare(`SELECT * FROM "${t}"`).all() as any[];
    out[t] = rows.map((r) => {
      const c: any = {};
      for (const [k, v] of Object.entries(r).sort(([a], [b]) => a.localeCompare(b))) {
        if (dropCols.includes(k)) continue;
        c[k] = Buffer.isBuffer(v) ? `<blob ${v.length}b sha256:${crypto.createHash('sha256').update(v).digest('hex').slice(0, 12)}>` : v;
      }
      return c;
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  db.close();
  return out;
}

export const CORE_TABLES = ['items', 'purchase_lots', 'stock_movements', 'vendors', 'users', 'global_sku_sequence', 'sku_sequences', 'media_assets', 'product_media_links', 'media_storage_locations', 'deleted_skus', 'photo_blobs', 'system_settings'];

export function listFilesWithHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha256File(p);
    }
  };
  walk(dir);
  return out;
}

let outStream: fs.WriteStream | null = null;
export function setOutputFile(p: string) { fs.mkdirSync(path.dirname(p), { recursive: true }); outStream = fs.createWriteStream(p); }
export function closeOutput() { outStream?.end(); }
export function log(...a: any[]) {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ');
  console.log(s);
  outStream?.write(s + '\n');
}
export const results: { step: string; pass: boolean; note?: string }[] = [];
export function check(step: string, pass: boolean, note = '') {
  results.push({ step, pass, note });
  log(`${pass ? 'PASS' : 'FAIL'}  ${step}${note ? '  -- ' + note : ''}`);
}

/** Build the Vite client of an extracted commit so the server can serve the real UI. */
export function buildClient(codeDir: string): void {
  execFileSync(path.join(codeDir, 'node_modules/.bin/vite'), ['build'], { cwd: codeDir, stdio: 'ignore' });
}

/** Compact "what does this data dir hold" fingerprint used to show recovered / not recovered. */
export function fingerprint(dataDir: string): Record<string, any> {
  const dbPath = path.join(dataDir, 'saaz_ledger.db');
  const db = openDb(dbPath);
  const q = (sql: string) => db.prepare(sql).all() as any[];
  const count = (t: string) => { try { return (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c; } catch { return 'n/a'; } };
  const fp: Record<string, any> = {
    items: q('SELECT sku, title, quantity, buying_price AS buy, selling_price AS sell, image_url, vendor_name FROM items ORDER BY sku'),
    purchase_lots: count('purchase_lots'),
    stock_movements: count('stock_movements'),
    vendors: q('SELECT code, name FROM vendors ORDER BY code').map((v) => `${v.code}:${v.name}`),
    users: q('SELECT email FROM users ORDER BY email').map((u) => u.email),
    sku_sequences: q('SELECT type_code||stone_code||color_code AS k, last_serial FROM sku_sequences ORDER BY k').map((s) => `${s.k}=${s.last_serial}`),
    global_sku_sequence: q('SELECT current_serial, is_initialized, starting_serial FROM global_sku_sequence'),
    media_assets: count('media_assets'),
    product_media_links: count('product_media_links'),
    photo_blobs: count('photo_blobs'),
    photo_names_blob: q("SELECT filename FROM photo_blobs WHERE filename NOT LIKE 'derivatives/%' ORDER BY filename").map((r) => r.filename),
    photo_files_on_disk: Object.keys(listFilesWithHash(path.join(dataDir, 'uploads/photos'))).filter((f) => !f.includes('derivatives') && /\.(png|jpe?g|webp)$/i.test(f)).length,
  };
  db.close();
  return fp;
}
