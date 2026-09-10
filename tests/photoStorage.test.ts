import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  savePhotoBuffer,
  saveBase64Photo,
  UPLOADS_DIR,
} from '../server/services/photoService';

describe('Content-Addressable Photo Storage Service', () => {
  it('saves binary photo buffers and deduplicates identical content by SHA-256 hash', () => {
    const sampleImageContent = Buffer.from('SAAZ_AURA_JEWELRY_IMAGE_TEST_BINARY_DATA');

    const result1 = savePhotoBuffer(sampleImageContent, 'sample_necklace.jpg');
    expect(result1.url).toMatch(/^\/api\/photos\/[a-f0-9]{16}\.jpg$/);
    expect(result1.hash.length).toBe(64); // SHA-256 length

    const filePath = path.join(UPLOADS_DIR, result1.filename);
    expect(fs.existsSync(filePath)).toBe(true);

    // Save exact same buffer a second time (should deduplicate without error)
    const result2 = savePhotoBuffer(sampleImageContent, 'duplicate_necklace.jpg');
    expect(result2.url).toBe(result1.url);
    expect(result2.hash).toBe(result1.hash);
    expect(result2.filename).toBe(result1.filename);
  });

  it('correctly handles base64 data URLs and ignores non-base64 image URLs', () => {
    // 1x1 transparent GIF base64
    const validDataUrl =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    const saved = saveBase64Photo(validDataUrl);
    expect(saved).not.toBeNull();
    expect(saved?.url).toMatch(/^\/api\/photos\/[a-f0-9]{16}\.gif$/);

    // Existing URL pass-through
    const alreadyStored = saveBase64Photo('/api/photos/abcdef1234567890.webp');
    expect(alreadyStored?.url).toBe('/api/photos/abcdef1234567890.webp');

    // Invalid format returns null
    const invalid = saveBase64Photo('not-a-valid-data-url');
    expect(invalid).toBeNull();
  });

  it('self-heals and re-creates missing disk file from SQLite photo_blobs table (Railway rebuild simulation)', async () => {
    const { getPhoto, restorePhoto, getPhotoStorageStats } = await import('../server/services/photoService');
    const testContent = Buffer.from('RAILWAY_REBUILD_PERSISTENCE_TEST_BYTES');
    const saved = savePhotoBuffer(testContent, 'resilience_test.webp');

    const diskPath = path.join(UPLOADS_DIR, saved.filename);
    expect(fs.existsSync(diskPath)).toBe(true);

    // Simulate Railway container rebuild wiping the ephemeral disk
    fs.unlinkSync(diskPath);
    expect(fs.existsSync(diskPath)).toBe(false);

    // getPhoto should detect disk miss, pull from SQLite photo_blobs, re-write to disk, and return buffer
    const recovered = getPhoto(saved.filename);
    expect(recovered).not.toBeNull();
    expect(recovered?.buffer.toString()).toBe('RAILWAY_REBUILD_PERSISTENCE_TEST_BYTES');
    expect(recovered?.mimeType).toBe('image/webp');

    // Verify disk cache was re-hydrated
    expect(fs.existsSync(diskPath)).toBe(true);

    // Test storage stats diagnostic
    const stats = getPhotoStorageStats();
    expect(stats.dbBlobCount).toBeGreaterThanOrEqual(1);
    expect(stats.diskFileCount).toBeGreaterThanOrEqual(1);
  });
});

