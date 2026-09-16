import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { savePhotoBuffer, getPhoto, UPLOADS_DIR } from '../server/services/photoService';
import { sniffFileFormat } from '../server/services/media/derivativeService';
import db from '../server/db/database';

describe('Supporting Media & S3 Archival Pipeline', () => {
  it('saves video files (.mp4, .mov, .webm) into photo storage and SQLite photo_blobs', () => {
    const videoBuffer = Buffer.from('TEST_MP4_VIDEO_STREAM_BYTES_SAAZ_AURA');
    const saved = savePhotoBuffer(videoBuffer, 'necklace_spin.mp4');

    expect(saved.url).toMatch(/^\/api\/photos\/[a-f0-9]{16}\.mp4$/);
    expect(saved.filename).toMatch(/\.mp4$/);

    const diskPath = path.join(UPLOADS_DIR, saved.filename);
    expect(fs.existsSync(diskPath)).toBe(true);

    const recovered = getPhoto(saved.filename);
    expect(recovered).not.toBeNull();
    expect(recovered?.buffer.toString()).toBe('TEST_MP4_VIDEO_STREAM_BYTES_SAAZ_AURA');
  });

  it('sniffs video MIME type and category for MP4, MOV, and WebM', () => {
    const fakeMp4 = Buffer.from('....ftypisom....');
    const sniffMp4 = sniffFileFormat(fakeMp4, 'pendant.mp4');
    expect(sniffMp4.category).toBe('video');
    expect(sniffMp4.mimeType).toBe('video/mp4');

    const fakeWebm = Buffer.from('test_webm_bytes');
    const sniffWebm = sniffFileFormat(fakeWebm, 'earrings.webm');
    expect(sniffWebm.category).toBe('video');
    expect(sniffWebm.mimeType).toBe('video/webm');

    const fakeMov = Buffer.from('test_mov_bytes');
    const sniffMov = sniffFileFormat(fakeMov, 'ring.mov');
    expect(sniffMov.category).toBe('video');
    expect(sniffMov.mimeType).toBe('video/quicktime');
  });

  it('persists s3_url, position, slot_title, and media_type in shopify_media_mappings', () => {
    const testProductId = `test_prod_${Date.now()}`;
    const testShopifyId = `shop_prod_${Date.now()}`;
    const medId1 = `med_${Date.now()}_1`;
    const medId2 = `med_${Date.now()}_2`;

    db.prepare(`
      INSERT INTO items (
        id, sku, title, type_code, stone_code, color_code, serial,
        buying_price, selling_price, quantity, date_added
      ) VALUES (?, ?, ?, 'NK', 'DI', 'YG', '001', 100, 200, 1, '2026-09-16')
    `).run(testProductId, `SKU_${Date.now()}`, 'Test Gold Necklace');

    db.prepare(`
      INSERT INTO media_assets (
        id, original_filename, display_title, checksum_sha256, byte_size, mime_type,
        upload_source, media_type, classification, processing_status, approval_status,
        is_deleted, created_at, updated_at
      ) VALUES (?, 'test1.jpg', 'Test 1', ?, 100, 'image/jpeg', 'web_upload', 'image', 'original', 'ready', 'approved', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(medId1, `chk_${Date.now()}_1`);

    db.prepare(`
      INSERT INTO media_assets (
        id, original_filename, display_title, checksum_sha256, byte_size, mime_type,
        upload_source, media_type, classification, processing_status, approval_status,
        is_deleted, created_at, updated_at
      ) VALUES (?, 'test2.mp4', 'Test 2', ?, 200, 'video/mp4', 'web_upload', 'video', 'original', 'ready', 'approved', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(medId2, `chk_${Date.now()}_2`);

    db.prepare(`
      INSERT OR REPLACE INTO shopify_media_mappings (
        id,
        media_id,
        product_id,
        shopify_product_id,
        shopify_media_id,
        shopify_image_url,
        s3_url,
        local_url,
        position,
        slot_title,
        media_type,
        filename,
        source_checksum_sha256,
        published_status,
        published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)
    `).run(
      `smm_test_1_${Date.now()}`,
      medId1,
      testProductId,
      testShopifyId,
      'shop_img_123',
      'https://cdn.shopify.com/s/files/1/0000/0001/products/hero.jpg',
      'https://saaz-media.s3.ap-south-1.amazonaws.com/shopify_published/p1/hero.jpg',
      '/api/photos/hero.jpg',
      1,
      'Slot 1: Commercial Cover',
      'image',
      'hero.jpg',
      'checksum1'
    );

    db.prepare(`
      INSERT OR REPLACE INTO shopify_media_mappings (
        id,
        media_id,
        product_id,
        shopify_product_id,
        shopify_media_id,
        shopify_image_url,
        s3_url,
        local_url,
        position,
        slot_title,
        media_type,
        filename,
        source_checksum_sha256,
        published_status,
        published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)
    `).run(
      `smm_test_2_${Date.now()}`,
      medId2,
      testProductId,
      testShopifyId,
      'shop_vid_456',
      '',
      'https://saaz-media.s3.ap-south-1.amazonaws.com/shopify_published/p1/spin.mp4',
      '/api/photos/spin.mp4',
      6,
      'Supporting Video',
      'video',
      'spin.mp4',
      'checksum2'
    );

    const rows = db.prepare(`
      SELECT 
        id,
        product_id,
        shopify_product_id,
        shopify_media_id,
        shopify_media_id AS shopify_image_id,
        shopify_image_url,
        s3_url,
        local_url,
        position,
        slot_title,
        media_type,
        filename,
        published_at AS synced_at
      FROM shopify_media_mappings
      WHERE product_id = ?
      ORDER BY position ASC
    `).all(testProductId) as any[];

    expect(rows.length).toBe(2);
    expect(rows[0].position).toBe(1);
    expect(rows[0].media_type).toBe('image');
    expect(rows[0].s3_url).toContain('https://saaz-media.s3.ap-south-1.amazonaws.com');
    expect(rows[0].slot_title).toBe('Slot 1: Commercial Cover');
    expect(rows[0].shopify_image_id).toBe('shop_img_123');
    expect(rows[0].synced_at).toBeDefined();

    expect(rows[1].position).toBe(6);
    expect(rows[1].media_type).toBe('video');
    expect(rows[1].s3_url).toContain('.mp4');
    expect(rows[1].slot_title).toBe('Supporting Video');
    expect(rows[1].shopify_image_id).toBe('shop_vid_456');
  });
});
