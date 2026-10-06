/**
 * Draft-only Shopify product service.
 *
 * - Looks up existing products (linked id / SKU / title) and classifies them.
 * - Blocks (writes nothing) when a match is active, archived, ambiguous or
 *   cannot be verified; returns a structured "needs manual review" result.
 * - Creates NEW products only as status "draft", only after a conclusive
 *   lookup that found nothing, with no status-less / active fallbacks.
 * - Re-reads the product from Shopify and reports id, status, media count and
 *   an admin review link.
 */
import { callShopifyAdminApi, type ShopifyBackendConfig } from './shopifyBackendService';
import {
  SHOPIFY_DRAFT_STATUS,
  ShopifyDraftGuardError,
  forceDraftStatus,
  createDraftWriteScope,
  grantDraftScope,
  type DraftWriteScope,
} from './shopifyDraftGuard';

/** Tag added to every product this app creates; required before we ever touch an existing draft. */
export const APP_MARKER_TAG = 'SaazLedger';

export interface DraftProductInput {
  sku?: string;
  title: string;
  price?: string | number;
  description?: string;
  category?: string;
  vendor?: string;
  tags?: string[];
  /** Optional REST image payloads (attachment/src) included in the create call. */
  images?: any[];
  /** Buying price -> Shopify inventory item `cost`. */
  cost?: string | number;
  /** Stock quantity -> inventory level `available` at the configured primary location. */
  quantity?: number;
  /** Jewellery type code (e.g. "PD"); only used to look up the optional taxonomy mapping. */
  typeCode?: string;
}

/**
 * Optional server-side map: jewellery type code -> Shopify Taxonomy category GID.
 * Env SHOPIFY_CATEGORY_TAXONOMY_MAP = JSON like {"PD":"gid://shopify/TaxonomyCategory/aa-6-..."}.
 * Default empty. GIDs are never invented; malformed entries are ignored.
 */
export function getCategoryTaxonomyMap(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = (env.SHOPIFY_CATEGORY_TAXONOMY_MAP || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      if (typeof v === 'string' && /^gid:\/\/shopify\/TaxonomyCategory\/[A-Za-z0-9-]+$/.test(v.trim())) {
        out[k.trim().toUpperCase()] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

export interface ShopifyDraftVerification {
  verified: boolean;
  productId?: string;
  status?: string;
  isDraft: boolean;
  mediaCount?: number;
  adminUrl?: string;
  /** Re-read values (null = could not be read / not set on Shopify). */
  variantPrice?: number | null;
  cost?: number | null;
  inventoryQuantity?: number | null;
  inventoryTracked?: boolean | null;
  error?: string;
  /** Loud warning when status != draft (or could not be confirmed). */
  warning?: string;
  /** Set when we attempted to force the product back to draft. */
  statusCorrectionAttempted?: boolean;
}

export interface ManualReview {
  needsManualReview: true;
  code:
    | 'lookup_inconclusive'
    | 'ambiguous_match'
    | 'live_product_match'
    | 'archived_product_match'
    | 'unknown_status_match'
    | 'draft_not_app_owned'
    | 'draft_identity_unverified'
    | 'linked_product_unverifiable'
    | 'create_outcome_unknown';
  reason: string;
  candidates: Array<{ id: string; status: string; matchedBy: string[]; adminUrl: string }>;
}

export interface DraftEnsureResult {
  ok: boolean;
  action: 'created' | 'reused_draft' | 'blocked' | 'failed';
  productId?: string;
  variantId?: string;
  review?: ManualReview;
  verification?: ShopifyDraftVerification;
  error?: string;
  warnings: string[];
  /** Machine-readable warning codes: inventory_not_set, category_taxonomy_not_set, ... */
  warningCodes?: string[];
}

interface Candidate {
  id: string;
  status: string;
  tags: string[];
  matchedBy: Set<string>;
  skus: string[];
}

export function normalizeDomain(domain: string): string {
  let d = (domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^["']|["']$/g, '');
  if (d && !d.includes('.')) d = `${d}.myshopify.com`;
  return d;
}

export function buildAdminUrl(config: Pick<ShopifyBackendConfig, 'shopDomain'>, productId: string): string {
  const domain = normalizeDomain(config.shopDomain);
  const m = domain.match(/^(.+)\.myshopify\.com$/i);
  if (m) return `https://admin.shopify.com/store/${m[1]}/products/${productId}`;
  return `https://${domain}/admin/products/${productId}`;
}

function normTags(t: unknown): string[] {
  if (Array.isArray(t)) return t.map((x) => String(x).trim()).filter(Boolean);
  if (typeof t === 'string') return t.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

function hasMarker(tags: string[]): boolean {
  return tags.some((t) => t.toLowerCase() === APP_MARKER_TAG.toLowerCase());
}

function gidToId(gid: string): string {
  return String(gid || '').split('/').pop() || '';
}

type Call = { ok: boolean; status: number; data: any };

async function call(
  config: ShopifyBackendConfig,
  path: string,
  method = 'GET',
  body?: any,
  scope?: DraftWriteScope
): Promise<Call> {
  const r = await callShopifyAdminApi(path, { method, body, config, scope });
  return { ok: r.ok, status: r.status, data: r.data };
}

/** Looks up existing products. `problems` non-empty => lookup inconclusive. */
export async function findExistingProducts(
  config: ShopifyBackendConfig,
  q: { sku?: string; title?: string; linkedIds?: string[] }
): Promise<{ candidates: Candidate[]; problems: string[] }> {
  const byId = new Map<string, Candidate>();
  const problems: string[] = [];
  const add = (id: string, status: string, tags: string[], by: string, skus: string[] = []) => {
    if (!id) return;
    const ex = byId.get(id);
    if (ex) {
      ex.matchedBy.add(by);
      skus.forEach((s) => !ex.skus.includes(s) && ex.skus.push(s));
      if (!ex.status || ex.status === 'unknown') ex.status = status;
      return;
    }
    byId.set(id, { id, status, tags, matchedBy: new Set([by]), skus: [...skus] });
  };

  // 1. Linked IDs (local DB link and/or client-provided id: both must be verified)
  for (const raw of q.linkedIds || []) {
    const id = String(raw || '').replace(/\D/g, '');
    if (!id) continue;
    try {
      const r = await call(config, `/admin/api/${config.apiVersion}/products/${id}.json`);
      if (r.ok && r.data?.product?.id) {
        const p = r.data.product;
        add(String(p.id), String(p.status || 'unknown').toLowerCase(), normTags(p.tags), 'linked',
          (p.variants || []).map((v: any) => String(v.sku || '')).filter(Boolean));
      } else {
        problems.push(`Linked product ${id} could not be verified (HTTP ${r.status}).`);
      }
    } catch (e: any) {
      problems.push(`Linked product ${id} lookup failed: ${e.message}`);
    }
  }

  // 2. SKU lookup (GraphQL)
  const cleanSku = (q.sku || '').trim();
  if (cleanSku) {
    try {
      const query = `query findBySku($query: String!) {
        productVariants(first: 10, query: $query) {
          edges { node { sku product { id status tags } } }
          pageInfo { hasNextPage }
        }
      }`;
      const r = await call(config, `/admin/api/${config.apiVersion}/graphql.json`, 'POST', {
        query,
        variables: { query: `sku:"${cleanSku.replace(/"/g, '\\"')}"` },
      });
      const pv = r.data?.data?.productVariants;
      if (!r.ok || r.data?.errors || !pv || !Array.isArray(pv.edges)) {
        problems.push(`SKU lookup for "${cleanSku}" was inconclusive (HTTP ${r.status}).`);
      } else {
        if (pv.pageInfo?.hasNextPage) problems.push(`SKU lookup for "${cleanSku}" returned partial results.`);
        for (const e of pv.edges) {
          const node = e?.node;
          const prod = node?.product;
          if (!prod?.id) continue;
          // Shopify's sku: search is fuzzy; only exact (case-insensitive) matches count.
          if (String(node.sku || '').trim().toLowerCase() !== cleanSku.toLowerCase()) continue;
          add(gidToId(prod.id), String(prod.status || 'unknown').toLowerCase(), normTags(prod.tags), 'sku', [String(node.sku)]);
        }
      }
    } catch (e: any) {
      problems.push(`SKU lookup for "${cleanSku}" failed: ${e.message}`);
    }
  }

  // 3. Title lookup (REST)
  const cleanTitle = (q.title || '').trim();
  if (cleanTitle) {
    try {
      const limit = 10;
      const r = await call(
        config,
        `/admin/api/${config.apiVersion}/products.json?title=${encodeURIComponent(cleanTitle)}&limit=${limit}`
      );
      if (!r.ok || !Array.isArray(r.data?.products)) {
        problems.push(`Title lookup for "${cleanTitle}" was inconclusive (HTTP ${r.status}).`);
      } else {
        if (r.data.products.length >= limit) problems.push(`Title lookup for "${cleanTitle}" returned partial results.`);
        for (const p of r.data.products) {
          if (String(p.title || '').trim().toLowerCase() !== cleanTitle.toLowerCase()) continue;
          add(String(p.id), String(p.status || 'unknown').toLowerCase(), normTags(p.tags), 'title',
            (p.variants || []).map((v: any) => String(v.sku || '')).filter(Boolean));
        }
      }
    } catch (e: any) {
      problems.push(`Title lookup for "${cleanTitle}" failed: ${e.message}`);
    }
  }

  return { candidates: [...byId.values()], problems };
}

function review(
  config: ShopifyBackendConfig,
  code: ManualReview['code'],
  reason: string,
  candidates: Candidate[]
): ManualReview {
  return {
    needsManualReview: true,
    code,
    reason,
    candidates: candidates.map((c) => ({
      id: c.id,
      status: c.status,
      matchedBy: [...c.matchedBy],
      adminUrl: buildAdminUrl(config, c.id),
    })),
  };
}

/**
 * Pure classification of lookup results. Returns either a review (block),
 * 'create' (conclusive: nothing exists) or the single reusable draft.
 */
export function classifyLookup(
  config: ShopifyBackendConfig,
  lookup: { candidates: Candidate[]; problems: string[] },
  ourSku?: string
): { kind: 'block'; review: ManualReview } | { kind: 'create' } | { kind: 'reuse'; candidate: Candidate } {
  const { candidates, problems } = lookup;
  if (problems.length > 0) {
    return {
      kind: 'block',
      review: review(
        config,
        problems.some((p) => p.startsWith('Linked product')) ? 'linked_product_unverifiable' : 'lookup_inconclusive',
        `Could not safely confirm whether this product already exists on Shopify, so nothing was created or changed. ${problems.join(' ')}`,
        candidates
      ),
    };
  }
  if (candidates.length === 0) return { kind: 'create' };
  if (candidates.length > 1) {
    return {
      kind: 'block',
      review: review(config, 'ambiguous_match',
        `${candidates.length} existing Shopify products match this item (${candidates.map((c) => `${c.id}:${c.status}`).join(', ')}). Nothing was changed.`,
        candidates),
    };
  }
  const c = candidates[0];
  if (c.status === 'active') {
    return { kind: 'block', review: review(config, 'live_product_match',
      `Existing Shopify product ${c.id} is ACTIVE (live). SaazLedger never modifies live products.`, candidates) };
  }
  if (c.status === 'archived') {
    return { kind: 'block', review: review(config, 'archived_product_match',
      `Existing Shopify product ${c.id} is ARCHIVED. SaazLedger never modifies archived products.`, candidates) };
  }
  if (c.status !== 'draft') {
    return { kind: 'block', review: review(config, 'unknown_status_match',
      `Existing Shopify product ${c.id} has unverifiable status "${c.status}".`, candidates) };
  }
  if (!hasMarker(c.tags)) {
    return { kind: 'block', review: review(config, 'draft_not_app_owned',
      `Existing draft ${c.id} was not created by SaazLedger (missing "${APP_MARKER_TAG}" tag). Not touching it.`, candidates) };
  }
  const skuOk = c.matchedBy.has('linked') || c.matchedBy.has('sku') ||
    (!!ourSku && c.skus.some((s) => s.trim().toLowerCase() === ourSku.trim().toLowerCase()));
  if (!skuOk) {
    return { kind: 'block', review: review(config, 'draft_identity_unverified',
      `Existing draft ${c.id} matched by title only; its identity could not be verified by link or SKU.`, candidates) };
  }
  return { kind: 'reuse', candidate: c };
}

/** Re-reads the product from Shopify and reports id, status, media count and admin link. */
export async function verifyDraftProduct(
  config: ShopifyBackendConfig,
  productId: string,
  opts: { correct?: boolean; sku?: string } = {}
): Promise<ShopifyDraftVerification> {
  const adminUrl = buildAdminUrl(config, productId);
  const read = async () => {
    const r = await call(config, `/admin/api/${config.apiVersion}/products/${productId}.json`);
    if (!r.ok || !r.data?.product) throw new Error(`HTTP ${r.status}`);
    return r.data.product;
  };
  try {
    let p = await read();
    let status = String(p.status || '').toLowerCase();
    let correctionAttempted = false;
    if (status !== SHOPIFY_DRAFT_STATUS && opts.correct !== false) {
      correctionAttempted = true;
      try {
        // Only ever set to draft; the guard rejects any other status.
        await call(config, `/admin/api/${config.apiVersion}/products/${productId}.json`, 'PUT', {
          product: { id: Number(productId), status: SHOPIFY_DRAFT_STATUS },
        });
        p = await read();
        status = String(p.status || '').toLowerCase();
      } catch {
        /* reported below */
      }
    }
    const isDraft = status === SHOPIFY_DRAFT_STATUS;
    const mediaCount = Array.isArray(p.images) ? p.images.length : Array.isArray(p.media) ? p.media.length : 0;
    const fields = await readVariantFields(config, p, opts.sku);
    return {
      ...fields,
      verified: true,
      productId: String(p.id ?? productId),
      status,
      isDraft,
      mediaCount,
      adminUrl,
      statusCorrectionAttempted: correctionAttempted || undefined,
      warning: isDraft
        ? undefined
        : `CRITICAL: Shopify product ${productId} is "${status}", not draft. Review it immediately at ${adminUrl}.`,
    };
  } catch (e: any) {
    return {
      verified: false,
      productId,
      isDraft: false,
      adminUrl,
      error: `Could not re-read product from Shopify: ${e.message}`,
      warning: `Could not verify that product ${productId} is a draft. Check it at ${adminUrl}.`,
    };
  }
}

function pickVariant(product: any, sku?: string): any | undefined {
  const vs: any[] = Array.isArray(product?.variants) ? product.variants : [];
  const want = (sku || '').trim().toLowerCase();
  if (want) {
    const m = vs.find((v) => String(v.sku || '').trim().toLowerCase() === want);
    if (m) return m;
  }
  return vs.length === 1 ? vs[0] : undefined;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Read-only: variant price, inventory item cost/tracked and stock at the configured location. */
async function readVariantFields(
  config: ShopifyBackendConfig,
  product: any,
  sku?: string
): Promise<Pick<ShopifyDraftVerification, 'variantPrice' | 'cost' | 'inventoryQuantity' | 'inventoryTracked'>> {
  const out = { variantPrice: null as number | null, cost: null as number | null, inventoryQuantity: null as number | null, inventoryTracked: null as boolean | null };
  const v = pickVariant(product, sku);
  if (!v) return out;
  out.variantPrice = num(v.price);
  const itemId = v.inventory_item_id ? String(v.inventory_item_id) : '';
  if (!itemId) return out;
  try {
    const r = await call(config, `/admin/api/${config.apiVersion}/inventory_items/${itemId}.json`);
    if (r.ok && r.data?.inventory_item) {
      out.cost = num(r.data.inventory_item.cost);
      out.inventoryTracked = typeof r.data.inventory_item.tracked === 'boolean' ? r.data.inventory_item.tracked : null;
    }
  } catch { /* leave null */ }
  const loc = String(config.primaryLocationId || '').trim();
  if (loc) {
    try {
      const r = await call(config, `/admin/api/${config.apiVersion}/inventory_levels.json?inventory_item_ids=${itemId}&location_ids=${encodeURIComponent(loc)}`);
      const lvl = r.ok && Array.isArray(r.data?.inventory_levels) ? r.data.inventory_levels.find((l: any) => String(l.location_id) === loc) : undefined;
      if (lvl) out.inventoryQuantity = num(lvl.available);
    } catch { /* leave null */ }
  }
  return out;
}

/**
 * Applies price / cost / stock / (optional) category to a draft this app owns.
 * `scope` MUST have been built from a product created by this app in this call, or a
 * draft re-verified (status draft + app marker) in this call. Writes happen only when
 * the Shopify value differs, so retries are idempotent.
 */
async function applyDraftFields(
  config: ShopifyBackendConfig,
  product: any,
  input: DraftProductInput,
  scope: DraftWriteScope,
  warnings: string[],
  codes: string[]
): Promise<void> {
  const warn = (code: string, msg: string) => { warnings.push(`${code}: ${msg}`); codes.push(code); };
  const api = `/admin/api/${config.apiVersion}`;
  const v = pickVariant(product, input.sku);
  if (!v) {
    warn('variant_not_found', 'Could not identify the draft variant; price/cost/stock were not reconciled.');
    return;
  }
  const productId = String(product.id);

  // Price (variant of this draft only)
  const wantPrice = parseFloat(String(input.price ?? ''));
  if (Number.isFinite(wantPrice) && wantPrice > 0) {
    const have = num(v.price);
    if (have === null || Math.abs(have - wantPrice) > 0.004) {
      const r = await call(config, `${api}/variants/${v.id}.json`, 'PUT', { variant: { id: Number(v.id), price: wantPrice.toFixed(2) } }, scope);
      if (!r.ok) warn('price_set_failed', `Shopify rejected the variant price update (HTTP ${r.status}).`);
    }
  }

  const itemId = v.inventory_item_id ? String(v.inventory_item_id) : '';
  if (!itemId) {
    warn('inventory_not_set', 'The draft variant has no inventory item id; cost and stock were not set.');
  } else {
    // Cost + tracking
    const wantCost = parseFloat(String(input.cost ?? ''));
    const iiRes = await call(config, `${api}/inventory_items/${itemId}.json`);
    const ii = iiRes.ok ? iiRes.data?.inventory_item : undefined;
    const patch: Record<string, any> = {};
    if (!ii || ii.tracked !== true) patch.tracked = true;
    if (Number.isFinite(wantCost) && wantCost > 0) {
      const haveCost = num(ii?.cost);
      if (haveCost === null || Math.abs(haveCost - wantCost) > 0.004) patch.cost = wantCost.toFixed(2);
    }
    if (Object.keys(patch).length > 0) {
      const r = await call(config, `${api}/inventory_items/${itemId}.json`, 'PUT', { inventory_item: { id: Number(itemId), ...patch } }, scope);
      if (!r.ok) warn('cost_set_failed', `Shopify rejected the inventory item update (HTTP ${r.status}).`);
    }

    // Stock at the configured location (never guessed)
    const loc = String(config.primaryLocationId || '').trim();
    const qty = input.quantity;
    if (!loc) {
      warn('inventory_not_set', 'SHOPIFY_PRIMARY_LOCATION_ID is not configured, so stock was NOT set. Price and cost were saved. Set the location id and re-send, or enter stock in Shopify admin.');
    } else if (qty === undefined || !Number.isInteger(qty) || qty < 0) {
      warn('inventory_not_set', 'The item has no valid stock quantity, so stock was NOT set.');
    } else {
      const lv = await call(config, `${api}/inventory_levels.json?inventory_item_ids=${itemId}&location_ids=${encodeURIComponent(loc)}`);
      const lvl = lv.ok && Array.isArray(lv.data?.inventory_levels) ? lv.data.inventory_levels.find((l: any) => String(l.location_id) === loc) : undefined;
      if (!lvl || num(lvl.available) !== qty) {
        const r = await call(config, `${api}/inventory_levels/set.json`, 'POST',
          { location_id: Number(loc), inventory_item_id: Number(itemId), available: qty }, scope);
        if (!r.ok) warn('inventory_set_failed', `Shopify rejected the stock update at location ${loc} (HTTP ${r.status}).`);
      }
    }
  }

  // Category (optional taxonomy mapping; never invented)
  const gid = input.typeCode ? getCategoryTaxonomyMap()[input.typeCode.trim().toUpperCase()] : undefined;
  if (!gid) {
    warn('category_taxonomy_not_set', 'No Shopify taxonomy category mapping for this jewellery type. Product type and tags were set; assign the category manually during draft review.');
  } else {
    const productGid = `gid://shopify/Product/${productId}`;
    let have = '';
    try {
      const q = await call(config, `${api}/graphql.json`, 'POST', {
        query: 'query productCategory($id: ID!) { product(id: $id) { category { id } } }',
        variables: { id: productGid },
      });
      have = String(q.data?.data?.product?.category?.id || '');
    } catch { /* treat as unknown */ }
    if (have !== gid) {
      const r = await call(config, `${api}/graphql.json`, 'POST', {
        query: 'mutation setCategory($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }',
        variables: { product: { id: productGid, category: gid } },
      }, scope);
      const errs = r.data?.data?.productUpdate?.userErrors;
      if (!r.ok || r.data?.errors || (Array.isArray(errs) && errs.length > 0)) {
        warn('category_set_failed', `Shopify did not accept the category (${Array.isArray(errs) && errs[0]?.message ? errs[0].message : `HTTP ${r.status}`}). Assign it manually.`);
      }
    }
  }
}

async function readProduct(config: ShopifyBackendConfig, productId: string): Promise<any> {
  const r = await call(config, `/admin/api/${config.apiVersion}/products/${productId}.json`);
  if (!r.ok || !r.data?.product) throw new Error(`HTTP ${r.status}`);
  return r.data.product;
}

/**
 * Gate for any write to an existing product (media sync). Throws unless the
 * product is verified draft AND carries the app marker tag. Returns the
 * product's current image alts so callers can avoid re-uploading.
 */
export async function assertProductWritableDraft(
  config: ShopifyBackendConfig,
  productId: string
): Promise<{ existingAlts: string[]; mediaCount: number }> {
  let p: any;
  try {
    const r = await call(config, `/admin/api/${config.apiVersion}/products/${productId}.json`);
    if (!r.ok || !r.data?.product) {
      throw new ShopifyDraftGuardError('product_unverifiable', `Shopify product ${productId} could not be verified (HTTP ${r.status}); not writing.`);
    }
    p = r.data.product;
  } catch (e: any) {
    if (e instanceof ShopifyDraftGuardError) throw e;
    throw new ShopifyDraftGuardError('product_unverifiable', `Shopify product ${productId} could not be verified (${e.message}); not writing.`);
  }
  const status = String(p.status || '').toLowerCase();
  if (status !== SHOPIFY_DRAFT_STATUS) {
    throw new ShopifyDraftGuardError('product_not_draft', `Shopify product ${productId} is "${status || 'unknown'}", not draft; refusing to modify it.`);
  }
  if (!hasMarker(normTags(p.tags))) {
    throw new ShopifyDraftGuardError('product_not_app_owned', `Shopify draft ${productId} was not created by SaazLedger; refusing to modify it.`);
  }
  const images: any[] = Array.isArray(p.images) ? p.images : [];
  return { existingAlts: images.map((i) => String(i.alt || '')).filter(Boolean), mediaCount: images.length };
}

function buildCreatePayload(input: DraftProductInput, variant: 'full' | 'no_images') {
  const price = parseFloat(String(input.price ?? '')) || 0;
  const tags = Array.from(new Set([APP_MARKER_TAG, ...(input.tags || [])])).join(', ');
  const product: Record<string, any> = {
    title: input.title,
    body_html: input.description || `<p>${input.title}</p>`,
    vendor: input.vendor || 'Saaz Aura Atelier',
    product_type: input.category || 'Jewelry',
    tags,
    variants: [{
      sku: (input.sku || '').trim() || undefined,
      price: price > 0 ? price.toFixed(2) : '0.00',
      // Stock/cost are applied right after creation by applyDraftFields (scoped, guarded writes).
      inventory_management: 'shopify',
      inventory_policy: 'deny',
    }],
  };
  if (variant === 'full' && input.images && input.images.length > 0) product.images = input.images;
  return { product: forceDraftStatus(product) };
}

/**
 * Looks up, then (only if conclusively absent) creates a DRAFT product, then verifies it.
 * Never creates after an inconclusive lookup; never modifies live products.
 */
export async function ensureDraftProduct(
  config: ShopifyBackendConfig,
  input: DraftProductInput,
  opts: { linkedProductIds?: Array<string | undefined | null> } = {}
): Promise<DraftEnsureResult> {
  const warnings: string[] = [];
  const linkedIds = Array.from(new Set((opts.linkedProductIds || []).map((x) => String(x || '').replace(/\D/g, '')).filter(Boolean)));

  const lookup = await findExistingProducts(config, { sku: input.sku, title: input.title, linkedIds });
  const decision = classifyLookup(config, lookup, input.sku);

  if (decision.kind === 'block') {
    return { ok: false, action: 'blocked', review: decision.review, error: decision.review.reason, warnings };
  }

  if (decision.kind === 'reuse') {
    const verification = await verifyDraftProduct(config, decision.candidate.id, { correct: false });
    if (!verification.isDraft) {
      return {
        ok: false,
        action: 'blocked',
        productId: decision.candidate.id,
        verification,
        review: review(config, 'unknown_status_match', verification.warning || 'Could not re-verify draft status.', [decision.candidate]),
        error: verification.warning,
        warnings,
      };
    }
    // Re-verify ownership in THIS call (draft + app marker) before granting a write scope.
    const codes: string[] = [];
    try {
      const prod = await readProduct(config, decision.candidate.id);
      if (String(prod.status || '').toLowerCase() === SHOPIFY_DRAFT_STATUS && hasMarker(normTags(prod.tags))) {
        const scope = createDraftWriteScope(config.primaryLocationId);
        grantDraftScope(scope, prod.id, prod.variants || []);
        await applyDraftFields(config, prod, input, scope, warnings, codes);
      }
    } catch (e: any) {
      if (e instanceof ShopifyDraftGuardError) throw e;
      warnings.push(`fields_not_reconciled: ${e.message}`);
      codes.push('fields_not_reconciled');
    }
    const finalVerification = await verifyDraftProduct(config, decision.candidate.id, { correct: false, sku: input.sku });
    return { ok: true, action: 'reused_draft', productId: decision.candidate.id, verification: finalVerification, warnings, warningCodes: codes };
  }

  // CREATE (lookup was conclusive and found nothing)
  const path = `/admin/api/${config.apiVersion}/products.json`;
  const variants: Array<'full' | 'no_images'> = input.images?.length ? ['full', 'no_images'] : ['no_images'];
  let created: any = null;
  let lastError = '';
  for (const v of variants) {
    let r: Call;
    try {
      r = await call(config, path, 'POST', buildCreatePayload(input, v));
    } catch (e: any) {
      if (e instanceof ShopifyDraftGuardError) throw e;
      // Network error/timeout: the product may or may not exist. Do NOT retry (would risk a duplicate).
      return {
        ok: false,
        action: 'failed',
        error: `Shopify create request failed (${e.message}); outcome unknown, not retrying to avoid duplicates.`,
        review: review(config, 'create_outcome_unknown',
          `The create request failed in transit (${e.message}). The draft may exist on Shopify; check before retrying.`, []),
        warnings,
      };
    }
    if (r.ok && r.data?.product?.id) {
      created = r.data.product;
      break;
    }
    lastError = `HTTP ${r.status}: ${typeof r.data?.errors === 'string' ? r.data.errors : JSON.stringify(r.data?.errors ?? r.data ?? {})}`;
    // Only definite validation rejections (nothing created) are safe to retry with a simpler draft payload.
    if (r.status !== 400 && r.status !== 422) {
      return {
        ok: false,
        action: 'failed',
        error: `Shopify create failed (${lastError}); not retrying.`,
        review: r.status >= 500
          ? review(config, 'create_outcome_unknown', `Shopify returned ${r.status}; the draft may exist. Check before retrying.`, [])
          : undefined,
        warnings,
      };
    }
  }
  if (!created) {
    return { ok: false, action: 'failed', error: `Could not create draft product: ${lastError}`, warnings };
  }

  const productId = String(created.id);
  const codes: string[] = [];
  // Scope = exactly the variant / inventory item ids of the product created by THIS call.
  const scope = createDraftWriteScope(config.primaryLocationId);
  try {
    let prod = created;
    if (!(prod.variants || []).every((v: any) => v.inventory_item_id) || String(prod.status || '').toLowerCase() !== SHOPIFY_DRAFT_STATUS) {
      prod = await readProduct(config, productId);
    }
    if (String(prod.status || '').toLowerCase() !== SHOPIFY_DRAFT_STATUS) {
      // Never write price/cost/stock to anything that is not a confirmed draft; verification below
      // only tries to set it back to draft and reports loudly.
      warnings.push('fields_not_applied: product is not a confirmed draft, so price/cost/stock were not written.');
      codes.push('fields_not_applied');
    } else {
      grantDraftScope(scope, productId, prod.variants || []);
      await applyDraftFields(config, prod, input, scope, warnings, codes);
    }
  } catch (e: any) {
    if (e instanceof ShopifyDraftGuardError) throw e;
    warnings.push(`fields_not_reconciled: ${e.message}`);
    codes.push('fields_not_reconciled');
  }
  const verification = await verifyDraftProduct(config, productId, { correct: true, sku: input.sku });
  if (verification.warning) warnings.push(verification.warning);
  return {
    warningCodes: codes,
    ok: true,
    action: 'created',
    productId,
    variantId: created.variants?.[0]?.id ? String(created.variants[0].id) : undefined,
    verification,
    warnings,
  };
}
