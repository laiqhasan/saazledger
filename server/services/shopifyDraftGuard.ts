/**
 * Central "draft-only" guard for every Shopify write made by SaazLedger.
 *
 * Policy: SaazLedger may only create Shopify products as DRAFT. It never
 * publishes, activates or archives a product and never edits an existing live
 * product. Client-supplied (or configured) statuses are never trusted: every
 * product payload is built through `forceDraftStatus`, and every outgoing
 * Admin API write is checked by `assertShopifyWriteAllowed`.
 *
 * This file is dependency-free on purpose so it can be imported anywhere.
 */

export const SHOPIFY_DRAFT_STATUS = 'draft' as const;

export class ShopifyDraftGuardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ShopifyDraftGuardError';
    this.code = code;
  }
}

/** Always returns the literal draft status, whatever was requested. */
export function enforcedStatus(_requested?: unknown): 'draft' {
  return SHOPIFY_DRAFT_STATUS;
}

/** Returns a copy of a REST product payload with status forced to "draft". */
export function forceDraftStatus<T extends Record<string, any>>(product: T): T & { status: 'draft' } {
  return { ...product, status: SHOPIFY_DRAFT_STATUS };
}

function isDraftValue(v: unknown): boolean {
  return typeof v === 'string' && v.trim().toLowerCase() === 'draft';
}

function collectStatuses(node: any, out: unknown[], depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 8) return;
  for (const [k, v] of Object.entries(node)) {
    if (k.toLowerCase() === 'status') out.push(v);
    else if (v && typeof v === 'object') collectStatuses(v, out, depth + 1);
  }
}

/** Extract root field names of a GraphQL operation (very small tokenizer). */
function graphqlRootFields(query: string): string[] {
  const src = query.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const open = src.indexOf('{');
  if (open === -1) return [];
  const fields: string[] = [];
  let depth = 0;
  let paren = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '{' && paren === 0) depth++;
    else if (ch === '}' && paren === 0) depth--;
    else if (depth === 1 && paren === 0 && /[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      let name = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] === ':') {
        k++;
        while (k < src.length && /\s/.test(src[k])) k++;
        let m = k;
        while (m < src.length && /[A-Za-z0-9_]/.test(src[m])) m++;
        name = src.slice(k, m);
        j = m;
      }
      fields.push(name);
      i = j;
      continue;
    }
    i++;
  }
  return fields;
}

export function isGraphqlMutation(query: unknown): boolean {
  return typeof query === 'string' && /(^|[\s}])mutation\b/.test(query.replace(/#[^\n]*/g, ''));
}

function stripApiPrefix(p: string): string {
  const noQuery = p.split('?')[0];
  return noQuery.replace(/^\/admin\/api\/[^/]+/, '');
}

/**
 * Throws ShopifyDraftGuardError unless the request is one SaazLedger may send.
 * GET/HEAD reads are always fine. Writes are an explicit allowlist:
 *  - POST   /products.json                  (status must be exactly "draft")
 *  - PUT    /products/:id.json              (only to explicitly set status "draft")
 *  - POST   /products/:id/images.json       (caller must have verified a draft)
 *  - PUT    /products/:id/images/:iid.json  (caller must have verified a draft)
 *  - POST   /graphql.json                   (queries; productCreateMedia; or productCreate with DRAFT)
 */
export function assertShopifyWriteAllowed(method: string | undefined, path: string, body?: any): void {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return;
  const p = stripApiPrefix(path);

  if (m === 'POST' && p === '/graphql.json') {
    const query = body?.query;
    if (!isGraphqlMutation(query)) return; // read-only query
    const roots = graphqlRootFields(String(query));
    // productCreateMedia attaches media to an existing product (callers verify a draft first);
    // it can neither set status nor publish.
    if (roots.length === 1 && roots[0] === 'productCreateMedia') return;
    if (roots.length !== 1 || roots[0] !== 'productCreate') {
      throw new ShopifyDraftGuardError(
        'graphql_mutation_blocked',
        `GraphQL mutation(s) [${roots.join(', ') || 'unknown'}] are not allowed. Only productCreate with status DRAFT is permitted.`
      );
    }
    const statuses: unknown[] = [];
    collectStatuses(body?.variables, statuses);
    const inline = String(query).match(/status\s*:\s*([A-Za-z_]+)/g) || [];
    for (const s of inline) statuses.push(s.split(':')[1].trim());
    if (statuses.length === 0 || !statuses.every(isDraftValue)) {
      throw new ShopifyDraftGuardError('non_draft_status', 'productCreate must set status DRAFT explicitly.');
    }
    return;
  }

  if (m === 'POST' && p === '/products.json') {
    if (!isDraftValue(body?.product?.status)) {
      throw new ShopifyDraftGuardError(
        'non_draft_status',
        `Refusing to create a Shopify product with status "${body?.product?.status ?? '(missing)'}". Only "draft" is allowed.`
      );
    }
    return;
  }

  if (m === 'PUT' && /^\/products\/\d+\.json$/.test(p)) {
    if (!isDraftValue(body?.product?.status)) {
      throw new ShopifyDraftGuardError(
        'product_update_blocked',
        'Updating an existing Shopify product is not allowed (only setting status to "draft").'
      );
    }
    return;
  }

  if (m === 'POST' && /^\/products\/\d+\/images\.json$/.test(p)) return;
  if (m === 'PUT' && /^\/products\/\d+\/images\/\d+\.json$/.test(p)) return;

  throw new ShopifyDraftGuardError(
    'write_blocked',
    `Shopify write ${m} ${p} is blocked: SaazLedger only sends products to Shopify as drafts.`
  );
}

/** Stricter check for the browser-facing proxy: reads only. */
export function assertProxyReadOnly(method: string | undefined, path: string, body?: any): void {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return;
  const p = stripApiPrefix(path);
  if (m === 'POST' && p === '/graphql.json' && !isGraphqlMutation(body?.query)) return;
  throw new ShopifyDraftGuardError(
    'proxy_write_blocked',
    `The Shopify proxy is read-only. ${m} ${p} blocked; use "Send to Shopify Draft" instead.`
  );
}
