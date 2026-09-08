import type { ClusteredMediaItem } from './mediaAnalyzerService';
import {
  generateControlledModelImage,
  type ModelGenerationPreset,
  MODEL_STYLING_PRESETS,
} from './modelImageGeneratorService';

export interface GallerySlot {
  slotNumber: number; // 1 to 5 (or 6)
  slotRole: 'HERO_COVER' | 'ALT_VIEW' | 'DETAIL_CLOSEUP' | 'MODEL_1' | 'MODEL_2_OR_SUPPORTING';
  slotTitle: string;
  mediaId: string;
  imageUrl: string;
  sourceType: 'real_photo' | 'ai_model' | 'ai_lifestyle' | 'detail_crop';
  isCover: boolean;
  altText: string;
  qualityScore: number;
  isAiGenerated: boolean;
  modelPresetKey?: string;
  canRegenerate: boolean;
}

export interface RecommendedGalleryPack {
  productId?: string;
  productTitle: string;
  slots: GallerySlot[];
  warnings: string[];
  totalRealImagesUsed: number;
  totalAiImagesUsed: number;
  isListingReady: boolean;
}

/**
 * Generates descriptive, commercially useful SEO alt text per gallery slot.
 */
export function generateSlotAltText(
  productTitle: string,
  role: GallerySlot['slotRole'],
  customNote?: string
): string {
  const cleanTitle = productTitle.trim();
  switch (role) {
    case 'HERO_COVER':
      return `Main commercial front view of ${cleanTitle}`;
    case 'ALT_VIEW':
      return `Alternate angle view of ${cleanTitle}`;
    case 'DETAIL_CLOSEUP':
      return `Close-up craftsmanship view showing stone setting and finish of ${cleanTitle}`;
    case 'MODEL_1':
      return `Fashion model wearing ${cleanTitle}`;
    case 'MODEL_2_OR_SUPPORTING':
      return customNote || `Detail focus on components and matching earrings of ${cleanTitle}`;
    default:
      return `${cleanTitle} product photograph`;
  }
}

/**
 * Builds the optimal recommended 4–5 image Shopify gallery pack
 * based on uploaded clustered media items and model generation preferences.
 */
export async function buildRecommendedGalleryPack(params: {
  productTitle: string;
  productId?: string;
  clusteredItems: ClusteredMediaItem[];
  enableModelGeneration?: boolean;
  modelPresetKey?: string;
  modelPresetKey2?: string;
  customPrompt?: string;
  targetSlotCount?: number; // default 5 (min 3, max 6)
}): Promise<RecommendedGalleryPack> {
  const warnings: string[] = [];
  const targetCount = Math.max(3, Math.min(6, params.targetSlotCount || 5));

  // Filter out rejected low-quality / duplicate items for default selection
  const usableItems = params.clusteredItems.filter(
    (item) => item.analysis.roleSuggestion !== 'DUPLICATE' && !item.analysis.isBlurry
  );

  if (usableItems.length < 3) {
    warnings.push(
      `Only ${usableItems.length} high-quality real image(s) detected. Minimum recommended for a premium gallery is 3 real photos.`
    );
  }

  // Fallback to all items if usable items are insufficient
  const sourcePool = usableItems.length >= 2 ? usableItems : params.clusteredItems;

  // 1. Identify Slot 1 (Hero / Cover): Highest quality score
  const heroCandidate =
    sourcePool.find((item) => item.analysis.roleSuggestion === 'HERO_CANDIDATE') ||
    sourcePool[0] ||
    params.clusteredItems[0];

  const slots: GallerySlot[] = [];

  if (heroCandidate) {
    slots.push({
      slotNumber: 1,
      slotRole: 'HERO_COVER',
      slotTitle: 'Main Cover / Hero',
      mediaId: heroCandidate.id,
      imageUrl: (heroCandidate as any).shopifySquareUrl || `/api/photos/${heroCandidate.originalFilename}`,
      sourceType: 'real_photo',
      isCover: true,
      altText: generateSlotAltText(params.productTitle, 'HERO_COVER'),
      qualityScore: heroCandidate.analysis.qualityScore,
      isAiGenerated: false,
      canRegenerate: false,
    });
  }

  // 2. Identify Slot 2 (Alternate View): Second best distinct image
  const remainingAfterHero = sourcePool.filter((item) => item.id !== heroCandidate?.id);
  const altCandidate =
    remainingAfterHero.find((item) => item.analysis.roleSuggestion === 'ALT_VIEW') ||
    remainingAfterHero[0] ||
    heroCandidate;

  if (altCandidate) {
    slots.push({
      slotNumber: 2,
      slotRole: 'ALT_VIEW',
      slotTitle: 'Alternate Full View',
      mediaId: altCandidate.id,
      imageUrl: (altCandidate as any).shopifySquareUrl || `/api/photos/${altCandidate.originalFilename}`,
      sourceType: 'real_photo',
      isCover: false,
      altText: generateSlotAltText(params.productTitle, 'ALT_VIEW'),
      qualityScore: altCandidate.analysis.qualityScore,
      isAiGenerated: false,
      canRegenerate: false,
    });
  }

  // 3. Identify Slot 3 (Detail / Close-up View)
  const remainingAfterAlt = remainingAfterHero.filter((item) => item.id !== altCandidate?.id);
  const detailCandidate =
    remainingAfterAlt.find(
      (item) => item.analysis.roleSuggestion === 'DETAIL_VIEW' || item.analysis.roleSuggestion === 'CLOSEUP'
    ) ||
    remainingAfterAlt[0] ||
    altCandidate;

  if (detailCandidate) {
    slots.push({
      slotNumber: 3,
      slotRole: 'DETAIL_CLOSEUP',
      slotTitle: 'Detail / Close-up',
      mediaId: detailCandidate.id,
      imageUrl:
        (detailCandidate as any).detailCropUrl ||
        (detailCandidate as any).shopifySquareUrl ||
        `/api/photos/${detailCandidate.originalFilename}`,
      sourceType: 'detail_crop',
      isCover: false,
      altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
      qualityScore: detailCandidate.analysis.qualityScore,
      isAiGenerated: false,
      canRegenerate: false,
    });
  }

  // 4. Identify Slot 4 (Fashion Model / Lifestyle Image OR Real Photo Fallback)
  if (targetCount >= 4) {
    if (params.enableModelGeneration !== false && heroCandidate) {
      const presetKey = params.modelPresetKey || 'indian_festive';
      const modelGen = await generateControlledModelImage({
        sourceImageUrl: (heroCandidate as any).shopifySquareUrl || `/api/photos/${heroCandidate.originalFilename}`,
        productTitle: params.productTitle,
        presetKey,
        customPrompt: params.customPrompt,
        targetSlot: 'model_1',
      });

      if (modelGen.success && modelGen.generatedImageUrl) {
        slots.push({
          slotNumber: 4,
          slotRole: 'MODEL_1',
          slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,
          mediaId: `model_gen_1_${heroCandidate.id}`,
          imageUrl: modelGen.generatedImageUrl,
          sourceType: 'ai_model',
          isCover: false,
          altText: generateSlotAltText(params.productTitle, 'MODEL_1'),
          qualityScore: 92,
          isAiGenerated: true,
          modelPresetKey: presetKey,
          canRegenerate: true,
        });
      } else {
        // Fallback to real image if model generation failed
        warnings.push(`Model image generation fallback: ${modelGen.statusNotes}`);
        const fallbackItem = remainingAfterAlt[1] || detailCandidate || heroCandidate;
        slots.push({
          slotNumber: 4,
          slotRole: 'ALT_VIEW',
          slotTitle: 'Supporting Real View (Model Fallback)',
          mediaId: `${fallbackItem.id}_slot4`,
          imageUrl: (fallbackItem as any).shopifySquareUrl || `/api/photos/${fallbackItem.originalFilename}`,
          sourceType: 'real_photo',
          isCover: false,
          altText: generateSlotAltText(params.productTitle, 'ALT_VIEW'),
          qualityScore: fallbackItem.analysis.qualityScore,
          isAiGenerated: false,
          canRegenerate: true,
        });
      }
    } else {
      // Model generation was explicitly disabled
      const fallbackItem = remainingAfterAlt[1] || detailCandidate || heroCandidate;
      slots.push({
        slotNumber: 4,
        slotRole: 'ALT_VIEW',
        slotTitle: 'Supporting Real Angle',
        mediaId: `${fallbackItem.id}_slot4`,
        imageUrl: (fallbackItem as any).shopifySquareUrl || `/api/photos/${fallbackItem.originalFilename}`,
        sourceType: 'real_photo',
        isCover: false,
        altText: generateSlotAltText(params.productTitle, 'ALT_VIEW'),
        qualityScore: fallbackItem?.analysis?.qualityScore || 85,
        isAiGenerated: false,
        canRegenerate: false,
      });
    }
  }

  // 5. Identify Slot 5 (Second Model / Lifestyle OR Secondary Component Focus)
  if (targetCount >= 5) {
    const earringFocusCandidate = sourcePool.find(
      (item) => item.analysis.roleSuggestion === 'EARRING_FOCUS' && !slots.some((s) => s.mediaId === item.id)
    );

    if (earringFocusCandidate) {
      slots.push({
        slotNumber: 5,
        slotRole: 'MODEL_2_OR_SUPPORTING',
        slotTitle: 'Earrings / Component Focus',
        mediaId: earringFocusCandidate.id,
        imageUrl: (earringFocusCandidate as any).shopifySquareUrl || `/api/photos/${earringFocusCandidate.originalFilename}`,
        sourceType: 'real_photo',
        isCover: false,
        altText: generateSlotAltText(params.productTitle, 'MODEL_2_OR_SUPPORTING', 'Focus on matching earrings'),
        qualityScore: earringFocusCandidate.analysis.qualityScore,
        isAiGenerated: false,
        canRegenerate: false,
      });
    } else if (params.enableModelGeneration !== false && heroCandidate) {
      const presetKey2 = params.modelPresetKey2 || 'minimal_luxury_studio';
      const modelGen2 = await generateControlledModelImage({
        sourceImageUrl: (heroCandidate as any).shopifySquareUrl || `/api/photos/${heroCandidate.originalFilename}`,
        productTitle: params.productTitle,
        presetKey: presetKey2,
        customPrompt: params.customPrompt,
        targetSlot: 'model_2',
      });

      slots.push({
        slotNumber: 5,
        slotRole: 'MODEL_2_OR_SUPPORTING',
        slotTitle: `Lifestyle Styling (${MODEL_STYLING_PRESETS[presetKey2]?.name || 'Studio'})`,
        mediaId: `model_gen_2_${heroCandidate.id}`,
        imageUrl: modelGen2.generatedImageUrl || slots[0].imageUrl,
        sourceType: 'ai_lifestyle',
        isCover: false,
        altText: `Styled lifestyle presentation of ${params.productTitle}`,
        qualityScore: 90,
        isAiGenerated: true,
        modelPresetKey: presetKey2,
        canRegenerate: true,
      });
    } else {
      const remainingItem = sourcePool.find((item) => !slots.some((s) => s.mediaId === item.id)) || slots[0];
      slots.push({
        slotNumber: 5,
        slotRole: 'MODEL_2_OR_SUPPORTING',
        slotTitle: 'Supporting Detail View',
        mediaId: remainingItem.id,
        imageUrl: (remainingItem as any).shopifySquareUrl || `/api/photos/${remainingItem.originalFilename}`,
        sourceType: 'real_photo',
        isCover: false,
        altText: generateSlotAltText(params.productTitle, 'MODEL_2_OR_SUPPORTING'),
        qualityScore: remainingItem.analysis?.qualityScore || 80,
        isAiGenerated: false,
        canRegenerate: false,
      });
    }
  }

  // Count real vs AI
  const totalRealImagesUsed = slots.filter((s) => !s.isAiGenerated).length;
  const totalAiImagesUsed = slots.filter((s) => s.isAiGenerated).length;

  return {
    productId: params.productId,
    productTitle: params.productTitle,
    slots: slots.slice(0, targetCount),
    warnings,
    totalRealImagesUsed,
    totalAiImagesUsed,
    isListingReady: slots.length >= 3,
  };
}

/**
 * Regenerates solely a single designated slot without altering the rest of the media pack.
 */
export async function regenerateSingleSlot(
  currentPack: RecommendedGalleryPack,
  slotNumber: number,
  options: {
    newPresetKey?: string;
    newCustomPrompt?: string;
    replacementMediaId?: string;
    clusteredPool?: ClusteredMediaItem[];
  }
): Promise<RecommendedGalleryPack> {
  const updatedSlots = [...currentPack.slots];
  const targetIndex = updatedSlots.findIndex((s) => s.slotNumber === slotNumber);

  if (targetIndex === -1) return currentPack;

  const targetSlot = updatedSlots[targetIndex];

  // If replacing from existing source pool
  if (options.replacementMediaId && options.clusteredPool) {
    const replacement = options.clusteredPool.find((i) => i.id === options.replacementMediaId);
    if (replacement) {
      updatedSlots[targetIndex] = {
        ...targetSlot,
        mediaId: replacement.id,
        imageUrl: (replacement as any).shopifySquareUrl || `/api/photos/${replacement.originalFilename}`,
        qualityScore: replacement.analysis.qualityScore,
        sourceType: 'real_photo',
        isAiGenerated: false,
      };
      return { ...currentPack, slots: updatedSlots };
    }
  }

  // If regenerating model/lifestyle slot
  if (targetSlot.isAiGenerated || targetSlot.canRegenerate || slotNumber === 4 || slotNumber === 5) {
    const presetKey = options.newPresetKey || targetSlot.modelPresetKey || 'indian_festive';
    const heroSlot = updatedSlots.find((s) => s.slotRole === 'HERO_COVER') || updatedSlots[0];

    const modelGen = await generateControlledModelImage({
      sourceImageUrl: heroSlot.imageUrl,
      productTitle: currentPack.productTitle,
      presetKey,
      customPrompt: options.newCustomPrompt,
      targetSlot: slotNumber === 4 ? 'model_1' : 'model_2',
    });

    if (modelGen.success && modelGen.generatedImageUrl) {
      updatedSlots[targetIndex] = {
        ...targetSlot,
        imageUrl: modelGen.generatedImageUrl,
        modelPresetKey: presetKey,
        slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,
        altText: `Fashion model wearing ${currentPack.productTitle}`,
      };
    } else {
      updatedSlots[targetIndex] = {
        ...targetSlot,
        modelPresetKey: presetKey,
        slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,
      };
    }
  }

  return {
    ...currentPack,
    slots: updatedSlots,
  };
}
