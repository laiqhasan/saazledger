import type { Express, Request, RequestHandler } from 'express';
import path from 'node:path';
import { db, DATA_DIR } from '../db/database';
import { BackupError, buildPhotoManifest, createDbSnapshot, listBackups, type SnapshotMethod } from '../services/backupService';

/**
 * Admin-only backup endpoints. They never stream a file: the response is metadata only, the snapshot stays on the
 * server volume (`<DATA_DIR>/backups`) and is retrieved out-of-band (see docs/backup-and-rollback.md).
 *
 *   GET  /api/admin/backup/db               list snapshots (metadata only)
 *   POST /api/admin/backup/db               create a consistent snapshot + photo manifest, returns metadata + integrity_check
 *   GET  /api/admin/backup/photos-manifest  live photo inventory (count/bytes/sha256) without writing anything
 *
 * Creation is POST (not GET) on purpose: it writes a file, so it must not be triggerable by link prefetch / <img src>.
 *
 * TODO(auth agent): pass `requireRole('admin')` as `requireAdmin` when it lands, e.g.
 *   registerBackupRoutes(app, authenticateToken, requireRole('admin'));
 * Until then `localAdminCheck` below enforces req.user.role === 'admin' after `auth` ran. NOTE: the legacy
 * authenticateToken passes requests WITHOUT a token through as a local admin, so this is only as strong as the
 * auth middleware it is mounted behind.
 */
export const localAdminCheck: RequestHandler = (req, res, next) => {
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  if (role !== 'admin') return res.status(403).json({ error: 'Admin role required.' });
  next();
};

export interface BackupRouteOptions {
  dataDir?: string;
  uploadsDir?: string;
  database?: typeof db;
  minIntervalMs?: number;
}

export function registerBackupRoutes(app: Express, auth: RequestHandler, requireAdmin: RequestHandler = localAdminCheck, opts: BackupRouteOptions = {}): void {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const uploadsDir = opts.uploadsDir ?? path.join(dataDir, 'uploads', 'photos');
  const database = opts.database ?? db;
  const fail = (res: any, err: any) => {
    if (err instanceof BackupError) return res.status(err.status).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: err?.message || 'Backup error' });
  };

  app.get('/api/admin/backup/db', auth, requireAdmin, (_req, res) => {
    try { res.json({ dataDir, backups: listBackups(dataDir) }); } catch (err) { fail(res, err); }
  });

  app.post('/api/admin/backup/db', auth, requireAdmin, async (req, res) => {
    try {
      const method: SnapshotMethod = req.body?.method === 'vacuum' ? 'vacuum' : 'backup';
      const result = await createDbSnapshot({
        db: database, dataDir, uploadsDir, method, label: req.body?.label, minIntervalMs: opts.minIntervalMs ?? 5000,
      });
      // Never leak absolute server paths beyond the backups dir name.
      res.status(result.ok ? 201 : 500).json({ ...result, file: path.basename(result.file), photos: result.photos && { ...result.photos, manifestFile: path.basename(result.photos.manifestFile) }, location: `${path.join(dataDir, 'backups')}` });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/admin/backup/photos-manifest', auth, requireAdmin, (_req, res) => {
    try {
      const m = buildPhotoManifest(uploadsDir);
      res.json({ generatedAt: m.generatedAt, fileCount: m.fileCount, totalBytes: m.totalBytes, files: m.files });
    } catch (err) { fail(res, err); }
  });
}
