/**
 * Restore a snapshot made by scripts/backup-db.ts (or `.backup()`) into the live database. Run on the server
 * (`railway ssh`), never via `railway run`.
 *
 *   npx tsx scripts/restore-db.ts --snapshot /data/backups/saaz_ledger-....db --sha256 <hash> --yes [--data-dir /data]
 *
 * Takes a PRE-RESTORE safety copy of the current DB first. Everything written after the snapshot is lost.
 * Make sure the code version that matches the snapshot's schema is the one running (roll the code back FIRST).
 */
import path from 'node:path';
import { restoreDbFromSnapshot } from '../server/services/backupService';

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; }

async function main() {
  const dataDir = path.resolve(arg('data-dir') || process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.resolve(process.cwd(), 'data'));
  const snapshotPath = arg('snapshot');
  if (!snapshotPath) { console.error('Usage: restore-db.ts --snapshot <file> [--sha256 <hash>] --yes [--data-dir <dir>]'); process.exit(2); }
  if (!process.argv.includes('--yes')) {
    console.error(`DRY RUN: would restore ${snapshotPath} over ${path.join(dataDir, 'saaz_ledger.db')}. Re-run with --yes to proceed.`);
    process.exit(3);
  }
  const res = await restoreDbFromSnapshot({ snapshotPath: path.resolve(snapshotPath), liveDbPath: path.join(dataDir, 'saaz_ledger.db'), dataDir, expectedSha256: arg('sha256') });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
