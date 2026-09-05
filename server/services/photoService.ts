import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/photos');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * Saves a buffer to disk using SHA-256 content-addressable naming.
 * Returns the public URL path and hash.
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

  return {
    url: `/api/photos/${filename}`,
    hash,
    filename,
  };
}

/**
 * Saves a base64 data URL (e.g. from canvas or camera) to disk
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
