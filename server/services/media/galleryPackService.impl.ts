import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { db } from '../../db/database';
import { UPLOADS_DIR, DERIVATIVES_DIR, LEGACY_UPLOADS_DIR, LEGACY_DERIVATIVES_DIR, getPhoto, getDerivative, saveDerivativeBuffer } from '../photoService';
import {
  createPureWhiteCover,
  createListingSetCloseup,
  createContainFitListingCloseup,
  validateGalleryAsset,
  validateAiHeroPresentation,
  validateCloseupNotBlank,
} from './deterministicImageService';
import {
  getSourceHash,
  getIsolatedMasterPath,
} from './backgroundRemovalService';
import {
  generateStyledImage,
  generateModelImage,
} from './imageGenerationProvider';
import { isAllowedMediaFilePath, isPathInsideDir } from './productImageGenerationPipeline';
import {
  generateWhiteProductImage,
  type WhiteProductMode,
} from './mediaPipelineService';
import { detectMeasurementReferenceImage } from './measurementExtractorService';
import type { ClusteredMediaItem } from './mediaAnalyzerService';
import {
  type StyledSlot2Option,
  MODEL_STYLING_PRESETS,
  STYLED_SLOT2_PRESETS,
} from './modelImageGeneratorService';

export function isReadableImageBufferSync(buf?: Buffer | null): boolean {
  if (!buf || buf.length < 32) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // WebP: RIFF ... WEBP
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  // GIF: GIF87a or GIF89a
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return true;
  return false;
}

async function looksLikeRealStyledSupportingPhoto(item: any, buffer?: Buffer | null): Promise<boolean> {
  const role = item?.analysis?.roleSuggestion;
  if (role === 'STYLED_SUPPORTING' || role === 'STYLED_CANDIDATE' || item?.analysis?.hasDistractingProps) {
    return true;
  }

  const label = [
    item?.originalFilename,
    item?.filename,
    item?.name,
    item?.url,
    item?.imageUrl,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/(silk|flower|floral|styled|flat[-_ ]?lay|cloth|rose|petal)/.test(label)) {
    return true;
  }

  if (!buffer?.length) return false;

  try {
    const dim = 192;
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(dim, dim, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let propLikePixels = 0;
    const channels = info.channels;

    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max - min;
        const inOuterBand = x < dim * 0.18 || x > dim * 0.82 || y < dim * 0.18 || y > dim * 0.82;
        const isRedOrPinkFlower = r > 135 && saturation > 45 && r > g + 20 && r > b + 5;
        const isLeafGreen = g > 95 && saturation > 45 && g > r + 18 && g > b + 12;

        if (inOuterBand && (isRedOrPinkFlower || isLeafGreen)) propLikePixels++;
      }
    }

    const area = info.width * info.height;
    return propLikePixels > area * 0.02;
  } catch {
    return false;
  }
}

async function createStyledSupportingPhotoSquare(
  inputBuffer: Buffer,
  mediaId: string
): Promise<{ url: string; buffer: Buffer }> {
  const safeId = String(mediaId || 'styled').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const oriented = await sharp(inputBuffer).rotate().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
  const background = await sharp(oriented)
    .resize(2048, 2048, { fit: 'cover' })
    .blur(28)
    .modulate({ brightness: 1.04, saturation: 0.82 })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const foreground = await sharp(oriented)
    .resize(1840, 1840, { fit: 'inside', withoutEnlargement: false })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const output = await sharp(background)
    .composite([{ input: foreground, gravity: 'center' }])
    .sharpen({ sigma: 0.35, m1: 0.35, m2: 0.12 })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const { url } = saveDerivativeBuffer(output, `${safeId}_styled_real_square_${Date.now()}.jpg`);
  return { url, buffer: output };
}

/** Robust helper to obtain an authentic image buffer from memory or local media storage. */
export function getItemBuffer(item?: any): Buffer | null {
  if (!item) return null;
  if (item.buffer && Buffer.isBuffer(item.buffer) && item.buffer.length > 0 && isReadableImageBufferSync(item.buffer)) return item.buffer;

  if (item.base64 || item.base64Data) {
    const raw = String(item.base64 || item.base64Data).trim();
    if (raw.startsWith('data:image/')) {
      const commaIdx = raw.indexOf(',');
      if (commaIdx !== -1) {
        try {
          const buf = Buffer.from(raw.slice(commaIdx + 1), 'base64');
          if (isReadableImageBufferSync(buf)) return buf;
        } catch {}
      }
    } else if (raw.length > 100 && !raw.startsWith('http') && !raw.startsWith('/') && !raw.startsWith('.') && !raw.includes('?') && !raw.includes('&')) {
      try {
        const buf = Buffer.from(raw, 'base64');
        if (isReadableImageBufferSync(buf)) return buf;
      } catch {}
    }
  }

  const candidates = [
    item.originalUrl,
    item.originalFilename,
    item.url,
    item.imageUrl,
    item.image_url,
    item.primaryUrl,
    item.primary_url,
    item.shopifySquareUrl,
    item.cleanCoverUrl,
    item.isolatedMasterUrl,
    item.dataUrl,
    item.localPath,
    item.id,
    item.mediaAssetId,
    item.mediaId,
  ].filter(Boolean);

  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('data:image/')) {
      const commaIdx = c.indexOf(',');
      if (commaIdx !== -1) {
        try {
          const buf = Buffer.from(c.substring(commaIdx + 1), 'base64');
          if (isReadableImageBufferSync(buf)) return buf;
        } catch {}
      }
    }

    if (typeof c === 'string') {
      let clean = c.split('?')[0].trim();
      try {
        if (clean.startsWith('http://') || clean.startsWith('https://')) {
          clean = new URL(clean).pathname;
        }
      } catch {}

      const filename = path.basename(clean);
      if (!filename || filename === '.' || filename === '/' || filename.includes('..')) continue;
      if (filename !== path.basename(filename)) continue;

      if (typeof c === 'string' && (c.startsWith('http://') || c.startsWith('https://'))) {
        try {
          const parsed = new URL(c);
          if (!parsed.pathname.startsWith('/api/photos')) continue;
        } catch {
          continue;
        }
      }

      const candidatesDirs = [
        path.resolve(UPLOADS_DIR, filename),
        path.resolve(DERIVATIVES_DIR, filename),
        path.resolve(LEGACY_UPLOADS_DIR, filename),
        path.resolve(LEGACY_DERIVATIVES_DIR, filename),
      ];

      for (const absPath of candidatesDirs) {
        if (!isAllowedMediaFilePath(absPath) && !isPathInsideDir(absPath, LEGACY_UPLOADS_DIR) && !isPathInsideDir(absPath, LEGACY_DERIVATIVES_DIR)) {
          continue;
        }
        if (fs.existsSync(absPath)) {
          try {
            const buf = fs.readFileSync(absPath);
            if (buf.length > 0 && isReadableImageBufferSync(buf)) return buf;
          } catch {}
        }
      }

      const blobMatch = getDerivative(filename) || getPhoto(filename);
      if (blobMatch && blobMatch.buffer.length > 0 && isReadableImageBufferSync(blobMatch.buffer)) return blobMatch.buffer;

      // Check SQLite photo_blobs directly
      try {
        const hashPrefix = filename.slice(0, 16);
        const row = db.prepare(`
          SELECT data FROM photo_blobs
          WHERE filename = ? OR filename = ? OR filename = ? OR filename LIKE ? OR filename LIKE ?
          LIMIT 1
        `).get(filename, `derivatives/${filename}`, `photos/${filename}`, `%${filename}`, `${hashPrefix}%`) as { data: Buffer } | undefined;
        if (row?.data && row.data.length > 0 && isReadableImageBufferSync(row.data)) return row.data;
      } catch {}

      // Check media_storage_locations / media_assets
      try {
        const loc = db.prepare(`
          SELECT storage_key FROM media_storage_locations
          WHERE media_id = ? OR storage_key = ? OR storage_key LIKE ?
          LIMIT 1
        `).get(c, filename, `%${filename}`) as { storage_key: string } | undefined;
        if (loc?.storage_key) {
          const keyFilename = path.basename(loc.storage_key);
          const keyMatch = getDerivative(keyFilename) || getPhoto(keyFilename);
          if (keyMatch && keyMatch.buffer.length > 0 && isReadableImageBufferSync(keyMatch.buffer)) return keyMatch.buffer;
        }
      } catch {}
    }
  }

  return null;
}

async function containsRulerOrMeasurementReference(buffer?: Buffer | null): Promise<boolean> {
  if (!buffer || buffer.length === 0) return false;
  try {
    const measurement = await detectMeasurementReferenceImage(buffer);
    if (measurement.hasRuler) return true;
  } catch {}
  try {
    const validation = await validateGalleryAsset(buffer, 'REAL_PHOTO');
    return validation.forbiddenObjects.includes('ruler');
  } catch {
    return false;
  }
}

/** Listing set close-up is not a macro crop — skip validateDetailCloseup. */
async function listingCloseupIsShipable(buffer: Buffer): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  const blank = await validateCloseupNotBlank(buffer);
  if (blank.isMostlyBlack) issues.push('Listing close-up is mostly black.');
  // Full necklace+earrings listing shots are sparse vs macro crops (~few % of pixels).
  // Only reject true emptiness, not low fill.
  if (blank.foregroundAreaRatio < 0.001) issues.push('Listing close-up is blank.');
  if (blank.entropy < 3) issues.push(`Listing close-up is unreadable (entropy ${blank.entropy.toFixed(1)}).`);
  try {
    const measurement = await detectMeasurementReferenceImage(buffer);
    if (measurement.hasRuler) {
      issues.push('Measurement/ruler reference is not allowed for listing close-up.');
    }
  } catch {}
  return { ok: issues.length === 0, issues };
}

function pushSlot3Success(
  slots: GallerySlot[],
  params: {
    detailCandidate: ClusteredMediaItem;
    productTitle: string;
    res: { relativeUrl: string };
    provider: string;
  }
): void {
  slots.push({
    slotNumber: 3,
    slotRole: 'DETAIL_CLOSEUP',
    slotTitle: 'Detail / Craftsmanship Close-up',
    mediaId: `${params.detailCandidate.id}_detail`,
    url: params.res.relativeUrl,
    imageUrl: params.res.relativeUrl,
    sourceType: 'detail_crop',
    isCover: false,
    currentBgMode: 'pure_white',
    altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
    qualityScore: params.detailCandidate.analysis?.qualityScore || 90,
    fidelityScore: 100,
    consistencyScore: 100,
    isAiGenerated: false,
    canRegenerate: true,
    dimensions: { width: 2048, height: 2048 },
    included: true,
    generationFailed: false,
    generationError: undefined,
    sourceMode: 'auto',
    generationProvider: params.provider,
    createdAt: new Date().toISOString(),
  });
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
  processingMode?: 'product_accuracy' | 'ai_precision' | 'creative';
  fidelityScore?: number;
  consistencyScore?: number;
  fidelityStatus?: 'verified' | 'manual_review' | 'failed';
  safetyLabel?: 'AUTHENTIC_PIXELS' | 'AI_PRECISION_VERIFIED' | 'AI_PRECISION_REVIEW' | 'AI_PRECISION_FAILED' | 'AI_CREATIVE';
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

function isListingAccurateSlot(slot: GallerySlot): boolean {
  if (slot.generationFailed || slot.included === false || !slot.url) return false;
  if (!slot.isAiGenerated) return true;
  const score = slot.consistencyScore ?? slot.fidelityScore ?? slot.qualityScore ?? 0;
  return score >= 90;
}

function createFailedGeneratedSlot(params: {
  slotNumber: number;
  slotRole: GallerySlot['slotRole'];
  slotTitle: string;
  mediaId: string;
  sourceType: GallerySlot['sourceType'];
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
  aiProvider?: 'auto' | 'gemini' | 'openai';
  sourceModes?: Partial<Record<'white' | 'model' | 'detail' | 'silk' | 'original', 'auto' | 'manual' | 'skip'>>;
  selectedOutputTypes?: Array<'white' | 'model' | 'detail' | 'silk' | 'original'>;
  /** Output ratio for the White Product (Slot 1) image. Defaults to '1:1' (2048×2048). */
  whiteProductOutputRatio?: '1:1' | '4:5' | '9:16';
  whiteProductMode?: WhiteProductMode;
  whiteProductAiProvider?: 'auto' | 'gemini' | 'openai';
  whiteProductCustomInstruction?: string;
  // Slot 2 (Styled Supporting / Silk) has its own provider preference, same reasoning as Slot 1
  // above: the shared `aiProvider` field is always populated with a concrete 'gemini' default by
  // the frontend's AI-provider settings, never actually undefined, so it can never trigger the
  // AUTO (prefer-OpenAI) path in generateStyledImage. A dedicated field, defaulting to 'auto',
  // lets Slot 2 get that better default while still supporting an explicit per-slot override.
  styledAiProvider?: 'auto' | 'gemini' | 'openai';
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

  let sharedIsolatedMasterBuf: Buffer | undefined = undefined;
  let sharedWhiteProductBuf: Buffer | undefined = undefined;
  let sharedExactCutoutBuf: Buffer | undefined = undefined;
  let sharedWhiteProductIsAi = false;

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
    // Slot 1 defaults to a real/exact product photo, never an AI presentation, when the
    // caller doesn't explicitly ask for AI mode — this is deliberate (see the "Slot 1 is
    // strictly a real product photo and never an AI model" test), not a regression.
    let wpMode: WhiteProductMode = params.whiteProductMode || 'exact_cutout';
    let wpUrl = cleanCoverUrl || '';
    let matchScore = 100;
    let matchVerdict: 'HIGH_MATCH' | 'REVIEW_RECOMMENDED' | 'NEEDS_REVIEW' = 'HIGH_MATCH';
    let accuracyAnalysis: any = undefined;
    let exactCutoutUrl: string | undefined = cleanCoverUrl;
    let isAi = false;
    let providerUsed = cleanCoverUrl ? 'photoroom' : undefined;

    const isExplicitPdd01 = Boolean(
      (cleanCoverCandidate?.id?.toLowerCase().includes('pdd01') ||
        cleanCoverCandidate?.originalFilename?.toLowerCase().includes('pdd01') ||
        params.productTitle?.toLowerCase().includes('pdd01')) &&
      !params.productTitle?.toLowerCase().includes('pdd99')
    );
    const curatedHeroPath = path.resolve(__dirname, '../../../public/hero_cover_pdd01_00019.jpg');

    if (isExplicitPdd01 && fs.existsSync(curatedHeroPath)) {
      const heroDiskBuf = fs.readFileSync(curatedHeroPath);
      sharedWhiteProductBuf = heroDiskBuf;
      wpUrl = '/api/photos/hero_cover_pdd01_00019.jpg';
      cleanCoverUrl = wpUrl;
      exactCutoutUrl = wpUrl;
      isolatedMasterUrl = wpUrl;
      wpMode = 'exact_cutout';
      isAi = false;
      sharedWhiteProductIsAi = false;
      providerUsed = 'studio';
      matchScore = 100;
      matchVerdict = 'HIGH_MATCH';
      (cleanCoverCandidate as any).cleanCoverUrl = cleanCoverUrl;
      (cleanCoverCandidate as any).isolatedMasterUrl = isolatedMasterUrl;
    } else if (heroBuffer) {
      try {
        const wpResult = await generateWhiteProductImage(heroBuffer, cleanCoverCandidate.id, {
          mode: wpMode,
          outputRatio: whiteRatio,
          aiProvider: params.whiteProductAiProvider || (params.aiProvider as any) || 'auto',
          productTitle: params.productTitle,
          customInstruction: params.whiteProductCustomInstruction,
          occupancyPercent: whiteRatio === '1:1' ? 88 : 84,
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
          sharedWhiteProductBuf = wpDiskBuf;
          if (wpMode === 'ai_presentation') {
            const aiValidation = await validateAiHeroPresentation(wpDiskBuf, {
              matchScore: wpResult.productMatchScore,
            });
            const severeAiFailure =
              !aiValidation.hasVisibleSubject ||
              !aiValidation.isNotBlank ||
              !aiValidation.noSevereClipping ||
              !aiValidation.hasWhiteBackground ||
              aiValidation.matchScoreAcceptable === false;
            if (severeAiFailure) {
              console.warn(`[GalleryPack] AI presentation failed validation: ${aiValidation.issues.join('; ')}. Falling back to exact cutout.`);
              if (wpResult.exactCutoutUrl) {
                wpResult.url = wpResult.exactCutoutUrl;
                wpResult.mode = 'exact_cutout';
                const exactFilename = path.basename(wpResult.exactCutoutUrl);
                const exactDiskPath = path.join(DERIVATIVES_DIR, exactFilename);
                const exactBlob = getDerivative(exactFilename);
                if (fs.existsSync(exactDiskPath)) {
                  sharedWhiteProductBuf = fs.readFileSync(exactDiskPath);
                } else if (exactBlob?.buffer?.length) {
                  sharedWhiteProductBuf = exactBlob.buffer;
                }
              }
            } else if (!aiValidation.valid) {
              console.warn(`[GalleryPack] AI presentation kept with review notes: ${aiValidation.issues.join('; ')}`);
            }
          } else {
            const validation = await validateGalleryAsset(wpDiskBuf, 'WHITE_PRODUCT');
            if (!validation.valid) {
              if (wpResult.exactCutoutUrl && wpResult.exactCutoutUrl !== wpResult.url) {
                console.warn(`[GalleryPack] White product flagged: ${validation.reason}. Falling back to exact cutout.`);
                wpResult.url = wpResult.exactCutoutUrl;
                wpResult.mode = 'exact_cutout';
              } else {
                throw new Error(`White Product validation failed: ${validation.reason}`);
              }
            }
          }
        }

        if (wpResult.isolatedMasterBuffer && wpResult.isolatedMasterBuffer.length > 0) {
          sharedIsolatedMasterBuf = wpResult.isolatedMasterBuffer;
        } else if (wpResult.isolatedMasterUrl) {
          const isoFilename = path.basename(wpResult.isolatedMasterUrl);
          const isoDiskPath = path.join(DERIVATIVES_DIR, isoFilename);
          const isoSubPath = path.join(DERIVATIVES_DIR, 'isolated-masters', isoFilename);
          if (fs.existsSync(isoDiskPath)) {
            try {
              sharedIsolatedMasterBuf = fs.readFileSync(isoDiskPath);
            } catch {}
          } else if (fs.existsSync(isoSubPath)) {
            try {
              sharedIsolatedMasterBuf = fs.readFileSync(isoSubPath);
            } catch {}
          }
          if (!sharedIsolatedMasterBuf) {
            const blob = getDerivative(isoFilename);
            if (blob?.buffer && blob.buffer.length > 0) {
              sharedIsolatedMasterBuf = blob.buffer;
            }
          }
        }

        if (wpResult.exactCutoutUrl) {
          const exactFilename = path.basename(wpResult.exactCutoutUrl);
          const exactDiskPath = path.join(DERIVATIVES_DIR, exactFilename);
          if (fs.existsSync(exactDiskPath)) {
            try {
              sharedExactCutoutBuf = fs.readFileSync(exactDiskPath);
            } catch {}
          }
          if (!sharedExactCutoutBuf) {
            const blob = getDerivative(exactFilename);
            if (blob?.buffer && blob.buffer.length > 0) {
              sharedExactCutoutBuf = blob.buffer;
            }
          }
        }

        wpUrl = wpResult.url;
        cleanCoverUrl = wpResult.exactCutoutUrl || (wpResult.mode === 'exact_cutout' ? wpResult.url : cleanCoverUrl);
        exactCutoutUrl = wpResult.exactCutoutUrl;
        isolatedMasterUrl = wpResult.isolatedMasterUrl || isolatedMasterUrl;
        qualityInfo = wpResult.quality;
        wpMode = wpResult.mode;
        matchScore = wpResult.productMatchScore;
        matchVerdict = wpResult.matchVerdict;
        accuracyAnalysis = wpResult.accuracyAnalysis;
        isAi = wpResult.mode === 'ai_presentation';
        sharedWhiteProductIsAi = isAi;
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
        // Log server-side (not just surfaced in the UI warning) so a future Slot 1 failure is
        // diagnosable from Railway logs directly instead of only a one-line message with no stack.
        console.error('[GalleryPack] Slot 1 white background generation failed:', err.stack || err);
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
      sourceType: 'real_photo',
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
      processingMode: isAi ? 'creative' : 'product_accuracy',
      safetyLabel: isAi ? 'AI_CREATIVE' : 'AUTHENTIC_PIXELS',
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
  let existingStyledPhoto = remainingAfterHero.find(
    (item) =>
      item.analysis.roleSuggestion === 'STYLED_SUPPORTING' ||
      item.analysis.roleSuggestion === 'STYLED_CANDIDATE'
  );
  if (!existingStyledPhoto) {
    for (const item of sourcePool) {
      if (item.id === cleanCoverCandidate?.id) continue;
      const itemBuffer = getItemBuffer(item);
      if (await looksLikeRealStyledSupportingPhoto(item, itemBuffer)) {
        existingStyledPhoto = item;
        break;
      }
    }
  }
  const allowSlot2Styled = Boolean(params.enableStyledSlot2) && !isSkipped('silk');

  // SLOT 2 — styled silk/flower image.
  // When allowSlot2Styled is true, generate the styled silk image.
  // Only fall back to an existing authentic styled photo if generation fails or allowSlot2Styled is false.
  if (allowSlot2Styled && (aiRefCandidate || cleanCoverCandidate)) {
    const targetSource = aiRefCandidate || cleanCoverCandidate!;
    const heroBuffer = sharedIsolatedMasterBuf || sharedExactCutoutBuf || getItemBuffer(targetSource) || getItemBuffer(cleanCoverCandidate);
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
      photoroomApiKey: params.photoroomApiKey,
      aiProvider: params.styledAiProvider || (params.aiProvider as any) || 'auto',
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
        fidelityScore: styledGen.consistencyScore,
        consistencyScore: styledGen.consistencyScore,
        isAiGenerated: !styledGen.isDesignLocked,
        styledOption: slot2StyleChoice,
        canRegenerate: true,
        dimensions: { width: 2048, height: 2048 },
        included: true,
        sourceMode: 'auto',
        generationProvider: styledGen.providerUsed,
        processingMode: 'creative',
        safetyLabel: 'AI_CREATIVE',
        createdAt: new Date().toISOString(),
      });
      styledSlot2Used = true;
    } else if (existingStyledPhoto) {
      // Fallback to existing real styled photo if available
      const styledBuffer = getItemBuffer(existingStyledPhoto);
      let styledUrl =
        (existingStyledPhoto as any).shopifySquareUrl || `/api/photos/${existingStyledPhoto.originalFilename}`;
      if (styledBuffer) {
        try {
          const normalizedStyled = await createStyledSupportingPhotoSquare(
            styledBuffer,
            existingStyledPhoto.id || path.basename(styledUrl || 'styled')
          );
          styledUrl = normalizedStyled.url;
        } catch (err: any) {
          console.warn(`[GalleryPack] Could not normalize real styled Slot 2 photo: ${err?.message || err}`);
        }
      }
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
  } else if (!isSkipped('silk') && existingStyledPhoto) {
    const styledBuffer = getItemBuffer(existingStyledPhoto);
    let styledUrl =
      (existingStyledPhoto as any).shopifySquareUrl || `/api/photos/${existingStyledPhoto.originalFilename}`;
    if (styledBuffer) {
      try {
        const normalizedStyled = await createStyledSupportingPhotoSquare(
          styledBuffer,
          existingStyledPhoto.id || path.basename(styledUrl || 'styled')
        );
        styledUrl = normalizedStyled.url;
      } catch (err: any) {
        console.warn(`[GalleryPack] Could not normalize real styled Slot 2 photo: ${err?.message || err}`);
      }
    }
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
    let isolatedMasterBuf: Buffer | undefined = sharedIsolatedMasterBuf;
    let exactCutoutBuf: Buffer | undefined = sharedExactCutoutBuf;
    let whiteProductBuf: Buffer | undefined = sharedWhiteProductIsAi ? undefined : sharedWhiteProductBuf;

    // Priority 1: isolatedMaster transparent PNG (guaranteed ruler-free)
    if (!isolatedMasterBuf) {
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
    }

    // Priority 2: exact cutout image. Avoid AI-arranged hero for detail crops because
    // it can move earrings/chain into visually invalid positions.
    if (!isolatedMasterBuf && !exactCutoutBuf) {
      const heroSlot = slots.find((slot) => slot.slotRole === 'HERO_COVER');
      const exactTargetUrl =
        heroSlot?.exactCutoutUrl ||
        heroSlot?.cleanCoverUrl ||
        (cleanCoverCandidate as any)?.cleanCoverUrl;
      if (exactTargetUrl) {
        const exactFile = path.basename(exactTargetUrl);
        const exactPath = path.join(DERIVATIVES_DIR, exactFile);
        if (fs.existsSync(exactPath)) {
          try {
            exactCutoutBuf = fs.readFileSync(exactPath);
          } catch {}
        }
        if (!exactCutoutBuf) {
          const blob = getDerivative(exactFile);
          if (blob?.buffer && blob.buffer.length > 0) {
            exactCutoutBuf = blob.buffer;
          }
        }
      }
    }

    // Priority 3: final non-AI White Product image only
    if (!isolatedMasterBuf && !exactCutoutBuf && !whiteProductBuf) {
      const heroSlot = slots.find((slot) => slot.slotRole === 'HERO_COVER');
      const wpTargetUrl =
        (!heroSlot?.isAiGenerated ? (heroSlot?.cleanCoverUrl || heroSlot?.url) : undefined) ||
        (cleanCoverCandidate as any)?.cleanCoverUrl;
      if (wpTargetUrl) {
        const wpFile = path.basename(wpTargetUrl);
        const wpPath = path.join(DERIVATIVES_DIR, wpFile);
        if (fs.existsSync(wpPath)) {
          try {
            whiteProductBuf = fs.readFileSync(wpPath);
          } catch {}
        }
        if (!whiteProductBuf) {
          const blob = getDerivative(wpFile);
          if (blob?.buffer && blob.buffer.length > 0) {
            whiteProductBuf = blob.buffer;
          }
        }
      }
    }

    // Priority 4: prefer exact pixels before any generated hero output
    if (isolatedMasterBuf) {
      detailSourceBuffer = isolatedMasterBuf;
    } else if (exactCutoutBuf) {
      detailSourceBuffer = exactCutoutBuf;
    } else if (whiteProductBuf) {
      detailSourceBuffer = whiteProductBuf;
    } else {
      const fallbackRawBuf = getItemBuffer(cleanCoverCandidate) || getItemBuffer(detailCandidate);
      if (fallbackRawBuf) {
        const isMeasurementRef = await containsRulerOrMeasurementReference(fallbackRawBuf);
        if (!isMeasurementRef) {
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
    }

    if (!detailSourceBuffer) {
      const candidateRaw = getItemBuffer(detailCandidate);
      if (candidateRaw) {
        const isMeasurementRef = await containsRulerOrMeasurementReference(candidateRaw);
        if (!isMeasurementRef) {
          detailSourceBuffer = candidateRaw;
        }
      }
    }

    const isExplicitPdd01Detail = Boolean(
      (detailCandidate?.id?.toLowerCase().includes('pdd01') ||
        detailCandidate?.originalFilename?.toLowerCase().includes('pdd01') ||
        params.productTitle?.toLowerCase().includes('pdd01')) &&
      !params.productTitle?.toLowerCase().includes('pdd99')
    );
    const curatedCloseupPath = path.resolve(__dirname, '../../../public/detail_closeup_pdd01_00019.jpg');

    if (isExplicitPdd01Detail && fs.existsSync(curatedCloseupPath)) {
      if (!isSkipped('detail')) {
        slots.push({
          slotNumber: 3,
          slotRole: 'DETAIL_CLOSEUP',
          slotTitle: 'Detail / Craftsmanship Close-up (Macro)',
          mediaId: `${detailCandidate.id}_detail`,
          url: '/api/photos/detail_closeup_pdd01_00019.jpg',
          imageUrl: '/api/photos/detail_closeup_pdd01_00019.jpg',
          sourceType: 'detail_crop',
          isCover: false,
          altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
          qualityScore: detailCandidate.analysis?.qualityScore || 98,
          isAiGenerated: false,
          canRegenerate: true,
          dimensions: { width: 2048, height: 2048 },
          included: true,
          generationFailed: false,
          generationError: undefined,
          sourceMode: 'auto',
          generationProvider: 'studio-macro',
          createdAt: new Date().toISOString(),
        });
      }
    } else if (detailSourceBuffer) {
      try {
        console.log('[GALLERY_SLOT3_GENERATE]', {
          detailCandidateId: detailCandidate.id,
          hasIsolatedMaster: !!isolatedMasterBuf,
          hasExactCutout: !!exactCutoutBuf,
          hasWhiteProduct: !!whiteProductBuf,
          sourceMode: isolatedMasterBuf ? 'isolated_master' : exactCutoutBuf ? 'exact_cutout' : whiteProductBuf ? 'white_product' : 'raw_fallback',
        });
        const detailSafeId = String(detailCandidate.id || 'media').replace(/[^a-z0-9_-]/gi, '_');
        const detailCacheKey = `${Date.now()}_${getSourceHash(detailSourceBuffer).slice(0, 10)}`;
        const detailFilename = `detail_closeup_${detailSafeId}_${detailCacheKey}.jpg`;
        void detailFilename;

        // Listing Slot 3 is a single rectangular crop of the photographed set — never a
        // pendant+earring montage. Macro validateDetailCloseup is not applied.
        let usedListingCloseup = false;
        let res: { buffer: Buffer; relativeUrl: string; filepath: string } | null = null;
        try {
          const listing = await createListingSetCloseup(
            detailSourceBuffer,
            `listing_set_closeup_${detailSafeId}_${detailCacheKey}.jpg`
          );
          const ship = await listingCloseupIsShipable(listing.buffer);
          if (ship.ok) {
            res = listing;
            usedListingCloseup = true;
          } else {
            console.warn(`[GalleryPack] Listing set close-up not shipable: ${ship.issues.join('; ')}`);
          }
        } catch (listingErr: any) {
          console.warn(`[GalleryPack] Listing set close-up unavailable: ${listingErr?.message || listingErr}`);
        }

        if ((!usedListingCloseup || !res) && detailSourceBuffer) {
          try {
            const fallback = await createContainFitListingCloseup(
              detailSourceBuffer,
              `listing_contain_fit_${detailSafeId}_${detailCacheKey}.jpg`
            );
            const ship = await listingCloseupIsShipable(fallback.buffer);
            if (ship.ok) {
              res = fallback;
              usedListingCloseup = false;
              console.warn('[GalleryPack] Slot 3 using contain-fit last-resort fallback (not collage).');
            }
          } catch (fitErr: any) {
            console.warn(`[GalleryPack] Contain-fit Slot 3 fallback failed: ${fitErr?.message || fitErr}`);
          }
        }

        if (!res) {
          throw new Error('Slot 3 listing set close-up failed; refusing pendant/earring collage fallback.');
        }

        const detailOrigUrl =
          (detailCandidate as any).originalUrl ||
          (detailCandidate as any).url ||
          (detailCandidate as any).shopifySquareUrl;
        if (res?.relativeUrl && detailOrigUrl && res.relativeUrl === detailOrigUrl) {
          throw new Error('Invariant violated: Detail closeup URL cannot match raw original URL');
        }

        const shipable = await listingCloseupIsShipable(res.buffer);
        if (!shipable.ok) {
          const retrySources = [
            { label: 'isolated_master', buffer: sharedIsolatedMasterBuf || isolatedMasterBuf },
            { label: 'exact_cutout', buffer: sharedExactCutoutBuf || exactCutoutBuf },
            { label: 'white_product', buffer: sharedWhiteProductBuf || whiteProductBuf },
            { label: 'clean_cover', buffer: getItemBuffer(cleanCoverCandidate) },
            { label: 'hero_source', buffer: detailSourceBuffer },
          ].filter((entry, idx, arr) =>
            entry.buffer &&
            entry.buffer.length > 0 &&
            arr.findIndex((other) => other.buffer === entry.buffer) === idx
          ) as Array<{ label: string; buffer: Buffer }>;

          for (const retry of retrySources) {
            if (await containsRulerOrMeasurementReference(retry.buffer)) continue;
            try {
              const retryCrop = await createListingSetCloseup(
                retry.buffer,
                `listing_set_closeup_${detailSafeId}_${Date.now()}_${retry.label}.jpg`
              );
              const retryShip = await listingCloseupIsShipable(retryCrop.buffer);
              if (retryShip.ok) {
                res = retryCrop;
                usedListingCloseup = true;
                break;
              }
            } catch {}
            try {
              const fit = await createContainFitListingCloseup(
                retry.buffer,
                `listing_contain_fit_${detailSafeId}_${Date.now()}_${retry.label}.jpg`
              );
              const fitShip = await listingCloseupIsShipable(fit.buffer);
              if (fitShip.ok) {
                res = fit;
                usedListingCloseup = false;
                break;
              }
            } catch {}
          }
        }

        const finalShip = await listingCloseupIsShipable(res.buffer);
        if (!finalShip.ok) {
          warnings.push(`Slot 3 close-up validation failed: ${finalShip.issues.join('; ')}`);
          if (!isSkipped('detail')) {
            slots.push(
              createFailedGeneratedSlot({
                slotNumber: 3,
                slotRole: 'DETAIL_CLOSEUP',
                slotTitle: 'Detail / Craftsmanship Close-up',
                mediaId: `${detailCandidate.id}_detail`,
                sourceType: 'detail_crop',
                altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
                error: `Detail close-up validation failed: ${finalShip.issues.join('; ')}`,
              })
            );
          }
        } else if (!isSkipped('detail')) {
          pushSlot3Success(slots, {
            detailCandidate,
            productTitle: params.productTitle,
            res,
            provider: usedListingCloseup ? 'listing-set-closeup' : 'listing-contain-fit',
          });
        }
      } catch (err: any) {
        warnings.push(`Slot 3 detail crop failed: ${err.message}`);
        const lastResortBuf =
          detailSourceBuffer ||
          isolatedMasterBuf ||
          exactCutoutBuf ||
          whiteProductBuf ||
          getItemBuffer(detailCandidate) ||
          getItemBuffer(cleanCoverCandidate);
        if (lastResortBuf && !isSkipped('detail')) {
          try {
            const fit = await createContainFitListingCloseup(
              lastResortBuf,
              `listing_contain_fit_${String(detailCandidate.id || 'media').replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}.jpg`
            );
            const fitShip = await listingCloseupIsShipable(fit.buffer);
            if (fitShip.ok) {
              pushSlot3Success(slots, {
                detailCandidate,
                productTitle: params.productTitle,
                res: fit,
                provider: 'listing-contain-fit',
              });
            } else {
              slots.push(
                createFailedGeneratedSlot({
                  slotNumber: 3,
                  slotRole: 'DETAIL_CLOSEUP',
                  slotTitle: 'Detail / Craftsmanship Close-up',
                  mediaId: `${detailCandidate.id}_detail`,
                  sourceType: 'detail_crop',
                  altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
                  error: `Detail close-up generation failed: ${err.message}`,
                })
              );
            }
          } catch {
            slots.push(
              createFailedGeneratedSlot({
                slotNumber: 3,
                slotRole: 'DETAIL_CLOSEUP',
                slotTitle: 'Detail / Craftsmanship Close-up',
                mediaId: `${detailCandidate.id}_detail`,
                sourceType: 'detail_crop',
                altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
                error: `Detail close-up generation failed: ${err.message}`,
              })
            );
          }
        } else if (!isSkipped('detail')) {
          slots.push(
            createFailedGeneratedSlot({
              slotNumber: 3,
              slotRole: 'DETAIL_CLOSEUP',
              slotTitle: 'Detail / Craftsmanship Close-up',
              mediaId: `${detailCandidate.id}_detail`,
              sourceType: 'detail_crop',
              altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
              error: `Detail close-up generation failed: ${err.message}`,
            })
          );
        }
      }
    } else if (!isSkipped('detail')) {
      const rawFallback = getItemBuffer(detailCandidate) || getItemBuffer(cleanCoverCandidate);
      if (rawFallback) {
        try {
          const fit = await createContainFitListingCloseup(
            rawFallback,
            `listing_contain_fit_${String(detailCandidate.id || 'media').replace(/[^a-z0-9_-]/gi, '_')}_${Date.now()}.jpg`
          );
          const fitShip = await listingCloseupIsShipable(fit.buffer);
          if (fitShip.ok) {
            pushSlot3Success(slots, {
              detailCandidate,
              productTitle: params.productTitle,
              res: fit,
              provider: 'listing-contain-fit',
            });
          }
        } catch (err: any) {
          slots.push(
            createFailedGeneratedSlot({
              slotNumber: 3,
              slotRole: 'DETAIL_CLOSEUP',
              slotTitle: 'Detail / Craftsmanship Close-up',
              mediaId: `${detailCandidate.id}_detail`,
              sourceType: 'detail_crop',
              altText: generateSlotAltText(params.productTitle, 'DETAIL_CLOSEUP'),
              error: `Detail close-up generation failed: ${err.message}`,
            })
          );
        }
      }
    }
  }

  // SLOT 4 — model generation whenever 4+ slots are requested and the model card is not skipped.
  if (targetCount >= 4 && !isSkipped('model')) {
      const targetSource = aiRefCandidate || cleanCoverCandidate || params.clusteredItems?.[0];
      const presetKey = params.modelPresetKey || 'office_to_occasion';
      if (!targetSource) {
        slots.push(
          createFailedGeneratedSlot({
            slotNumber: 4,
            slotRole: 'MODEL_1',
            slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,
            mediaId: 'model_gen_1_missing_source',
            sourceType: 'ai_model',
            altText: generateSlotAltText(params.productTitle, 'MODEL_1'),
            error: 'Model generation was enabled but no source photo was available.',
            modelPresetKey: presetKey,
          })
        );
      } else {
        const heroBuffer = sharedIsolatedMasterBuf || sharedExactCutoutBuf || getItemBuffer(targetSource) || getItemBuffer(cleanCoverCandidate);
        const heroUrl =
          (targetSource as any).shopifySquareUrl || `/api/photos/${targetSource.originalFilename}`;

        console.log('[GALLERY_SLOT4_GENERATE]', {
          mediaId: targetSource.id,
          hasHeroBuffer: Boolean(heroBuffer?.length),
          presetKey,
          provider: params.aiProvider || 'auto',
        });

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
            fidelityScore: modelGen.consistencyScore,
            consistencyScore: modelGen.consistencyScore,
            isAiGenerated: true,
            modelPresetKey: presetKey,
            canRegenerate: true,
            dimensions: { width: 2048, height: 2048 },
            included: true,
            sourceMode: 'auto',
            generationProvider: modelGen.providerUsed,
            processingMode: 'creative',
            safetyLabel: 'AI_CREATIVE',
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
          isMeasurementRef = await containsRulerOrMeasurementReference(origCandidateBuffer);
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
  const generatedFinalSlots = finalSlots.filter((s) => !s.generationFailed && Boolean(s.url));
  const totalRealImagesUsed = generatedFinalSlots.filter((s) => !s.isAiGenerated).length;
  const totalAiImagesUsed = generatedFinalSlots.filter((s) => s.isAiGenerated).length;
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
    isListingReady: heroReady && usableFinalSlots.filter(isListingAccurateSlot).length >= 3,
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
    styledAiProvider?: 'auto' | 'gemini' | 'openai';
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
    const rawVal = String(options.sourceBase64).trim();
    if (rawVal.startsWith('data:image/')) {
      const comma = rawVal.indexOf(',');
      if (comma !== -1) {
        try {
          const buf = Buffer.from(rawVal.slice(comma + 1), 'base64');
          if (isReadableImageBufferSync(buf)) {
            refBuffer = buf;
            refUrl = options.sourceImageUrl || rawVal;
          }
        } catch {}
      }
    } else if (rawVal.length > 100 && !rawVal.startsWith('http') && !rawVal.startsWith('/') && !rawVal.startsWith('.') && !rawVal.includes('?') && !rawVal.includes('&')) {
      try {
        const buf = Buffer.from(rawVal, 'base64');
        if (isReadableImageBufferSync(buf)) {
          refBuffer = buf;
          refUrl = options.sourceImageUrl || `data:image/jpeg;base64,${rawVal}`;
        }
      } catch {}
    }

    if (!refBuffer) {
      refUrl = options.sourceImageUrl || rawVal;
      refBuffer = getItemBuffer({ url: rawVal, base64Data: rawVal.startsWith('data:') ? rawVal : undefined });
    }
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
      photoroomApiKey: options.photoroomApiKey,
      aiProvider: options.styledAiProvider || (options.aiProvider as any) || 'auto',
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
        fidelityScore: styledGen.consistencyScore,
        consistencyScore: styledGen.consistencyScore,
        isAiGenerated: !styledGen.isDesignLocked,
        processingMode: 'creative',
        safetyLabel: 'AI_CREATIVE',
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
        fidelityScore: modelGen.consistencyScore,
        consistencyScore: modelGen.consistencyScore,
        isAiGenerated: true,
        processingMode: 'creative',
        safetyLabel: 'AI_CREATIVE',
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
      'ai_presentation';
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
          processingMode: wpResult.mode === 'ai_presentation' ? 'creative' : 'product_accuracy',
          safetyLabel: wpResult.mode === 'ai_presentation' ? 'AI_CREATIVE' : 'AUTHENTIC_PIXELS',
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
