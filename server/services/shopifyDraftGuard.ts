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

/**
 * Capability granting narrow follow-up writes to resources THIS APP just created
 * (or a verified app-owned draft re-verified in the same call). Without a scope
 * that names the exact id, inventory / variant / productUpdate writes always throw.
 */
export interface DraftWriteScope {
  productIds: Set<string>;
  variantIds: Set<string>;
  inventoryItemIds: Set<string>;
  /** Only this location may receive inventory_levels/set. */
  locationId?: string;
}

export function createDraftWriteScope(locationId?: string): DraftWriteScope {
  return { productIds: new Set(), variantIds: new Set(), inventoryItemIds: new Set(), locationId: locationId ? String(locationId) : undefined };
}

/** Register a draft product (and its variant -> inventory item ids) in the scope. */
export function grantDraftScope(
  scope: DraftWriteScope,
  productId: string | number,
  variants: Array<{ id?: string | number; inventory_item_id?: string | number }>
): void {
  scope.productIds.add(String(productId));
  for (const v of variants) {
    if (v.id !== undefined && v.id !== null) scope.variantIds.add(String(v.id));
    if (v.inventory_item_id !== undefined && v.inventory_item_id !== null) scope.inventoryItemIds.add(String(v.inventory_item_id));
  }
}

function onlyKeys(obj: any, allowed: string[]): boolean {
  return !!obj && typeof obj === 'object' && Object.keys(obj).every((k) => allowed.includes(k));
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
 * Scoped extras (ONLY with a `scope` naming the exact id of a draft this app owns):
 *  - PUT    /inventory_items/:id.json       (cost / tracked only)
 *  - POST   /inventory_levels/set.json      (location_id, inventory_item_id, available only)
 *  - PUT    /variants/:id.json              (price only; used to reconcile an app-owned draft)
 *  - POST   /graphql.json productUpdate     (id + category only, for a scoped draft product)
 */
export function assertShopifyWriteAllowed(
  method: string | undefined,
  path: string,
  body?: any,
  scope?: DraftWriteScope
): void {
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
    if (roots.length === 1 && roots[0] === 'productUpdate') {
      const input = body?.variables?.product ?? body?.variables?.input;
      const gid = String(input?.id || '');
      const pid = gid.split('/').pop() || '';
      const queryNoStatus = !/status/i.test(String(query));
      if (!scope || !pid || !scope.productIds.has(pid) || !onlyKeys(input, ['id', 'category']) || !queryNoStatus) {
        throw new ShopifyDraftGuardError(
          'graphql_mutation_blocked',
          'productUpdate is only allowed for a draft created by this app, and only to set its category.'
        );
      }
      return;
    }
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

  let mm: RegExpMatchArray | null;
  if (m === 'PUT' && (mm = p.match(/^\/inventory_items\/(\d+)\.json$/))) {
    const ok =
      !!scope && scope.inventoryItemIds.has(mm[1]) &&
      onlyKeys(body, ['inventory_item']) &&
      onlyKeys(body?.inventory_item, ['id', 'cost', 'tracked']) &&
      (body.inventory_item.id === undefined || String(body.inventory_item.id) === mm[1]);
    if (!ok) {
      throw new ShopifyDraftGuardError('inventory_write_blocked',
        `Inventory item ${mm[1]} is not owned by a draft created by this app (or the body is not cost/tracked only); write blocked.`);
    }
    return;
  }
  if (m === 'POST' && p === '/inventory_levels/set.json') {
    const ok =
      !!scope &&
      scope.inventoryItemIds.has(String(body?.inventory_item_id ?? '')) &&
      onlyKeys(body, ['location_id', 'inventory_item_id', 'available']) &&
      Number.isInteger(body?.available) && body.available >= 0 &&
      !!scope.locationId && String(body?.location_id ?? '') === scope.locationId;
    if (!ok) {
      throw new ShopifyDraftGuardError('inventory_write_blocked',
        'Inventory level writes are only allowed for an inventory item of a draft created by this app, at the configured location, setting "available" only.');
    }
    return;
  }
  if (m === 'PUT' && (mm = p.match(/^\/variants\/(\d+)\.json$/))) {
    const ok =
      !!scope && scope.variantIds.has(mm[1]) &&
      onlyKeys(body, ['variant']) && onlyKeys(body?.variant, ['id', 'price']) &&
      (body.variant.id === undefined || String(body.variant.id) === mm[1]);
    if (!ok) {
      throw new ShopifyDraftGuardError('variant_write_blocked',
        `Variant ${mm[1]} is not owned by a draft created by this app (or the body is not price only); write blocked.`);
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
