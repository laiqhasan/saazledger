// Compatibility wrapper around the gallery implementation.
// Adds exact-white product metadata and normalizes UI quick-action image sources
// without disturbing the established 5-slot pipeline.

import {
  buildRecommendedGalleryPack as baseBuildRecommendedGalleryPack,
  regenerateSingleSlot as baseRegenerateSingleSlot,
} from './galleryPackService.impl';

export * from './galleryPackService.impl';

type BuildParams = Parameters<typeof baseBuildRecommendedGalleryPack>[0];
type RegenerateParams = Parameters<typeof baseRegenerateSingleSlot>[2];
type PackResult = Awaited<ReturnType<typeof baseBuildRecommendedGalleryPack>>;

const EXACT_WHITE_PRESET = 'ecommerce_white_product';

function normalizeExactWhiteSlot(slot: any, productTitle: string): any {
  if (!slot) return slot;
  return {
    ...slot,
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

function normalizePack(pack: PackResult, exactSlotNumber?: number): PackResult {
  const slots = (pack.slots || []).map((slot: any) => {
    if (slot.slotRole === 'DETAIL_CLOSEUP') {
      return {
        ...slot,
        slotTitle: 'Product Detail - Complete Earrings + Pendant (Safe Crop)',
      };
    }

    if (
      slot.modelPresetKey === EXACT_WHITE_PRESET ||
      (exactSlotNumber && slot.slotNumber === exactSlotNumber)
    ) {
      return normalizeExactWhiteSlot(slot, pack.productTitle);
    }

    return slot;
  });

  const usable = slots.filter(
    (slot: any) => !slot.generationFailed && Boolean(slot.url || slot.imageUrl) && slot.included !== false
  );

  return {
    ...pack,
    slots,
    totalRealImagesUsed: usable.filter((slot: any) => !slot.isAiGenerated).length,
    totalAiImagesUsed: usable.filter((slot: any) => Boolean(slot.isAiGenerated)).length,
  } as PackResult;
}

/** Build the normal gallery, then normalize the special exact-white Slot 4. */
export async function buildRecommendedGalleryPack(params: BuildParams): Promise<PackResult> {
  const pack = await baseBuildRecommendedGalleryPack(params);
  return normalizePack(
    pack,
    params.modelPresetKey === EXACT_WHITE_PRESET ? 4 : undefined
  );
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

  const targetBefore = currentPack.slots.find((s: any) => s.slotNumber === slotNumber);
  const effectivePreset =
    normalizedOptions.newPresetKey || targetBefore?.modelPresetKey;

  return normalizePack(
    result,
    effectivePreset === EXACT_WHITE_PRESET ? Number(slotNumber) : undefined
  );
}
