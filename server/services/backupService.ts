/**
 * Consistent SQLite snapshots + photo manifest.
 *
 * Why not just `cp saaz_ledger.db`? The database runs in WAL mode: recent committed writes may live only
 * in `saaz_ledger.db-wal`, so a plain file copy taken while the app is running can be stale or torn.
 * SQLite's online backup API (better-sqlite3 `db.backup()`) and `VACUUM INTO` both produce a transactionally
 * consistent copy of the database as of one point in time, even while another connection is writing.
 *
 * This module is dependency-free apart from better-sqlite3 and never reads or writes anything outside
 * `<dataDir>/backups`. It does NOT delete files. It is used by routes/backupRoutes.ts and scripts/backup-db.ts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SnapshotMethod = 'backup' | 'vacuum';

export interface PhotoManifestEntry { path: string; bytes: number; sha256: string }
export interface PhotoManifest {
  generatedAt: string;
  uploadsDir: string;
  fileCount: number;
  totalBytes: number;
  files: PhotoManifestEntry[];
}

export interface SnapshotResult {
  ok: boolean;
  method: SnapshotMethod;
  file: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  integrityCheck: string[];
  foreignKeyViolations: number;
  journalModeOfSource: string;
  tableCounts: Record<string, number>;
  photos?: {
    manifestFile: string;
    manifestSha256: string;
    fileCount: number;
    totalBytes: number;
    dbPhotoBlobCount: number | null;
    /** photo_blobs rows (bytes live inside the DB snapshot) that have no file on disk. */
    blobsMissingOnDisk: string[];
    /** files on disk that have no photo_blobs row, i.e. photos whose only copy is the disk/volume. */
    filesWithoutBlob: string[];
  };
  warnings: string[];
}

export class BackupError extends Error {
  constructor(message: string, public status = 500, public code = 'BACKUP_FAILED') { super(message); }
}

export const BACKUP_SUBDIR = 'backups';
const KEY_TABLES = [
  'items', 'purchase_lots', 'stock_movements', 'vendors', 'users', 'sku_sequences', 'global_sku_sequence',
  'media_assets', 'product_media_links', 'photo_blobs', 'media_pack_drafts', 'deleted_skus', 'audit_logs',
];

export function backupsDir(dataDir: string): string { return path.join(dataDir, BACKUP_SUBDIR); }

export function sha256File(p: string): string {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', 'Z');
}

/** Recursive file listing with sha256, relative posix paths, sorted. Skips nothing: derivatives included. */
export function buildPhotoManifest(uploadsDir: string, now = new Date()): PhotoManifest {
  const files: PhotoManifestEntry[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files.push({ path: path.relative(uploadsDir, p).split(path.sep).join('/'), bytes: fs.statSync(p).size, sha256: sha256File(p) });
      }
    }
  };
  walk(uploadsDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { generatedAt: now.toISOString(), uploadsDir, fileCount: files.length, totalBytes: files.reduce((s, f) => s + f.bytes, 0), files };
}

/** Compare a stored manifest to what is on disk now: detects deleted / altered / unexpected photo files. */
export function verifyPhotoManifest(manifest: PhotoManifest, uploadsDir: string) {
  const current = new Map(buildPhotoManifest(uploadsDir).files.map((f) => [f.path, f]));
  const missing: string[] = []; const changed: string[] = [];
  for (const f of manifest.files) {
    const c = current.get(f.path);
    if (!c) missing.push(f.path); else if (c.sha256 !== f.sha256) changed.push(f.path);
  }
  const known = new Set(manifest.files.map((f) => f.path));
  const added = [...current.keys()].filter((k) => !known.has(k));
  return { ok: missing.length === 0 && changed.length === 0, missing, changed, added };
}

function integrity(dbPath: string) {
  const c = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = c.pragma('integrity_check') as { integrity_check: string }[];
    const fk = c.pragma('foreign_key_check') as unknown[];
    const counts: Record<string, number> = {};
    for (const t of KEY_TABLES) {
      const exists = c.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (exists) counts[t] = (c.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    }
    const blobNames = counts.photo_blobs !== undefined
      ? (c.prepare("SELECT filename FROM photo_blobs WHERE filename NOT LIKE 'derivatives/%'").all() as { filename: string }[]).map((r) => r.filename)
      : null;
    return { integrityCheck: rows.map((r) => r.integrity_check), fkViolations: fk.length, counts, blobNames };
  } finally { c.close(); }
}

let inFlight = false;
let lastRun = 0;

export interface SnapshotOptions {
  /** Open better-sqlite3 handle of the live DB (the app's own `db`, or a fresh handle in the CLI). */
  db: Database.Database;
  dataDir: string;
  /** Photo root to manifest. Default `<dataDir>/uploads/photos`. */
  uploadsDir?: string;
  method?: SnapshotMethod;
  label?: string;
  now?: Date;
  /** Refuse if a snapshot finished less than this many ms ago (route guard). Default 0 = no limit. */
  minIntervalMs?: number;
  /** Refuse to create more than this many snapshots (we never delete). Default 200. */
  maxFiles?: number;
}

/**
 * Create `<dataDir>/backups/saaz_ledger-<UTC stamp>[-label].db` plus `.photos-manifest.json`.
 * The file only becomes visible under its final name after integrity_check passed; a failed snapshot is kept
 * as `*.FAILED.db` for diagnosis and reported ok=false.
 */
export async function createDbSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const method = opts.method ?? 'backup';
  const now = opts.now ?? new Date();
  const dir = backupsDir(opts.dataDir);
  if (inFlight) throw new BackupError('A backup is already running.', 409, 'BACKUP_IN_PROGRESS');
  if (opts.minIntervalMs && Date.now() - lastRun < opts.minIntervalMs) {
    throw new BackupError('A backup was just taken; wait a few seconds before taking another.', 429, 'BACKUP_TOO_SOON');
  }
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => /^saaz_ledger-.*\.db$/.test(f)).length;
  if (existing >= (opts.maxFiles ?? 200)) throw new BackupError(`Backups directory already holds ${existing} snapshots; remove old ones manually first.`, 409, 'BACKUP_LIMIT');

  const label = opts.label ? '-' + String(opts.label).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) : '';
  const base = `saaz_ledger-${stamp(now)}${label}`;
  const finalPath = path.join(dir, `${base}.db`);
  const tmpPath = path.join(dir, `${base}.partial`);
  if (fs.existsSync(finalPath)) throw new BackupError('Snapshot file already exists for this timestamp.', 409, 'BACKUP_EXISTS');

  inFlight = true;
  try {
    const journalModeOfSource = String(opts.db.pragma('journal_mode', { simple: true }));
    if (method === 'backup') {
      await opts.db.backup(tmpPath);
    } else {
      opts.db.prepare('VACUUM INTO ?').run(tmpPath);
    }
    const chk = integrity(tmpPath);
    const ok = chk.integrityCheck.length === 1 && chk.integrityCheck[0] === 'ok';
    const warnings: string[] = [];
    if (chk.fkViolations > 0) warnings.push(`foreign_key_check reports ${chk.fkViolations} violation(s) (pre-existing in source data)`);
    const outPath = ok ? finalPath : path.join(dir, `${base}.FAILED.db`);
    fs.renameSync(tmpPath, outPath);
    for (const ext of ['-wal', '-shm']) { try { fs.rmSync(tmpPath + ext, { force: true }); } catch { /* none */ } }

    const result: SnapshotResult = {
      ok, method, file: outPath, bytes: fs.statSync(outPath).size, sha256: sha256File(outPath),
      createdAt: now.toISOString(), integrityCheck: chk.integrityCheck, foreignKeyViolations: chk.fkViolations,
      journalModeOfSource, tableCounts: chk.counts, warnings,
    };

    const uploadsDir = opts.uploadsDir ?? path.join(opts.dataDir, 'uploads', 'photos');
    const manifest = buildPhotoManifest(uploadsDir, now);
    const manifestFile = path.join(dir, `${base}.photos-manifest.json`);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const onDisk = new Set(manifest.files.map((f) => f.path));
    const blobNames = chk.blobNames;
    result.photos = {
      manifestFile, manifestSha256: sha256File(manifestFile), fileCount: manifest.fileCount, totalBytes: manifest.totalBytes,
      dbPhotoBlobCount: blobNames ? blobNames.length : null,
      blobsMissingOnDisk: blobNames ? blobNames.filter((n) => !onDisk.has(n)) : [],
      filesWithoutBlob: blobNames ? [...onDisk].filter((p) => !p.includes('/') && !blobNames.includes(p)) : [],
    };
    if (result.photos.blobsMissingOnDisk.length) warnings.push(`${result.photos.blobsMissingOnDisk.length} photo(s) exist only inside the DB snapshot (file missing on disk)`);
    if (result.photos.filesWithoutBlob.length) warnings.push(`${result.photos.filesWithoutBlob.length} photo file(s) on disk have no copy inside the DB; they are protected only by the volume/photo-manifest`);
    lastRun = Date.now();
    return result;
  } catch (err: any) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    if (err instanceof BackupError) throw err;
    throw new BackupError(`Snapshot failed: ${err?.message || err}`);
  } finally { inFlight = false; }
}

export interface BackupListEntry { file: string; bytes: number; modifiedAt: string; hasManifest: boolean }
export function listBackups(dataDir: string): BackupListEntry[] {
  const dir = backupsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^saaz_ledger-.*\.db$/.test(f)).sort().reverse().map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { file: f, bytes: st.size, modifiedAt: st.mtime.toISOString(), hasManifest: fs.existsSync(path.join(dir, f.replace(/\.db$/, '.photos-manifest.json'))) };
  });
}
