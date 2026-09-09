import path from 'path';
import fs from 'fs';
import { UPLOADS_DIR } from '../photoService';
import {
  createCleanCoverDerivative,
  createStyledSupportingDerivative,
  createDetailCropDerivative,
  createComponentFocusDerivative,
} from './mediaPipelineService';
import type { ClusteredMediaItem } from './mediaAnalyzerService';
import {
  generateControlledModelImage,
  generateStyledSupportingImage,
  type ModelGenerationPreset,
  type StyledSlot2Option,
  MODEL_STYLING_PRESETS,
  STYLED_SLOT2_PRESETS,
} from './modelImageGeneratorService';

/**
 * Robust helper to obtain image Buffer from memory or disk
 */
export function getItemBuffer(item?: any): Buffer | null {
  if (!item) return null;
  if (item.buffer && Buffer.isBuffer(item.buffer) && item.buffer.length > 0) {
    return item.buffer;
  }
  if (item.base64 || item.base64Data) {
    const raw = item.base64 || item.base64Data;
    const clean = raw.replace(/^data:image\/\w+;base64,/, '');
    try {
      const buf = Buffer.from(clean, 'base64');
      if (buf.length > 0) return buf;
    } catch {}
  }
  const candidates = [
    item.originalFilename,
    item.url,
    item.imageUrl,
    item.shopifySquareUrl,
    item.dataUrl,
  ].filter(Boolean);

  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('data:image/')) {
      const commaIdx = c.indexOf(',');
      if (commaIdx !== -1) {
        try {
          const b64 = c.substring(commaIdx + 1);
          const buf = Buffer.from(b64, 'base64');
          if (buf.length > 0) return buf;
        } catch {}
      }
    }

    if (typeof c === 'string') {
      const filename = c
        .replace('/api/photos/derivatives/', '')
        .replace('/api/photos/', '')
        .split('?')[0];

      const absPath = path.resolve(UPLOADS_DIR, filename);
      if (fs.existsSync(absPath)) {
        try {
          const buf = fs.readFileSync(absPath);
          if (buf.length > 0) return buf;
        } catch {}
      }

      const derivPath = path.resolve(UPLOADS_DIR, 'derivatives', filename);
      if (fs.existsSync(derivPath)) {
        try {
          const buf = fs.readFileSync(derivPath);
          if (buf.length > 0) return buf;
        } catch {}
      }
    }
  }
  return null;
}

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
  geminiApiKey?: string;
  openaiApiKey?: string;
  aiReferenceMediaId?: string;
  aiProvider?: 'gemini' | 'openai';
}): Promise<RecommendedGalleryPack> {
  const warnings: string[] = [];
  const targetCount = Math.max(3, Math.min(6, params.targetSlotCount || 5));
  const slot2StyleChoice: StyledSlot2Option = params.slot2StyleOption || 'silk_and_flower';

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

  // Dedicated AI Reference Photo if selected by user
  const aiRefCandidate =
    (params.aiReferenceMediaId &&
      params.clusteredItems.find(
        (item) => item.id === params.aiReferenceMediaId || item.originalFilename === params.aiReferenceMediaId
      )) ||
    null;

  // ----------------------------------------------------
  // 1. Identify Slot 1 (Clean Cover Image)
  // ----------------------------------------------------
  // Must have a clean, distraction-free background (studio white, plain neutral).
  // Table borders trimmed, product centered, no clutter.
  const cleanCoverCandidate =
    sourcePool.find((item) => item.analysis.roleSuggestion === 'HERO_CANDIDATE' && !item.analysis.hasDistractingProps) ||
    sourcePool.find((item) => item.analysis.isCleanBackground && !item.analysis.hasDistractingProps) ||
    sourcePool.find((item) => !item.analysis.hasDistractingProps) ||
    sourcePool[0] ||
    params.clusteredItems[0];

  const slots: GallerySlot[] = [];

  if (cleanCoverCandidate) {
    let heroUrl = (cleanCoverCandidate as any).cleanCoverUrl;
    const heroBuffer = getItemBuffer(cleanCoverCandidate);

    if (!heroUrl && heroBuffer) {
      try {
        const cleanCoverFilename = `${cleanCoverCandidate.id}_clean_cover_2048.jpg`;
        const res = await createCleanCoverDerivative(heroBuffer, cleanCoverFilename);
        heroUrl = res.relativeUrl;
        (cleanCoverCandidate as any).cleanCoverUrl = heroUrl;
      } catch (err: any) {
        console.warn('Notice generating clean cover derivative:', err.message);
      }
    }

    if (!heroUrl) {
      heroUrl = (cleanCoverCandidate as any).shopifySquareUrl || `/api/photos/${cleanCoverCandidate.originalFilename}`;
    }

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
      qualityScore: cleanCoverCandidate.analysis?.qualityScore || 95,
      isAiGenerated: false,
      canRegenerate: false,
    });
  }

  // ----------------------------------------------------
  // 2. Identify Slot 2 (Styled Supporting Image)
  // ----------------------------------------------------
  const remainingAfterHero = sourcePool.filter((item) => item.id !== cleanCoverCandidate?.id);
  let styledSlot2Used = false;

  const existingStyledPhoto = remainingAfterHero.find(
    (item) =>
      item.analysis.roleSuggestion === 'STYLED_SUPPORTING' ||
      item.analysis.roleSuggestion === 'STYLED_CANDIDATE' ||
      item.analysis.hasDistractingProps
  );

  if (existingStyledPhoto && !params.enableStyledSlot2) {
    const styledUrl =
      (existingStyledPhoto as any).shopifySquareUrl || `/api/photos/${existingStyledPhoto.originalFilename}`;
    slots.push({
      slotNumber: 2,
      slotRole: 'STYLED_SUPPORTING',
      slotTitle: `Styled Supporting Presentation`,
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
  } else if (params.enableStyledSlot2 !== false && (aiRefCandidate || cleanCoverCandidate)) {
    // Generate styled supporting image preserving exact product identity from selected AI reference or cover
    const targetSource = aiRefCandidate || cleanCoverCandidate!;
    const heroBuffer = getItemBuffer(targetSource) || getItemBuffer(cleanCoverCandidate);
    const heroUrl =
      (targetSource as any).shopifySquareUrl ||
      `/api/photos/${targetSource.originalFilename}` ||
      slots[0]?.imageUrl;

    const styledGen = await generateStyledSupportingImage({
      sourceImageUrl: heroUrl,
      productTitle: params.productTitle,
      styleOption: slot2StyleChoice,
      customPrompt: params.customPrompt,
      sourceBuffer: heroBuffer || undefined,
      mediaId: `styled_slot2_${targetSource.id}`,
      geminiApiKey: params.geminiApiKey,
      openaiApiKey: params.openaiApiKey,
      aiProvider: params.aiProvider,
    });

    let styledImageUrl = styledGen.generatedImageUrl || heroUrl;

    // If styledImageUrl fell back to identical heroUrl and heroBuffer is available, force procedural styling
    if (styledImageUrl === heroUrl && heroBuffer) {
      try {
        const fallbackStyledName = `styled_slot2_${cleanCoverCandidate.id}_${slot2StyleChoice}.jpg`;
        const res = await createStyledSupportingDerivative(heroBuffer, fallbackStyledName, slot2StyleChoice);
        styledImageUrl = res.relativeUrl;
      } catch (e: any) {
        console.warn('Notice generating procedural styled supporting derivative:', e.message);
      }
    }

    slots.push({
      slotNumber: 2,
      slotRole: 'STYLED_SUPPORTING',
      slotTitle: `Styled Supporting (${STYLED_SLOT2_PRESETS[slot2StyleChoice]?.name || 'Silk Drape'})`,
      mediaId: `styled_slot2_${cleanCoverCandidate.id}`,
      url: styledImageUrl,
      imageUrl: styledImageUrl,
      sourceType: 'ai_lifestyle',
      isCover: false,
      altText: generateSlotAltText(
        params.productTitle,
        'STYLED_SUPPORTING',
        `Elegantly styled on ${STYLED_SLOT2_PRESETS[slot2StyleChoice]?.name || 'silk cloth'}`
      ),
      qualityScore: 92,
      isAiGenerated: false,
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
      qualityScore: altCandidate.analysis?.qualityScore || 85,
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
    let detailUrl = (detailCandidate as any).detailCropUrl;
    const detailBuffer = getItemBuffer(detailCandidate);

    if (!detailUrl && detailBuffer) {
      try {
        const detailFilename = `${detailCandidate.id}_detail_2048.jpg`;
        const res = await createDetailCropDerivative(detailBuffer, detailFilename, 2048);
        detailUrl = res.relativeUrl;
        (detailCandidate as any).detailCropUrl = detailUrl;
      } catch (err: any) {
        console.warn('Notice generating detail crop derivative:', err.message);
      }
    }

    if (!detailUrl) {
      detailUrl = (detailCandidate as any).shopifySquareUrl || `/api/photos/${detailCandidate.originalFilename}`;
    }

    slots.push({
      slotNumber: 3,
      slotRole: 'DETAIL_CLOSEUP',
      slotTitle: 'Detail / Craftsmanship Close-up',
      mediaId: `${detailCandidate.id}_detail`,
      url: detailUrl,
      imageUrl: detailUrl,
      sourceType: 'detail_crop',
      isCover: false,
      altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
      qualityScore: detailCandidate.analysis?.qualityScore || 90,
      isAiGenerated: false,
      canRegenerate: false,
    });
  }

  // ----------------------------------------------------
  // 4. Identify Slot 4 (Fashion Model 1 or Wearing Scale)
  // ----------------------------------------------------
  if (targetCount >= 4) {
    let slot4Created = false;

    if (params.enableModelGeneration !== false && (aiRefCandidate || cleanCoverCandidate)) {
      const targetSource = aiRefCandidate || cleanCoverCandidate!;
      const presetKey = params.modelPresetKey || 'indian_festive';
      const heroBuffer = getItemBuffer(targetSource) || getItemBuffer(cleanCoverCandidate);
      const heroUrl =
        (targetSource as any).shopifySquareUrl ||
        `/api/photos/${targetSource.originalFilename}` ||
        slots[0]?.imageUrl;

      const modelGen = await generateControlledModelImage({
        sourceImageUrl: heroUrl,
        productTitle: params.productTitle,
        presetKey,
        customPrompt: params.customPrompt,
        targetSlot: 'model_1',
        sourceBuffer: heroBuffer || undefined,
        mediaId: targetSource.id,
        geminiApiKey: params.geminiApiKey,
        openaiApiKey: params.openaiApiKey,
        aiProvider: params.aiProvider,
      });

      if (modelGen.success && modelGen.generatedImageUrl) {
        slots.push({
          slotNumber: 4,
          slotRole: 'MODEL_1',
          slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,
          mediaId: `model_gen_1_${targetSource.id}`,
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
        slot4Created = true;
      }
    }

    if (!slot4Created) {
      // Check if there is an unused distinct real photo
      const unusedReal = remainingAfterHero.find((item) => !slots.some((s) => s.mediaId === item.id || s.mediaId.startsWith(item.id)));
      if (unusedReal) {
        const unusedUrl = (unusedReal as any).shopifySquareUrl || `/api/photos/${unusedReal.originalFilename}`;
        slots.push({
          slotNumber: 4,
          slotRole: 'ALT_VIEW',
          slotTitle: 'Supporting Real Angle',
          mediaId: unusedReal.id,
          url: unusedUrl,
          imageUrl: unusedUrl,
          sourceType: 'real_photo',
          isCover: false,
          altText: generateSlotAltText(params.productTitle, 'ALT_VIEW'),
          qualityScore: unusedReal.analysis?.qualityScore || 85,
          isAiGenerated: false,
          canRegenerate: true,
        });
      } else {
        // Fallback: Generate wearing scale / neckline derivative from hero
        const heroBuffer = getItemBuffer(cleanCoverCandidate);
        let scaleUrl = slots[0]?.imageUrl;
        if (heroBuffer) {
          try {
            const scaleFilename = `${cleanCoverCandidate.id}_wearing_scale_2048.jpg`;
            const res = await createComponentFocusDerivative(heroBuffer, scaleFilename, 'wearing_scale');
            scaleUrl = res.relativeUrl;
          } catch (e: any) {
            console.warn('Notice generating wearing scale derivative:', e.message);
          }
        }

        slots.push({
          slotNumber: 4,
          slotRole: 'ALT_VIEW',
          slotTitle: 'Wearing Scale & Neckline Fit',
          mediaId: `scale_slot4_${cleanCoverCandidate?.id || 'deriv'}`,
          url: scaleUrl,
          imageUrl: scaleUrl,
          sourceType: 'DERIVATIVE',
          isCover: false,
          altText: `Wearing scale and neckline drape of ${params.productTitle}`,
          qualityScore: 88,
          isAiGenerated: false,
          canRegenerate: true,
        });
      }
    }
  }

  // ----------------------------------------------------
  // 5. Identify Slot 5 (Lifestyle / Prompt Photo or Component Focus)
  // ----------------------------------------------------
  if (targetCount >= 5) {
    let slot5Created = false;

    if (params.enableModelGeneration !== false && (aiRefCandidate || cleanCoverCandidate)) {
      const targetSource = aiRefCandidate || cleanCoverCandidate!;
      const presetKey2 = params.modelPresetKey2 || 'minimal_luxury_studio';
      const heroBuffer = getItemBuffer(targetSource) || getItemBuffer(cleanCoverCandidate);
      const heroUrl =
        (targetSource as any).shopifySquareUrl ||
        `/api/photos/${targetSource.originalFilename}` ||
        slots[0]?.imageUrl;

      const modelGen2 = await generateControlledModelImage({
        sourceImageUrl: heroUrl,
        productTitle: params.productTitle,
        presetKey: presetKey2,
        customPrompt: params.customPrompt,
        targetSlot: 'model_2',
        sourceBuffer: heroBuffer || undefined,
        mediaId: targetSource.id,
        geminiApiKey: params.geminiApiKey,
        openaiApiKey: params.openaiApiKey,
        aiProvider: params.aiProvider,
      });

      if (modelGen2.success && modelGen2.generatedImageUrl) {
        slots.push({
          slotNumber: 5,
          slotRole: 'MODEL_2_OR_SUPPORTING',
          slotTitle: `Lifestyle Styling (${MODEL_STYLING_PRESETS[presetKey2]?.name || 'Studio'})`,
          mediaId: `model_gen_2_${targetSource.id}`,
          url: modelGen2.generatedImageUrl,
          imageUrl: modelGen2.generatedImageUrl,
          sourceType: 'ai_lifestyle',
          isCover: false,
          altText: `Styled lifestyle presentation of ${params.productTitle}`,
          qualityScore: 90,
          isAiGenerated: true,
          modelPresetKey: presetKey2,
          canRegenerate: true,
        });
        slot5Created = true;
      }
    }

    if (!slot5Created) {
      const earringFocusCandidate = sourcePool.find(
        (item) => item.analysis.roleSuggestion === 'EARRING_FOCUS' && !slots.some((s) => s.mediaId === item.id || s.mediaId.startsWith(item.id))
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
      } else {
        // Unused real photo check
        const unusedReal = remainingAfterHero.find((item) => !slots.some((s) => s.mediaId === item.id || s.mediaId.startsWith(item.id)));
        if (unusedReal) {
          const unusedUrl = (unusedReal as any).shopifySquareUrl || `/api/photos/${unusedReal.originalFilename}`;
          slots.push({
            slotNumber: 5,
            slotRole: 'MODEL_2_OR_SUPPORTING',
            slotTitle: 'Alternate Angle View',
            mediaId: unusedReal.id,
            url: unusedUrl,
            imageUrl: unusedUrl,
            sourceType: 'real_photo',
            isCover: false,
            altText: generateSlotAltText(params.productTitle, 'MODEL_2_OR_SUPPORTING'),
            qualityScore: unusedReal.analysis?.qualityScore || 80,
            isAiGenerated: false,
            canRegenerate: false,
          });
        } else {
          // Generate matching earrings focus derivative from heroBuffer
          const heroBuffer = getItemBuffer(cleanCoverCandidate);
          let earringUrl = slots[0]?.imageUrl;
          if (heroBuffer) {
            try {
              const earringFilename = `${cleanCoverCandidate.id}_earrings_focus_2048.jpg`;
              const res = await createComponentFocusDerivative(heroBuffer, earringFilename, 'earrings');
              earringUrl = res.relativeUrl;
            } catch (e: any) {
              console.warn('Notice generating earrings focus derivative:', e.message);
            }
          }

          slots.push({
            slotNumber: 5,
            slotRole: 'MODEL_2_OR_SUPPORTING',
            slotTitle: 'Earrings Component Focus',
            mediaId: `earrings_slot5_${cleanCoverCandidate?.id || 'deriv'}`,
            url: earringUrl,
            imageUrl: earringUrl,
            sourceType: 'DERIVATIVE',
            isCover: false,
            altText: `Detail focus on matching earrings of ${params.productTitle}`,
            qualityScore: 89,
            isAiGenerated: false,
            canRegenerate: true,
          });
        }
      }
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
    geminiApiKey?: string;
    openaiApiKey?: string;
    sourceSlotNumber?: number;
    sourceMediaId?: string;
    sourceImageUrl?: string;
    sourceBase64?: string;
    targetRole?: 'AI_MODEL' | 'STYLED_SUPPORTING';
    aiProvider?: 'gemini' | 'openai';
  }
): Promise<RecommendedGalleryPack> {
  const updatedSlots = [...currentPack.slots];
  const targetIndex = updatedSlots.findIndex((s) => s.slotNumber === slotNumber);

  if (targetIndex === -1) return currentPack;

  const targetSlot = updatedSlots[targetIndex];

  // If replacing from existing source pool (real photo swap)
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

  // Resolve reference image for AI generation from user selection
  let refUrl = '';
  let refBuffer: Buffer | null = null;

  if (options.sourceBase64) {
    const raw = options.sourceBase64.replace(/^data:image\/\w+;base64,/, '');
    try {
      refBuffer = Buffer.from(raw, 'base64');
      refUrl = options.sourceImageUrl || `data:image/jpeg;base64,${raw}`;
    } catch {}
  } else if (options.sourceSlotNumber) {
    const found = updatedSlots.find((s) => s.slotNumber === options.sourceSlotNumber);
    if (found) {
      refUrl = found.imageUrl || found.url;
      refBuffer = getItemBuffer(found);
    }
  } else if (options.sourceMediaId) {
    const poolItem = options.clusteredPool?.find((i) => i.id === options.sourceMediaId);
    if (poolItem) {
      refUrl = (poolItem as any).shopifySquareUrl || `/api/photos/${poolItem.originalFilename}`;
      refBuffer = getItemBuffer(poolItem);
    } else {
      const found = updatedSlots.find((s) => s.mediaId === options.sourceMediaId);
      if (found) {
        refUrl = found.imageUrl || found.url;
        refBuffer = getItemBuffer(found);
      }
    }
  } else if (options.sourceImageUrl) {
    refUrl = options.sourceImageUrl;
    refBuffer = getItemBuffer({ imageUrl: options.sourceImageUrl });
  }

  // Fallback to cover slot or slot 0
  if (!refUrl) {
    const heroSlot = updatedSlots.find((s) => s.slotRole === 'HERO_COVER') || updatedSlots[0];
    if (heroSlot) {
      refUrl = heroSlot.imageUrl || heroSlot.url;
      refBuffer = options.clusteredPool?.find((i) => i.id === heroSlot.mediaId)?.buffer || getItemBuffer(heroSlot);
    }
  }

  // 1. If regenerating as Styled Supporting Image
  if (slotNumber === 2 || options.targetRole === 'STYLED_SUPPORTING') {
    const styleOption = (options.newSlot2StyleOption || options.newPresetKey || targetSlot.styledOption || 'silk_cloth') as StyledSlot2Option;

    const styledGen = await generateStyledSupportingImage({
      sourceImageUrl: refUrl,
      productTitle: currentPack.productTitle,
      styleOption,
      customPrompt: options.newCustomPrompt,
      sourceBuffer: refBuffer || undefined,
      mediaId: `regenerated_styled_${slotNumber}_${Date.now()}`,
      geminiApiKey: options.geminiApiKey,
      openaiApiKey: options.openaiApiKey,
      aiProvider: options.aiProvider,
    });

    let styledImageUrl = styledGen.generatedImageUrl || refUrl;
    if (styledImageUrl === refUrl && refBuffer) {
      try {
        const fallbackName = `regenerated_styled_${slotNumber}_${Date.now()}_${styleOption}.jpg`;
        const res = await createStyledSupportingDerivative(refBuffer, fallbackName, styleOption);
        styledImageUrl = res.relativeUrl;
      } catch (e: any) {
        console.warn('Notice generating regenerated styled derivative:', e.message);
      }
    }

    updatedSlots[targetIndex] = {
      ...targetSlot,
      url: styledImageUrl,
      imageUrl: styledImageUrl,
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

  // 2. If regenerating as AI Model / Lifestyle slot (or any other slot requested as model)
  if (
    options.targetRole === 'AI_MODEL' ||
    targetSlot.isAiGenerated ||
    targetSlot.canRegenerate ||
    slotNumber === 4 ||
    slotNumber === 5
  ) {
    const presetKey = options.newPresetKey || targetSlot.modelPresetKey || 'indian_festive';

    const modelGen = await generateControlledModelImage({
      sourceImageUrl: refUrl,
      productTitle: currentPack.productTitle,
      presetKey,
      customPrompt: options.newCustomPrompt,
      targetSlot: slotNumber === 4 ? 'model_1' : 'model_2',
      sourceBuffer: refBuffer || undefined,
      mediaId: `regenerated_model_${slotNumber}_${Date.now()}`,
      geminiApiKey: options.geminiApiKey,
      openaiApiKey: options.openaiApiKey,
      aiProvider: options.aiProvider,
    });

    if (modelGen.success && modelGen.generatedImageUrl) {
      const isSlot4 = slotNumber === 4;
      updatedSlots[targetIndex] = {
        ...targetSlot,
        url: modelGen.generatedImageUrl,
        imageUrl: modelGen.generatedImageUrl,
        modelPresetKey: presetKey,
        slotRole: isSlot4 ? 'MODEL_1' : 'MODEL_2_OR_SUPPORTING',
        slotTitle: isSlot4
          ? `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`
          : `Lifestyle Styling (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Studio'})`,
        altText: isSlot4
          ? `Fashion model wearing ${currentPack.productTitle}`
          : `Styled lifestyle presentation of ${currentPack.productTitle}`,
        sourceType: isSlot4 ? 'ai_model' : 'ai_lifestyle',
        isAiGenerated: true,
        canRegenerate: true,
      };
    } else {
      const isSlot4 = slotNumber === 4;
      updatedSlots[targetIndex] = {
        ...targetSlot,
        modelPresetKey: presetKey,
        slotTitle: isSlot4
          ? `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`
          : `Lifestyle Styling (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Studio'})`,
      };
    }
  }

  return {
    ...currentPack,
    slots: updatedSlots,
  };
}
