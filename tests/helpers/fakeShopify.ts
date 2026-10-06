import { vi } from 'vitest';

export interface FakeProduct {
  id: string;
  title: string;
  status: string;
  tags: string;
  variants: Array<{ id: number; sku: string }>;
  images: Array<{ id: number; alt?: string }>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: any;
}

export interface FakeOptions {
  /** HTTP status to fail the SKU GraphQL lookup with (non-2xx) */
  failSku?: number;
  /** Return graphql `errors` for the SKU lookup */
  skuGraphqlErrors?: boolean;
  /** Mark SKU lookup as having a next page (partial) */
  skuHasNextPage?: boolean;
  failTitle?: number;
  failProductGet?: number;
  /** Sequence of statuses for successive POST /products.json calls (e.g. [422, 200]) */
  createStatuses?: number[];
  /** Throw a network error on POST /products.json */
  createThrows?: boolean;
  /** Simulates Shopify defaulting a missing status to active */
  defaultCreateStatus?: string;
  /** Force every created product to this status (simulates unexpected publication) */
  forceCreatedStatus?: string;
  /** If true, PUT status=draft is ignored (product stays as is) */
  ignoreStatusPut?: boolean;
}

/**
 * In-memory fake Shopify Admin API. Installs a fetch mock; never touches the network.
 */
export class FakeShopify {
  products = new Map<string, FakeProduct>();
  requests: RecordedRequest[] = [];
  private nextId = 9000;
  private createCalls = 0;
  opts: FakeOptions;

  constructor(opts: FakeOptions = {}) {
    this.opts = opts;
  }

  addProduct(p: Partial<FakeProduct> & { id: string; sku?: string }): FakeProduct {
    const prod: FakeProduct = {
      id: p.id,
      title: p.title ?? 'Some Product',
      status: p.status ?? 'active',
      tags: p.tags ?? '',
      variants: p.variants ?? (p.sku ? [{ id: Number(p.id) + 1, sku: p.sku }] : []),
      images: p.images ?? [],
    };
    this.products.set(prod.id, prod);
    return prod;
  }

  install() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const url = new URL(String(input));
      const method = String(init?.method || 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      this.requests.push({ method, path: url.pathname + url.search, body });
      return this.handle(method, url, body);
    });
  }

  /** Requests that could change state on Shopify (writes + GraphQL mutations). */
  writes(): RecordedRequest[] {
    return this.requests.filter((r) => {
      if (r.method === 'GET' || r.method === 'HEAD') return false;
      if (r.path.includes('/graphql.json') && !/\bmutation\b/.test(String(r.body?.query || ''))) return false;
      return true;
    });
  }

  private json(status: number, data: any): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }

  private toRest(p: FakeProduct) {
    return { id: Number(p.id), title: p.title, status: p.status, tags: p.tags, variants: p.variants, images: p.images };
  }

  private handle(method: string, url: URL, body: any): Response {
    const p = url.pathname.replace(/^\/admin\/api\/[^/]+/, '');

    if (p === '/graphql.json') {
      const q = String(body?.query || '');
      if (/productVariants/.test(q)) {
        if (this.opts.failSku) return this.json(this.opts.failSku, { errors: 'boom' });
        if (this.opts.skuGraphqlErrors) return this.json(200, { errors: [{ message: 'throttled' }] });
        const term = String(body.variables?.query || '').replace(/^sku:/, '').replace(/^"|"$/g, '').toLowerCase();
        const edges: any[] = [];
        for (const prod of this.products.values()) {
          for (const v of prod.variants) {
            if (v.sku.toLowerCase() === term) {
              edges.push({
                node: {
                  sku: v.sku,
                  product: {
                    id: `gid://shopify/Product/${prod.id}`,
                    status: prod.status.toUpperCase(),
                    tags: prod.tags ? prod.tags.split(',').map((t) => t.trim()) : [],
                  },
                },
              });
            }
          }
        }
        return this.json(200, {
          data: { productVariants: { edges, pageInfo: { hasNextPage: !!this.opts.skuHasNextPage } } },
        });
      }
      if (/\bmutation\b/.test(q)) return this.json(200, { data: {} });
      return this.json(200, { data: {} });
    }

    if (method === 'GET' && p === '/products.json') {
      if (this.opts.failTitle) return this.json(this.opts.failTitle, { errors: 'boom' });
      const title = (url.searchParams.get('title') || '').toLowerCase();
      const list = [...this.products.values()].filter((x) => !title || x.title.toLowerCase() === title);
      return this.json(200, { products: list.map((x) => this.toRest(x)) });
    }

    if (method === 'POST' && p === '/products.json') {
      if (this.opts.createThrows) throw new Error('socket hang up');
      const planned = this.opts.createStatuses?.[this.createCalls];
      this.createCalls++;
      if (planned && planned !== 200) return this.json(planned, { errors: { base: ['rejected'] } });
      const status = this.opts.forceCreatedStatus ?? body?.product?.status ?? this.opts.defaultCreateStatus ?? 'active';
      const id = String(this.nextId++);
      const prod = this.addProduct({
        id,
        title: body.product.title,
        status,
        tags: body.product.tags || '',
        variants: (body.product.variants || []).map((v: any, i: number) => ({ id: Number(id) + i + 1, sku: v.sku || '' })),
        images: (body.product.images || []).map((_: any, i: number) => ({ id: 5000 + i })),
      });
      return this.json(201, { product: this.toRest(prod) });
    }

    const mProd = p.match(/^\/products\/(\d+)\.json$/);
    if (mProd) {
      const prod = this.products.get(mProd[1]);
      if (method === 'GET') {
        if (this.opts.failProductGet) return this.json(this.opts.failProductGet, { errors: 'boom' });
        if (!prod) return this.json(404, { errors: 'Not Found' });
        return this.json(200, { product: this.toRest(prod) });
      }
      if (method === 'PUT' && prod) {
        if (!this.opts.ignoreStatusPut && body?.product?.status) prod.status = body.product.status;
        return this.json(200, { product: this.toRest(prod) });
      }
    }

    const mImg = p.match(/^\/products\/(\d+)\/images\.json$/);
    if (mImg && method === 'POST') {
      const prod = this.products.get(mImg[1]);
      if (!prod) return this.json(404, { errors: 'Not Found' });
      const img = { id: 7000 + prod.images.length, alt: body.image?.alt, src: 'https://cdn.example/x.jpg' };
      prod.images.push(img);
      return this.json(200, { image: img });
    }
    if (p.match(/^\/products\/\d+\/images\/\d+\.json$/) && method === 'PUT') return this.json(200, { image: {} });

    return this.json(404, { errors: 'unhandled in fake: ' + method + ' ' + p });
  }
}

export const TEST_CONFIG = {
  shopDomain: 'test-store.myshopify.com',
  adminAccessToken: 'shpat_fake',
  apiVersion: '2026-07',
};
