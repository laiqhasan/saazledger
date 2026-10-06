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

const tmpDirs: string[] = [];
process.on('exit', () => { if (!process.env.KEEP_TMP) for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
export function mkTmp(label: string): string {
  const d = fs.mkdtempSync(path.join(process.env.DRILL_TMP || os.tmpdir(), `saaz-drill-${label}-`));
  tmpDirs.push(d);
  return d;
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

let outFd: number | null = null;
export function setOutputFile(p: string) { fs.mkdirSync(path.dirname(p), { recursive: true }); outFd = fs.openSync(p, 'w'); }
export function closeOutput() { if (outFd !== null) { fs.closeSync(outFd); outFd = null; } }
export function log(...a: any[]) {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ');
  console.log(s);
  if (outFd !== null) fs.writeSync(outFd, s + '\n');
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

/** Dump EVERY user table (blobs hashed) for exact row-wise comparison. */
export function dumpAll(dbPath: string): Record<string, any[]> {
  const db = openDb(dbPath);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[]).map((r) => r.name);
  db.close();
  return dumpTables(dbPath, tables);
}

export function schemaObjects(dbPath: string): { tables: string[]; triggers: string[]; indexes: string[]; itemsColumns: string[] } {
  const db = openDb(dbPath);
  const names = (type: string) => (db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE \'sqlite_%\' ORDER BY name').all(type) as any[]).map((r) => r.name);
  const out = { tables: names('table'), triggers: names('trigger'), indexes: names('index'), itemsColumns: (db.prepare('PRAGMA table_info(items)').all() as any[]).map((c) => c.name) };
  db.close();
  return out;
}

export interface TableDiff { table: string; onlyInA: any[]; onlyInB: any[] }
/** Row-wise set diff of two dumps. `ignoreTables` skips tables (e.g. ones that only exist in one schema). */
export function diffDumps(a: Record<string, any[]>, b: Record<string, any[]>, ignoreTables: string[] = []): TableDiff[] {
  const out: TableDiff[] = [];
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ignoreTables.includes(t)) continue;
    const sa = new Set((a[t] || []).map((r) => JSON.stringify(r)));
    const sb = new Set((b[t] || []).map((r) => JSON.stringify(r)));
    const onlyInA = [...sa].filter((x) => !sb.has(x)).map((x) => JSON.parse(x));
    const onlyInB = [...sb].filter((x) => !sa.has(x)).map((x) => JSON.parse(x));
    if (onlyInA.length || onlyInB.length) out.push({ table: t, onlyInA, onlyInB });
  }
  return out;
}

/** Consistent copy of a (possibly WAL-mode) DB using SQLite's online backup API. */
export async function snapshotDb(srcDb: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const d = new Database(srcDb, { fileMustExist: true });
  try { await d.backup(dest); } finally { d.close(); }
}

export function copyDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

/** Photos referenced by items (image/original/white-bg), media_assets storage rows and pack drafts. */
export function referencedPhotoNames(dbPath: string): Set<string> {
  const db = openDb(dbPath);
  const refs = new Set<string>();
  const add = (u: any) => { if (typeof u === 'string' && u.includes('/api/photos/')) refs.add(u.split('/api/photos/')[1].split('?')[0]); else if (typeof u === 'string' && u && !u.startsWith('http')) refs.add(u.split('/').pop()!); };
  const cols = (db.prepare('PRAGMA table_info(items)').all() as any[]).map((c) => c.name);
  for (const c of ['image_url', 'original_image_url', 'white_bg_image_url']) if (cols.includes(c)) for (const r of db.prepare(`SELECT ${c} AS u FROM items WHERE ${c} IS NOT NULL`).all() as any[]) add(r.u);
  try { for (const r of db.prepare('SELECT pack_json, original_refs FROM media_pack_drafts').all() as any[]) { for (const m of (r.pack_json + ' ' + (r.original_refs || '')).matchAll(/\/api\/photos\/([A-Za-z0-9_.-]+)/g)) refs.add(m[1]); } } catch { /* table absent */ }
  db.close();
  return refs;
}

/**
 * The exact node one-liners given to the operator in docs/backup-and-rollback.md. They need nothing but node +
 * better-sqlite3 (already in the deployed app), so they work with ANY deployed release, including the old one.
 * `$DB`, `$OUT`, `$SNAP` are shell variables.
 */
export const ONE_LINER_BACKUP =
  `node -e "const D=require('better-sqlite3');const d=new D(process.argv[1]);d.backup(process.argv[2]).then(()=>{d.close();const c=new D(process.argv[2],{readonly:true});console.log('integrity_check:',c.pragma('integrity_check',{simple:true}),'items:',c.prepare('select count(*) n from items').get().n);c.close()})" "$DB" "$OUT"`;
export const ONE_LINER_RESTORE =
  `node -e "const D=require('better-sqlite3');const s=new D(process.argv[1],{readonly:true});const ok=s.pragma('integrity_check',{simple:true});if(ok!=='ok'){console.error('SNAPSHOT CORRUPT',ok);process.exit(1)}s.backup(process.argv[2]).then(()=>{s.close();const c=new D(process.argv[2]);console.log('restored. integrity_check:',c.pragma('integrity_check',{simple:true}),'items:',c.prepare('select count(*) n from items').get().n);c.close()})" "$SNAP" "$DB"`;
