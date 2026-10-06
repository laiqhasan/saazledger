/**
 * In-process fake Shopify Admin API served over a REAL http server on 127.0.0.1
 * (ephemeral port). No internet. Strict about the draft-only policy: any non-draft
 * product status, or any write touching a non-draft product / its variants /
 * inventory items / levels, is REJECTED (HTTP 403) and recorded in `violations`.
 */
import http from 'http';
import type { AddressInfo } from 'net';

export interface FakeVariant { id: number; sku: string; price: string; inventory_item_id: number; inventory_management: string | null; inventory_policy: string }
export interface FakeProd { id: number; title: string; status: string; tags: string; product_type: string; vendor: string; body_html: string; variants: FakeVariant[]; images: any[]; category?: string }
export interface FakeInvItem { id: number; sku: string; cost: string | null; tracked: boolean; productId: number }
export interface LogEntry { method: string; path: string; body: any; status: number }

export interface FakeServerOptions {
  token?: string;
  defaultLocationId?: number;
  /** GraphQL sku search returns this HTTP status (simulates an inconclusive lookup). */
  skuLookupStatus?: number;
  /** inventory_levels/set rejects with 422 */
  failInventorySet?: boolean;
  /** Simulate Shopify unexpectedly publishing a created product. */
  forceCreatedStatus?: string;
}

export class FakeShopifyServer {
  products = new Map<number, FakeProd>();
  invItems = new Map<number, FakeInvItem>();
  levels = new Map<string, number>(); // `${itemId}:${locationId}` -> available
  log: LogEntry[] = [];
  violations: string[] = [];
  opts: FakeServerOptions;
  baseUrl = '';
  private server?: http.Server;
  private nextId = 1000;
  readonly token: string;
  readonly defaultLocationId: number;

  constructor(opts: FakeServerOptions = {}) {
    this.opts = opts;
    this.token = opts.token || 'shpat_fake_local';
    this.defaultLocationId = opts.defaultLocationId ?? 7001;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: any;
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) { try { body = JSON.parse(raw); } catch { body = undefined; } }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const method = (req.method || 'GET').toUpperCase();
        let status = 500;
        let payload: any = { errors: 'fake error' };
        try {
          if (req.headers['x-shopify-access-token'] !== this.token) { status = 401; payload = { errors: 'Invalid API key or access token' }; }
          else [status, payload] = this.handle(method, url, body);
        } catch (e: any) { status = 500; payload = { errors: e.message }; }
        this.log.push({ method, path: url.pathname + url.search, body, status });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** Seed a product directly (e.g. a live product that must never be written). */
  seed(p: { id: number; title?: string; status: string; sku: string; tags?: string; price?: string; cost?: string; qty?: number }): FakeProd {
    const invId = p.id * 10 + 1;
    const prod: FakeProd = {
      id: p.id, title: p.title ?? 'Seeded product', status: p.status, tags: p.tags ?? '', product_type: '', vendor: 'x', body_html: '',
      variants: [{ id: p.id * 10, sku: p.sku, price: p.price ?? '999.00', inventory_item_id: invId, inventory_management: 'shopify', inventory_policy: 'deny' }],
      images: [],
    };
    this.products.set(p.id, prod);
    this.invItems.set(invId, { id: invId, sku: p.sku, cost: p.cost ?? '100.00', tracked: true, productId: p.id });
    this.levels.set(`${invId}:${this.defaultLocationId}`, p.qty ?? 3);
    return prod;
  }

  /** Mutating requests (REST non-GET + GraphQL mutations), in order. */
  writes(): LogEntry[] {
    return this.log.filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && !(r.path.includes('graphql') && !/\bmutation\b/.test(String(r.body?.query || ''))));
  }

  /** Writes whose target id belongs to the given product (incl. its variants / inventory items). */
  writesTouching(productId: number): LogEntry[] {
    const prod = this.products.get(productId);
    if (!prod) return [];
    const vIds = prod.variants.map((v) => String(v.id));
    const iIds = prod.variants.map((v) => String(v.inventory_item_id));
    return this.writes().filter((w) => {
      const p = w.path;
      if (new RegExp(`/products/${productId}(/|\\.)`).test(p)) return true;
      if (vIds.some((id) => p.includes(`/variants/${id}.json`))) return true;
      if (iIds.some((id) => p.includes(`/inventory_items/${id}.json`))) return true;
      if (p.includes('inventory_levels/set') && iIds.includes(String(w.body?.inventory_item_id))) return true;
      if (p.includes('graphql') && String(w.body?.query || '').includes('mutation') && JSON.stringify(w.body?.variables || {}).includes(`/Product/${productId}"`)) return true;
      return false;
    });
  }

  draftProducts(): FakeProd[] {
    return [...this.products.values()].filter((p) => p.status === 'draft');
  }

  private rest(p: FakeProd) { return { ...p }; }
  private deny(msg: string): [number, any] { this.violations.push(msg); return [403, { errors: `FAKE STORE REFUSED: ${msg}` }]; }

  private handle(method: string, url: URL, body: any): [number, any] {
    const p = url.pathname.replace(/^\/admin\/api\/[^/]+/, '');
    let m: RegExpMatchArray | null;

    if (p === '/graphql.json' && method === 'POST') return this.graphql(body);

    if (p === '/products.json' && method === 'GET') {
      const title = (url.searchParams.get('title') || '').toLowerCase();
      return [200, { products: [...this.products.values()].filter((x) => !title || x.title.toLowerCase() === title).map((x) => this.rest(x)) }];
    }
    if (p === '/products.json' && method === 'POST') {
      const pr = body?.product || {};
      if (String(pr.status || '').toLowerCase() !== 'draft') return this.deny(`create product with status "${pr.status}"`);
      const id = this.nextId++;
      const prod: FakeProd = {
        id, title: pr.title, status: this.opts.forceCreatedStatus ?? 'draft', tags: pr.tags || '', product_type: pr.product_type || '', vendor: pr.vendor || '', body_html: pr.body_html || '',
        variants: [], images: (pr.images || []).map((_: any, i: number) => ({ id: 5000 + i })),
      };
      for (const v of pr.variants || []) {
        const vid = this.nextId++; const iid = this.nextId++;
        const tracked = v.inventory_management === 'shopify';
        prod.variants.push({ id: vid, sku: v.sku || '', price: v.price ?? '0.00', inventory_item_id: iid, inventory_management: tracked ? 'shopify' : null, inventory_policy: v.inventory_policy || 'deny' });
        this.invItems.set(iid, { id: iid, sku: v.sku || '', cost: null, tracked, productId: id });
        if (tracked) this.levels.set(`${iid}:${this.defaultLocationId}`, 0);
      }
      this.products.set(id, prod);
      return [201, { product: this.rest(prod) }];
    }
    if ((m = p.match(/^\/products\/(\d+)\.json$/))) {
      const prod = this.products.get(Number(m[1]));
      if (method === 'GET') return prod ? [200, { product: this.rest(prod) }] : [404, { errors: 'Not Found' }];
      if (!prod) return [404, { errors: 'Not Found' }];
      if (method === 'PUT') {
        const st = body?.product?.status;
        // The ONLY write tolerated on a non-draft product: forcing it back to draft.
        if (String(st).toLowerCase() !== 'draft' || Object.keys(body.product).some((k) => !['id', 'status'].includes(k))) return this.deny(`PUT product ${prod.id} (${prod.status}) other than status=draft`);
        prod.status = 'draft';
        return [200, { product: this.rest(prod) }];
      }
      return this.deny(`${method} product ${prod.id}`);
    }
    if ((m = p.match(/^\/products\/(\d+)\/images\.json$/)) && method === 'POST') {
      const prod = this.products.get(Number(m[1]));
      if (!prod) return [404, { errors: 'Not Found' }];
      if (prod.status !== 'draft') return this.deny(`add image to ${prod.status} product ${prod.id}`);
      const img = { id: 7000 + prod.images.length, alt: body?.image?.alt, src: 'http://127.0.0.1/fake.jpg' };
      prod.images.push(img);
      return [200, { image: img }];
    }
    if ((m = p.match(/^\/variants\/(\d+)\.json$/))) {
      const found = [...this.products.values()].find((x) => x.variants.some((v) => v.id === Number(m![1])));
      if (!found) return [404, { errors: 'Not Found' }];
      if (found.status !== 'draft') return this.deny(`${method} variant ${m[1]} of ${found.status} product ${found.id}`);
      if (method === 'PUT') {
        const v = found.variants.find((x) => x.id === Number(m![1]))!;
        if (body?.variant?.price !== undefined) v.price = String(body.variant.price);
        return [200, { variant: v }];
      }
    }
    if ((m = p.match(/^\/inventory_items\/(\d+)\.json$/))) {
      const ii = this.invItems.get(Number(m[1]));
      if (!ii) return [404, { errors: 'Not Found' }];
      if (method === 'GET') return [200, { inventory_item: ii }];
      if (method === 'PUT') {
        const owner = this.products.get(ii.productId);
        if (!owner || owner.status !== 'draft') return this.deny(`PUT inventory item ${ii.id} of ${owner?.status} product ${ii.productId}`);
        const b = body?.inventory_item || {};
        if (b.cost !== undefined) ii.cost = String(b.cost);
        if (b.tracked !== undefined) ii.tracked = !!b.tracked;
        return [200, { inventory_item: ii }];
      }
    }
    if (p === '/inventory_levels.json' && method === 'GET') {
      const ids = (url.searchParams.get('inventory_item_ids') || '').split(',').filter(Boolean);
      const locs = (url.searchParams.get('location_ids') || '').split(',').filter(Boolean);
      const out: any[] = [];
      for (const [k, avail] of this.levels) {
        const [iid, loc] = k.split(':');
        if ((!ids.length || ids.includes(iid)) && (!locs.length || locs.includes(loc))) out.push({ inventory_item_id: Number(iid), location_id: Number(loc), available: avail });
      }
      return [200, { inventory_levels: out }];
    }
    if (p === '/inventory_levels/set.json' && method === 'POST') {
      const ii = this.invItems.get(Number(body?.inventory_item_id));
      if (!ii) return [404, { errors: 'Not Found' }];
      const owner = this.products.get(ii.productId);
      if (!owner || owner.status !== 'draft') return this.deny(`set inventory level of item ${ii.id} of ${owner?.status} product ${ii.productId}`);
      if (this.opts.failInventorySet) return [422, { errors: 'rejected' }];
      const key = `${ii.id}:${body.location_id}`;
      if (!this.levels.has(key)) return [422, { errors: { base: ['The inventory item is not stocked at that location.'] } }];
      this.levels.set(key, Number(body.available));
      return [200, { inventory_level: { inventory_item_id: ii.id, location_id: body.location_id, available: Number(body.available) } }];
    }
    return [404, { errors: `unhandled in fake: ${method} ${p}` }];
  }

  private graphql(body: any): [number, any] {
    const q = String(body?.query || '');
    if (/\bmutation\b/.test(q)) {
      if (/productUpdate/.test(q)) {
        const pid = Number(String(body.variables?.product?.id || '').split('/').pop());
        const prod = this.products.get(pid);
        if (!prod || prod.status !== 'draft') return this.deny(`productUpdate on ${prod?.status ?? 'unknown'} product ${pid}`);
        if (/status/i.test(q) || body.variables?.product?.status !== undefined) return this.deny('productUpdate with status');
        if (body.variables.product.category) prod.category = body.variables.product.category;
        return [200, { data: { productUpdate: { product: { id: body.variables.product.id }, userErrors: [] } } }];
      }
      if (/productCreate\b/.test(q)) return this.deny('graphql productCreate not supported by fake');
      return [200, { data: {} }];
    }
    if (/productVariants/.test(q)) {
      if (this.opts.skuLookupStatus) return [this.opts.skuLookupStatus, { errors: 'boom' }];
      const term = String(body.variables?.query || '').replace(/^sku:/, '').replace(/^"|"$/g, '').toLowerCase();
      const edges: any[] = [];
      for (const prod of this.products.values())
        for (const v of prod.variants)
          if (v.sku.toLowerCase() === term)
            edges.push({ node: { sku: v.sku, product: { id: `gid://shopify/Product/${prod.id}`, status: prod.status.toUpperCase(), tags: prod.tags ? prod.tags.split(',').map((t) => t.trim()) : [] } } });
      return [200, { data: { productVariants: { edges, pageInfo: { hasNextPage: false } } } }];
    }
    if (/\bproduct\(/.test(q)) {
      const pid = Number(String(body.variables?.id || '').split('/').pop());
      const prod = this.products.get(pid);
      return [200, { data: { product: prod ? { category: prod.category ? { id: prod.category } : null } : null } }];
    }
    return [200, { data: {} }];
  }
}
