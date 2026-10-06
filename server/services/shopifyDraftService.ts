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
}

export interface ShopifyDraftVerification {
  verified: boolean;
  productId?: string;
  status?: string;
  isDraft: boolean;
  mediaCount?: number;
  adminUrl?: string;
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

async function call(config: ShopifyBackendConfig, path: string, method = 'GET', body?: any): Promise<Call> {
  const r = await callShopifyAdminApi(path, { method, body, config });
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
  opts: { correct?: boolean } = {}
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
    return {
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
    variants: [{ sku: (input.sku || '').trim() || undefined, price: price > 0 ? price.toFixed(2) : '0.00' }],
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
    return { ok: true, action: 'reused_draft', productId: decision.candidate.id, verification, warnings };
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
  const verification = await verifyDraftProduct(config, productId, { correct: true });
  if (verification.warning) warnings.push(verification.warning);
  return {
    ok: true,
    action: 'created',
    productId,
    variantId: created.variants?.[0]?.id ? String(created.variants[0].id) : undefined,
    verification,
    warnings,
  };
}
