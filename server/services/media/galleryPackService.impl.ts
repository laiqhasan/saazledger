import path from 'path';
import fs from 'fs';
import { UPLOADS_DIR, DERIVATIVES_DIR, getPhoto, getDerivative } from '../photoService';
import {
  createPureWhiteCover,
  createDetailCraftsmanshipCrop,
  createEarringComponentCrop,
} from './deterministicImageService';
import {
  generateStyledImage,
  generateModelImage,
} from './imageGenerationProvider';
import type { ClusteredMediaItem } from './mediaAnalyzerService';
import {
  type StyledSlot2Option,
  MODEL_STYLING_PRESETS,
  STYLED_SLOT2_PRESETS,
} from './modelImageGeneratorService';

/** Robust helper to obtain an authentic image buffer from memory or local media storage. */
export function getItemBuffer(item?: any): Buffer | null {
  if (!item) return null;
  if (item.buffer && Buffer.isBuffer(item.buffer) && item.buffer.length > 0) return item.buffer;

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
          const buf = Buffer.from(c.substring(commaIdx + 1), 'base64');
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

      const derivPath = path.resolve(DERIVATIVES_DIR, filename);
      if (fs.existsSync(derivPath)) {
        try {
          const buf = fs.readFileSync(derivPath);
          if (buf.length > 0) return buf;
        } catch {}
      }

      const blobMatch = getDerivative(filename) || getPhoto(filename);
      if (blobMatch && blobMatch.buffer.length > 0) return blobMatch.buffer;
    }
  }

  return null;
}

export interface GallerySlot {
  slotNumber: number;
  slotRole: 'HERO_COVER' | 'STYLED_SUPPORTING' | 'ALT_VIEW' | 'DETAIL_CLOSEUP' | 'MODEL_1' | 'MODEL_2_OR_SUPPORTING' | 'REAL_PHOTO_FALLBACK';
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
  currentBgMode?: 'pure_white' | 'original' | 'transparent';
  cleanCoverUrl?: string;
  originalUrl?: string;
  transparentUrl?: string;
  isolatedMasterUrl?: string;
  sourceMode?: 'auto' | 'manual' | 'skip';
  generationProvider?: string;
  createdAt?: string;
  generationFailed?: boolean;
  generationError?: string;
  segmentationQuality?: any;
  dimensions?: { width: number; height: number };
  cropData?: any;
  included?: boolean;
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
  sourceModes?: Partial<Record<'white' | 'model' | 'detail' | 'silk' | 'original', 'auto' | 'manual' | 'skip'>>;
  isListingReady: boolean;
}

export function generateSlotAltText(
  productTitle: string,
  slotRole: GallerySlot['slotRole'],
  detailNote?: string
): string {
  const cleanTitle = productTitle.replace(/\s+/g, ' ').trim();
  switch (slotRole) {
    case 'HERO_COVER':
      return `Clean white background front view of ${cleanTitle}`;
    case 'STYLED_SUPPORTING':
      return detailNote || `Styled flat-lay presentation of ${cleanTitle}`;
    case 'ALT_VIEW':
      return `Alternate view of ${cleanTitle}`;
    case 'DETAIL_CLOSEUP':
      return detailNote || `Close-up detail of ${cleanTitle}`;
    case 'MODEL_1':
      return `Fashion model wearing ${cleanTitle}`;
    case 'MODEL_2_OR_SUPPORTING':
      return detailNote || `Supporting product view of ${cleanTitle}`;
    default:
      return `${cleanTitle} jewellery view`;
  }
}

function createFailedGeneratedSlot(params: {
  slotNumber: number;
  slotRole: GallerySlot['slotRole'];
  slotTitle: string;
  mediaId: string;
  sourceType: 'ai_model' | 'ai_lifestyle';
  altText: string;
  error: string;
  modelPresetKey?: string;
  styledOption?: StyledSlot2Option;
}): GallerySlot {
  return {
    slotNumber: params.slotNumber,
    slotRole: params.slotRole,
    slotTitle: params.slotTitle,
    mediaId: params.mediaId,
    url: '',
    imageUrl: '',
    sourceType: params.sourceType,
    isCover: false,
    altText: params.altText,
    qualityScore: 0,
    isAiGenerated: true,
    generationFailed: true,
    generationError: params.error,
    modelPresetKey: params.modelPresetKey,
    styledOption: params.styledOption,
    canRegenerate: true,
    included: false,
  };
}

/**
 * Builds the 5-role Shopify gallery. Failed generation remains visibly failed;
 * authentic hero photos are never substituted into AI slots.
 */
export async function buildRecommendedGalleryPack(params: {
  productId?: string;
  productTitle: string;
  clusteredItems: ClusteredMediaItem[];
  targetSlotCount?: number;
  modelPresetKey?: string;
  modelPresetKey2?: string;
  enableModelGeneration?: boolean;
  enableStyledSlot2?: boolean;
  enableModelSlot4?: boolean;
  enableLifestyleSlot5?: boolean;
  slot2StyleOption?: StyledSlot2Option;
  customPrompt?: string;
  customPromptSlot2?: string;
  customPromptSlot4?: string;
  customPromptSlot5?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  aiReferenceMediaId?: string;
  aiProvider?: 'gemini' | 'openai';
  sourceModes?: Partial<Record<'white' | 'model' | 'detail' | 'silk' | 'original', 'auto' | 'manual' | 'skip'>>;
  selectedOutputTypes?: Array<'white' | 'model' | 'detail' | 'silk' | 'original'>;
}): Promise<RecommendedGalleryPack> {
  const warnings: string[] = [];
  const targetCount = Math.max(1, Math.min(5, params.targetSlotCount || 5));
  const sourceModes = params.sourceModes || {};
  const isSkipped = (card: 'white' | 'model' | 'detail' | 'silk' | 'original') =>
    sourceModes[card] === 'skip' || sourceModes[card] === 'manual';
  const slot2StyleChoice: StyledSlot2Option = params.slot2StyleOption || 'silk_and_flower';

  const usableItems = params.clusteredItems.filter(
    (item) => item.analysis.roleSuggestion !== 'DUPLICATE' && !item.analysis.isBlurry
  );

  if (usableItems.length < 3) {
    warnings.push(
      `Only ${usableItems.length} high-quality real image(s) detected. Three authentic photos are recommended.`
    );
  }

  const sourcePool = usableItems.length > 0 ? usableItems : params.clusteredItems;
  const aiRefCandidate =
    (params.aiReferenceMediaId &&
      params.clusteredItems.find(
        (item) => item.id === params.aiReferenceMediaId || item.originalFilename === params.aiReferenceMediaId
      )) ||
    null;

  const cleanCoverCandidate =
    sourcePool.find((item) => item.analysis.roleSuggestion === 'HERO_CANDIDATE' && !item.analysis.hasDistractingProps) ||
    sourcePool.find((item) => item.analysis.isCleanBackground && !item.analysis.hasDistractingProps) ||
    sourcePool.find((item) => !item.analysis.hasDistractingProps) ||
    sourcePool[0] ||
    params.clusteredItems[0];

  const slots: GallerySlot[] = [];

  // SLOT 1 — deterministic white e-commerce cover.
  if (cleanCoverCandidate && !isSkipped('white')) {
    const originalUrl =
      (cleanCoverCandidate as any).shopifySquareUrl ||
      `/api/photos/${cleanCoverCandidate.originalFilename}`;
    let cleanCoverUrl = (cleanCoverCandidate as any).cleanCoverUrl as string | undefined;
    let isolatedMasterUrl = (cleanCoverCandidate as any).isolatedMasterUrl as string | undefined;
    let qualityInfo: any = null;
    let coverError: string | undefined;
    const heroBuffer = getItemBuffer(cleanCoverCandidate);

    if (heroBuffer && !cleanCoverUrl) {
      try {
        const result = await createPureWhiteCover(
          heroBuffer,
          `${cleanCoverCandidate.id}_clean_cover_2048.jpg`,
          { targetWidth: 2048, targetHeight: 2048, backgroundMode: 'pure_white' }
        );
        cleanCoverUrl = result.relativeUrl;
        isolatedMasterUrl = result.isolatedMasterUrl || isolatedMasterUrl;
        qualityInfo = result.quality;
        (cleanCoverCandidate as any).cleanCoverUrl = cleanCoverUrl;
        (cleanCoverCandidate as any).isolatedMasterUrl = isolatedMasterUrl;
      } catch (err: any) {
        coverError = err.message || 'White background generation failed';
        warnings.push(`Slot 1 white background needs review: ${coverError}`);
      }
    }

    slots.push({
      slotNumber: 1,
      slotRole: 'HERO_COVER',
      slotTitle: cleanCoverUrl
        ? 'Main Cover / Hero (Pure White E-Commerce Background)'
        : 'Main Cover / Hero (Original — White BG Needs Review)',
      mediaId: cleanCoverCandidate.id,
      url: cleanCoverUrl || originalUrl,
      imageUrl: cleanCoverUrl || originalUrl,
      originalUrl,
      cleanCoverUrl,
      transparentUrl: isolatedMasterUrl,
      isolatedMasterUrl,
      currentBgMode: cleanCoverUrl ? 'pure_white' : 'original',
      segmentationQuality: qualityInfo || (coverError ? { isAcceptable: false, isValid: false, issues: [coverError] } : undefined),
      sourceType: 'real_photo',
      isCover: true,
      altText: cleanCoverUrl
        ? generateSlotAltText(params.productTitle, 'HERO_COVER')
        : `Front view of ${params.productTitle}`,
      qualityScore: cleanCoverUrl ? (qualityInfo?.qualityScore ?? 0) : (cleanCoverCandidate.analysis?.qualityScore || 0),
      isAiGenerated: false,
      canRegenerate: true,
      dimensions: cleanCoverUrl ? { width: 2048, height: 2048 } : undefined,
      included: Boolean(cleanCoverUrl),
      sourceMode: 'auto',
      generationProvider: cleanCoverUrl ? 'photoroom' : undefined,
      createdAt: new Date().toISOString(),
    });
  }

  const remainingAfterHero = sourcePool.filter((item) => item.id !== cleanCoverCandidate?.id);
  let styledSlot2Used = false;
  const existingStyledPhoto = remainingAfterHero.find(
    (item) =>
      item.analysis.roleSuggestion === 'STYLED_SUPPORTING' ||
      item.analysis.roleSuggestion === 'STYLED_CANDIDATE'
  );
  const allowSlot2Styled = Boolean(params.enableStyledSlot2) && !isSkipped('silk');

  // SLOT 2 — styled silk/flower image.
  if (!isSkipped('silk') && existingStyledPhoto && !allowSlot2Styled) {
    const styledUrl =
      (existingStyledPhoto as any).shopifySquareUrl || `/api/photos/${existingStyledPhoto.originalFilename}`;
    slots.push({
      slotNumber: 2,
      slotRole: 'STYLED_SUPPORTING',
      slotTitle: 'Styled Supporting Presentation',
      mediaId: existingStyledPhoto.id,
      url: styledUrl,
      imageUrl: styledUrl,
      sourceType: 'real_photo',
      isCover: false,
      altText: generateSlotAltText(
        params.productTitle,
        'STYLED_SUPPORTING',
        `Styled presentation of ${params.productTitle}`
      ),
      qualityScore: existingStyledPhoto.analysis.qualityScore,
      isAiGenerated: false,
      styledOption: slot2StyleChoice,
      canRegenerate: true,
      dimensions: { width: 2048, height: 2048 },
      included: true,
      sourceMode: 'auto',
      createdAt: new Date().toISOString(),
    });
    styledSlot2Used = true;
  } else if (allowSlot2Styled && (aiRefCandidate || cleanCoverCandidate)) {
    const targetSource = aiRefCandidate || cleanCoverCandidate!;
    const heroBuffer = getItemBuffer(targetSource) || getItemBuffer(cleanCoverCandidate);
    const heroUrl =
      (targetSource as any).shopifySquareUrl ||
      `/api/photos/${targetSource.originalFilename}`;

    const styledGen = await generateStyledImage({
      sourceImageUrl: heroUrl,
      productTitle: params.productTitle,
      styleOption: slot2StyleChoice,
      customPrompt: params.customPromptSlot2 || params.customPrompt,
      sourceBuffer: heroBuffer || undefined,
      mediaId: `styled_slot2_${targetSource.id}`,
      geminiApiKey: params.geminiApiKey,
      openaiApiKey: params.openaiApiKey,
      aiProvider: params.aiProvider,
    });

    if (styledGen.success && styledGen.generatedImageUrl) {
      slots.push({
        slotNumber: 2,
        slotRole: 'STYLED_SUPPORTING',
        slotTitle: `Styled Supporting (${STYLED_SLOT2_PRESETS[slot2StyleChoice]?.name || 'Silk & Flowers'})`,
        mediaId: `styled_slot2_${targetSource.id}`,
        url: styledGen.generatedImageUrl,
        imageUrl: styledGen.generatedImageUrl,
        sourceType: 'ai_lifestyle',
        isCover: false,
        altText: generateSlotAltText(params.productTitle, 'STYLED_SUPPORTING'),
        qualityScore: styledGen.consistencyScore ?? 0,
        isAiGenerated: true,
        styledOption: slot2StyleChoice,
        canRegenerate: true,
        dimensions: { width: 2048, height: 2048 },
        included: true,
        sourceMode: 'auto',
        generationProvider: styledGen.providerUsed,
        createdAt: new Date().toISOString(),
      });
      styledSlot2Used = true;
    } else {
      warnings.push(`Slot 2 generation failed: ${styledGen.error || 'AI generation failed'}`);
      slots.push(
        createFailedGeneratedSlot({
          slotNumber: 2,
          slotRole: 'STYLED_SUPPORTING',
          slotTitle: `Styled Supporting (${STYLED_SLOT2_PRESETS[slot2StyleChoice]?.name || 'Silk & Flowers'})`,
          mediaId: `styled_slot2_${targetSource.id}`,
          sourceType: 'ai_lifestyle',
          altText: generateSlotAltText(params.productTitle, 'STYLED_SUPPORTING'),
          error: styledGen.error || 'AI generation failed',
          styledOption: slot2StyleChoice,
        })
      );
    }
  } else if (!isSkipped('silk') && !isSkipped('original')) {
    const altCandidate = remainingAfterHero[0];
    if (altCandidate) {
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
        qualityScore: altCandidate.analysis?.qualityScore || 0,
        isAiGenerated: false,
        canRegenerate: true,
        dimensions: { width: 2048, height: 2048 },
        included: true,
      });
    }
  }

  // SLOT 3 — deterministic detail crop.
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
    const detailBuffer = getItemBuffer(detailCandidate);
    if (detailBuffer) {
      try {
        const res = await createDetailCraftsmanshipCrop(
          detailBuffer,
          `${detailCandidate.id}_detail_2048.jpg`,
          'pendant'
        );
        if (!isSkipped('detail')) slots.push({
          slotNumber: 3,
          slotRole: 'DETAIL_CLOSEUP',
          slotTitle: 'Detail / Craftsmanship Close-up',
          mediaId: `${detailCandidate.id}_detail`,
          url: res.relativeUrl,
          imageUrl: res.relativeUrl,
          sourceType: 'detail_crop',
          isCover: false,
          altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
          qualityScore: detailCandidate.analysis?.qualityScore || 0,
          isAiGenerated: false,
          canRegenerate: true,
          dimensions: { width: 2048, height: 2048 },
          included: true,
          sourceMode: 'auto',
          generationProvider: 'deterministic-crop',
          createdAt: new Date().toISOString(),
        });
      } catch (err: any) {
        warnings.push(`Slot 3 detail crop failed: ${err.message}`);
      }
    }
  }

  // SLOT 4 — actual model generation only.
  if (targetCount >= 4 && !isSkipped('model')) {
    const allowSlot4Model = params.enableModelSlot4 !== undefined
      ? params.enableModelSlot4
      : params.enableModelGeneration === true;

    if (allowSlot4Model && (aiRefCandidate || cleanCoverCandidate)) {
      const targetSource = aiRefCandidate || cleanCoverCandidate!;
      const presetKey = params.modelPresetKey || 'office_to_occasion';
      const heroBuffer = getItemBuffer(targetSource) || getItemBuffer(cleanCoverCandidate);
      const heroUrl =
        (targetSource as any).shopifySquareUrl || `/api/photos/${targetSource.originalFilename}`;

      const modelGen = await generateModelImage({
        sourceImageUrl: heroUrl,
        productTitle: params.productTitle,
        presetKey,
        customPrompt: params.customPromptSlot4 || params.customPrompt,
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
          qualityScore: modelGen.consistencyScore ?? 0,
          isAiGenerated: true,
          modelPresetKey: presetKey,
          canRegenerate: true,
          dimensions: { width: 2048, height: 2048 },
          included: true,
          sourceMode: 'auto',
          generationProvider: modelGen.providerUsed,
          createdAt: new Date().toISOString(),
        });
      } else {
        warnings.push(`Slot 4 model generation failed: ${modelGen.error || 'AI generation failed'}`);
        slots.push(
          createFailedGeneratedSlot({
            slotNumber: 4,
            slotRole: 'MODEL_1',
            slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,
            mediaId: `model_gen_1_${targetSource.id}`,
            sourceType: 'ai_model',
            altText: generateSlotAltText(params.productTitle, 'MODEL_1'),
            error: modelGen.error || 'AI generation failed',
            modelPresetKey: presetKey,
          })
        );
      }
    } else {
      const unusedReal = remainingAfterHero.find(
        (item) => !slots.some((s) => s.mediaId === item.id || s.mediaId.startsWith(item.id))
      );
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
          qualityScore: unusedReal.analysis?.qualityScore || 0,
          isAiGenerated: false,
          canRegenerate: true,
          dimensions: { width: 2048, height: 2048 },
          included: true,
        });
      }
    }
  }

  // SLOT 5 — authentic original photo. This remains separate from White Product.
  if (targetCount >= 5 && !isSkipped('original')) {
    const originalCandidate = cleanCoverCandidate || sourcePool[0] || params.clusteredItems[0];
    if (originalCandidate) {
      const originalUrl =
        (originalCandidate as any).shopifySquareUrl ||
        (originalCandidate as any).url ||
        `/api/photos/${originalCandidate.originalFilename}`;
      slots.push({
        slotNumber: 5,
        slotRole: 'REAL_PHOTO_FALLBACK',
        slotTitle: 'Original Photo',
        mediaId: `original_slot5_${originalCandidate.id}`,
        url: originalUrl,
        imageUrl: originalUrl,
        originalUrl,
        sourceType: 'real_photo',
        isCover: false,
        altText: `Original product photo of ${params.productTitle}`,
        qualityScore: originalCandidate.analysis?.qualityScore || 0,
        isAiGenerated: false,
        canRegenerate: false,
        dimensions: { width: 2048, height: 2048 },
        included: true,
        sourceMode: 'auto',
        generationProvider: 'original',
        createdAt: new Date().toISOString(),
      });
    }
  }

  const finalSlots = slots.sort((a, b) => a.slotNumber - b.slotNumber);
  const usableFinalSlots = finalSlots.filter((s) => !s.generationFailed && Boolean(s.url) && s.included !== false);
  const totalRealImagesUsed = usableFinalSlots.filter((s) => !s.isAiGenerated).length;
  const totalAiImagesUsed = usableFinalSlots.filter((s) => s.isAiGenerated).length;
  const heroReady = usableFinalSlots.some(
    (s) => s.slotRole === 'HERO_COVER' && s.currentBgMode === 'pure_white'
  );

  return {
    productId: params.productId,
    productTitle: params.productTitle,
    slots: finalSlots,
    warnings,
    totalRealImagesUsed,
    totalAiImagesUsed,
    slot2StyleOption: slot2StyleChoice,
    styledSlot2Used,
    sourceModes,
    isListingReady: heroReady && usableFinalSlots.length >= 3,
  };
}

/** Regenerates one slot without modifying any other slot. */
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
        generationFailed: false,
        generationError: undefined,
        included: true,
      };
      return { ...currentPack, slots: updatedSlots };
    }
  }

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
      refUrl = found.originalUrl || found.imageUrl || found.url;
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
        refUrl = found.originalUrl || found.imageUrl || found.url;
        refBuffer = getItemBuffer(found);
      }
    }
  } else if (options.sourceImageUrl) {
    refUrl = options.sourceImageUrl;
    refBuffer = getItemBuffer({ imageUrl: options.sourceImageUrl });
  }

  if (!refBuffer) {
    const heroSlot = updatedSlots.find((s) => s.slotRole === 'HERO_COVER') || updatedSlots[0];
    if (heroSlot) {
      refUrl = heroSlot.originalUrl || heroSlot.imageUrl || heroSlot.url;
      refBuffer =
        options.clusteredPool?.find((i) => heroSlot.mediaId === i.id)?.buffer ||
        getItemBuffer({ imageUrl: refUrl });
    }
  }

  if (slotNumber === 2 || options.targetRole === 'STYLED_SUPPORTING') {
    const styleOption = (
      options.newSlot2StyleOption ||
      options.newPresetKey ||
      targetSlot.styledOption ||
      'silk_and_flower'
    ) as StyledSlot2Option;

    const styledGen = await generateStyledImage({
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

    if (styledGen.success && styledGen.generatedImageUrl) {
      updatedSlots[targetIndex] = {
        ...targetSlot,
        url: styledGen.generatedImageUrl,
        imageUrl: styledGen.generatedImageUrl,
        slotRole: 'STYLED_SUPPORTING',
        slotTitle: `Styled Supporting (${STYLED_SLOT2_PRESETS[styleOption]?.name || 'Silk & Flowers'})`,
        altText: generateSlotAltText(currentPack.productTitle, 'STYLED_SUPPORTING'),
        styledOption: styleOption,
        sourceType: 'ai_lifestyle',
        qualityScore: styledGen.consistencyScore ?? 0,
        isAiGenerated: true,
        generationFailed: false,
        generationError: undefined,
        canRegenerate: true,
        included: true,
      };
    } else {
      updatedSlots[targetIndex] = {
        ...targetSlot,
        url: '',
        imageUrl: '',
        styledOption: styleOption,
        sourceType: 'ai_lifestyle',
        isAiGenerated: true,
        qualityScore: 0,
        generationFailed: true,
        generationError: styledGen.error || 'Regeneration failed',
        included: false,
      };
    }

    return {
      ...currentPack,
      slots: updatedSlots,
      slot2StyleOption: styleOption,
      styledSlot2Used: true,
      isListingReady: false,
    };
  }

  if (slotNumber === 4 || options.targetRole === 'AI_MODEL') {
    const presetKey = options.newPresetKey || targetSlot.modelPresetKey || 'office_to_occasion';
    const modelGen = await generateModelImage({
      sourceImageUrl: refUrl,
      productTitle: currentPack.productTitle,
      presetKey,
      customPrompt: options.newCustomPrompt,
      sourceBuffer: refBuffer || undefined,
      mediaId: `regenerated_model_${slotNumber}_${Date.now()}`,
      geminiApiKey: options.geminiApiKey,
      openaiApiKey: options.openaiApiKey,
      aiProvider: options.aiProvider,
    });

    if (modelGen.success && modelGen.generatedImageUrl) {
      updatedSlots[targetIndex] = {
        ...targetSlot,
        url: modelGen.generatedImageUrl,
        imageUrl: modelGen.generatedImageUrl,
        modelPresetKey: presetKey,
        slotRole: 'MODEL_1',
        slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,
        altText: `Fashion model wearing ${currentPack.productTitle}`,
        sourceType: 'ai_model',
        qualityScore: modelGen.consistencyScore ?? 0,
        isAiGenerated: true,
        generationFailed: false,
        generationError: undefined,
        canRegenerate: true,
        included: true,
      };
    } else {
      updatedSlots[targetIndex] = {
        ...targetSlot,
        url: '',
        imageUrl: '',
        modelPresetKey: presetKey,
        sourceType: 'ai_model',
        qualityScore: 0,
        isAiGenerated: true,
        generationFailed: true,
        generationError: modelGen.error || 'Model generation failed',
        included: false,
      };
    }
  }

  return {
    ...currentPack,
    slots: updatedSlots,
    isListingReady: false,
  };
}
