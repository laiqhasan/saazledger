import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FakeShopify, TEST_CONFIG } from './helpers/fakeShopify';

let guard: typeof import('../server/services/shopifyDraftGuard');
let svc: typeof import('../server/services/shopifyDraftService');
let backend: typeof import('../server/services/shopifyBackendService');
let mediaSync: typeof import('../server/services/media/shopifyMediaSyncService');

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-draft-test-'));
  guard = await import('../server/services/shopifyDraftGuard');
  svc = await import('../server/services/shopifyDraftService');
  backend = await import('../server/services/shopifyBackendService');
  mediaSync = await import('../server/services/media/shopifyMediaSyncService');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const INPUT = { sku: 'PDD01-00001', title: 'Diamond Pendant Set', price: 1200, description: '<p>x</p>', category: 'Jewelry' };

function bodiesOfProductPosts(fake: FakeShopify) {
  return fake.requests.filter((r) => r.method === 'POST' && /\/products\.json/.test(r.path)).map((r) => r.body);
}

describe('central draft guard', () => {
  it('rejects non-draft / missing status on product creation', () => {
    const p = '/admin/api/2026-07/products.json';
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { product: { status: 'active' } })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { product: { title: 'x' } })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { product: { status: 'archived' } })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { product: { status: 'draft' } })).not.toThrow();
  });

  it('forceDraftStatus overrides any requested status', () => {
    expect(guard.forceDraftStatus({ title: 'x', status: 'active' }).status).toBe('draft');
    expect(guard.enforcedStatus('active')).toBe('draft');
  });

  it('blocks product updates, deletes, variant/inventory writes and publishing', () => {
    const base = '/admin/api/2026-07';
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${base}/products/1.json`, { product: { price: '1' } })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${base}/products/1.json`, { product: { status: 'active' } })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${base}/products/1.json`, { product: { status: 'draft' } })).not.toThrow();
    expect(() => guard.assertShopifyWriteAllowed('DELETE', `${base}/products/1.json`)).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('PUT', `${base}/variants/1.json`, { variant: {} })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', `${base}/inventory_levels/set.json`, {})).toThrow();
  });

  it('GraphQL: allows queries and productCreate DRAFT only', () => {
    const p = '/admin/api/2026-07/graphql.json';
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { query: 'query { shop { name } }' })).not.toThrow();
    const create = 'mutation c($input: ProductInput!) { productCreate(input: $input) { product { id } } }';
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { query: create, variables: { input: { status: 'ACTIVE' } } })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { query: create, variables: { input: { title: 'x' } } })).toThrow();
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { query: create, variables: { input: { status: 'DRAFT' } } })).not.toThrow();
    const upd = 'mutation u($input: ProductInput!) { productUpdate(input: $input) { product { id } } }';
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { query: upd, variables: { input: { status: 'DRAFT' } } })).toThrow();
    const pub = 'mutation { publishablePublish(id: "x", input: []) { userErrors { message } } }';
    expect(() => guard.assertShopifyWriteAllowed('POST', p, { query: pub })).toThrow();
  });

  it('callShopifyAdminApi refuses an active create before any network call', async () => {
    const fake = new FakeShopify();
    fake.install();
    await expect(
      backend.callShopifyAdminApi('/admin/api/2026-07/products.json', {
        method: 'POST',
        config: TEST_CONFIG,
        body: { product: { title: 'x', status: 'active' } },
      })
    ).rejects.toThrow(/draft/i);
    expect(fake.requests.length).toBe(0);
  });

  it('browser proxy is read-only', () => {
    expect(() => guard.assertProxyReadOnly('GET', '/admin/api/2026-07/products.json')).not.toThrow();
    expect(() => guard.assertProxyReadOnly('POST', '/admin/api/2026-07/products.json', { product: { status: 'draft' } })).toThrow();
    expect(() => guard.assertProxyReadOnly('PUT', '/admin/api/2026-07/products/1.json', {})).toThrow();
    expect(() => guard.assertProxyReadOnly('DELETE', '/admin/api/2026-07/products/1.json')).toThrow();
    expect(() => guard.assertProxyReadOnly('POST', '/admin/api/2026-07/graphql.json', { query: 'mutation { x }' })).toThrow();
  });
});

describe('draft creation', () => {
  it('creates with explicit draft even if Shopify would default to active, and a client status is ignored', async () => {
    const fake = new FakeShopify({ defaultCreateStatus: 'active' });
    fake.install();
    const res = await svc.ensureDraftProduct(TEST_CONFIG, { ...INPUT, status: 'active' } as any);
    expect(res.ok).toBe(true);
    expect(res.action).toBe('created');
    const posts = bodiesOfProductPosts(fake);
    expect(posts.length).toBe(1);
    for (const b of posts) expect(b.product.status).toBe('draft');
    expect(fake.products.get(res.productId!)!.status).toBe('draft');
  });

  it('every retry/fallback create attempt carries status draft (and never a status-less minimal payload)', async () => {
    const fake = new FakeShopify({ createStatuses: [422, 200] });
    fake.install();
    const res = await svc.ensureDraftProduct(TEST_CONFIG, { ...INPUT, images: [{ attachment: 'AAAA', filename: 'a.jpg' }] });
    expect(res.ok).toBe(true);
    const posts = bodiesOfProductPosts(fake);
    expect(posts.length).toBe(2); // with images (422) -> without images
    expect(posts[0].product.images).toBeTruthy();
    expect(posts[1].product.images).toBeUndefined();
    for (const b of posts) expect(b.product.status).toBe('draft');
    // no request anywhere carries an active status
    expect(JSON.stringify(fake.requests.map((r) => r.body))).not.toMatch(/"active"/i);
  });

  it('does not retry or create twice after a network error / 5xx (outcome unknown)', async () => {
    const fake = new FakeShopify({ createThrows: true });
    fake.install();
    const res = await svc.ensureDraftProduct(TEST_CONFIG, INPUT);
    expect(res.ok).toBe(false);
    expect(res.review?.code).toBe('create_outcome_unknown');
    expect(bodiesOfProductPosts(fake).length).toBe(1);

    const fake2 = new FakeShopify({ createStatuses: [500, 200] });
    fake2.install();
    const res2 = await svc.ensureDraftProduct(TEST_CONFIG, INPUT);
    expect(res2.ok).toBe(false);
    expect(bodiesOfProductPosts(fake2).length).toBe(1);
  });

  it('post-create verification re-reads id, status, mediaCount and admin url', async () => {
    const fake = new FakeShopify();
    fake.install();
    const res = await svc.ensureDraftProduct(TEST_CONFIG, { ...INPUT, images: [{ attachment: 'AAAA' }] });
    const v = res.verification!;
    expect(v.verified).toBe(true);
    expect(v.productId).toBe(res.productId);
    expect(v.status).toBe('draft');
    expect(v.isDraft).toBe(true);
    expect(v.mediaCount).toBe(1);
    expect(v.adminUrl).toBe(`https://admin.shopify.com/store/test-store/products/${res.productId}`);
    // the verification was a real re-read
    expect(fake.requests.some((r) => r.method === 'GET' && r.path.includes(`/products/${res.productId}.json`))).toBe(true);
  });

  it('admin url falls back to the shop domain for custom domains', () => {
    expect(svc.buildAdminUrl({ shopDomain: 'shop.example.com' }, '42')).toBe('https://shop.example.com/admin/products/42');
  });

  it('if verification shows non-draft it reports loudly and only ever tries to set draft', async () => {
    const fake = new FakeShopify({ forceCreatedStatus: 'active', ignoreStatusPut: true });
    fake.install();
    const res = await svc.ensureDraftProduct(TEST_CONFIG, INPUT);
    expect(res.verification!.isDraft).toBe(false);
    expect(res.verification!.warning).toMatch(/CRITICAL/);
    expect(res.warnings.length).toBeGreaterThan(0);
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    expect(puts.length).toBe(1);
    expect(puts[0].body.product.status).toBe('draft');

    const fake2 = new FakeShopify({ forceCreatedStatus: 'active' });
    fake2.install();
    const res2 = await svc.ensureDraftProduct(TEST_CONFIG, INPUT);
    expect(res2.verification!.isDraft).toBe(true); // corrected to draft
    expect(res2.verification!.statusCorrectionAttempted).toBe(true);
  });
});

describe('existing products are never modified', () => {
  const cases: Array<[string, (f: FakeShopify) => void, string]> = [
    ['active SKU match', (f) => f.addProduct({ id: '100', sku: INPUT.sku, status: 'active', tags: 'SaazLedger' }), 'live_product_match'],
    ['archived SKU match', (f) => f.addProduct({ id: '100', sku: INPUT.sku, status: 'archived', tags: 'SaazLedger' }), 'archived_product_match'],
    ['active title-only match', (f) => f.addProduct({ id: '100', title: INPUT.title, status: 'active' }), 'live_product_match'],
    [
      'ambiguous (two products share the SKU)',
      (f) => {
        f.addProduct({ id: '100', sku: INPUT.sku, status: 'draft', tags: 'SaazLedger' });
        f.addProduct({ id: '200', sku: INPUT.sku, status: 'draft', tags: 'SaazLedger' });
      },
      'ambiguous_match',
    ],
    [
      'ambiguous (SKU match + different title match)',
      (f) => {
        f.addProduct({ id: '100', sku: INPUT.sku, status: 'draft', tags: 'SaazLedger' });
        f.addProduct({ id: '200', title: INPUT.title, status: 'draft', tags: 'SaazLedger' });
      },
      'ambiguous_match',
    ],
    ['draft not created by this app', (f) => f.addProduct({ id: '100', sku: INPUT.sku, status: 'draft', tags: 'vintage' }), 'draft_not_app_owned'],
    ['draft matched by title only', (f) => f.addProduct({ id: '100', title: INPUT.title, status: 'draft', tags: 'SaazLedger' }), 'draft_identity_unverified'],
  ];

  for (const [name, setup, code] of cases) {
    it(`blocks: ${name} -> manual review, zero writes`, async () => {
      const fake = new FakeShopify();
      setup(fake);
      fake.install();
      const res = await svc.ensureDraftProduct(TEST_CONFIG, INPUT);
      expect(res.ok).toBe(false);
      expect(res.action).toBe('blocked');
      expect(res.review?.needsManualReview).toBe(true);
      expect(res.review?.code).toBe(code);
      expect(res.review!.reason.length).toBeGreaterThan(10);
      expect(res.review!.candidates.length).toBeGreaterThan(0);
      expect(fake.writes()).toEqual([]);
    });
  }

  it('blocks a linked id that is active (even when SKU lookup finds nothing)', async () => {
    const fake = new FakeShopify();
    fake.addProduct({ id: '555', title: 'Other', status: 'active', tags: 'SaazLedger' });
    fake.install();
    const res = await svc.ensureDraftProduct(TEST_CONFIG, INPUT, { linkedProductIds: ['555'] });
    expect(res.review?.code).toBe('live_product_match');
    expect(fake.writes()).toEqual([]);
  });

  const inconclusive: Array<[string, any, (f: FakeShopify) => void, string[]]> = [
    ['SKU lookup HTTP 500', { failSku: 500 }, () => {}, []],
    ['SKU lookup graphql errors', { skuGraphqlErrors: true }, () => {}, []],
    ['SKU lookup partial (hasNextPage)', { skuHasNextPage: true }, () => {}, []],
    ['title lookup HTTP 503', { failTitle: 503 }, () => {}, []],
    ['linked product 404/unverifiable', {}, () => {}, ['777']],
    ['linked product read error', { failProductGet: 500 }, (f) => f.addProduct({ id: '777' }), ['777']],
  ];
  for (const [name, opts, setup, linked] of inconclusive) {
    it(`inconclusive lookup creates nothing: ${name}`, async () => {
      const fake = new FakeShopify(opts);
      setup(fake);
      const initialCount = fake.products.size;
      fake.install();
      const res = await svc.ensureDraftProduct(TEST_CONFIG, INPUT, { linkedProductIds: linked });
      expect(res.ok).toBe(false);
      expect(res.action).toBe('blocked');
      expect(res.review?.needsManualReview).toBe(true);
      expect(['lookup_inconclusive', 'linked_product_unverifiable']).toContain(res.review!.code);
      expect(fake.writes()).toEqual([]);
      expect(fake.products.size).toBe(initialCount);
    });
  }

  it('retry does not create a duplicate: second call reuses the app-created draft', async () => {
    const fake = new FakeShopify();
    fake.install();
    const first = await svc.ensureDraftProduct(TEST_CONFIG, INPUT);
    expect(first.action).toBe('created');
    const second = await svc.ensureDraftProduct(TEST_CONFIG, INPUT, { linkedProductIds: [first.productId] });
    expect(second.action).toBe('reused_draft');
    expect(second.productId).toBe(first.productId);
    const third = await svc.ensureDraftProduct(TEST_CONFIG, INPUT); // link lost: found via SKU
    expect(third.action).toBe('reused_draft');
    expect(fake.products.size).toBe(1);
    expect(bodiesOfProductPosts(fake).length).toBe(1);
    // reuse performs no writes at all
    const putsOrPosts = fake.writes().filter((w) => w.method !== 'POST' || !/products\.json/.test(w.path));
    expect(putsOrPosts).toEqual([]);
  });

  it('a reused draft that Shopify now reports as active is blocked, never "fixed" by a write', async () => {
    const fake = new FakeShopify();
    fake.addProduct({ id: '100', sku: INPUT.sku, status: 'active', tags: 'SaazLedger' });
    fake.install();
    const res = await svc.ensureDraftProduct(TEST_CONFIG, INPUT, { linkedProductIds: ['100'] });
    expect(res.ok).toBe(false);
    expect(fake.writes()).toEqual([]);
  });
});

describe('media sync only writes to verified app-created drafts', () => {
  const pack = (url: string) =>
    ({
      productId: 'p1',
      productTitle: 'T',
      slots: [{ slotNumber: 1, slotTitle: 'Cover', imageUrl: url, altText: 'Cover alt', mediaId: 'm1' }],
    }) as any;
  const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/';

  for (const [name, status, tags] of [
    ['active', 'active', 'SaazLedger'],
    ['archived', 'archived', 'SaazLedger'],
    ['draft not app-owned', 'draft', 'other'],
  ] as const) {
    it(`refuses and writes nothing for ${name} product`, async () => {
      const fake = new FakeShopify();
      fake.addProduct({ id: '300', status, tags });
      fake.install();
      await expect(
        mediaSync.syncGalleryPackToShopify({ shopifyProductId: '300', productId: 'p1', galleryPack: pack(dataUrl), shopifyConfig: TEST_CONFIG })
      ).rejects.toThrow();
      expect(fake.writes()).toEqual([]);
    });
  }

  it('refuses when the product cannot be read (unverifiable)', async () => {
    const fake = new FakeShopify();
    fake.install(); // product 404
    await expect(
      mediaSync.syncGalleryPackToShopify({ shopifyProductId: '404', productId: 'p1', galleryPack: pack(dataUrl), shopifyConfig: TEST_CONFIG })
    ).rejects.toThrow();
    expect(fake.writes()).toEqual([]);
  });

  it('uploads images to a verified app-created draft and skips already-present images on retry', async () => {
    const fake = new FakeShopify();
    fake.addProduct({ id: '300', status: 'draft', tags: 'SaazLedger' });
    fake.install();
    const r1 = await mediaSync.syncGalleryPackToShopify({ shopifyProductId: '300', productId: 'p1', galleryPack: pack(dataUrl), shopifyConfig: TEST_CONFIG });
    expect(r1.uploadedCount).toBe(1);
    expect(fake.products.get('300')!.images.length).toBe(1);
    const r2 = await mediaSync.syncGalleryPackToShopify({ shopifyProductId: '300', productId: 'p1', galleryPack: pack(dataUrl), shopifyConfig: TEST_CONFIG });
    expect(r2.uploadedCount).toBe(0);
    expect(fake.products.get('300')!.images.length).toBe(1);
    for (const w of fake.writes()) expect(w.path).toMatch(/\/products\/300\/images/);
  });
});

describe('ordinary inventory save never touches Shopify', () => {
  it('createItem performs no network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('network must not be used by inventory save');
    });
    const { createItem } = await import('../server/services/inventoryService');
    const item = createItem({
      title: 'Save Test Ring',
      typeCode: 'RNG',
      stoneCode: 'D',
      colorCode: '01',
      quantity: 1,
      buyingPrice: 10,
      sellingPrice: 20,
    } as any);
    expect(item.id).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('save-path sources contain no Shopify write calls', () => {
    const root = path.resolve(__dirname, '..');
    for (const f of ['server/services/inventoryService.ts', 'src/services/apiService.ts']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src).not.toMatch(/shopifyService|callShopifyAdminApi|shopify-proxy|send-draft|publish-shopify/);
    }
    // inventory CRUD routes in server.ts must not call Shopify
    const server = fs.readFileSync(path.join(root, 'server/server.ts'), 'utf8');
    const start = server.indexOf("app.post('/api/inventory', authenticateToken");
    const end = server.indexOf("app.post('/api/inventory/next-sku'");
    expect(server.slice(start, end)).not.toMatch(/shopify/i);
    const upd = server.indexOf("app.put('/api/inventory/:id'");
    const updEnd = server.indexOf("app.post('/api/inventory/:id/restore'");
    expect(server.slice(upd, updEnd)).not.toMatch(/callShopify|syncGalleryPack|ensureDraft/);
  });
});

describe('client "Send to Shopify Draft"', () => {
  it('pushItemToShopify never sends a status (even with defaultStatus active) and targets the draft endpoint', async () => {
    const { pushItemToShopify } = await import('../src/services/shopifyService');
    const calls: Array<{ url: string; body: any }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(
        JSON.stringify({
          success: true,
          shopifyProductId: '9001',
          verification: { verified: true, productId: '9001', status: 'draft', isDraft: true, mediaCount: 0, adminUrl: 'https://admin.shopify.com/store/x/products/9001' },
          adminUrl: 'https://admin.shopify.com/store/x/products/9001',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    const res = await pushItemToShopify(
      { id: '1', sku: 'S1', title: 'T', typeCode: 'RNG', stoneCode: 'D', colorCode: '01', quantity: 1, sellingPrice: 10, buyingPrice: 5 } as any,
      { ...TEST_CONFIG, defaultStatus: 'active', isConnected: true } as any,
      { status: 'active' }
    );
    expect(res.success).toBe(true);
    expect(res.verification?.status).toBe('draft');
    expect(res.adminUrl).toContain('/products/9001');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/api/shopify/send-draft');
    expect(JSON.stringify(calls[0].body)).not.toMatch(/active|"status"/);
  });
});
