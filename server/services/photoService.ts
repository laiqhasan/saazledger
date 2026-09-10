import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { db, DATA_DIR } from '../db/database';
import { getMediaStorageSettings } from './media/storageProvider';
import { S3StorageAdapter } from './media/s3Adapter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Legacy directory for backwards compatibility with existing local setups
export const LEGACY_UPLOADS_DIR = path.resolve(__dirname, '../../uploads/photos');
export const LEGACY_DERIVATIVES_DIR = path.join(LEGACY_UPLOADS_DIR, 'derivatives');

// Persistent uploads directory inside DATA_DIR (persists across Railway Volume mounts)
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads/photos');
export const DERIVATIVES_DIR = path.join(UPLOADS_DIR, 'derivatives');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(DERIVATIVES_DIR)) {
  fs.mkdirSync(DERIVATIVES_DIR, { recursive: true });
}

// Also ensure legacy directory exists for any legacy references
if (!fs.existsSync(LEGACY_UPLOADS_DIR)) {
  try {
    fs.mkdirSync(LEGACY_UPLOADS_DIR, { recursive: true });
  } catch {}
}
if (!fs.existsSync(LEGACY_DERIVATIVES_DIR)) {
  try {
    fs.mkdirSync(LEGACY_DERIVATIVES_DIR, { recursive: true });
  } catch {}
}

/**
 * Asynchronously replicates an image to AWS S3 if S3 credentials and bucket are configured
 */
export async function syncPhotoToS3(
  filename: string,
  buffer: Buffer,
  mimeType = 'image/jpeg'
): Promise<string | null> {
  try {
    const settings = getMediaStorageSettings();
    const hasBucket = Boolean(settings.s3?.bucket || process.env.AWS_S3_BUCKET);
    const hasKey = Boolean(settings.s3?.accessKeyId || process.env.AWS_ACCESS_KEY_ID);
    const hasSecret = Boolean(settings.s3?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY);

    if (!hasBucket || !hasKey || !hasSecret) {
      return null;
    }

    const adapter = new S3StorageAdapter(settings.s3);
    const prefix = settings.s3.prefix ? `${settings.s3.prefix.replace(/^\/+|\/+$/g, '')}/` : '';
    const objectKey = `${prefix}photos/${filename}`;

    const url = await adapter.uploadBufferDirect(buffer, objectKey, mimeType);
    console.log(`[PhotoService] Synced photo to AWS S3: ${url}`);
    return url;
  } catch (err: any) {
    console.warn(`[PhotoService] S3 sync skipped/failed for ${filename}:`, err.message);
    return null;
  }
}

/**
 * Uploads all existing local photos in uploads/photos/ to AWS S3
 */
export async function syncAllPhotosToS3(): Promise<{ count: number; failed: number }> {
  const settings = getMediaStorageSettings();
  if (!settings.s3?.bucket) {
    throw new Error('S3 bucket name is not configured.');
  }

  const targetDirs = [UPLOADS_DIR, LEGACY_UPLOADS_DIR];
  const seenFiles = new Set<string>();
  let count = 0;
  let failed = 0;

  for (const dir of targetDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    for (const file of files) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);

      const filePath = path.join(dir, file);
      try {
        if (!fs.statSync(filePath).isFile()) continue;
        const buffer = fs.readFileSync(filePath);
        const ext = path.extname(file).toLowerCase();
        let mimeType = 'image/jpeg';
        if (ext === '.png') mimeType = 'image/png';
        if (ext === '.webp') mimeType = 'image/webp';
        if (ext === '.gif') mimeType = 'image/gif';

        const s3Url = await syncPhotoToS3(file, buffer, mimeType);
        if (s3Url) {
          count++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
  }

  return { count, failed };
}

/**
 * Saves a buffer to disk using SHA-256 content-addressable naming.
 * Also persists to SQLite photo_blobs table for self-healing across Railway container rebuilds.
 * Also asynchronously replicates to AWS S3 if enabled.
 */
export function savePhotoBuffer(
  buffer: Buffer,
  originalFilename?: string
): { url: string; hash: string; filename: string } {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Determine extension
  let ext = '.webp';
  if (originalFilename) {
    const parsedExt = path.extname(originalFilename).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(parsedExt)) {
      ext = parsedExt;
    }
  }

  const filename = `${hash.slice(0, 16)}${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  const legacyFilePath = path.join(LEGACY_UPLOADS_DIR, filename);

  // 1. Write to persistent UPLOADS_DIR
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }
  // Also write to legacy path if different so legacy code can find it
  if (legacyFilePath !== filePath && !fs.existsSync(legacyFilePath)) {
    try {
      fs.writeFileSync(legacyFilePath, buffer);
    } catch {}
  }

  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';

  // 2. Persist to SQLite DB photo_blobs table (protects against container wipe)
  try {
    db.prepare(`
      INSERT OR REPLACE INTO photo_blobs (filename, mime_type, data, file_size)
      VALUES (?, ?, ?, ?)
    `).run(filename, mimeType, buffer, buffer.length);
  } catch (err: any) {
    console.warn(`[PhotoService] Failed to persist photo blob to SQLite:`, err?.message);
  }

  // 3. Asynchronously replicate to S3 in the background
  syncPhotoToS3(filename, buffer, mimeType).catch(() => {});

  return {
    url: `/api/photos/${filename}`,
    hash,
    filename,
  };
}

/**
 * Saves a base64 data URL (e.g. from canvas or camera) to disk, DB, and S3
 */
export function saveBase64Photo(dataUrl: string): { url: string; hash: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    if (dataUrl.startsWith('/api/photos/') || dataUrl.startsWith('http')) {
      return { url: dataUrl, hash: '' };
    }
    return null;
  }

  const mimeType = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');

  let ext = '.webp';
  if (mimeType.includes('png')) ext = '.png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = '.jpg';
  if (mimeType.includes('gif')) ext = '.gif';
  if (mimeType.includes('webp')) ext = '.webp';

  const res = savePhotoBuffer(buffer, `upload${ext}`);
  return { url: res.url, hash: res.hash };
}

/**
 * Retrieves a photo by filename with complete self-healing:
 * 1. Checks primary UPLOADS_DIR (fastest disk read).
 * 2. Checks legacy directory (copies forward to primary if found).
 * 3. Checks SQLite photo_blobs table (re-hydrates disk cache and serves immediately).
 */
export function getPhoto(filename: string): { buffer: Buffer; mimeType: string } | null {
  const sanitized = path.basename(filename);
  const ext = path.extname(sanitized).toLowerCase();
  const defaultMimeType =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
      ? 'image/webp'
      : ext === '.gif'
      ? 'image/gif'
      : 'image/jpeg';

  // 1. Check primary UPLOADS_DIR
  const primaryPath = path.join(UPLOADS_DIR, sanitized);
  if (fs.existsSync(primaryPath)) {
    try {
      const buffer = fs.readFileSync(primaryPath);
      return { buffer, mimeType: defaultMimeType };
    } catch {}
  }

  // 2. Check legacy UPLOADS_DIR (if different)
  if (LEGACY_UPLOADS_DIR !== UPLOADS_DIR) {
    const legacyPath = path.join(LEGACY_UPLOADS_DIR, sanitized);
    if (fs.existsSync(legacyPath)) {
      try {
        const buffer = fs.readFileSync(legacyPath);
        // Self-heal: copy to primary UPLOADS_DIR and insert into DB
        try {
          fs.writeFileSync(primaryPath, buffer);
        } catch {}
        try {
          db.prepare(`INSERT OR IGNORE INTO photo_blobs (filename, mime_type, data, file_size) VALUES (?, ?, ?, ?)`).run(
            sanitized,
            defaultMimeType,
            buffer,
            buffer.length
          );
        } catch {}
        return { buffer, mimeType: defaultMimeType };
      } catch {}
    }
  }

  // 3. Fallback to SQLite DB photo_blobs (restores wiped container disk)
  try {
    const row = db
      .prepare('SELECT mime_type, data FROM photo_blobs WHERE filename = ?')
      .get(sanitized) as { mime_type: string; data: Buffer } | undefined;

    if (row && row.data) {
      // Re-hydrate disk cache for subsequent lightning-fast requests
      try {
        fs.writeFileSync(primaryPath, row.data);
      } catch {}
      return { buffer: row.data, mimeType: row.mime_type || defaultMimeType };
    }
  } catch (err: any) {
    console.warn(`[PhotoService] DB query failed for photo ${sanitized}:`, err?.message);
  }

  // 4. Also check derivatives directory if not found in root uploads
  const derivMatch = getDerivative(sanitized);
  if (derivMatch) {
    return derivMatch;
  }

  return null;
}

/**
 * Saves a derivative image (e.g. 2048x2048 square master, model lifestyle, social crops)
 * to DERIVATIVES_DIR and persists to SQLite photo_blobs table for 100% durability.
 */
export function saveDerivativeBuffer(
  buffer: Buffer,
  outputFilename: string
): { url: string; filename: string } {
  const sanitized = path.basename(outputFilename);
  const ext = path.extname(sanitized).toLowerCase();
  const mimeType =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
      ? 'image/webp'
      : ext === '.gif'
      ? 'image/gif'
      : 'image/jpeg';

  const primaryPath = path.join(DERIVATIVES_DIR, sanitized);
  const legacyPath = path.join(LEGACY_DERIVATIVES_DIR, sanitized);

  try {
    fs.writeFileSync(primaryPath, buffer);
  } catch (err: any) {
    console.warn(`[PhotoService] Failed writing derivative to primary path:`, err?.message);
  }
  if (legacyPath !== primaryPath) {
    try {
      fs.writeFileSync(legacyPath, buffer);
    } catch {}
  }

  // Persist to DB under both 'derivatives/filename' and 'filename'
  try {
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO photo_blobs (filename, mime_type, data, file_size)
      VALUES (?, ?, ?, ?)
    `);
    insertStmt.run(`derivatives/${sanitized}`, mimeType, buffer, buffer.length);
    insertStmt.run(sanitized, mimeType, buffer, buffer.length);
  } catch (err: any) {
    console.warn(`[PhotoService] Failed persisting derivative blob to SQLite:`, err?.message);
  }

  return {
    url: `/api/photos/derivatives/${sanitized}`,
    filename: sanitized,
  };
}

/**
 * Retrieves a derivative image from DERIVATIVES_DIR, legacy dir, or SQLite photo_blobs
 */
export function getDerivative(filename: string): { buffer: Buffer; mimeType: string } | null {
  const sanitized = path.basename(filename);
  const ext = path.extname(sanitized).toLowerCase();
  const defaultMimeType =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
      ? 'image/webp'
      : ext === '.gif'
      ? 'image/gif'
      : 'image/jpeg';

  // 1. Check primary DERIVATIVES_DIR
  const primaryPath = path.join(DERIVATIVES_DIR, sanitized);
  if (fs.existsSync(primaryPath)) {
    try {
      const buffer = fs.readFileSync(primaryPath);
      return { buffer, mimeType: defaultMimeType };
    } catch {}
  }

  // 2. Check legacy DERIVATIVES_DIR
  if (LEGACY_DERIVATIVES_DIR !== DERIVATIVES_DIR) {
    const legacyPath = path.join(LEGACY_DERIVATIVES_DIR, sanitized);
    if (fs.existsSync(legacyPath)) {
      try {
        const buffer = fs.readFileSync(legacyPath);
        try {
          fs.writeFileSync(primaryPath, buffer);
        } catch {}
        try {
          db.prepare(`INSERT OR IGNORE INTO photo_blobs (filename, mime_type, data, file_size) VALUES (?, ?, ?, ?)`).run(
            `derivatives/${sanitized}`,
            defaultMimeType,
            buffer,
            buffer.length
          );
        } catch {}
        return { buffer, mimeType: defaultMimeType };
      } catch {}
    }
  }

  // 3. Fallback to SQLite DB photo_blobs
  try {
    const row = (db
      .prepare('SELECT mime_type, data FROM photo_blobs WHERE filename = ? OR filename = ?')
      .get(`derivatives/${sanitized}`, sanitized)) as { mime_type: string; data: Buffer } | undefined;

    if (row && row.data) {
      try {
        fs.writeFileSync(primaryPath, row.data);
      } catch {}
      return { buffer: row.data, mimeType: row.mime_type || defaultMimeType };
    }
  } catch (err: any) {
    console.warn(`[PhotoService] DB query failed for derivative ${sanitized}:`, err?.message);
  }

  return null;
}


/**
 * Restores a photo buffer directly into disk and database
 */
export function restorePhoto(
  filename: string,
  base64OrBuffer: string | Buffer,
  mimeType?: string
): { success: boolean; url: string } {
  const sanitized = path.basename(filename);
  let buffer: Buffer;
  let resolvedMimeType = mimeType || 'image/jpeg';

  if (typeof base64OrBuffer === 'string') {
    const match = base64OrBuffer.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      resolvedMimeType = match[1];
      buffer = Buffer.from(match[2], 'base64');
    } else {
      buffer = Buffer.from(base64OrBuffer, 'base64');
    }
  } else {
    buffer = base64OrBuffer;
  }

  const primaryPath = path.join(UPLOADS_DIR, sanitized);
  try {
    fs.writeFileSync(primaryPath, buffer);
  } catch (err: any) {
    console.warn(`[PhotoService] Failed writing restored photo to disk:`, err?.message);
  }

  try {
    db.prepare(`
      INSERT OR REPLACE INTO photo_blobs (filename, mime_type, data, file_size)
      VALUES (?, ?, ?, ?)
    `).run(sanitized, resolvedMimeType, buffer, buffer.length);
  } catch (err: any) {
    console.warn(`[PhotoService] Failed writing restored photo to DB:`, err?.message);
  }

  return { success: true, url: `/api/photos/${sanitized}` };
}

/**
 * Get storage statistics and health diagnostics
 */
export function getPhotoStorageStats(): {
  uploadsDir: string;
  isVolumeMounted: boolean;
  diskFileCount: number;
  dbBlobCount: number;
  dbTotalBytes: number;
} {
  let diskFileCount = 0;
  if (fs.existsSync(UPLOADS_DIR)) {
    try {
      diskFileCount = fs.readdirSync(UPLOADS_DIR).filter((f) => !f.startsWith('.')).length;
    } catch {}
  }

  let dbBlobCount = 0;
  let dbTotalBytes = 0;
  try {
    const stat = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as totalBytes FROM photo_blobs').get() as {
      count: number;
      totalBytes: number;
    };
    if (stat) {
      dbBlobCount = stat.count;
      dbTotalBytes = stat.totalBytes;
    }
  } catch {}

  const isVolumeMounted = Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR);

  return {
    uploadsDir: UPLOADS_DIR,
    isVolumeMounted,
    diskFileCount,
    dbBlobCount,
    dbTotalBytes,
  };
}
