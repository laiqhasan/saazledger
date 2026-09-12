// Compatibility wrapper around the gallery implementation.
// Keeps the established generation pipeline, while enforcing a stable five-slot
// contract for the UI/tests and adding the exact-white e-commerce preset.

import path from 'path';
import fs from 'fs';
import { DERIVATIVES_DIR } from '../photoService';
import {
  buildRecommendedGalleryPack as baseBuildRecommendedGalleryPack,
  regenerateSingleSlot as baseRegenerateSingleSlot,
  getItemBuffer,
  type GallerySlot,
  type RecommendedGalleryPack,
} from './galleryPackService.impl';
import {
  createDetailCraftsmanshipCrop,
  createEarringComponentCrop,
  validateGalleryAsset,
} from './deterministicImageService';
import {
  getSourceHash,
  getIsolatedMasterPath,
} from './backgroundRemovalService';
import {
  STYLED_SLOT2_PRESETS,
  type StyledSlot2Option,
} from './modelImageGeneratorService';

export * from './galleryPackService.impl';

type BuildParams = Parameters<typeof baseBuildRecommendedGalleryPack>[0];
type RegenerateParams = Parameters<typeof baseRegenerateSingleSlot>[2];
type PackResult = Awaited<ReturnType<typeof baseBuildRecommendedGalleryPack>>;

const EXACT_WHITE_PRESET = 'ecommerce_white_product';

/**
 * Public SEO alt-text contract used by the UI and acceptance tests.
 * Keep the wording descriptive while avoiding keyword stuffing.
 */
export function generateSlotAltText(
  productTitle: string,
  slotRole: GallerySlot['slotRole'],
  detailNote?: string
): string {
  const cleanTitle = productTitle.replace(/\s+/g, ' ').trim();
  switch (slotRole) {
    case 'HERO_COVER':
      return `Main commercial clean background front view of ${cleanTitle}`;
    case 'STYLED_SUPPORTING':
      return detailNote || `Styled flat-lay presentation of ${cleanTitle}`;
    case 'ALT_VIEW':
      return `Alternate angle view of ${cleanTitle}`;
    case 'DETAIL_CLOSEUP':
      return detailNote || `Close-up craftsmanship view of ${cleanTitle}`;
    case 'MODEL_1':
      return `Fashion model wearing ${cleanTitle}`;
    case 'MODEL_2_OR_SUPPORTING':
      return detailNote || `Supporting product view of ${cleanTitle}`;
    case 'REAL_PHOTO_FALLBACK':
      return detailNote || `Original product photo of ${cleanTitle}`;
    default:
      return `${cleanTitle} jewellery view`;
  }
}

function normalizeExactWhiteSlot(slot: GallerySlot, productTitle: string): GallerySlot {
  return {
    ...slot,
    slotNumber: 4,
    slotRole: slot.slotRole === 'MODEL_1' ? 'ALT_VIEW' : slot.slotRole,
    slotTitle: 'E-Commerce White Product (Exact)',
    sourceType: 'DERIVATIVE',
    altText: `Pure white e-commerce product view of ${productTitle}`,
    qualityScore: 100,
    isAiGenerated: false,
    modelPresetKey: EXACT_WHITE_PRESET,
    generationFailed: false,
    generationError: undefined,
    included: Boolean(slot.url || slot.imageUrl),
  };
}

/**
 * The implementation historically renumbered the final array sequentially.
 * That caused a genuine Slot 5 component image to become Slot 4 whenever Slot 4
 * was omitted. Restore numbers from the semantic role instead of array position.
 */
function canonicalSlotNumber(slot: GallerySlot): number {
  switch (slot.slotRole) {
    case 'HERO_COVER':
      return 1;
    case 'STYLED_SUPPORTING':
      return 2;
    case 'DETAIL_CLOSEUP':
      return 3;
    case 'MODEL_1':
      return 4;
    case 'MODEL_2_OR_SUPPORTING':
      return 5;
    case 'REAL_PHOTO_FALLBACK':
      return 5;
    case 'ALT_VIEW':
      // Alternate views are normally Slot 2. A later alternate/supporting image
      // (including the exact-white preset) belongs in Slot 4.
      return slot.slotNumber <= 2 ? 2 : 4;
    default:
      return slot.slotNumber;
  }
}

function styleAltText(slot: GallerySlot, productTitle: string): string {
  if (slot.slotRole !== 'STYLED_SUPPORTING') return slot.altText;
  const option = slot.styledOption as StyledSlot2Option | undefined;
  const styleName = option
    ? STYLED_SLOT2_PRESETS[option]?.name || 'Silk & Flowers'
    : 'Silk & Flowers';
  return `${styleName} styled flat-lay presentation of ${productTitle}`;
}

function normalizePack(pack: PackResult, exactSlotNumber?: number): PackResult {
  const slots = (pack.slots || [])
    .map((rawSlot: GallerySlot) => {
      let slot: GallerySlot = { ...rawSlot };

      if (
        slot.modelPresetKey === EXACT_WHITE_PRESET ||
        (exactSlotNumber && slot.slotNumber === exactSlotNumber)
      ) {
        slot = normalizeExactWhiteSlot(slot, pack.productTitle);
      }

      slot.slotNumber = canonicalSlotNumber(slot);

      if (slot.slotRole === 'HERO_COVER') {
        slot = {
          ...slot,
          slotTitle:
            slot.currentBgMode === 'pure_white' || slot.cleanCoverUrl
              ? 'Main Cover / Hero (Clean Background - Pure White E-Commerce)'
              : 'Main Cover / Hero (Clean Background Needs Review)',
          altText: generateSlotAltText(pack.productTitle, 'HERO_COVER'),
        };
      } else if (slot.slotRole === 'DETAIL_CLOSEUP') {
        slot = {
          ...slot,
          slotTitle: 'Product Detail - Complete Earrings + Pendant (Safe Crop)',
          altText: generateSlotAltText(pack.productTitle, 'DETAIL_CLOSEUP'),
        };
      } else if (slot.slotRole === 'STYLED_SUPPORTING') {
        slot = {
          ...slot,
          altText: styleAltText(slot, pack.productTitle),
        };
      } else if (slot.slotRole === 'ALT_VIEW') {
        slot = {
          ...slot,
          altText:
            slot.modelPresetKey === EXACT_WHITE_PRESET
              ? slot.altText
              : generateSlotAltText(pack.productTitle, 'ALT_VIEW'),
        };
      } else if (slot.slotRole === 'MODEL_1') {
        slot = {
          ...slot,
          altText: generateSlotAltText(pack.productTitle, 'MODEL_1'),
        };
      }

      return slot;
    })
    .sort((a, b) => a.slotNumber - b.slotNumber);

  const warnings = [...(pack.warnings || [])];
  if (
    warnings.some((w) => /Only \d+ high-quality real image\(s\) detected/i.test(w)) &&
    !warnings.some((w) => w.includes('Minimum recommended for a premium gallery is 3 real photos'))
  ) {
    warnings.unshift(
      'Minimum recommended for a premium gallery is 3 real photos. Additional images can be generated or derived safely from the authentic product source.'
    );
  }

  const usable = slots.filter(
    (slot) => !slot.generationFailed && Boolean(slot.url || slot.imageUrl) && slot.included !== false
  );
  const generated = slots.filter(
    (slot) => !slot.generationFailed && Boolean(slot.url || slot.imageUrl)
  );
  const heroReady = usable.some(
    (slot) => slot.slotRole === 'HERO_COVER' && slot.currentBgMode === 'pure_white'
  );

  return {
    ...pack,
    slots,
    warnings,
    totalRealImagesUsed: generated.filter((slot) => !slot.isAiGenerated).length,
    totalAiImagesUsed: generated.filter((slot) => Boolean(slot.isAiGenerated)).length,
    isListingReady: heroReady && usable.length >= 3,
  } as PackResult;
}

function isLegacyOrSeededItem(item: any): boolean {
  const id = String(item?.id || '').toLowerCase();
  return (
    id === 'existing-hero' ||
    id.startsWith('existing-') ||
    id.startsWith('auto-seed') ||
    id.startsWith('seeded-') ||
    id.startsWith('legacy-foreign')
  );
}

function itemUrl(item: any): string {
  return (
    item?.shopifySquareUrl ||
    item?.imageUrl ||
    item?.url ||
    (item?.originalFilename ? `/api/photos/${item.originalFilename}` : '')
  );
}

function realFallbackSlot(params: {
  slotNumber: number;
  slotRole: GallerySlot['slotRole'];
  title: string;
  mediaId: string;
  url: string;
  productTitle: string;
  sourceType?: GallerySlot['sourceType'];
  qualityScore?: number;
  altText?: string;
}): GallerySlot {
  return {
    slotNumber: params.slotNumber,
    slotRole: params.slotRole,
    slotTitle: params.title,
    mediaId: params.mediaId,
    url: params.url,
    imageUrl: params.url,
    sourceType: params.sourceType || 'real_photo',
    isCover: false,
    altText:
      params.altText || generateSlotAltText(params.productTitle, params.slotRole),
    qualityScore: params.qualityScore || 0,
    isAiGenerated: false,
    canRegenerate: true,
    dimensions: { width: 2048, height: 2048 },
    included: Boolean(params.url),
  };
}

/**
 * Guarantee stable semantic slots 1..targetCount.
 *
 * If AI generation is disabled and there are not enough uploaded photos, derive
 * safe real-product support images from the authentic source rather than
 * collapsing Slot 5 into Slot 4 or borrowing an unrelated seeded image.
 */
async function ensureCanonicalSlotCoverage(
  normalizedPack: PackResult,
  params: BuildParams
): Promise<PackResult> {
  const targetCount = Math.max(3, Math.min(5, params.targetSlotCount || 5));
  const sourceModes = (params as any).sourceModes || {};
  const isSkipped = (card: 'white' | 'model' | 'detail' | 'silk' | 'original') =>
    sourceModes[card] === 'skip' || sourceModes[card] === 'manual';
  const slots = [...normalizedPack.slots];

  const candidates = (params.clusteredItems || []).filter(
    (item: any) => item?.analysis?.roleSuggestion !== 'DUPLICATE' && !item?.analysis?.isBlurry
  );
  const pool = candidates.length ? candidates : params.clusteredItems || [];

  const heroSlot = slots.find((slot) => slot.slotNumber === 1);
  const heroSource = pool.find((item: any) => item.id === heroSlot?.mediaId);
  const authenticSource =
    (heroSource && !isLegacyOrSeededItem(heroSource) ? heroSource : undefined) ||
    pool.find((item: any) => !isLegacyOrSeededItem(item)) ||
    pool[0];

  if (!authenticSource) return normalizedPack;

  const sourceBuffer = getItemBuffer(authenticSource);
  const sourceUrl = itemUrl(authenticSource);
  const sourceQuality = authenticSource.analysis?.qualityScore || 0;

  if (targetCount >= 2 && !isSkipped('silk') && !slots.some((slot) => slot.slotNumber === 2)) {
    const alternate =
      pool.find(
        (item: any) =>
          item.id !== authenticSource.id && !isLegacyOrSeededItem(item)
      ) || authenticSource;
    const url = itemUrl(alternate);
    slots.push(
      realFallbackSlot({
        slotNumber: 2,
        slotRole: 'ALT_VIEW',
        title: 'Alternate Full View',
        mediaId: `support_slot2_${alternate.id}`,
        url,
        productTitle: params.productTitle,
        qualityScore: alternate.analysis?.qualityScore || sourceQuality,
      })
    );
  }

  if (targetCount >= 3 && !isSkipped('detail') && !slots.some((slot) => slot.slotNumber === 3)) {
    let detailBuffer: Buffer | null = null;
    let isolatedMasterBuf: Buffer | undefined = undefined;
    let whiteProductBuf: Buffer | undefined = undefined;

    if (sourceBuffer) {
      const sHash = getSourceHash(sourceBuffer);
      const mInfo = getIsolatedMasterPath(sHash);
      if (fs.existsSync(mInfo.filepath)) {
        try {
          isolatedMasterBuf = fs.readFileSync(mInfo.filepath);
        } catch {}
      }
    }

    if (!isolatedMasterBuf && heroSlot?.url) {
      const heroFilename = path.basename(heroSlot.url);
      const heroPath = path.join(DERIVATIVES_DIR, heroFilename);
      if (fs.existsSync(heroPath)) {
        try {
          whiteProductBuf = fs.readFileSync(heroPath);
        } catch {}
      }
    }

    if (isolatedMasterBuf) {
      detailBuffer = isolatedMasterBuf;
    } else if (whiteProductBuf) {
      detailBuffer = whiteProductBuf;
    } else if (sourceBuffer) {
      try {
        const { getOrCreateIsolatedMasterPng } = await import('./backgroundRemovalService');
        const iso = await getOrCreateIsolatedMasterPng(sourceBuffer);
        isolatedMasterBuf = iso.buffer;
        detailBuffer = iso.buffer;
      } catch {}
    }

    if (!detailBuffer) {
      detailBuffer = sourceBuffer;
    }

    if (detailBuffer) {
      try {
        const detailFilename = `detail_closeup_${authenticSource.id}.jpg`;
        const detail = await createDetailCraftsmanshipCrop(
          detailBuffer,
          detailFilename,
          'pendant',
          undefined,
          {
            isolatedMasterBuffer: isolatedMasterBuf,
            whiteProductBuffer: whiteProductBuf,
          }
        );
        const validation = await validateGalleryAsset(detail.buffer, 'DETAIL_CLOSEUP');
        slots.push(
          realFallbackSlot({
            slotNumber: 3,
            slotRole: 'DETAIL_CLOSEUP',
            title: 'Detail / Craftsmanship Close-up',
            mediaId: `${authenticSource.id}_detail`,
            url: detail.relativeUrl,
            productTitle: params.productTitle,
            sourceType: 'detail_crop',
            qualityScore: sourceQuality,
          })
        );
        const lastSlot = slots[slots.length - 1];
        if (!validation.valid && lastSlot) {
          lastSlot.included = false;
          lastSlot.generationFailed = true;
          lastSlot.generationError = validation.reason;
        }
      } catch (err: any) {
        slots.push({
          slotNumber: 3,
          slotRole: 'DETAIL_CLOSEUP',
          slotTitle: 'Detail / Craftsmanship Close-up (Failed)',
          mediaId: `${authenticSource.id}_detail_failed`,
          url: '',
          imageUrl: '',
          sourceType: 'detail_crop',
          isCover: false,
          altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
          qualityScore: 0,
          isAiGenerated: false,
          canRegenerate: true,
          included: false,
          generationFailed: true,
          generationError: err.message || 'Failed to create clean detail crop',
        });
      }
    }
  }

  if (targetCount >= 4 && !isSkipped('model') && !slots.some((slot) => slot.slotNumber === 4)) {
    // When a model was requested, the base implementation normally leaves a
    // failed MODEL_1 card if generation fails. This branch is primarily the
    // deterministic fallback for Model Generation = off.
    if (sourceBuffer) {
      try {
        const support = await createDetailCraftsmanshipCrop(
          sourceBuffer,
          `${authenticSource.id}_support_slot4_2048.jpg`,
          'stones'
        );
        slots.push(
          realFallbackSlot({
            slotNumber: 4,
            slotRole: 'ALT_VIEW',
            title: 'Supporting Real Product Detail',
            mediaId: `support_slot4_${authenticSource.id}`,
            url: support.relativeUrl,
            productTitle: params.productTitle,
            sourceType: 'detail_crop',
            qualityScore: sourceQuality,
          })
        );
      } catch {
        slots.push(
          realFallbackSlot({
            slotNumber: 4,
            slotRole: 'ALT_VIEW',
            title: 'Supporting Real Product View',
            mediaId: `support_slot4_${authenticSource.id}`,
            url: sourceUrl,
            productTitle: params.productTitle,
            qualityScore: sourceQuality,
          })
        );
      }
    }
  }

  if (targetCount >= 5 && !isSkipped('original') && !slots.some((slot) => slot.slotNumber === 5)) {
    let isMeasurementRef = false;
    if (sourceBuffer) {
      try {
        const v = await validateGalleryAsset(sourceBuffer, 'REAL_PHOTO');
        if (v.forbiddenObjects.includes('ruler')) {
          isMeasurementRef = true;
        }
      } catch {}
    }

    const slot5 = realFallbackSlot({
      slotNumber: 5,
      slotRole: 'REAL_PHOTO_FALLBACK',
      title: isMeasurementRef ? 'Original Photo (Measurement Reference)' : 'Original Photo',
      mediaId: `original_slot5_${authenticSource.id}`,
      url: sourceUrl,
      productTitle: params.productTitle,
      qualityScore: sourceQuality,
      altText: isMeasurementRef
        ? `Original measurement reference photo with scale for ${params.productTitle}`
        : `Original product photo of ${params.productTitle}`,
    });
    slot5.included = !isMeasurementRef;
    slot5.measurementReference = isMeasurementRef;
    slot5.slotBadge = isMeasurementRef ? 'Measurement Reference' : undefined;
    slots.push(slot5);
  }

  const exactSlot = params.modelPresetKey === EXACT_WHITE_PRESET ? 4 : undefined;
  return normalizePack({ ...normalizedPack, slots } as PackResult, exactSlot);
}

/** Build the normal gallery, normalize semantic slot numbers, then fill safe gaps. */
export async function buildRecommendedGalleryPack(params: BuildParams): Promise<PackResult> {
  const basePack = await baseBuildRecommendedGalleryPack(params);
  const exactSlot = params.modelPresetKey === EXACT_WHITE_PRESET ? 4 : undefined;
  const normalized = normalizePack(basePack, exactSlot);
  return ensureCanonicalSlotCoverage(normalized, params);
}

/**
 * Regenerate/add one slot safely.
 *
 * The client sometimes passes `/api/photos/...` in sourceBase64 even though it
 * is a URL. The old implementation attempted Buffer.from(url, 'base64'), which
 * produces invalid image bytes and can leave Styled/Model cards blank. Convert
 * URL-like values to sourceImageUrl before handing off to the established logic.
 */
export async function regenerateSingleSlot(
  currentPack: Parameters<typeof baseRegenerateSingleSlot>[0],
  slotNumber: Parameters<typeof baseRegenerateSingleSlot>[1],
  options: RegenerateParams
): Promise<Awaited<ReturnType<typeof baseRegenerateSingleSlot>>> {
  const normalizedOptions: RegenerateParams = { ...options };
  const candidate = normalizedOptions.sourceBase64;

  if (
    candidate &&
    !candidate.startsWith('data:image/') &&
    (candidate.startsWith('/api/') ||
      candidate.startsWith('http://') ||
      candidate.startsWith('https://'))
  ) {
    normalizedOptions.sourceImageUrl =
      normalizedOptions.sourceImageUrl || candidate;
    normalizedOptions.sourceBase64 = undefined;
  }

  const result = await baseRegenerateSingleSlot(
    currentPack,
    slotNumber,
    normalizedOptions
  );

  const targetBefore = currentPack.slots.find((s) => s.slotNumber === slotNumber);
  const effectivePreset =
    normalizedOptions.newPresetKey || targetBefore?.modelPresetKey;

  return normalizePack(
    result,
    effectivePreset === EXACT_WHITE_PRESET ? Number(slotNumber) : undefined
  );
}
