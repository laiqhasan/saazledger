import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getMediaStorageSettings } from './media/storageProvider';
import { S3StorageAdapter } from './media/s3Adapter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/photos');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
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

  const files = fs.readdirSync(UPLOADS_DIR).filter((f) => !f.startsWith('.'));
  let count = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = path.join(UPLOADS_DIR, file);
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

  return { count, failed };
}

/**
 * Saves a buffer to disk using SHA-256 content-addressable naming.
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

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }

  // Asynchronously replicate to S3 in the background
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  syncPhotoToS3(filename, buffer, mimeType).catch(() => {});

  return {
    url: `/api/photos/${filename}`,
    hash,
    filename,
  };
}

/**
 * Saves a base64 data URL (e.g. from canvas or camera) to disk and S3
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
