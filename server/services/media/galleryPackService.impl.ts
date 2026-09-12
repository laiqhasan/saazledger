import path from 'path';
import fs from 'fs';
import { UPLOADS_DIR, DERIVATIVES_DIR, getPhoto, getDerivative } from '../photoService';
import {
  createPureWhiteCover,
  createDetailCraftsmanshipCrop,
  createEarringComponentCrop,
  validateGalleryAsset,
} from './deterministicImageService';
import {
  getSourceHash,
  getIsolatedMasterPath,
} from './backgroundRemovalService';
import {
  generateStyledImage,
  generateModelImage,
} from './imageGenerationProvider';
import {
  generateWhiteProductImage,
  type WhiteProductMode,
} from './mediaPipelineService';
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
    item.originalUrl,
    item.originalFilename,
    item.url,
    item.imageUrl,
    item.shopifySquareUrl,
    item.cleanCoverUrl,
    item.isolatedMasterUrl,
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
        .replace('/api/derivatives/', '')
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
  outputRatio?: '1:1' | '4:5' | '9:16';
  mediaPackRole?: 'white' | 'model' | 'detail' | 'silk' | 'original';
  whiteProductMode?: 'exact_cutout' | 'ai_presentation';
  productMatchScore?: number;
  matchVerdict?: 'HIGH_MATCH' | 'REVIEW_RECOMMENDED' | 'NEEDS_REVIEW';
  accuracyAnalysis?: any;
  exactCutoutUrl?: string;
  measurementReference?: boolean;
  slotBadge?: string;
  forbiddenObjects?: string[];
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
  photoroomApiKey?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  aiReferenceMediaId?: string;
  aiProvider?: 'gemini' | 'openai';
  sourceModes?: Partial<Record<'white' | 'model' | 'detail' | 'silk' | 'original', 'auto' | 'manual' | 'skip'>>;
  selectedOutputTypes?: Array<'white' | 'model' | 'detail' | 'silk' | 'original'>;
  /** Output ratio for the White Product (Slot 1) image. Defaults to '1:1' (2048×2048). */
  whiteProductOutputRatio?: '1:1' | '4:5' | '9:16';
  whiteProductMode?: WhiteProductMode;
  whiteProductAiProvider?: 'auto' | 'gemini' | 'openai';
  whiteProductCustomInstruction?: string;
  mockScoreForTests?: number;
}): Promise<RecommendedGalleryPack> {
  const warnings: string[] = [];
  const targetCount = Math.max(1, Math.min(5, params.targetSlotCount || 5));
  const sourceModes = params.sourceModes || {};
  const isSkipped = (card: 'white' | 'model' | 'detail' | 'silk' | 'original') =>
    sourceModes[card] === 'skip' || sourceModes[card] === 'manual';
  const slot2StyleChoice: StyledSlot2Option = params.slot2StyleOption || 'silk_and_flower';

  // Resolve white product canvas dimensions from the requested output ratio.
  const whiteRatio = params.whiteProductOutputRatio || '1:1';
  const whiteProductDims: { width: number; height: number } = (() => {
    if (whiteRatio === '4:5') return { width: 1638, height: 2048 };
    if (whiteRatio === '9:16') return { width: 1152, height: 2048 };
    return { width: 2048, height: 2048 }; // '1:1' default
  })();

  // Ensure any in-memory clustered item buffers are persisted to UPLOADS_DIR for seamless regeneration
  const itemsList = params.clusteredItems || [];
  for (const item of itemsList) {
    if (item.buffer && item.originalFilename) {
      const uploadPath = path.join(UPLOADS_DIR, item.originalFilename);
      if (!fs.existsSync(uploadPath)) {
        try {
          fs.writeFileSync(uploadPath, item.buffer);
        } catch {}
      }
    }
  }

  const usableItems = itemsList.filter(
    (item) => item.analysis?.roleSuggestion !== 'DUPLICATE' && !item.analysis?.isBlurry
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

  // SLOT 1 — White Product (Exact Cutout or AI Presentation)
  if (cleanCoverCandidate && !isSkipped('white')) {
    const originalUrl =
      (cleanCoverCandidate as any).shopifySquareUrl ||
      `/api/photos/${cleanCoverCandidate.originalFilename}`;
    let cleanCoverUrl = (cleanCoverCandidate as any).cleanCoverUrl as string | undefined;
    let isolatedMasterUrl = (cleanCoverCandidate as any).isolatedMasterUrl as string | undefined;
    let qualityInfo: any = null;
    let coverError: string | undefined;
    const heroBuffer = getItemBuffer(cleanCoverCandidate);
    let wpMode: WhiteProductMode = params.whiteProductMode || 'exact_cutout';
    let wpUrl = cleanCoverUrl || '';
    let matchScore = 100;
    let matchVerdict: 'HIGH_MATCH' | 'REVIEW_RECOMMENDED' | 'NEEDS_REVIEW' = 'HIGH_MATCH';
    let accuracyAnalysis: any = undefined;
    let exactCutoutUrl: string | undefined = cleanCoverUrl;
    let isAi = false;
    let providerUsed = cleanCoverUrl ? 'photoroom' : undefined;

    if (heroBuffer) {
      try {
        const wpResult = await generateWhiteProductImage(heroBuffer, cleanCoverCandidate.id, {
          mode: wpMode,
          outputRatio: whiteRatio,
          aiProvider: params.whiteProductAiProvider || (params.aiProvider as any) || 'auto',
          productTitle: params.productTitle,
          customInstruction: params.whiteProductCustomInstruction,
          geminiApiKey: params.geminiApiKey,
          openaiApiKey: params.openaiApiKey,
          sourceImageUrl: originalUrl,
          mockScoreForTests: params.mockScoreForTests,
          apiKey: params.photoroomApiKey,
        });

        if (wpResult.url && originalUrl && wpResult.url === originalUrl) {
          throw new Error('Invariant violated: White Product URL cannot match raw original URL');
        }

        const wpFilename = path.basename(wpResult.url);
        const wpDiskPath = path.join(DERIVATIVES_DIR, wpFilename);
        if (fs.existsSync(wpDiskPath)) {
          const wpDiskBuf = fs.readFileSync(wpDiskPath);
          const validation = await validateGalleryAsset(wpDiskBuf, 'WHITE_PRODUCT');
          if (!validation.valid) {
            throw new Error(`White Product validation failed: ${validation.reason}`);
          }
        }

        wpUrl = wpResult.url;
        cleanCoverUrl = wpResult.exactCutoutUrl || wpResult.url;
        exactCutoutUrl = wpResult.exactCutoutUrl;
        isolatedMasterUrl = wpResult.isolatedMasterUrl || isolatedMasterUrl;
        qualityInfo = wpResult.quality;
        wpMode = wpResult.mode;
        matchScore = wpResult.productMatchScore;
        matchVerdict = wpResult.matchVerdict;
        accuracyAnalysis = wpResult.accuracyAnalysis;
        isAi = wpResult.mode === 'ai_presentation';
        providerUsed = wpResult.providerUsed || (cleanCoverUrl ? 'photoroom' : undefined);
        (cleanCoverCandidate as any).cleanCoverUrl = cleanCoverUrl;
        (cleanCoverCandidate as any).isolatedMasterUrl = isolatedMasterUrl;

        console.log('[GALLERY_SLOT1_ASSIGN]', {
          slot: 1,
          source: 'WHITE_PRODUCT_FINAL',
          url: wpUrl,
          hasRuler: false,
        });
      } catch (err: any) {
        coverError = err.message || 'White Product generation failed — regenerate';
        warnings.push(`Slot 1 white background needs review: ${coverError}`);
      }
    }

    const isWhiteGenerated = Boolean(cleanCoverUrl && wpUrl && !coverError);

    slots.push({
      slotNumber: 1,
      slotRole: 'HERO_COVER',
      slotTitle: isWhiteGenerated
        ? (wpMode === 'ai_presentation'
            ? `Main Cover / Hero (AI Presentation — ${matchScore}% Match)`
            : 'Main Cover / Hero (Exact Cutout — Pure White E-Commerce Background)')
        : 'White Product generation failed — regenerate',
      mediaId: cleanCoverCandidate.id,
      url: isWhiteGenerated ? wpUrl : '',
      imageUrl: isWhiteGenerated ? wpUrl : '',
      originalUrl,
      cleanCoverUrl: isWhiteGenerated ? cleanCoverUrl : undefined,
      exactCutoutUrl: isWhiteGenerated ? exactCutoutUrl : undefined,
      transparentUrl: isolatedMasterUrl,
      isolatedMasterUrl,
      currentBgMode: 'pure_white',
      segmentationQuality: qualityInfo || (coverError ? { isAcceptable: false, isValid: false, issues: [coverError] } : undefined),
      sourceType: isAi ? 'ai_lifestyle' : 'real_photo',
      isCover: true,
      altText: isWhiteGenerated
        ? generateSlotAltText(params.productTitle, 'HERO_COVER')
        : `Front view of ${params.productTitle}`,
      qualityScore: isWhiteGenerated ? (qualityInfo?.qualityScore ?? matchScore) : 0,
      isAiGenerated: isAi,
      canRegenerate: true,
      dimensions: { width: whiteProductDims.width, height: whiteProductDims.height },
      outputRatio: whiteRatio,
      whiteProductMode: wpMode,
      productMatchScore: matchScore,
      matchVerdict: matchVerdict,
      accuracyAnalysis,
      included: isWhiteGenerated,
      generationFailed: !isWhiteGenerated,
      generationError: isWhiteGenerated ? undefined : (coverError || 'White Product generation failed — regenerate'),
      sourceMode: 'auto',
      generationProvider: providerUsed,
      createdAt: new Date().toISOString(),
      mediaPackRole: 'white',
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
    let detailSourceBuffer: Buffer | null = null;
    let isolatedMasterBuf: Buffer | undefined = undefined;
    let whiteProductBuf: Buffer | undefined = undefined;

    // Priority 1: isolatedMaster transparent PNG (guaranteed ruler-free)
    const candidatesForMaster = [detailCandidate, cleanCoverCandidate].filter(Boolean);
    for (const c of candidatesForMaster) {
      const cBuf = getItemBuffer(c);
      if (cBuf) {
        const sHash = getSourceHash(cBuf);
        const mInfo = getIsolatedMasterPath(sHash);
        if (fs.existsSync(mInfo.filepath)) {
          try {
            isolatedMasterBuf = fs.readFileSync(mInfo.filepath);
            break;
          } catch {}
        }
      }
    }

    // Priority 2: final White Product image
    if (!isolatedMasterBuf) {
      const wpTargetUrl = wpUrl || cleanCoverUrl;
      if (wpTargetUrl) {
        const wpFile = path.basename(wpTargetUrl);
        const wpPath = path.join(DERIVATIVES_DIR, wpFile);
        if (fs.existsSync(wpPath)) {
          try {
            whiteProductBuf = fs.readFileSync(wpPath);
          } catch {}
        }
      }
    }

    // Priority 3: NEVER raw source when a clean master exists
    if (isolatedMasterBuf) {
      detailSourceBuffer = isolatedMasterBuf;
    } else if (whiteProductBuf) {
      detailSourceBuffer = whiteProductBuf;
    } else {
      const fallbackRawBuf = getItemBuffer(cleanCoverCandidate) || getItemBuffer(detailCandidate);
      if (fallbackRawBuf) {
        try {
          const { getOrCreateIsolatedMasterPng } = await import('./backgroundRemovalService');
          const iso = await getOrCreateIsolatedMasterPng(fallbackRawBuf, {
            apiKey: params.photoroomApiKey,
            geminiApiKey: params.geminiApiKey,
          });
          isolatedMasterBuf = iso.buffer;
          detailSourceBuffer = iso.buffer;
        } catch {}
      }
    }

    if (!detailSourceBuffer) {
      detailSourceBuffer = getItemBuffer(detailCandidate);
    }

    if (detailSourceBuffer) {
      try {
        const detailFilename = `detail_closeup_${detailCandidate.id}.jpg`;
        const res = await createDetailCraftsmanshipCrop(
          detailSourceBuffer,
          detailFilename,
          'pendant',
          undefined,
          {
            isolatedMasterBuffer: isolatedMasterBuf,
            whiteProductBuffer: whiteProductBuf,
          }
        );

        const detailOrigUrl =
          (detailCandidate as any).originalUrl ||
          (detailCandidate as any).url ||
          (detailCandidate as any).shopifySquareUrl;
        if (res?.relativeUrl && detailOrigUrl && res.relativeUrl === detailOrigUrl) {
          throw new Error('Invariant violated: Detail closeup URL cannot match raw original URL');
        }

        const validation = await validateGalleryAsset(res.buffer, 'DETAIL_CLOSEUP');
        const isValid = validation.valid;

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
          included: isValid,
          generationFailed: !isValid,
          generationError: isValid ? undefined : validation.reason,
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
      const origCandidateUrl =
        (originalCandidate as any).shopifySquareUrl ||
        (originalCandidate as any).url ||
        `/api/photos/${originalCandidate.originalFilename}`;

      let isMeasurementRef = false;
      const origCandidateBuffer = getItemBuffer(originalCandidate);
      if (origCandidateBuffer) {
        try {
          const v = await validateGalleryAsset(origCandidateBuffer, 'REAL_PHOTO');
          if (v.forbiddenObjects.includes('ruler')) {
            isMeasurementRef = true;
          }
        } catch {}
      }

      slots.push({
        slotNumber: 5,
        slotRole: 'REAL_PHOTO_FALLBACK',
        slotTitle: isMeasurementRef
          ? 'Original Photo (Measurement Reference)'
          : 'Original Photo',
        mediaId: `original_slot5_${originalCandidate.id}`,
        url: origCandidateUrl,
        imageUrl: origCandidateUrl,
        originalUrl: origCandidateUrl,
        sourceType: 'real_photo',
        isCover: false,
        altText: isMeasurementRef
          ? `Original measurement reference photo with scale for ${params.productTitle}`
          : `Original product photo of ${params.productTitle}`,
        qualityScore: originalCandidate.analysis?.qualityScore || 0,
        isAiGenerated: false,
        canRegenerate: false,
        dimensions: { width: 2048, height: 2048 },
        included: !isMeasurementRef,
        measurementReference: isMeasurementRef,
        slotBadge: isMeasurementRef ? 'Measurement Reference' : undefined,
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
    photoroomApiKey?: string;
    geminiApiKey?: string;
    openaiApiKey?: string;
    sourceSlotNumber?: number;
    sourceMediaId?: string;
    sourceImageUrl?: string;
    sourceBase64?: string;
    targetRole?: 'AI_MODEL' | 'STYLED_SUPPORTING' | 'HERO_COVER' | 'white';
    aiProvider?: 'gemini' | 'openai';
    whiteProductOutputRatio?: '1:1' | '4:5' | '9:16';
    whiteProductMode?: WhiteProductMode;
    whiteProductAiProvider?: 'auto' | 'gemini' | 'openai';
    mockScoreForTests?: number;
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
        getItemBuffer(heroSlot);
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

  if (slotNumber === 1 || options.targetRole === 'HERO_COVER' || options.targetRole === 'white') {
    const mode: WhiteProductMode =
      options.whiteProductMode ||
      targetSlot.whiteProductMode ||
      'exact_cutout';
    const ratio: '1:1' | '4:5' | '9:16' =
      options.whiteProductOutputRatio ||
      (targetSlot.outputRatio as any) ||
      '1:1';
    const dims: Record<string, { width: number; height: number }> = {
      '1:1': { width: 2048, height: 2048 },
      '4:5': { width: 1638, height: 2048 },
      '9:16': { width: 1152, height: 2048 },
    };
    const { width, height } = dims[ratio] || dims['1:1'];

    if (refBuffer) {
      try {
        const wpResult = await generateWhiteProductImage(refBuffer, targetSlot.mediaId || 'slot1', {
          mode,
          outputRatio: ratio,
          aiProvider: options.whiteProductAiProvider || (options.aiProvider as any) || 'auto',
          customInstruction: options.newCustomPrompt,
          productTitle: currentPack.productTitle,
          geminiApiKey: options.geminiApiKey,
          openaiApiKey: options.openaiApiKey,
          sourceImageUrl: targetSlot.originalUrl || targetSlot.imageUrl,
          mockScoreForTests: options.mockScoreForTests,
          apiKey: options.photoroomApiKey,
        });

        updatedSlots[targetIndex] = {
          ...targetSlot,
          url: wpResult.url,
          imageUrl: wpResult.url,
          cleanCoverUrl: wpResult.exactCutoutUrl || wpResult.url,
          exactCutoutUrl: wpResult.exactCutoutUrl,
          isolatedMasterUrl: wpResult.isolatedMasterUrl || targetSlot.isolatedMasterUrl,
          dimensions: { width, height },
          outputRatio: ratio,
          whiteProductMode: wpResult.mode,
          productMatchScore: wpResult.productMatchScore,
          matchVerdict: wpResult.matchVerdict,
          accuracyAnalysis: wpResult.accuracyAnalysis,
          currentBgMode: 'pure_white',
          sourceType: wpResult.mode === 'ai_presentation' ? 'ai_lifestyle' : 'real_photo',
          isAiGenerated: wpResult.mode === 'ai_presentation',
          generationProvider: wpResult.providerUsed || targetSlot.generationProvider,
          generationFailed: false,
          generationError: undefined,
          included: true,
        };
      } catch (err: any) {
        updatedSlots[targetIndex] = {
          ...targetSlot,
          url: '',
          imageUrl: '',
          cleanCoverUrl: undefined,
          generationFailed: true,
          generationError: err.message || 'White cover generation failed',
          included: false,
        };
      }
    }
  }

  return {
    ...currentPack,
    slots: updatedSlots,
    isListingReady: false,
  };
}
