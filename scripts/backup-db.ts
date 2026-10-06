/**
 * Consistent SQLite snapshot + photo manifest, usable on the server (NOT via `railway run`, which executes on your
 * own computer and cannot see the /data volume; use `railway ssh`).
 *
 *   npx tsx scripts/backup-db.ts [--label pre-release] [--method backup|vacuum] [--data-dir /data]
 *
 * Data dir resolution matches the app: --data-dir, else RAILWAY_VOLUME_MOUNT_PATH, else DATA_DIR, else ./data.
 * Never modifies the live DB (opens it, runs the online-backup API, closes it). Prints JSON; exit code 0 only if
 * `PRAGMA integrity_check` returned "ok" on the snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDbSnapshot, type SnapshotMethod } from '../server/services/backupService';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dataDir = path.resolve(arg('data-dir') || process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.resolve(process.cwd(), 'data'));
  const dbPath = path.join(dataDir, 'saaz_ledger.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}. Wrong data dir? (set --data-dir, e.g. /data on Railway)`);
    process.exit(2);
  }
  const method = (arg('method') === 'vacuum' ? 'vacuum' : 'backup') as SnapshotMethod;
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 10000');
  try {
    const res = await createDbSnapshot({ db, dataDir, method, label: arg('label') });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  } finally {
    db.close();
  }
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
