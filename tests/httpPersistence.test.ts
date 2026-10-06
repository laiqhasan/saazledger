/**
 * HTTP-level persistence verification on an ISOLATED database: the real express `app` is started on an
 * ephemeral port with a temp DATA_DIR / upload dir and real JWT auth, and every check goes over HTTP.
 * Nothing here touches ./data or ./uploads.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { seedTestUser } from './helpers/authTestUtils';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-http-persist-'));
const dataDir = path.join(tmpRoot, 'data');
const legacyUploads = path.join(tmpRoot, 'legacy-uploads');
fs.mkdirSync(dataDir, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.LEGACY_UPLOADS_DIR = legacyUploads;
process.env.JWT_SECRET = 'http-persistence-test-secret';
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;

let server: Server;
let base = '';
let db: any;
const token = jwt.sign({ id: 'usr_test_admin', username: 'test_admin', role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' });

async function boot() {
  vi.resetModules();
  const mod = await import('../server/server');
  ({ db } = await import('../server/db/database'));
  seedTestUser(db, 'usr_test_admin', 'admin'); // the API now loads the user from the DB on every request
  expect(mod.app).toBeDefined();
  await new Promise<void>((resolve) => {
    server = mod.app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function shutdown() {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { db.close(); } catch {}
}

async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// The pilot batch values
const fixture = {
  title: 'Pilot Batch Necklace',
  typeCode: 'NK',
  stoneCode: 'Z',
  colorCode: '09',
  buyingPrice: 500,
  sellingPrice: 1200,
  quantity: 5,
  imageUrl: '/api/photos/aaaaaaaaaaaaaaaa.jpg',
  originalImageUrl: '/api/photos/bbbbbbbbbbbbbbbb.jpg',
  whiteBgImageUrl: '/api/photos/cccccccccccccccc.jpg',
};

const counts = () => ({
  items: (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c,
  lots: (db.prepare('SELECT COUNT(*) c FROM purchase_lots').get() as any).c,
  moves: (db.prepare('SELECT COUNT(*) c FROM stock_movements').get() as any).c,
});

function pick(i: any) {
  return {
    id: i.id, sku: i.sku, buyingPrice: i.buyingPrice, sellingPrice: i.sellingPrice, quantity: i.quantity,
    imageUrl: i.imageUrl, originalImageUrl: i.originalImageUrl, whiteBgImageUrl: i.whiteBgImageUrl,
  };
}

beforeAll(boot);
afterAll(async () => {
  await shutdown();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('HTTP persistence on an isolated database', () => {
  let created: any;

  it('uses the temp DATA_DIR, never the repo data dir', async () => {
    const { DB_PATH } = await import('../server/db/database');
    expect(DB_PATH.startsWith(tmpRoot)).toBe(true);
  });

  it('(1) POST /api/inventory -> 201, then /verify and GET /api/inventory read back identical data', async () => {
    const r = await api('POST', '/api/inventory', { ...fixture, clientItemId: 'cli_http_1' });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(true);
    created = r.json.item;
    expect(created.quantity).toBe(5);
    expect(created.buyingPrice).toBe(500);
    expect(created.sellingPrice).toBe(1200);

    const v = await api('GET', `/api/inventory/${created.id}/verify`);
    expect(v.status).toBe(200);
    expect(pick(v.json.item)).toEqual(pick(created));
    expect(v.json.stored.quantity).toBe(5);
    expect(v.json.stored.buying_price).toBe(500);
    expect(v.json.stored.selling_price).toBe(1200);

    const list = await api('GET', '/api/inventory');
    const fromList = list.json.items.find((i: any) => i.id === created.id);
    expect(pick(fromList)).toEqual(pick(created));
    expect(fromList.originalImageUrl).toBe(fixture.originalImageUrl);
    expect(fromList.whiteBgImageUrl).toBe(fixture.whiteBgImageUrl);
  });

  it('(2) retrying the same POST (same clientItemId / Idempotency-Key) -> 200, same item, count unchanged', async () => {
    const before = counts();
    const r = await api('POST', '/api/inventory', { ...fixture, clientItemId: 'cli_http_1' });
    expect(r.status).toBe(200);
    expect(r.json.idempotentReplay).toBe(true);
    expect(r.json.item.id).toBe(created.id);
    expect(r.json.item.sku).toBe(created.sku);

    const viaHeader = await api('POST', '/api/inventory', { ...fixture }, { 'Idempotency-Key': 'cli_http_1' });
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.json.item.id).toBe(created.id);
    expect(counts()).toEqual(before);
  });

  it('(3) 5 concurrent identical POSTs (double-click) create exactly one item', async () => {
    const before = counts();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => api('POST', '/api/inventory', { ...fixture, title: 'Double Click Necklace', clientItemId: 'cli_http_dbl' }))
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(4);
    expect(new Set(rs.map((r) => r.json.item.id)).size).toBe(1);
    const after = counts();
    expect(after.items).toBe(before.items + 1);
    expect(after.lots).toBe(before.lots + 1);
    expect(after.moves).toBe(before.moves + 1);
    expect((db.prepare('SELECT COUNT(*) c FROM items WHERE client_item_id = ?').get('cli_http_dbl') as any).c).toBe(1);
  });

  it('(4) duplicate SKU with a different clientItemId -> 409 and nothing created', async () => {
    const before = counts();
    const r = await api('POST', '/api/inventory', { ...fixture, sku: created.sku, clientItemId: 'cli_http_dup_sku' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('DUPLICATE_SKU');
    expect(counts()).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) c FROM items WHERE client_item_id = ?').get('cli_http_dup_sku') as any).c).toBe(0);
  });

  it('(5) PUT update preserves original + white-bg photos and media links', async () => {
    db.prepare(`INSERT INTO media_assets (id, original_filename, display_title, mime_type, byte_size, checksum_sha256,
      upload_source, media_type, classification, processing_status, approval_status, file_role)
      VALUES ('m_http1','a.jpg','A','image/jpeg',10,'sum_http1','web_upload','image','ai_generated','ready','approved','gallery')`).run();
    db.prepare(`INSERT INTO media_storage_locations (id, media_id, provider, storage_role, storage_key, public_delivery_url, replication_status)
      VALUES ('l_http1','m_http1','local_disk','primary','k_http1','/media/a.jpg','synced')`).run();
    db.prepare(`INSERT INTO product_media_links (id, product_id, media_id, slot_type, display_order, is_cover)
      VALUES ('pml_http1', ?, 'm_http1', 'cover', 0, 1)`).run(created.id);

    const put = await api('PUT', `/api/inventory/${created.id}`, {
      title: 'Renamed Necklace', sellingPrice: 1300, imageUrl: '', originalImageUrl: '', whiteBgImageUrl: undefined,
    });
    expect(put.status).toBe(200);
    expect(put.json.item.title).toBe('Renamed Necklace');
    expect(put.json.item.sellingPrice).toBe(1300);
    expect(put.json.item.quantity).toBe(5);
    expect(put.json.item.buyingPrice).toBe(500);

    const v = await api('GET', `/api/inventory/${created.id}/verify`);
    expect(v.json.item.imageUrl).toBe(fixture.imageUrl);
    expect(v.json.item.originalImageUrl).toBe(fixture.originalImageUrl);
    expect(v.json.item.whiteBgImageUrl).toBe(fixture.whiteBgImageUrl);
    expect(v.json.counts.totalLinks).toBe(1);
    expect(v.json.media[0].url).toBe('/media/a.jpg');
    expect(v.json.media[0].is_cover).toBe(true);
    created = v.json.item;
  });

  it('(7) failed saves (invalid body) -> 4xx, nothing persisted, no half-written item', async () => {
    const before = counts();
    const noTitle = await api('POST', '/api/inventory', { ...fixture, title: '   ', clientItemId: 'cli_http_bad' });
    expect(noTitle.status).toBe(400);
    const empty = await api('POST', '/api/inventory', { clientItemId: 'cli_http_bad2' });
    expect(empty.status).toBe(400);
    const badType = await api('POST', '/api/inventory', { ...fixture, typeCode: 'NOT_A_TYPE_CODE_AT_ALL', stoneCode: '', colorCode: '', clientItemId: 'cli_http_bad3' });
    expect(badType.status).toBeGreaterThanOrEqual(400);
    expect(badType.status).toBeLessThan(500);
    expect(counts()).toEqual(before);
    for (const id of ['cli_http_bad', 'cli_http_bad2', 'cli_http_bad3']) {
      expect((db.prepare('SELECT COUNT(*) c FROM items WHERE client_item_id = ?').get(id) as any).c).toBe(0);
    }
    const missing = await api('PUT', '/api/inventory/does-not-exist', { title: 'x' });
    expect(missing.status).toBe(404);
    expect(counts()).toEqual(before);
  });

  describe('(8) media pack drafts', () => {
    const cid = 'cli_http_pack';
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const pack = {
      slots: [
        { slotNumber: 1, isCover: true, url: '/api/photos/1111111111111111.webp', productId: 'draft-x' },
        { slotNumber: 2, url: gif, productId: 'draft-x' },
      ],
      realPhotoCount: 2, aiModelCount: 0, warnings: [],
      originalAssets: [{ url: '/api/photos/bbbbbbbbbbbbbbbb.jpg' }],
      createdAt: '2026-10-06T00:00:00.000Z',
    };

    it('requires nothing but a valid id/pack; rejects bad input with 400', async () => {
      expect((await api('PUT', '/api/media-pack-drafts/bad id!', { pack })).status).toBe(400);
      expect((await api('PUT', `/api/media-pack-drafts/${cid}`, { pack: 'nope' })).status).toBe(400);
      expect((await api('GET', '/api/media-pack-drafts/never-saved')).status).toBe(404);
    });

    it('upsert is idempotent, stores URLs only (data: URLs moved to photo storage) and reads back', async () => {
      const a = await api('PUT', `/api/media-pack-drafts/${cid}`, { pack, sku: 'NKZ09-00001' });
      expect(a.status).toBe(201);
      expect(a.json.convertedDataUrls).toBe(1);
      const b = await api('PUT', `/api/media-pack-drafts/${cid}`, { pack, sku: 'NKZ09-00001' });
      expect(b.status).toBe(200);
      expect(b.json.created).toBe(false);
      expect(b.json.changed).toBe(false);
      expect((db.prepare('SELECT COUNT(*) c FROM media_pack_drafts WHERE client_item_id = ?').get(cid) as any).c).toBe(1);

      const raw = (db.prepare('SELECT pack_json, original_refs FROM media_pack_drafts WHERE client_item_id = ?').get(cid) as any);
      expect(raw.pack_json).not.toContain('base64');
      expect(raw.pack_json).not.toContain('data:');
      expect(JSON.parse(raw.original_refs)).toEqual(['/api/photos/bbbbbbbbbbbbbbbb.jpg']);

      const g = await api('GET', `/api/media-pack-drafts/${cid}`);
      expect(g.status).toBe(200);
      expect(g.json.draft.pack.slots[1].url).toMatch(/^\/api\/photos\/[a-f0-9]{16}\.gif$/);
      expect(g.json.draft.pack.slots[0].url).toBe('/api/photos/1111111111111111.webp');
      expect(g.json.draft.sku).toBe('NKZ09-00001');

      const l = await api('GET', '/api/media-pack-drafts');
      expect(l.json.drafts.map((d: any) => d.clientItemId)).toContain(cid);
      expect(l.json.drafts[0].pack).toBeUndefined();
      // converted image is really stored and served
      const img = await fetch(base + g.json.draft.pack.slots[1].url);
      expect(img.status).toBe(200);
    });

    it('rejects an oversized pack with 413 and a clear error, keeping the previous draft intact', async () => {
      const huge = { ...pack, notes: 'x'.repeat(2 * 1024 * 1024 + 10) };
      const r = await api('PUT', `/api/media-pack-drafts/${cid}`, { pack: huge });
      expect(r.status).toBe(413);
      expect(r.json.code).toBe('PACK_TOO_LARGE');
      expect(r.json.error).toMatch(/limit/i);
      const g = await api('GET', `/api/media-pack-drafts/${cid}`);
      expect(g.json.draft.pack.notes).toBeUndefined();
    });

    it('link-on-save: creating the item with that clientItemId attaches the draft to the server-issued id', async () => {
      const r = await api('POST', '/api/inventory', { ...fixture, title: 'Pack Necklace', clientItemId: cid });
      expect(r.status).toBe(201);
      expect(r.json.packDraftLinked).toBe(true);
      const g = await api('GET', `/api/media-pack-drafts/${cid}`);
      expect(g.json.draft.itemId).toBe(r.json.item.id);
      expect(g.json.draft.sku).toBe(r.json.item.sku);
      expect(g.json.draft.pack.productId).toBe(r.json.item.id);
      expect(g.json.draft.pack.slots[0].productId).toBe(r.json.item.id);
    });

    it('a draft saved after its item exists is linked immediately', async () => {
      const it = await api('POST', '/api/inventory', { ...fixture, title: 'Late Pack', clientItemId: 'cli_http_late' });
      const p = await api('PUT', '/api/media-pack-drafts/cli_http_late', { pack });
      expect(p.json.draft.itemId).toBe(it.json.item.id);
    });
  });

  it('(6) restart simulation: close DB + app, reopen on the same DATA_DIR, data and drafts still there', async () => {
    const list1 = (await api('GET', '/api/inventory')).json.items.map(pick).sort((a: any, b: any) => a.id.localeCompare(b.id));
    const draft1 = (await api('GET', '/api/media-pack-drafts/cli_http_pack')).json.draft;
    await shutdown();
    await boot();
    const list2 = (await api('GET', '/api/inventory')).json.items.map(pick).sort((a: any, b: any) => a.id.localeCompare(b.id));
    expect(list2).toEqual(list1);
    const item = list2.find((i: any) => i.id === created.id);
    expect(item.quantity).toBe(5);
    expect(item.buyingPrice).toBe(500);
    const v = await api('GET', `/api/inventory/${created.id}/verify`);
    // the startup migration may ADD a backfilled link for the main image, but the existing link must survive
    expect(v.json.media.map((m: any) => m.link_id)).toContain('pml_http1');
    const draft2 = (await api('GET', '/api/media-pack-drafts/cli_http_pack')).json.draft;
    expect(draft2).toEqual(draft1);
    // retry after restart is still idempotent
    const again = await api('POST', '/api/inventory', { ...fixture, clientItemId: 'cli_http_1' });
    expect(again.status).toBe(200);
    expect(again.json.item.id).toBe(created.id);
  });
});
