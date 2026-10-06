import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FakeShopifyServer } from './helpers/fakeShopifyServer';

let guard: typeof import('../server/services/shopifyDraftGuard');
let svc: typeof import('../server/services/shopifyDraftService');
let backend: typeof import('../server/services/shopifyBackendService');
let dbm: typeof import('../server/db/database');
let syncState: typeof import('../server/services/shopifySyncState');
let fake: FakeShopifyServer;
let cfg: any;
const LOC = '7001';
const INPUT = { sku: 'PD-D-01-001', title: 'Diamond Pendant Set', price: 1200, cost: 500, quantity: 5, typeCode: 'PD', category: 'Pendant Set', tags: ['Pendant Set'] };

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-fields-unit-'));
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  guard = await import('../server/services/shopifyDraftGuard');
  svc = await import('../server/services/shopifyDraftService');
  backend = await import('../server/services/shopifyBackendService');
  dbm = await import('../server/db/database');
  syncState = await import('../server/services/shopifySyncState');
});

beforeEach(async () => {
  dbm.db.prepare(syncState.SYNC_STATE_DDL).run();
  dbm.db.prepare('DELETE FROM shopify_sync_state').run();
  fake = new FakeShopifyServer();
  process.env.SHOPIFY_TEST_BASE_URL = await fake.start();
  delete process.env.SHOPIFY_CATEGORY_TAXONOMY_MAP;
  cfg = { shopDomain: 'test-store.myshopify.com', adminAccessToken: fake.token, apiVersion: '2026-07', primaryLocationId: LOC };
});
afterEach(async () => {
  await fake.stop();
  delete process.env.SHOPIFY_TEST_BASE_URL;
  delete process.env.SHOPIFY_CATEGORY_TAXONOMY_MAP;
});
afterAll(() => {});

const A = '/admin/api/2026-07';

describe('base URL override is test-only', () => {
  it('is honoured under NODE_ENV=test for loopback only', () => {
    const env: any = { NODE_ENV: 'test', SHOPIFY_TEST_BASE_URL: 'http://127.0.0.1:4555/' };
    expect(backend.resolveShopifyBaseUrl('s.myshopify.com', env)).toBe('http://127.0.0.1:4555');
    expect(backend.resolveShopifyBaseUrl('s.myshopify.com', { ...env, SHOPIFY_TEST_BASE_URL: 'http://evil.example.com' })).toBe('https://s.myshopify.com');
    expect(backend.resolveShopifyBaseUrl('s.myshopify.com', { ...env, SHOPIFY_TEST_BASE_URL: 'https://127.0.0.1:1' })).toBe('https://s.myshopify.com');
  });
  it('is ignored when NODE_ENV is not test', () => {
    for (const nodeEnv of ['production', 'development', undefined]) {
      const env: any = { NODE_ENV: nodeEnv, SHOPIFY_TEST_BASE_URL: 'http://127.0.0.1:4555' };
      expect(backend.resolveShopifyBaseUrl('s.myshopify.com', env)).toBe('https://s.myshopify.com');
    }
  });
});

describe('guard: scoped inventory writes', () => {
  const scope = () => {
    const s = guard.createDraftWriteScope(LOC);
    guard.grantDraftScope(s, 10, [{ id: 11, inventory_item_id: 12 }]);
    return s;
  };

  it('allows cost/tracked and available-only writes for owned ids', () => {
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/inventory_items/12.json`, { inventory_item: { id: 12, cost: '500.00', tracked: true } }, scope())).not.toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/inventory_levels/set.json`, { location_id: 7001, inventory_item_id: 12, available: 5 }, scope())).not.toThrow();
  });

  it('a bare inventory write for an unknown id throws', () => {
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/inventory_items/12.json`, { inventory_item: { cost: '1' } })).toThrow(/not owned/);
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/inventory_items/99.json`, { inventory_item: { cost: '1' } }, scope())).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/inventory_levels/set.json`, { location_id: 7001, inventory_item_id: 12, available: 5 })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/inventory_levels/set.json`, { location_id: 7001, inventory_item_id: 99, available: 5 }, scope())).toThrow();
  });

  it('rejects extra fields, other locations, negative or non-integer stock', () => {
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/inventory_items/12.json`, { inventory_item: { cost: '1', sku: 'x' } }, scope())).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/inventory_items/12.json`, { inventory_item: { cost: '1' }, extra: 1 }, scope())).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/inventory_levels/set.json`, { location_id: 1, inventory_item_id: 12, available: 5 }, scope())).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/inventory_levels/set.json`, { location_id: 7001, inventory_item_id: 12, available: -1 }, scope())).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/inventory_levels/set.json`, { location_id: 7001, inventory_item_id: 12, available: 5, disconnect_if_necessary: true }, scope())).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/inventory_levels/set.json`, { inventory_item_id: 12, available: 5 }, guard.createDraftWriteScope())).toThrow();
  });

  it('still blocks everything else even with a scope', () => {
    const s = scope();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/products.json`, { product: { status: 'active' } }, s)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/products/10.json`, { product: { status: 'active' } }, s)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/products/10.json`, { product: { title: 'x' } }, s)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('DELETE', `${A}/products/10.json`, undefined, s)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('DELETE', `${A}/inventory_items/12.json`, undefined, s)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/variants/999.json`, { variant: { price: '1.00' } }, s)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${A}/variants/11.json`, { variant: { price: '1.00', sku: 'x' } }, s)).toThrow();
    const upd = 'mutation u($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } } }';
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/graphql.json`, { query: upd, variables: { product: { id: 'gid://shopify/Product/10', status: 'ACTIVE' } } }, s)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/graphql.json`, { query: upd, variables: { product: { id: 'gid://shopify/Product/55', category: 'gid://shopify/TaxonomyCategory/aa' } } }, s)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/graphql.json`, { query: upd, variables: { product: { id: 'gid://shopify/Product/10', category: 'gid://shopify/TaxonomyCategory/aa' } } })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${A}/graphql.json`, { query: upd, variables: { product: { id: 'gid://shopify/Product/10', category: 'gid://shopify/TaxonomyCategory/aa' } } }, s)).not.toThrow();
  });

  it('writes against an inventory item of a LIVE product throw and send zero requests', async () => {
    fake.seed({ id: 500, status: 'active', sku: 'LIVE-1' });
    const liveItem = 5001;
    const own = guard.createDraftWriteScope(LOC);
    guard.grantDraftScope(own, 10, [{ id: 11, inventory_item_id: 12 }]);
    for (const scope of [undefined, own]) {
      await expect(backend.callShopifyAdminApi(`${A}/inventory_items/${liveItem}.json`, { method: 'PUT', config: cfg, scope, body: { inventory_item: { cost: '1.00' } } })).rejects.toThrow();
      await expect(backend.callShopifyAdminApi(`${A}/inventory_levels/set.json`, { method: 'POST', config: cfg, scope, body: { location_id: 7001, inventory_item_id: liveItem, available: 99 } })).rejects.toThrow();
      await expect(backend.callShopifyAdminApi(`${A}/variants/5000.json`, { method: 'PUT', config: cfg, scope, body: { variant: { price: '1.00' } } })).rejects.toThrow();
      await expect(backend.callShopifyAdminApi(`${A}/products/500.json`, { method: 'PUT', config: cfg, scope, body: { product: { status: 'active' } } })).rejects.toThrow();
      await expect(backend.callShopifyAdminApi(`${A}/products/500.json`, { method: 'DELETE', config: cfg, scope })).rejects.toThrow();
    }
    expect(fake.log.length).toBe(0);
    expect(fake.violations.length).toBe(0);
  });
});

describe('ensureDraftProduct: price / cost / stock / category', () => {
  it('creates a draft with 1200 / 500 / 5 and verifies by re-reading', async () => {
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.ok).toBe(true);
    expect(r.action).toBe('created');
    expect(r.verification).toMatchObject({ status: 'draft', isDraft: true, variantPrice: 1200, cost: 500, inventoryQuantity: 5, inventoryTracked: true });
    const prod = fake.products.get(Number(r.productId))!;
    expect(prod.status).toBe('draft');
    expect(prod.product_type).toBe('Pendant Set');
    expect(prod.variants[0]).toMatchObject({ price: '1200.00', inventory_management: 'shopify', inventory_policy: 'deny' });
    expect(fake.violations).toEqual([]);
    expect(r.warningCodes).toEqual(['category_taxonomy_not_set']);
  });

  it('missing location: price+cost set, stock not set, inventory_not_set warning', async () => {
    const r = await svc.ensureDraftProduct({ ...cfg, primaryLocationId: undefined }, INPUT);
    expect(r.ok).toBe(true);
    expect(r.warningCodes).toContain('inventory_not_set');
    expect(r.verification).toMatchObject({ variantPrice: 1200, cost: 500, inventoryQuantity: null });
    expect(fake.writes().some((w) => w.path.includes('inventory_levels/set'))).toBe(false);
  });

  it('retry with the same SKU reuses the draft: no second product, no repeated writes', async () => {
    const first = await svc.ensureDraftProduct(cfg, INPUT);
    const writesAfterFirst = fake.writes().length;
    const second = await svc.ensureDraftProduct(cfg, INPUT);
    expect(second.action).toBe('reused_draft');
    expect(second.productId).toBe(first.productId);
    expect(fake.draftProducts().length).toBe(1);
    expect(fake.writes().length).toBe(writesAfterFirst);
    expect(second.verification).toMatchObject({ variantPrice: 1200, cost: 500, inventoryQuantity: 5 });
  });

  it('reuse writes only what SaazLedger changed (Shopify untouched since last sync), on the draft own variant', async () => {
    const first = await svc.ensureDraftProduct(cfg, INPUT);
    const prod = fake.products.get(Number(first.productId))!;
    const before = fake.writes().length;
    const second = await svc.ensureDraftProduct(cfg, { ...INPUT, price: 1300, quantity: 8 });
    const newWrites = fake.writes().slice(before).map((w) => `${w.method} ${w.path.replace(A, '')}`);
    expect(newWrites).toEqual([`PUT /variants/${prod.variants[0].id}.json`, 'POST /inventory_levels/set.json']);
    expect(second.verification).toMatchObject({ variantPrice: 1300, cost: 500, inventoryQuantity: 8 });
  });

  it('same SKU on a LIVE product: blocked, zero writes anywhere', async () => {
    fake.seed({ id: 500, status: 'active', sku: INPUT.sku });
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.ok).toBe(false);
    expect(r.review?.code).toBe('live_product_match');
    expect(fake.writes()).toEqual([]);
  });

  it('a non-app-owned draft with the same SKU is not touched', async () => {
    fake.seed({ id: 600, status: 'draft', sku: INPUT.sku, tags: 'other' });
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.review?.code).toBe('draft_not_app_owned');
    expect(fake.writes()).toEqual([]);
  });

  it('inconclusive SKU lookup: nothing created', async () => {
    fake.opts.skuLookupStatus = 500;
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.ok).toBe(false);
    expect(r.review?.code).toBe('lookup_inconclusive');
    expect(fake.writes()).toEqual([]);
  });

  it('category: with a mapping the draft gets productUpdate(category); without, a warning', async () => {
    process.env.SHOPIFY_CATEGORY_TAXONOMY_MAP = JSON.stringify({ PD: 'gid://shopify/TaxonomyCategory/aa-6-3', BAD: 'not-a-gid' });
    expect(svc.getCategoryTaxonomyMap()).toEqual({ PD: 'gid://shopify/TaxonomyCategory/aa-6-3' });
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.warningCodes).not.toContain('category_taxonomy_not_set');
    expect(fake.products.get(Number(r.productId))!.category).toBe('gid://shopify/TaxonomyCategory/aa-6-3');
    const r2 = await svc.ensureDraftProduct(cfg, { ...INPUT, sku: 'OTHER-1', title: 'Other', typeCode: 'EAR' });
    expect(r2.warningCodes).toContain('category_taxonomy_not_set');
    expect(fake.products.get(Number(r2.productId))!.category).toBeUndefined();
  });

  it('if Shopify publishes a created product, no price/cost/stock is written to it (only a status=draft correction)', async () => {
    fake.opts.forceCreatedStatus = 'active';
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.warningCodes).toContain('fields_not_applied');
    expect(fake.violations).toEqual([]);
    const w = fake.writes().map((x) => `${x.method} ${x.path.replace(A, '')}`);
    expect(w.filter((x) => !x.startsWith('POST /products.json'))).toEqual([`PUT /products/${r.productId}.json`]);
    expect(r.verification?.isDraft).toBe(true);
  });

  it('a Shopify inventory set failure is surfaced, not hidden', async () => {
    fake.opts.failInventorySet = true;
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.warningCodes).toContain('inventory_set_failed');
  });
});


describe('manual Shopify edits are never silently overwritten', () => {
  const invKey = (prod: any) => `${prod.variants[0].inventory_item_id}:${LOC}`;
  const setup = async () => {
    const first = await svc.ensureDraftProduct(cfg, INPUT);
    const prod = fake.products.get(Number(first.productId))!;
    return { first, prod };
  };
  const stockWrites = () => fake.writes().filter((w) => w.path.includes('inventory_levels/set'));

  it('first create sets 5 / 500 / 1200 exactly, without confirmation, and records sync state', async () => {
    const { first, prod } = await setup();
    expect(first.action).toBe('created');
    expect(first.verification).toMatchObject({ variantPrice: 1200, cost: 500, inventoryQuantity: 5 });
    expect(fake.writes().map((w) => `${w.method} ${w.path.replace(A, '')}`)).toContain('POST /inventory_levels/set.json');
    expect(await syncState.readSyncState(String(prod.id))).toMatchObject({ last_synced_quantity: 5, last_synced_price: 1200, last_synced_cost: 500, location_id: LOC, category_status: 'manual_required', sku: INPUT.sku });
  });

  it('untouched resend: zero writes', async () => {
    await setup();
    const before = fake.writes().length;
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.ok).toBe(true);
    expect(fake.writes().length).toBe(before);
  });

  it('manual stock edit then resend: no write, needs-confirmation with all fields', async () => {
    const { prod } = await setup();
    fake.levels.set(invKey(prod), 7);
    const before = fake.writes().length;
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.ok).toBe(false);
    expect(r.action).toBe('needs_confirmation');
    expect(r.confirmation).toMatchObject({ code: 'stock_overwrite_requires_confirmation', currentQuantity: 7, desiredQuantity: 5, lastSyncedQuantity: 5, productId: String(prod.id) });
    expect(r.confirmation!.adminUrl).toContain(String(prod.id));
    expect(fake.writes().length).toBe(before);
    expect(fake.levels.get(invKey(prod))).toBe(7);
  });

  it('confirm with matching expectedCurrentQuantity overwrites; then a resend is a no-op', async () => {
    const { prod } = await setup();
    fake.levels.set(invKey(prod), 7);
    const r = await svc.ensureDraftProduct(cfg, INPUT, { confirm: { confirmStockOverwrite: true, expectedCurrentQuantity: 7 } });
    expect(r.ok).toBe(true);
    expect(fake.levels.get(invKey(prod))).toBe(5);
    expect(stockWrites().pop()!.body).toMatchObject({ available: 5 });
    const before = fake.writes().length;
    await svc.ensureDraftProduct(cfg, INPUT);
    expect(fake.writes().length).toBe(before);
  });

  it('stale / mismatched expected value is refused, no write; confirm without expected is refused', async () => {
    const { prod } = await setup();
    fake.levels.set(invKey(prod), 9); // changed again after the user saw 7
    const before = fake.writes().length;
    const stale = await svc.ensureDraftProduct(cfg, INPUT, { confirm: { confirmStockOverwrite: true, expectedCurrentQuantity: 7 } });
    expect(stale.action).toBe('needs_confirmation');
    expect(stale.confirmation!.conflicts[0]).toMatchObject({ field: 'stock', currentValue: 9, staleConfirmation: true });
    const noExpected = await svc.ensureDraftProduct(cfg, INPUT, { confirm: { confirmStockOverwrite: true } });
    expect(noExpected.action).toBe('needs_confirmation');
    const flagOnly = await svc.ensureDraftProduct(cfg, INPUT, { confirm: { expectedCurrentQuantity: 9 } });
    expect(flagOnly.action).toBe('needs_confirmation');
    expect(fake.writes().length).toBe(before);
    expect(fake.levels.get(invKey(prod))).toBe(9);
  });

  it('keepShopifyValues: skips the conflicting stock, still no stock write', async () => {
    const { prod } = await setup();
    fake.levels.set(invKey(prod), 7);
    const r = await svc.ensureDraftProduct(cfg, INPUT, { confirm: { keepShopifyValues: true } });
    expect(r.ok).toBe(true);
    expect(r.warningCodes).toContain('stock_kept_shopify_value');
    expect(fake.levels.get(invKey(prod))).toBe(7);
    // still remembered as a conflict next time
    expect((await svc.ensureDraftProduct(cfg, INPUT)).action).toBe('needs_confirmation');
  });

  it('no sync state (legacy draft) and current != desired needs confirmation; current == desired does nothing', async () => {
    const { prod } = await setup();
    dbm.db.prepare('DELETE FROM shopify_sync_state').run();
    const before = fake.writes().length;
    expect((await svc.ensureDraftProduct(cfg, INPUT)).ok).toBe(true); // equal => nothing
    expect(fake.writes().length).toBe(before);
    dbm.db.prepare('DELETE FROM shopify_sync_state').run();
    fake.levels.set(invKey(prod), 2);
    expect((await svc.ensureDraftProduct(cfg, INPUT)).action).toBe('needs_confirmation');
    expect(fake.writes().length).toBe(before);
  });

  it('manual price edit: same protection; confirm with expectedCurrentPrice overwrites', async () => {
    const { prod } = await setup();
    prod.variants[0].price = '900.00';
    const before = fake.writes().length;
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.action).toBe('needs_confirmation');
    expect(r.confirmation).toMatchObject({ code: 'price_overwrite_requires_confirmation' });
    expect(r.confirmation!.conflicts[0]).toMatchObject({ field: 'price', currentValue: 900, desiredValue: 1200, lastSyncedValue: 1200 });
    expect(fake.writes().length).toBe(before);
    expect((await svc.ensureDraftProduct(cfg, INPUT, { confirm: { confirmPriceOverwrite: true, expectedCurrentPrice: 800 } })).action).toBe('needs_confirmation');
    expect(fake.writes().length).toBe(before);
    expect((await svc.ensureDraftProduct(cfg, INPUT, { confirm: { confirmPriceOverwrite: true, expectedCurrentPrice: 900 } })).ok).toBe(true);
    expect(prod.variants[0].price).toBe('1200.00');
  });

  it('manual cost edit: same protection', async () => {
    const { prod } = await setup();
    fake.invItems.get(prod.variants[0].inventory_item_id)!.cost = '450.00';
    const before = fake.writes().length;
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.confirmation).toMatchObject({ code: 'cost_overwrite_requires_confirmation' });
    expect(fake.writes().length).toBe(before);
    expect((await svc.ensureDraftProduct(cfg, INPUT, { confirm: { confirmCostOverwrite: true, expectedCurrentCost: 450 } })).ok).toBe(true);
    expect(fake.invItems.get(prod.variants[0].inventory_item_id)!.cost).toBe('500.00');
  });

  it('a stock conflict blocks ALL writes (price change too) until resolved', async () => {
    const { prod } = await setup();
    fake.levels.set(invKey(prod), 7);
    const before = fake.writes().length;
    const r = await svc.ensureDraftProduct(cfg, { ...INPUT, price: 1500 });
    expect(r.action).toBe('needs_confirmation');
    expect(fake.writes().length).toBe(before);
  });

  it('guard still blocks everything non-draft (live product with differing stock: zero writes, no confirmation path)', async () => {
    fake.seed({ id: 500, status: 'active', sku: INPUT.sku, qty: 3 });
    const r = await svc.ensureDraftProduct(cfg, INPUT, { confirm: { confirmStockOverwrite: true, expectedCurrentQuantity: 3, keepShopifyValues: false } });
    expect(r.review?.code).toBe('live_product_match');
    expect(fake.writes()).toEqual([]);
    expect(fake.violations).toEqual([]);
  });
});

describe('category status', () => {
  it('unmapped type: categoryStatus manual_required + category_taxonomy_not_set (create and reuse), persisted', async () => {
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.categoryStatus).toBe('manual_required');
    expect(r.warningCodes).toContain('category_taxonomy_not_set');
    expect(r.warnings.join(' ')).toContain('Category: NOT SET');
    const again = await svc.ensureDraftProduct(cfg, INPUT);
    expect(again.categoryStatus).toBe('manual_required');
    expect(again.warningCodes).toContain('category_taxonomy_not_set');
    expect((await syncState.readSyncState(String(r.productId)))!.category_status).toBe('manual_required');
    // never pollutes tags
    expect(fake.products.get(Number(r.productId))!.tags).not.toMatch(/category:/i);
  });

  it('valid mapping: mapped, productUpdate(category) only on the draft', async () => {
    process.env.SHOPIFY_CATEGORY_TAXONOMY_MAP = JSON.stringify({ PD: 'gid://shopify/TaxonomyCategory/aa-6-3' });
    fake.seed({ id: 500, status: 'active', sku: 'LIVE-1' });
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.categoryStatus).toBe('mapped');
    expect(r.warningCodes).not.toContain('category_taxonomy_not_set');
    expect((await syncState.readSyncState(String(r.productId)))!.category_status).toBe('mapped');
    const gq = fake.writes().filter((w) => w.path.includes('graphql'));
    expect(gq).toHaveLength(1);
    expect(gq[0].body.variables.product).toEqual({ id: `gid://shopify/Product/${r.productId}`, category: 'gid://shopify/TaxonomyCategory/aa-6-3' });
    expect(fake.writesTouching(500)).toEqual([]);
    expect(fake.violations).toEqual([]);
  });

  it('rejected category => manual_required + category_set_failed', async () => {
    process.env.SHOPIFY_CATEGORY_TAXONOMY_MAP = JSON.stringify({ PD: 'gid://shopify/TaxonomyCategory/aa-6-3' });
    const orig = (fake as any).graphql.bind(fake);
    (fake as any).graphql = (b: any) => (/productUpdate/.test(String(b?.query)) ? [200, { data: { productUpdate: { product: null, userErrors: [{ field: ['category'], message: 'invalid' }] } } }] : orig(b));
    const r = await svc.ensureDraftProduct(cfg, INPUT);
    expect(r.categoryStatus).toBe('manual_required');
    expect(r.warningCodes).toContain('category_set_failed');
  });
});
