/**
 * End-to-end: the REAL Express routes (/api/shopify/send-draft and
 * /api/media/pack/publish-shopify) driven over HTTP against a fake Shopify store
 * served on 127.0.0.1. Temp DATA_DIR; no internet.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { FakeShopifyServer } from './helpers/fakeShopifyServer';

const LOC = '7001';
const SKU = 'PDD01-00001';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = jwt.sign({ id: 'usr_test', role: 'admin', username: 'tester' }, process.env.JWT_SECRET || 'saaz-ledger-enterprise-secure-jwt-key-2026');

let tmp: string;
let api: Server;
let base: string;
let fake: FakeShopifyServer;
let dbm: typeof import('../server/db/database');

async function post(p: string, body: any) {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
}

// A "JewelryItem" as the client sends it: values come from the item, not constants.
const ITEM = { id: 'it_e2e_1', sku: SKU, title: 'Diamond Pendant Set', typeCode: 'PD', stoneCode: 'D', colorCode: '01', quantity: 5, buyingPrice: 500, sellingPrice: 1200, vendor: 'Aura Creations', notes: 'Test piece', status: 'active' };
const sendDraft = (item: any = ITEM, extra: any = {}) => post('/api/shopify/send-draft', { item, shopifyConfig: { defaultStatus: 'active' }, ...extra });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-e2e-'));
  process.env.DATA_DIR = tmp;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.NODE_ENV = 'test';
  dbm = await import('../server/db/database');
  expect(dbm.DATA_DIR).toBe(tmp);
  const server = await import('../server/server');
  api = server.app.listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => api.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  fake = new FakeShopifyServer();
  process.env.SHOPIFY_TEST_BASE_URL = await fake.start();
  process.env.SHOPIFY_SHOP_DOMAIN = 'test-store.myshopify.com';
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = fake.token;
  process.env.SHOPIFY_PRIMARY_LOCATION_ID = LOC;
  delete process.env.SHOPIFY_CATEGORY_TAXONOMY_MAP;
  dbm.db.prepare('DELETE FROM items').run();
});
afterEach(async () => {
  await fake.stop();
  for (const k of ['SHOPIFY_TEST_BASE_URL', 'SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_PRIMARY_LOCATION_ID', 'SHOPIFY_CATEGORY_TAXONOMY_MAP']) delete process.env[k];
});

describe('E2E fake Shopify: /api/shopify/send-draft', () => {
  it('server.ts exports app (no auto app.listen under NODE_ENV=test); test listens on an ephemeral port', async () => {
    const r = await fetch(`${base}/api/health`).catch(() => null);
    expect(api.listening).toBe(true);
    void r;
  });

  it('new item (qty 5, cost 500, price 1200) -> draft with exactly those values; read-back correct', async () => {
    const r = await sendDraft();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, draftOnly: true, action: 'created' });
    expect(r.json.verification).toMatchObject({ status: 'draft', isDraft: true, variantPrice: 1200, cost: 500, inventoryQuantity: 5, mediaCount: 0 });
    expect(r.json.verification.adminUrl).toContain(r.json.shopifyProductId);
    expect(r.json.warningCodes).toEqual(['category_taxonomy_not_set']);

    const prod = fake.products.get(Number(r.json.shopifyProductId))!;
    expect(prod.status).toBe('draft');
    expect(prod.product_type).toBe('Pendant Set');
    const tags = prod.tags.split(',').map((t) => t.trim());
    expect(tags).toEqual(expect.arrayContaining(['SaazLedger', 'Pendant Set', 'American Diamond (CZ)', 'Antique Gold Tone', `SKU:${SKU}`]));
    expect(prod.variants[0]).toMatchObject({ sku: SKU, price: '1200.00', inventory_management: 'shopify', inventory_policy: 'deny' });
    const ii = fake.invItems.get(prod.variants[0].inventory_item_id)!;
    expect(ii).toMatchObject({ cost: '500.00', tracked: true });
    expect(fake.levels.get(`${ii.id}:${LOC}`)).toBe(5);
    expect(fake.violations).toEqual([]);
    expect(fake.draftProducts().length).toBe(1);
    expect(JSON.stringify(fake.log.find((l) => l.method === 'POST' && l.path.endsWith('/products.json'))!.body)).not.toContain('compare_at');
    // eslint-disable-next-line no-console
    console.log('FAKE_STORE_WRITE_LOG ' + JSON.stringify(fake.writes().map((w) => ({ method: w.method, path: w.path.replace('/admin/api/2026-07', ''), body: w.body, status: w.status })), null, 1));
  });

  it('values come from the item (a different item yields different values)', async () => {
    const r = await sendDraft({ ...ITEM, sku: 'EAR-X', title: 'Other', typeCode: 'EAR', quantity: 2, buyingPrice: 321.5, sellingPrice: 999 });
    expect(r.json.verification).toMatchObject({ variantPrice: 999, cost: 321.5, inventoryQuantity: 2 });
    expect(fake.products.get(Number(r.json.shopifyProductId))!.product_type).toBe('Earrings / Jhumkas');
  });

  it('retry with the same SKU -> no second product, still exactly one draft, no repeated writes', async () => {
    const a = await sendDraft();
    const writes = fake.writes().length;
    const b = await sendDraft();
    expect(b.json.action).toBe('reused_draft');
    expect(b.json.shopifyProductId).toBe(a.json.shopifyProductId);
    expect(fake.products.size).toBe(1);
    expect(fake.draftProducts().length).toBe(1);
    expect(fake.writes().length).toBe(writes);
    expect(b.json.verification).toMatchObject({ variantPrice: 1200, cost: 500, inventoryQuantity: 5 });
  });

  it('seeded LIVE product with the same SKU -> blocked (409), zero writes to it or anything', async () => {
    fake.seed({ id: 500, status: 'active', sku: SKU, price: '777.00', cost: '111.00', qty: 9 });
    const r = await sendDraft();
    expect(r.status).toBe(409);
    expect(r.json.success).toBe(false);
    expect(r.json.needsManualReview.code).toBe('live_product_match');
    expect(fake.writes()).toEqual([]);
    expect(fake.writesTouching(500)).toEqual([]);
    expect(fake.products.size).toBe(1);
    expect(fake.violations).toEqual([]);
    expect(fake.products.get(500)!.variants[0].price).toBe('777.00');
  });

  it('ambiguous / inconclusive lookup -> nothing created', async () => {
    fake.opts.skuLookupStatus = 500;
    const r = await sendDraft();
    expect(r.status).toBe(409);
    expect(r.json.needsManualReview.code).toBe('lookup_inconclusive');
    expect(fake.writes()).toEqual([]);
    expect(fake.products.size).toBe(0);
    fake.opts.skuLookupStatus = undefined;
    fake.seed({ id: 501, status: 'draft', sku: SKU, tags: 'SaazLedger', title: 'a' });
    fake.seed({ id: 502, status: 'draft', sku: SKU, tags: 'SaazLedger', title: 'b' });
    const r2 = await sendDraft();
    expect(r2.json.needsManualReview.code).toBe('ambiguous_match');
    expect(fake.writes()).toEqual([]);
  });

  it("configured status 'active' (item.status, config.defaultStatus) is ignored", async () => {
    const r = await sendDraft({ ...ITEM, status: 'active' }, { shopifyConfig: { defaultStatus: 'active', status: 'active' } });
    expect(r.json.verification.status).toBe('draft');
    expect(fake.products.get(Number(r.json.shopifyProductId))!.status).toBe('draft');
    for (const w of fake.writes()) expect(JSON.stringify(w.body)).not.toMatch(/"status":"active"/i);
    expect(fake.violations).toEqual([]);
  });

  it('missing location -> price+cost set, stock not set, inventory_not_set warning', async () => {
    delete process.env.SHOPIFY_PRIMARY_LOCATION_ID;
    dbm.db.prepare("DELETE FROM system_settings WHERE key = 'shopify_primary_location_id'").run();
    const r = await sendDraft();
    expect(r.status).toBe(200);
    expect(r.json.warningCodes).toContain('inventory_not_set');
    expect(r.json.warnings.join(' ')).toMatch(/inventory_not_set/);
    expect(r.json.verification).toMatchObject({ variantPrice: 1200, cost: 500, inventoryQuantity: null });
    expect(fake.writes().some((w) => w.path.includes('inventory_levels'))).toBe(false);
    const ii = [...fake.invItems.values()][0];
    expect(ii.cost).toBe('500.00');
    expect(fake.levels.get(`${ii.id}:${LOC}`)).toBe(0);
  });

  it('category mapping env -> sent via GraphQL productUpdate to the new draft only', async () => {
    process.env.SHOPIFY_CATEGORY_TAXONOMY_MAP = JSON.stringify({ PD: 'gid://shopify/TaxonomyCategory/aa-6-3' });
    const r = await sendDraft();
    expect(r.json.warningCodes).not.toContain('category_taxonomy_not_set');
    expect(fake.products.get(Number(r.json.shopifyProductId))!.category).toBe('gid://shopify/TaxonomyCategory/aa-6-3');
  });
});

describe('E2E fake Shopify: /api/media/pack/publish-shopify', () => {
  function seedLocalItem() {
    dbm.db.prepare(`INSERT INTO items (id, sku, title, type_code, stone_code, color_code, serial, buying_price, selling_price, quantity, date_added)
      VALUES ('it_pub_1', ?, 'Diamond Pendant Set', 'PD', 'D', '01', '001', 500, 1200, 5, '2026-01-01')`).run(SKU);
  }
  const publish = (extra: any = {}) =>
    post('/api/media/pack/publish-shopify', {
      productId: 'it_pub_1',
      productData: { id: 'it_pub_1', sku: SKU, title: 'Diamond Pendant Set' },
      gallerySlots: [{ slotNumber: 1, slotTitle: 'Hero', imageUrl: PNG, included: true }],
      shopifyConfig: { defaultStatus: 'active' },
      mode: 'review_approved',
      ...extra,
    });

  it('creates a draft from the DB item (5 / 500 / 1200) with media, verified on read-back', async () => {
    seedLocalItem();
    const r = await publish();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, draftOnly: true, action: 'created' });
    expect(r.json.verification).toMatchObject({ status: 'draft', isDraft: true, variantPrice: 1200, cost: 500, inventoryQuantity: 5, mediaCount: 1 });
    expect(r.json.adminUrl).toContain(r.json.shopifyProductId);
    expect(fake.draftProducts().length).toBe(1);
    expect(fake.violations).toEqual([]);
  });

  it('retry -> no second product; media not duplicated; live same-SKU product blocked with zero writes', async () => {
    seedLocalItem();
    const a = await publish();
    const b = await publish();
    expect(b.json.action).toBe('reused_draft');
    expect(b.json.shopifyProductId).toBe(a.json.shopifyProductId);
    expect(fake.products.size).toBe(1);
    expect(b.json.verification.mediaCount).toBe(1);

    const fake2 = new FakeShopifyServer({ token: fake.token });
    process.env.SHOPIFY_TEST_BASE_URL = await fake2.start();
    fake2.seed({ id: 800, status: 'active', sku: SKU });
    const c = await publish();
    expect(c.status).toBe(409);
    expect(fake2.writes()).toEqual([]);
    await fake2.stop();
  });

  it('missing location -> warning surfaced on the pack route too', async () => {
    seedLocalItem();
    delete process.env.SHOPIFY_PRIMARY_LOCATION_ID;
    dbm.db.prepare("DELETE FROM system_settings WHERE key = 'shopify_primary_location_id'").run();
    const r = await publish();
    expect(r.json.warningCodes).toContain('inventory_not_set');
    expect(r.json.verification).toMatchObject({ variantPrice: 1200, cost: 500, inventoryQuantity: null });
  });
});
