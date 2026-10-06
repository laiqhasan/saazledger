/**
 * Pure helpers shared by the Media Pack Studio UI and the server pack builder.
 * No DOM / React / Node imports so they can be unit-tested directly.
 *
 * Rules enforced here (single source of truth):
 *  - A failed, blank, clipped or forbidden-object output is never "ready".
 *  - A validator error always overrides a similarity score: no "HIGH MATCH" label, no percentage.
 *  - "Original" is only ever the true upload; generated/cropped images are "derivatives".
 *  - Source images are counted once per distinct upload; derivatives are counted separately.
 *  - Product Accuracy (deterministic exact cutout) is the default mode for the white-product slot.
 */

export type OutputStatus = 'ready' | 'needs_review' | 'failed';

/** Product Accuracy is the default processing mode for the Exact white-product slot. */
export const DEFAULT_WHITE_PROCESSING_MODE = 'product_accuracy' as const;
/** The server-side white-product mode that corresponds to Product Accuracy. */
export const DEFAULT_WHITE_PRODUCT_MODE = 'exact_cutout' as const;

export interface OriginalRef {
  mediaId?: string;
  url: string;
  filename?: string;
  width: number;
  height: number;
  sha256?: string;
  byteSize?: number;
}

export interface SlotLike {
  slotNumber?: number;
  slotRole?: string;
  url?: string;
  imageUrl?: string;
  generationFailed?: boolean;
  generationError?: string;
  included?: boolean;
  outputStatus?: OutputStatus;
  outputIssues?: string[];
  productMatchScore?: number;
  matchVerdict?: 'HIGH_MATCH' | 'REVIEW_RECOMMENDED' | 'NEEDS_REVIEW';
  whiteProductMode?: 'exact_cutout' | 'ai_presentation';
  mediaId?: string;
  mediaAssetId?: string;
  originalUrl?: string;
  sourceOriginal?: OriginalRef;
  measurementReference?: boolean;
  forbiddenObjects?: string[];
}

export function slotImageUrl(slot?: SlotLike | null): string {
  return String(slot?.url || slot?.imageUrl || '');
}

/** ready | needs_review | failed for one slot. */
export function getSlotOutputStatus(slot?: SlotLike | null): OutputStatus {
  if (!slot) return 'failed';
  if (slot.generationFailed || slot.outputStatus === 'failed') return 'failed';
  if (!slotImageUrl(slot)) return 'failed';
  if (slot.outputStatus === 'needs_review') return 'needs_review';
  if (slot.forbiddenObjects && slot.forbiddenObjects.length > 0) return 'needs_review';
  if (slot.included === false) return 'needs_review';
  return 'ready';
}

export function isSlotReady(slot?: SlotLike | null): boolean {
  return getSlotOutputStatus(slot) === 'ready';
}

/** Human readable reason a slot is not ready (validator reason first). */
export function getSlotProblemReason(slot?: SlotLike | null): string | undefined {
  if (!slot || isSlotReady(slot)) return undefined;
  if (slot.outputIssues && slot.outputIssues.length > 0) return slot.outputIssues.join(' ');
  if (slot.generationError) return slot.generationError;
  if (slot.forbiddenObjects && slot.forbiddenObjects.length > 0) {
    return `Forbidden object(s) detected: ${slot.forbiddenObjects.join(', ')}`;
  }
  if (!slotImageUrl(slot)) return 'No image was produced.';
  return 'Needs review before publishing.';
}

export interface MatchLabel {
  /** null => show NO similarity label / percentage at all */
  text: string | null;
  tone: 'high' | 'review' | 'needs_review' | 'failed';
}

/**
 * The only place a "HIGH MATCH - NN%" style label may be derived. A validator error (failed /
 * needs_review status, forbidden objects, blank/clipped output) overrides any score.
 */
export function getMatchLabel(slot?: SlotLike | null): MatchLabel {
  const status = getSlotOutputStatus(slot);
  if (status === 'failed') return { text: null, tone: 'failed' };
  if (status === 'needs_review') return { text: null, tone: 'needs_review' };
  const score = slot?.productMatchScore;
  if (score === undefined || score === null || Number.isNaN(score)) return { text: null, tone: 'review' };
  if (slot?.matchVerdict === 'NEEDS_REVIEW' || score < 80) return { text: `NEEDS REVIEW - ${score}%`, tone: 'needs_review' };
  if (score >= 90) return { text: `HIGH MATCH - ${score}%`, tone: 'high' };
  return { text: `REVIEW RECOMMENDED - ${score}%`, tone: 'review' };
}

// ─────────────────────────────────────────────────────────────────────────────
// True original resolution (crop editor / regeneration)
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors server-side isDerivativeReference: URLs that point at generated/cropped images. */
export function looksLikeDerivativeUrl(ref?: string | null): boolean {
  if (!ref || typeof ref !== 'string') return false;
  if (ref.startsWith('data:')) return false;
  const clean = ref.split('?')[0];
  if (/\/derivatives\//i.test(clean) || /^derivatives\//i.test(clean)) return true;
  const base = clean.split('/').pop() || '';
  return (
    /(_shopify_2048|_clean_cover|_exact_cutout|_isolated|_cutout|_detail|_white_product|_original_photo|_thumb|_social|_styled|_ai_|_master|_square|_whitebg|_white_bg)/i.test(base) ||
    /^crop_/i.test(base)
  );
}

export interface RawFileLike {
  id: string;
  name?: string;
  dataUrl: string;
  width?: number;
  height?: number;
}

export interface ResolvedOriginal {
  url: string;
  width?: number;
  height?: number;
  sha256?: string;
  mediaId?: string;
  /** where the true original came from */
  origin: 'browser_upload' | 'server_record' | 'slot_original_url';
}

/**
 * Resolves the TRUE original upload for a slot, or null when only derivatives are known.
 * Never returns the slot's own (derived) url / imageUrl / cleanCoverUrl / shopifySquareUrl.
 */
export function resolveTrueOriginal(slot: SlotLike | null | undefined, rawFiles: RawFileLike[]): ResolvedOriginal | null {
  if (!slot) return null;
  const ref = slot.sourceOriginal;
  const ids = [ref?.mediaId, slot.mediaId, slot.mediaAssetId].filter(Boolean) as string[];
  const raw = rawFiles.find((f) => f.id && ids.some((id) => id === f.id || id.includes(f.id)));
  if (raw?.dataUrl) {
    return { url: raw.dataUrl, width: raw.width ?? ref?.width, height: raw.height ?? ref?.height, sha256: ref?.sha256, mediaId: raw.id, origin: 'browser_upload' };
  }
  if (ref?.url && !looksLikeDerivativeUrl(ref.url)) {
    return { url: ref.url, width: ref.width, height: ref.height, sha256: ref.sha256, mediaId: ref.mediaId, origin: 'server_record' };
  }
  if (slot.originalUrl && !looksLikeDerivativeUrl(slot.originalUrl)) {
    return { url: slot.originalUrl, origin: 'slot_original_url' };
  }
  return null;
}

/** 'Original' only for the real upload; everything generated/cropped is a derivative. */
export function describeImageKind(isTrueOriginal: boolean): 'Original' | 'Derivative' {
  return isTrueOriginal ? 'Original' : 'Derivative';
}

// ─────────────────────────────────────────────────────────────────────────────
// Counts
// ─────────────────────────────────────────────────────────────────────────────

function cheapHash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  return `${value.length}:${h}`;
}

/** Number of distinct uploads (the same bytes added twice count once). */
export function countDistinctOriginals(files: Array<{ id?: string; dataUrl?: string; sha256?: string }>): number {
  const seen = new Set<string>();
  for (const f of files) {
    const key = f.sha256 || (f.dataUrl ? cheapHash(f.dataUrl) : f.id || '');
    if (key) seen.add(key);
  }
  return seen.size;
}

export interface StudioCounts {
  /** distinct uploaded source photos (originals) */
  sourceOriginals: number;
  /** derivative outputs that are usable (ready) - excludes failed / blank / clipped */
  derivativesReady: number;
  derivativesNeedingReview: number;
  derivativesFailed: number;
  /** slots that can be published right now (ready derivatives + the original-photo slot when ready) */
  readyToPublish: number;
  /** pieces represented by the sources. Several photos of one piece are ONE piece. */
  pieces: number;
}

function isOriginalPhotoSlot(slot: SlotLike): boolean {
  return slot.slotRole === 'REAL_PHOTO_FALLBACK';
}

export function computeStudioCounts(input: {
  rawFiles: Array<{ id?: string; dataUrl?: string; sha256?: string }>;
  slots: SlotLike[];
  /** distinct pieces if known (e.g. from server duplicate grouping); defaults to 1 per pack */
  pieces?: number;
}): StudioCounts {
  const sourceOriginals = countDistinctOriginals(input.rawFiles);
  let derivativesReady = 0;
  let derivativesNeedingReview = 0;
  let derivativesFailed = 0;
  let readyToPublish = 0;
  for (const slot of input.slots) {
    const status = getSlotOutputStatus(slot);
    if (status === 'ready') readyToPublish++;
    if (isOriginalPhotoSlot(slot)) continue; // the upload itself is not a derivative
    if (status === 'ready') derivativesReady++;
    else if (status === 'needs_review') derivativesNeedingReview++;
    else if (slot.generationFailed || slot.outputStatus === 'failed' || slotImageUrl(slot) === '') derivativesFailed++;
  }
  return {
    sourceOriginals,
    derivativesReady,
    derivativesNeedingReview,
    derivativesFailed,
    readyToPublish,
    pieces: input.pieces ?? (sourceOriginals > 0 ? 1 : 0),
  };
}
