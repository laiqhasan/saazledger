import type { ClusteredMediaItem } from './mediaAnalyzerService';
import {
  generateControlledModelImage,
  generateStyledSupportingImage,
  type ModelGenerationPreset,
  type StyledSlot2Option,
  MODEL_STYLING_PRESETS,
  STYLED_SLOT2_PRESETS,
} from './modelImageGeneratorService';

export interface GallerySlot {
  slotNumber: number; // 1 to 5 (or 6)
  slotRole: 'HERO_COVER' | 'STYLED_SUPPORTING' | 'ALT_VIEW' | 'DETAIL_CLOSEUP' | 'MODEL_1' | 'MODEL_2_OR_SUPPORTING';
  slotTitle: string;
  mediaId: string;
  url: string;
  imageUrl: string;
  sourceType: 'real_photo' | 'ai_model' | 'ai_lifestyle' | 'detail_crop' | 'DERIVATIVE';
  isCover: boolean;
  altText: string;
  qualityScore: number;
  isAiGenerated: boolean;
  modelPresetKey?: string;
  styledOption?: StyledSlot2Option;
  canRegenerate: boolean;
}

export interface RecommendedGalleryPack {
  productId?: string;
  productTitle: string;
  slots: GallerySlot[];
  warnings: string[];
  totalRealImagesUsed: number;
  totalAiImagesUsed: number;
  slot2StyleOption?: StyledSlot2Option;
  styledSlot2Used?: boolean;
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
      return `Main commercial clean background front view of ${cleanTitle}`;
    case 'STYLED_SUPPORTING':
      return customNote || `Elegant styled luxury presentation of ${cleanTitle}`;
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
 * based on uploaded clustered media items, clean cover requirements, and styled preferences.
 *
 * Slot 1 = Clean Cover Image (distraction-free, plain neutral background, no props)
 * Slot 2 = Styled Supporting Image (silk cloth, flower styling, or elegant flat lay)
 * Slot 3 = Detail Close-up (pendant, stone, craftsmanship crop)
 * Slot 4 = Model 1 (actual fashion model image only)
 * Slot 5 = Model 2 or Supporting (actual model or supporting component angle)
 */
export async function buildRecommendedGalleryPack(params: {
  productTitle: string;
  productId?: string;
  clusteredItems: ClusteredMediaItem[];
  enableModelGeneration?: boolean;
  enableStyledSlot2?: boolean; // default true
  slot2StyleOption?: StyledSlot2Option; // 'silk_cloth' | 'flower_styling' | 'silk_and_flower' | 'minimal_luxury_flat_lay'
  modelPresetKey?: string;
  modelPresetKey2?: string;
  customPrompt?: string;
  targetSlotCount?: number; // default 5 (min 3, max 6)
}): Promise<RecommendedGalleryPack> {
  const warnings: string[] = [];
  const targetCount = Math.max(3, Math.min(6, params.targetSlotCount || 5));
  const slot2StyleChoice: StyledSlot2Option = params.slot2StyleOption || 'silk_cloth';

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

  // ----------------------------------------------------
  // 1. Identify Slot 1 (Clean Cover Image)
  // ----------------------------------------------------
  // Must have a clean, distraction-free background (white, off-white, soft neutral).
  // Strongly penalize props, flowers, silk folds in Slot 1.
  const cleanCoverCandidate =
    sourcePool.find((item) => item.analysis.roleSuggestion === 'HERO_CANDIDATE' && !item.analysis.hasDistractingProps) ||
    sourcePool.find((item) => item.analysis.isCleanBackground && !item.analysis.hasDistractingProps) ||
    sourcePool.find((item) => !item.analysis.hasDistractingProps) ||
    sourcePool[0] ||
    params.clusteredItems[0];

  const slots: GallerySlot[] = [];

  if (cleanCoverCandidate) {
    const heroUrl = (cleanCoverCandidate as any).shopifySquareUrl || `/api/photos/${cleanCoverCandidate.originalFilename}`;
    const isClean = cleanCoverCandidate.analysis?.isCleanBackground && !cleanCoverCandidate.analysis?.hasDistractingProps;

    slots.push({
      slotNumber: 1,
      slotRole: 'HERO_COVER',
      slotTitle: 'Main Cover / Hero (Clean Background)',
      mediaId: cleanCoverCandidate.id,
      url: heroUrl,
      imageUrl: heroUrl,
      sourceType: isClean ? 'real_photo' : 'DERIVATIVE',
      isCover: true,
      altText: generateSlotAltText(params.productTitle, 'HERO_COVER'),
      qualityScore: cleanCoverCandidate.analysis.qualityScore,
      isAiGenerated: false,
      canRegenerate: false,
    });
  }

  // ----------------------------------------------------
  // 2. Identify Slot 2 (Styled Supporting Image)
  // ----------------------------------------------------
  // Slot 2 should preferably be a styled image (silk cloth, flower styling, silk + flower, minimal luxury).
  // Prop styling must support the product without overpowering it.
  const remainingAfterHero = sourcePool.filter((item) => item.id !== cleanCoverCandidate?.id);
  const existingStyledPhoto = remainingAfterHero.find(
    (item) => item.analysis.roleSuggestion === 'STYLED_CANDIDATE' || item.analysis.isStyledCandidate
  );

  let styledSlot2Used = false;

  if (existingStyledPhoto) {
    // A genuine styled real photo already exists in uploaded photos
    const styledUrl = (existingStyledPhoto as any).shopifySquareUrl || `/api/photos/${existingStyledPhoto.originalFilename}`;
    slots.push({
      slotNumber: 2,
      slotRole: 'STYLED_SUPPORTING',
      slotTitle: `Styled Real Photo (${STYLED_SLOT2_PRESETS[slot2StyleChoice]?.name || 'Atelier'})`,
      mediaId: existingStyledPhoto.id,
      url: styledUrl,
      imageUrl: styledUrl,
      sourceType: 'real_photo',
      isCover: false,
      altText: generateSlotAltText(
        params.productTitle,
        'STYLED_SUPPORTING',
        `Elegantly styled on ${STYLED_SLOT2_PRESETS[slot2StyleChoice]?.name || 'silk'}`
      ),
      qualityScore: existingStyledPhoto.analysis.qualityScore,
      isAiGenerated: false,
      styledOption: slot2StyleChoice,
      canRegenerate: true,
    });
    styledSlot2Used = true;
  } else if (params.enableStyledSlot2 !== false && cleanCoverCandidate) {
    // Generate styled supporting image using prompts while preserving exact product identity
    const heroUrl = (cleanCoverCandidate as any).shopifySquareUrl || `/api/photos/${cleanCoverCandidate.originalFilename}`;
    const styledGen = await generateStyledSupportingImage({
      sourceImageUrl: heroUrl,
      productTitle: params.productTitle,
      styleOption: slot2StyleChoice,
      customPrompt: params.customPrompt,
      sourceBuffer: cleanCoverCandidate.buffer,
      mediaId: `styled_slot2_${cleanCoverCandidate.id}`,
    });

    slots.push({
      slotNumber: 2,
      slotRole: 'STYLED_SUPPORTING',
      slotTitle: `Styled Supporting (${STYLED_SLOT2_PRESETS[slot2StyleChoice]?.name || 'Silk Drape'})`,
      mediaId: `styled_slot2_${cleanCoverCandidate.id}`,
      url: styledGen.generatedImageUrl || heroUrl,
      imageUrl: styledGen.generatedImageUrl || heroUrl,
      sourceType: 'ai_lifestyle',
      isCover: false,
      altText: generateSlotAltText(
        params.productTitle,
        'STYLED_SUPPORTING',
        `Elegantly styled on ${STYLED_SLOT2_PRESETS[slot2StyleChoice]?.name || 'silk cloth'}`
      ),
      qualityScore: 92,
      isAiGenerated: true,
      styledOption: slot2StyleChoice,
      canRegenerate: true,
    });
    styledSlot2Used = true;
  } else {
    // Fallback: distinct alternate real photo (must be different from Slot 1)
    const altCandidate = remainingAfterHero[0] || cleanCoverCandidate;
    const altUrl = (altCandidate as any).shopifySquareUrl || `/api/photos/${altCandidate.originalFilename}`;
    slots.push({
      slotNumber: 2,
      slotRole: 'ALT_VIEW',
      slotTitle: 'Alternate Full View',
      mediaId: altCandidate.id,
      url: altUrl,
      imageUrl: altUrl,
      sourceType: 'real_photo',
      isCover: false,
      altText: generateSlotAltText(params.productTitle, 'ALT_VIEW'),
      qualityScore: altCandidate.analysis.qualityScore,
      isAiGenerated: false,
      canRegenerate: false,
    });
  }

  // ----------------------------------------------------
  // 3. Identify Slot 3 (Detail / Craftsmanship Close-up)
  // ----------------------------------------------------
  const remainingAfterSlot2 = remainingAfterHero.filter(
    (item) => !slots.some((s) => s.mediaId === item.id)
  );
  const detailCandidate =
    remainingAfterSlot2.find(
      (item) => item.analysis.roleSuggestion === 'DETAIL_VIEW' || item.analysis.roleSuggestion === 'CLOSEUP'
    ) ||
    remainingAfterSlot2[0] ||
    cleanCoverCandidate;

  if (detailCandidate) {
    const detailUrl =
      (detailCandidate as any).detailCropUrl ||
      (detailCandidate as any).shopifySquareUrl ||
      `/api/photos/${detailCandidate.originalFilename}`;
    slots.push({
      slotNumber: 3,
      slotRole: 'DETAIL_CLOSEUP',
      slotTitle: 'Detail / Craftsmanship Close-up',
      mediaId: detailCandidate.id,
      url: detailUrl,
      imageUrl: detailUrl,
      sourceType: 'detail_crop',
      isCover: false,
      altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
      qualityScore: detailCandidate.analysis.qualityScore,
      isAiGenerated: false,
      canRegenerate: false,
    });
  }

  // ----------------------------------------------------
  // 4. Identify Slot 4 (Fashion Model 1)
  // ----------------------------------------------------
  if (targetCount >= 4) {
    if (params.enableModelGeneration !== false && cleanCoverCandidate) {
      const presetKey = params.modelPresetKey || 'indian_festive';
      const modelGen = await generateControlledModelImage({
        sourceImageUrl: (cleanCoverCandidate as any).shopifySquareUrl || `/api/photos/${cleanCoverCandidate.originalFilename}`,
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
          mediaId: `model_gen_1_${cleanCoverCandidate.id}`,
          url: modelGen.generatedImageUrl,
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
        const fallbackItem = remainingAfterSlot2[1] || detailCandidate || cleanCoverCandidate;
        const fallbackUrl = (fallbackItem as any).shopifySquareUrl || `/api/photos/${fallbackItem.originalFilename}`;
        slots.push({
          slotNumber: 4,
          slotRole: 'ALT_VIEW',
          slotTitle: 'Supporting Real View (Model Fallback)',
          mediaId: `${fallbackItem.id}_slot4`,
          url: fallbackUrl,
          imageUrl: fallbackUrl,
          sourceType: 'real_photo',
          isCover: false,
          altText: generateSlotAltText(params.productTitle, 'ALT_VIEW'),
          qualityScore: fallbackItem.analysis.qualityScore,
          isAiGenerated: false,
          canRegenerate: true,
        });
      }
    } else {
      // Model generation explicitly disabled
      const fallbackItem = remainingAfterSlot2[1] || detailCandidate || cleanCoverCandidate;
      const fallbackUrl = (fallbackItem as any).shopifySquareUrl || `/api/photos/${fallbackItem.originalFilename}`;
      slots.push({
        slotNumber: 4,
        slotRole: 'ALT_VIEW',
        slotTitle: 'Supporting Real Angle',
        mediaId: `${fallbackItem.id}_slot4`,
        url: fallbackUrl,
        imageUrl: fallbackUrl,
        sourceType: 'real_photo',
        isCover: false,
        altText: generateSlotAltText(params.productTitle, 'ALT_VIEW'),
        qualityScore: fallbackItem?.analysis?.qualityScore || 85,
        isAiGenerated: false,
        canRegenerate: false,
      });
    }
  }

  // ----------------------------------------------------
  // 5. Identify Slot 5 (Model 2 or Supporting Angle)
  // ----------------------------------------------------
  if (targetCount >= 5) {
    const earringFocusCandidate = sourcePool.find(
      (item) => item.analysis.roleSuggestion === 'EARRING_FOCUS' && !slots.some((s) => s.mediaId === item.id)
    );

    if (earringFocusCandidate) {
      const earringUrl = (earringFocusCandidate as any).shopifySquareUrl || `/api/photos/${earringFocusCandidate.originalFilename}`;
      slots.push({
        slotNumber: 5,
        slotRole: 'MODEL_2_OR_SUPPORTING',
        slotTitle: 'Earrings / Component Focus',
        mediaId: earringFocusCandidate.id,
        url: earringUrl,
        imageUrl: earringUrl,
        sourceType: 'real_photo',
        isCover: false,
        altText: generateSlotAltText(params.productTitle, 'MODEL_2_OR_SUPPORTING', 'Focus on matching earrings'),
        qualityScore: earringFocusCandidate.analysis.qualityScore,
        isAiGenerated: false,
        canRegenerate: false,
      });
    } else if (params.enableModelGeneration !== false && cleanCoverCandidate) {
      const presetKey2 = params.modelPresetKey2 || 'minimal_luxury_studio';
      const modelGen2 = await generateControlledModelImage({
        sourceImageUrl: (cleanCoverCandidate as any).shopifySquareUrl || `/api/photos/${cleanCoverCandidate.originalFilename}`,
        productTitle: params.productTitle,
        presetKey: presetKey2,
        customPrompt: params.customPrompt,
        targetSlot: 'model_2',
      });

      const slot5Url = modelGen2.generatedImageUrl || slots[0].imageUrl;
      slots.push({
        slotNumber: 5,
        slotRole: 'MODEL_2_OR_SUPPORTING',
        slotTitle: `Lifestyle Styling (${MODEL_STYLING_PRESETS[presetKey2]?.name || 'Studio'})`,
        mediaId: `model_gen_2_${cleanCoverCandidate.id}`,
        url: slot5Url,
        imageUrl: slot5Url,
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
      const remainingUrl = (remainingItem as any).shopifySquareUrl || `/api/photos/${remainingItem.originalFilename}`;
      slots.push({
        slotNumber: 5,
        slotRole: 'MODEL_2_OR_SUPPORTING',
        slotTitle: 'Supporting Detail View',
        mediaId: remainingItem.id,
        url: remainingUrl,
        imageUrl: remainingUrl,
        sourceType: 'real_photo',
        isCover: false,
        altText: generateSlotAltText(params.productTitle, 'MODEL_2_OR_SUPPORTING'),
        qualityScore: remainingItem.analysis?.qualityScore || 80,
        isAiGenerated: false,
        canRegenerate: false,
      });
    }
  }

  // Ensure all slots have 2048x2048 dimensions
  const finalSlots = slots.slice(0, targetCount).map((s) => ({
    ...s,
    dimensions: s.dimensions || { width: 2048, height: 2048 },
  }));

  // Count real vs AI
  const totalRealImagesUsed = finalSlots.filter((s) => !s.isAiGenerated).length;
  const totalAiImagesUsed = finalSlots.filter((s) => s.isAiGenerated).length;

  return {
    productId: params.productId,
    productTitle: params.productTitle,
    slots: finalSlots,
    warnings,
    totalRealImagesUsed,
    totalAiImagesUsed,
    slot2StyleOption: slot2StyleChoice,
    styledSlot2Used,
    isListingReady: finalSlots.length >= 3,
  };
}

/**
 * Regenerates solely a single designated slot without altering the rest of the media pack.
 * Supports switching Slot 2 between Silk Cloth, Flower Styling, Silk + Flower, and Minimal Luxury.
 */
export async function regenerateSingleSlot(
  currentPack: RecommendedGalleryPack,
  slotNumber: number,
  options: {
    newPresetKey?: string;
    newSlot2StyleOption?: StyledSlot2Option;
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
      const repUrl = (replacement as any).shopifySquareUrl || `/api/photos/${replacement.originalFilename}`;
      updatedSlots[targetIndex] = {
        ...targetSlot,
        mediaId: replacement.id,
        url: repUrl,
        imageUrl: repUrl,
        qualityScore: replacement.analysis.qualityScore,
        sourceType: 'real_photo',
        isAiGenerated: false,
      };
      return { ...currentPack, slots: updatedSlots };
    }
  }

  // If regenerating Slot 2 Styled Supporting Image
  if (slotNumber === 2) {
    const styleOption = (options.newSlot2StyleOption || options.newPresetKey || targetSlot.styledOption || 'silk_cloth') as StyledSlot2Option;
    const heroSlot = updatedSlots.find((s) => s.slotRole === 'HERO_COVER') || updatedSlots[0];
    const heroItem = options.clusteredPool?.find((i) => i.id === heroSlot.mediaId);

    const styledGen = await generateStyledSupportingImage({
      sourceImageUrl: heroSlot.imageUrl,
      productTitle: currentPack.productTitle,
      styleOption,
      customPrompt: options.newCustomPrompt,
      sourceBuffer: heroItem?.buffer,
      mediaId: `regenerated_styled_slot2_${Date.now()}`,
    });

    updatedSlots[targetIndex] = {
      ...targetSlot,
      url: styledGen.generatedImageUrl || heroSlot.imageUrl,
      imageUrl: styledGen.generatedImageUrl || heroSlot.imageUrl,
      slotRole: 'STYLED_SUPPORTING',
      slotTitle: `Styled Supporting (${STYLED_SLOT2_PRESETS[styleOption]?.name || 'Silk Drape'})`,
      altText: generateSlotAltText(
        currentPack.productTitle,
        'STYLED_SUPPORTING',
        `Elegantly styled on ${STYLED_SLOT2_PRESETS[styleOption]?.name || 'silk cloth'}`
      ),
      styledOption: styleOption,
      sourceType: 'ai_lifestyle',
      isAiGenerated: true,
      canRegenerate: true,
    };

    return {
      ...currentPack,
      slots: updatedSlots,
      slot2StyleOption: styleOption,
      styledSlot2Used: true,
    };
  }

  // If regenerating model/lifestyle slot (Slot 4 or 5)
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
        url: modelGen.generatedImageUrl,
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
