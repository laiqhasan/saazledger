import { describe, it, expect } from 'vitest';
import { db } from '../server/db/database';
import {
  ingestMediaFile,
  getAllMediaAssets,
  getMediaAssetById,
  linkMediaToProduct,
  unlinkMediaFromProduct,
  reorderProductMedia,
  softDeleteMediaAsset,
  purgeMediaAsset,
} from '../server/services/media/mediaService';
import {
  getMediaStorageSettings,
  saveMediaStorageSettings,
} from '../server/services/media/storageProvider';
import { sniffFileFormat } from '../server/services/media/derivativeService';
import { LocalDiskStorageAdapter } from '../server/services/media/localDiskAdapter';
import { S3StorageAdapter } from '../server/services/media/s3Adapter';
import { GoogleDriveStorageAdapter } from '../server/services/media/googleDriveAdapter';

describe('Cloud Media Library Service (Feature 9)', () => {
  describe('File Format Sniffing & Magic Bytes', () => {
    it('accurately identifies JPEG, PNG, GIF, and WEBP files via magic bytes', () => {
      const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      expect(sniffFileFormat(jpegBuf, 'piece.jpg').mimeType).toBe('image/jpeg');

      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(sniffFileFormat(pngBuf, 'pendant.png').mimeType).toBe('image/png');

      const gifBuf = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00');
      expect(sniffFileFormat(gifBuf, 'ring.gif').mimeType).toBe('image/gif');

      const webpBuf = Buffer.from('RIFF\x20\x00\x00\x00WEBPVP8 ');
      expect(sniffFileFormat(webpBuf, 'earring.webp').mimeType).toBe('image/webp');
    });

    it('identifies HEIC and MOV formats for fallback handling', () => {
      const heicBuf = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
      ]);
      const heicFormat = sniffFileFormat(heicBuf, 'photo.heic');
      expect(heicFormat.isHeic).toBe(true);
      expect(heicFormat.canGeneratePreview).toBe(false);

      const movBuf = Buffer.from([
        0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
      ]);
      const movFormat = sniffFileFormat(movBuf, 'showcase.mov');
      expect(movFormat.isMov).toBe(true);
      expect(movFormat.category).toBe('video');
    });
  });

  describe('Direct Media Ingestion & SHA-256 Deduplication', () => {
    const testBuffer = Buffer.from('SAAZ_AURA_UNIQUE_KUNDAN_TEST_MEDIA_BYTES_' + Date.now());
    let createdAssetId: string;

    it('ingests a new media file with calculated SHA-256 and creates storage record', async () => {
      const result = await ingestMediaFile({
        buffer: testBuffer,
        originalFilename: 'kundan_necklace_hero.jpg',
        displayTitle: 'Kundan Hero Necklace',
        uploadSource: 'web_upload',
        slotType: 'cover',
      });

      expect(result.isDuplicate).toBe(false);
      expect(result.asset).toBeDefined();
      expect(result.asset.checksum_sha256).toBeDefined();
      expect(result.asset.checksum_sha256.length).toBe(64);
      expect(result.asset.byte_size).toBe(testBuffer.length);
      createdAssetId = result.asset.id;

      // Verify location stored
      const locations = db
        .prepare('SELECT * FROM media_storage_locations WHERE media_id = ?')
        .all(createdAssetId);
      expect(locations.length).toBeGreaterThan(0);
    });

    it('deduplicates identical file content without uploading or creating redundant records', async () => {
      const result = await ingestMediaFile({
        buffer: testBuffer, // exact same bytes
        originalFilename: 'duplicate_upload.jpg',
        displayTitle: 'Duplicate Attempt',
      });

      expect(result.isDuplicate).toBe(true);
      expect(result.duplicateAssetId).toBe(createdAssetId);
      expect(result.asset.id).toBe(createdAssetId);

      // Verify no duplicate row was created with this hash
      const countRow = db
        .prepare('SELECT COUNT(*) as cnt FROM media_assets WHERE checksum_sha256 = ?')
        .get(result.asset.checksum_sha256) as { cnt: number };
      expect(countRow.cnt).toBe(1);
    });

    it('retrieves asset by ID and lists via getAllMediaAssets', () => {
      const asset = getMediaAssetById(createdAssetId);
      expect(asset).not.toBeNull();
      expect(asset?.display_title).toBe('Kundan Hero Necklace');

      const { assets, totalCount } = getAllMediaAssets({ query: 'Kundan Hero' });
      expect(totalCount).toBeGreaterThanOrEqual(1);
      expect(assets.some((a) => a.id === createdAssetId)).toBe(true);
    });
  });

  describe('Product-Media Links & Cascade Protection', () => {
    const testBuffer = Buffer.from('SAAZ_AURA_CASCADE_PROTECTION_TEST_' + Date.now());
    let mediaId: string;
    const testProductId = 'item-1';

    it('links media asset to product with specific slot and display order', async () => {
      const ingest = await ingestMediaFile({
        buffer: testBuffer,
        originalFilename: 'ring_front.jpg',
        displayTitle: 'Polki Ring Front Angle',
        productId: testProductId,
        slotType: 'front',
      });
      mediaId = ingest.asset.id;

      const success = linkMediaToProduct({
        productId: testProductId,
        mediaId,
        slotType: 'front',
        displayOrder: 1,
        altText: 'Front angle showing center polki stone',
      });

      expect(success).toBe(true);

      const linkRow = db
        .prepare('SELECT * FROM product_media_links WHERE product_id = ? AND media_id = ?')
        .get(testProductId, mediaId) as any;
      expect(linkRow.product_id).toBe(testProductId);
      expect(linkRow.slot_type).toBe('front');
      expect(linkRow.alt_text).toBe('Front angle showing center polki stone');
    });

    it('supports reordering product media slots', () => {
      const success = reorderProductMedia(testProductId, [
        { mediaId, displayOrder: 10 },
      ]);
      expect(success).toBe(true);

      const linkRow = db
        .prepare('SELECT display_order FROM product_media_links WHERE product_id = ? AND media_id = ?')
        .get(testProductId, mediaId) as { display_order: number };
      expect(linkRow.display_order).toBe(10);
    });

    it('protects media asset from deletion when unlinked from a product', () => {
      // Unlink from product
      const unlinked = unlinkMediaFromProduct(testProductId, mediaId, 'front');
      expect(unlinked).toBe(true);

      // Verify link removed
      const linkCheck = db
        .prepare('SELECT COUNT(*) as cnt FROM product_media_links WHERE product_id = ? AND media_id = ?')
        .get(testProductId, mediaId) as { cnt: number };
      expect(linkCheck.cnt).toBe(0);

      // Verify MEDIA ASSET STILL EXISTS IN THE MEDIA LIBRARY!
      const asset = getMediaAssetById(mediaId);
      expect(asset).not.toBeNull();
      expect(asset?.is_deleted).toBe(0);
    });

    it('soft deletes and purges media assets cleanly', () => {
      // Soft delete
      const softDeleted = softDeleteMediaAsset(mediaId, 'test_user');
      expect(softDeleted).toBe(true);

      const afterSoft = getMediaAssetById(mediaId);
      expect(afterSoft?.is_deleted).toBe(1);

      // Normal listing should exclude soft-deleted assets
      const { assets } = getAllMediaAssets({ query: 'Polki Ring Front Angle' });
      expect(assets.some((a) => a.id === mediaId)).toBe(false);

      // Permanent purge
      const purged = purgeMediaAsset(mediaId);
      expect(purged).toBe(true);

      const afterPurge = getMediaAssetById(mediaId);
      expect(afterPurge).toBeNull();
    });
  });

  describe('Storage Adapters & Connection Health Probes', () => {
    it('local disk adapter tests health non-destructively and verifies content', async () => {
      const localAdapter = new LocalDiskStorageAdapter();
      const testResult = await localAdapter.testConnection();

      expect(testResult.provider).toBe('local_disk');
      expect(testResult.success).toBe(true);
      expect(testResult.latencyMs).toBeDefined();
    });

    it('S3 adapter probe gracefully handles unconfigured credentials with informative failure', async () => {
      const s3Adapter = new S3StorageAdapter({
        bucket: 'test-bucket',
        region: 'ap-south-1',
        prefix: 'saaz-ledger/media',
      });
      const testResult = await s3Adapter.testConnection();

      expect(testResult.provider).toBe('s3');
      // When AWS credentials are not set, probe should return failure without crashing
      expect(testResult.success).toBe(false);
      expect(testResult.message).toBeDefined();
    });

    it('Google Drive adapter probe gracefully handles unconfigured tokens with informative failure', async () => {
      const gdriveAdapter = new GoogleDriveStorageAdapter({
        folderId: 'sample-folder-id',
        tokenHealth: 'not_configured',
      });
      const testResult = await gdriveAdapter.testConnection();

      expect(testResult.provider).toBe('google_drive');
      expect(testResult.success).toBe(false);
      expect(testResult.message).toContain('credentials');
    });
  });

  describe('Media Storage Settings Persistence', () => {
    it('saves and reads back storage settings from system_settings table', () => {
      const originalSettings = getMediaStorageSettings();

      saveMediaStorageSettings({
        primaryProvider: 's3',
        backupEnabled: true,
        backupProvider: 'google_drive',
        s3: {
          bucket: 'saaz-media-vault',
          region: 'ap-south-1',
          prefix: 'saaz-ledger/photos',
        },
      });

      const updated = getMediaStorageSettings();
      expect(updated.primaryProvider).toBe('s3');
      expect(updated.backupEnabled).toBe(true);
      expect(updated.backupProvider).toBe('google_drive');
      expect(updated.s3.bucket).toBe('saaz-media-vault');

      // Revert back to local_disk to keep development environment clean
      saveMediaStorageSettings({
        primaryProvider: originalSettings.primaryProvider,
        backupEnabled: originalSettings.backupEnabled,
        backupProvider: originalSettings.backupProvider,
        s3: originalSettings.s3,
      });

      const reverted = getMediaStorageSettings();
      expect(reverted.primaryProvider).toBe(originalSettings.primaryProvider);
    });
  });
});
