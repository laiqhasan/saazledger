import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolated temp DB (never touches the real data dir)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-reliable-save-'));
process.env.DATA_DIR = tmpDir;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

let db: any;
let svc: typeof import('../server/services/inventoryService');

const baseInput = {
  title: 'Reliable Test Necklace',
  typeCode: 'NK',
  stoneCode: 'Z',
  colorCode: '09',
  buyingPrice: 100,
  sellingPrice: 300,
  quantity: 4,
};

beforeAll(async () => {
  ({ db } = await import('../server/db/database'));
  svc = await import('../server/services/inventoryService');
});

afterAll(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Reliable inventory saving (server)', () => {
  it('new item: create then read back from server (getItemById + verify report)', () => {
    const { item, created } = svc.createItemIdempotent({ ...baseInput, clientItemId: 'cli_readback' });
    expect(created).toBe(true);
    const stored = svc.getItemById(item.id);
    expect(stored?.sku).toBe(item.sku);
    const report = svc.getItemVerification(item.id)!;
    expect(report.id).toBe(item.id);
    expect(report.stored.title).toBe('Reliable Test Necklace');
    expect(report.item.clientItemId).toBe('cli_readback');
    expect(report.counts.totalLinks).toBe(0);
    expect(svc.getItemVerification('does-not-exist')).toBeNull();
  });

  it('idempotency: same clientItemId twice (retry / double-click) yields exactly one item', () => {
    const a = svc.createItemIdempotent({ ...baseInput, clientItemId: 'cli_double' });
    const b = svc.createItemIdempotent({ ...baseInput, clientItemId: 'cli_double' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.sku).toBe(a.item.sku);
    const count = (db.prepare('SELECT COUNT(*) c FROM items WHERE client_item_id = ?').get('cli_double') as any).c;
    expect(count).toBe(1);
    const lots = (db.prepare('SELECT COUNT(*) c FROM purchase_lots WHERE item_id = ?').get(a.item.id) as any).c;
    expect(lots).toBe(1);
  });

  it('duplicate SKU guard: a reserved SKU already used by another item is rejected', () => {
    const first = svc.createItemIdempotent({ ...baseInput, clientItemId: 'cli_sku_a', sku: 'ZZZ-00001', serial: '00001' });
    expect(first.item.sku).toBe('ZZZ-00001');
    expect(() => svc.createItemIdempotent({ ...baseInput, clientItemId: 'cli_sku_b', sku: 'ZZZ-00001' })).toThrow(/already belongs/);
    const replay = svc.createItemIdempotent({ ...baseInput, clientItemId: 'cli_sku_a', sku: 'ZZZ-00001' });
    expect(replay.created).toBe(false);
  });

  it('invalid create is rejected (nothing stored)', () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c;
    expect(() => svc.createItemIdempotent({ ...baseInput, title: '  ', clientItemId: 'cli_bad' })).toThrow();
    expect((db.prepare('SELECT COUNT(*) c FROM items').get() as any).c).toBe(before);
  });

  it('update preserves original photo, white-bg photo and gallery/media links', () => {
    const { item } = svc.createItemIdempotent({
      ...baseInput,
      clientItemId: 'cli_media',
      imageUrl: '/uploads/main.jpg',
      originalImageUrl: '/uploads/original.jpg',
      whiteBgImageUrl: '/uploads/white.jpg',
    });
    db.prepare(`INSERT INTO media_assets (id, original_filename, display_title, mime_type, byte_size, checksum_sha256,
      upload_source, media_type, classification, processing_status, approval_status, file_role)
      VALUES ('m1','a.jpg','A','image/jpeg',10,'sum1','web_upload','image','ai_generated','ready','approved','gallery')`).run();
    db.prepare(`INSERT INTO media_storage_locations (id, media_id, provider, storage_role, storage_key, public_delivery_url, replication_status)
      VALUES ('l1','m1','local_disk','primary','k1','/media/a.jpg','synced')`).run();
    db.prepare(`INSERT INTO product_media_links (id, product_id, media_id, slot_type, display_order, is_cover)
      VALUES ('pml1', ?, 'm1', 'cover', 0, 1)`).run(item.id);

    // edit form sends blank photo fields + a changed title/price
    const updated = svc.updateItem(item.id, { title: 'Renamed', sellingPrice: 999, imageUrl: '', originalImageUrl: '', whiteBgImageUrl: undefined })!;
    expect(updated.title).toBe('Renamed');
    expect(updated.selling_price).toBe(999);
    expect(updated.image_url).toBe('/uploads/main.jpg');
    expect(updated.original_image_url).toBe('/uploads/original.jpg');
    expect(updated.white_bg_image_url).toBe('/uploads/white.jpg');
    expect(updated.client_item_id).toBe('cli_media');

    const dto = svc.itemRecordToJewelryItem(updated);
    expect(dto.originalImageUrl).toBe('/uploads/original.jpg');
    expect(dto.whiteBgImageUrl).toBe('/uploads/white.jpg');

    const report = svc.getItemVerification(item.id)!;
    expect(report.counts.totalLinks).toBe(1);
    expect(report.counts.byRole.gallery).toBe(1);
    expect(report.media[0].url).toBe('/media/a.jpg');
    expect(report.media[0].is_cover).toBe(true);
    expect(report.counts.hasOriginalImage).toBe(true);

    // a real new photo does replace the stored one
    expect(svc.updateItem(item.id, { imageUrl: '/uploads/new.jpg' })!.image_url).toBe('/uploads/new.jpg');
  });

  it('updateItem on unknown id returns undefined (route maps to 404; create never goes through update)', () => {
    expect(svc.updateItem('item-brand-new-client-id', { title: 'x' })).toBeUndefined();
  });
});
