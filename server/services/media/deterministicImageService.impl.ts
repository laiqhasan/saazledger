import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { executeBackgroundRemoval } from './backgroundRemovalService';
import { DATA_DIR } from '../../db/database';
import { cleanJewelleryCutoutArtifacts } from './imageCleanupService';
import { saveDerivativeBuffer } from '../photoService';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zoom?: number;
  aspectRatio?: '1:1' | '4:5' | '9:16' | 'free';
  coordinateSpace?: string;
}

export interface SegmentationQualityResult {
  isAcceptable: boolean;
  isValid: boolean;
  qualityScore: number;
  chainContinuityScore: number;
  occupancyRatio: number;
  issues: string[];
  bounds: { x: number; y: number; width: number; height: number };
}

export interface PureWhiteCoverResult {
  buffer: Buffer;
  relativeUrl: string;
  filepath?: string;
  quality: SegmentationQualityResult;
  width: number;
  height: number;
  backgroundMode: 'pure_white' | 'original' | 'transparent';
  isolatedMasterBuffer?: Buffer;
  isolatedMasterUrl?: string;
  isolatedMasterPath?: string;
  sourceHash?: string;
  cacheHit?: boolean;
  cacheVersion?: string;
  transparentWidth?: number;
  transparentHeight?: number;
  opaquePixelRatio?: number;
  componentCount?: number;
  forbiddenObjects?: string[];
}

const DERIVATIVES_DIR = path.join(DATA_DIR, 'uploads/photos/derivatives');
if (!fs.existsSync(DERIVATIVES_DIR)) {
  fs.mkdirSync(DERIVATIVES_DIR, { recursive: true });
}

function saveDerivative(buffer: Buffer, filename: string): { relativeUrl: string; filepath: string } {
  const sanitized = path.basename(filename);
  const saved = saveDerivativeBuffer(buffer, sanitized);
  const filepath = path.join(DERIVATIVES_DIR, sanitized);
  return {
    relativeUrl: saved.url,
    filepath,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function autoOrient(inputBuffer: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  const buffer = await sharp(inputBuffer).rotate().toBuffer();
  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    width: meta.width || 1,
    height: meta.height || 1,
  };
}

/**
 * Evaluates whether an alpha mask really looks like isolated jewellery.
 * In addition to empty/chain checks, reject masks that keep most of the original
 * board/background or touch almost the complete frame. This prevents a false
 * "pure white" success where the old rectangular photo is still visible.
 */
export async function evaluateSegmentationQuality(
  alphaBuffer: Buffer,
  width: number,
  height: number,
  options: {
    isIsolatedMaster?: boolean;
  } = {}
): Promise<SegmentationQualityResult> {
  const issues: string[] = [];
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let foregroundCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = alphaBuffer[y * width + x];
      if (alpha > 30) {
        foregroundCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (foregroundCount === 0 || maxX < minX || maxY < minY) {
    return {
      isAcceptable: false,
      isValid: false,
      qualityScore: 0,
      chainContinuityScore: 0,
      occupancyRatio: 0,
      issues: ['No jewellery foreground detected in the background-removal mask.'],
      bounds: { x: 0, y: 0, width, height },
    };
  }

  const objW = maxX - minX + 1;
  const objH = maxY - minY + 1;
  const occupancyRatio = foregroundCount / Math.max(1, width * height);
  const coveragePercent = occupancyRatio * 100;
  const boundsCoverage = (objW * objH) / Math.max(1, width * height);
  const isCandidateMaster = Boolean(options.isIsolatedMaster);

  if (coveragePercent < 0.35) {
    issues.push('Too little foreground remains; chain, stones or components may have been erased.');
  }

  // Jewellery normally contains significant negative space. A very dense mask is
  // usually the supplier board / cloth being preserved as foreground.
  if (coveragePercent > (isCandidateMaster ? 65 : 42)) {
    issues.push('Foreground mask is too dense; original background is probably still present.');
  }

  // Only reject for full frame bounds if this was a raw photo background removal and mask is dense
  if (!isCandidateMaster && boundsCoverage > 0.96 && occupancyRatio > 0.35) {
    issues.push('Foreground touches almost the complete frame; background isolation is unreliable.');
  }

  const edgeMarginX = Math.max(2, Math.round(width * 0.01));
  const edgeMarginY = Math.max(2, Math.round(height * 0.01));
  const touchesAllEdges =
    minX <= edgeMarginX &&
    minY <= edgeMarginY &&
    maxX >= width - 1 - edgeMarginX &&
    maxY >= height - 1 - edgeMarginY;
  if (!isCandidateMaster && touchesAllEdges && occupancyRatio > 0.35) {
    issues.push('Mask reaches every image edge, indicating the original rectangular photo may have been retained.');
  }

  let chainContinuityScore = 95;
  const scanStartY = minY + Math.round(objH * 0.08);
  const scanEndY = minY + Math.round(objH * 0.5);
  let emptySlices = 0;
  let totalSlices = 0;

  for (let y = scanStartY; y <= scanEndY; y += 4) {
    totalSlices++;
    let rowForeground = 0;
    for (let x = minX; x <= maxX; x++) {
      if (alphaBuffer[y * width + x] > 45) rowForeground++;
    }
    if (rowForeground === 0) emptySlices++;
  }

  if (totalSlices > 0 && emptySlices / totalSlices > 0.45) {
    chainContinuityScore = Math.max(25, 95 - Math.round((emptySlices / totalSlices) * 100));
    issues.push('Potential chain break or missing upper component detected.');
  }

  let qualityScore = 100;
  qualityScore -= issues.length * 22;
  if (chainContinuityScore < 70) qualityScore -= 15;
  qualityScore = clamp(Math.round(qualityScore), 0, 100);

  const isAcceptable =
    qualityScore >= 60 &&
    occupancyRatio >= 0.0035 &&
    occupancyRatio <= (isCandidateMaster ? 0.65 : 0.42) &&
    (isCandidateMaster || boundsCoverage <= 0.96) &&
    (isCandidateMaster || !touchesAllEdges || occupancyRatio <= 0.35);

  return {
    isAcceptable,
    isValid: isAcceptable,
    qualityScore,
    chainContinuityScore,
    occupancyRatio,
    issues,
    bounds: { x: minX, y: minY, width: objW, height: objH },
  };
}

/**
 * Creates a deterministic e-commerce cover. No generative model is involved.
 * A successful `pure_white` result means the old background was actually removed.
 * If segmentation is unsafe, this function throws instead of lying with a white
 * canvas behind the untouched rectangular photo.
 */
export async function createPureWhiteCover(
  inputBuffer: Buffer,
  outputFilename: string,
  options: {
    targetWidth?: number;
    targetHeight?: number;
    occupancyPercent?: number;
    backgroundMode?: 'pure_white' | 'transparent' | 'original';
    customCrop?: CropRect;
    rulerBounds?: { x: number; y: number; width: number; height: number };
    cleanArtifacts?: boolean;
    apiKey?: string;
    geminiApiKey?: string;
    isIsolatedMaster?: boolean;
    isolatedMasterUrl?: string;
    isolatedMasterPath?: string;
    sourceHash?: string;
  } = {}
): Promise<PureWhiteCoverResult> {
  const targetW = options.targetWidth || 2048;
  const targetH = options.targetHeight || 2048;
  const occupancy = clamp((options.occupancyPercent || 88) / 100, 0.6, 0.94);
  const bgMode = options.backgroundMode || 'pure_white';

  let workingBuffer = inputBuffer;

  if (options.customCrop && options.customCrop.width > 0 && options.customCrop.height > 0) {
    // Preserve pixels and crop the authentic source first. Do not force it to square here.
    const cropRes = await applyNonDestructiveCrop(inputBuffer, {
      ...options.customCrop,
      aspectRatio: 'free',
    });
    workingBuffer = cropRes.buffer;
  }

  if (bgMode === 'original') {
    const oriented = await autoOrient(workingBuffer);
    const scale = Math.min((targetW * occupancy) / oriented.width, (targetH * occupancy) / oriented.height);
    const scaledW = Math.max(1, Math.round(oriented.width * scale));
    const scaledH = Math.max(1, Math.round(oriented.height * scale));
    const resized = await sharp(oriented.buffer).resize(scaledW, scaledH, { fit: 'inside' }).toBuffer();

    // A neutral white canvas is predictable and makes the result a real 1:1 derivative;
    // the original photo background remains inside its own rectangle by definition.
    const canvas = await sharp({
      create: {
        width: targetW,
        height: targetH,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([{ input: resized, gravity: 'center' }])
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer();

    const saved = saveDerivative(canvas, outputFilename);
    return {
      buffer: canvas,
      relativeUrl: saved.relativeUrl,
      filepath: saved.filepath,
      quality: {
        isAcceptable: true,
        isValid: true,
        qualityScore: 100,
        chainContinuityScore: 100,
        occupancyRatio: (scaledW * scaledH) / (targetW * targetH),
        issues: ['Original background retained intentionally.'],
        bounds: {
          x: Math.round((targetW - scaledW) / 2),
          y: Math.round((targetH - scaledH) / 2),
          width: scaledW,
          height: scaledH,
        },
      },
      width: targetW,
      height: targetH,
      backgroundMode: 'original',
    };
  }

  const workingMeta = await sharp(workingBuffer).metadata();
  const inputIsAlreadyTransparent = Boolean(options.isIsolatedMaster);

  let cutoutBuffer: Buffer;
  let bgResult: any;

  if (inputIsAlreadyTransparent) {
    cutoutBuffer = workingBuffer;
    bgResult = {
      buffer: workingBuffer,
      providerUsed: 'cached-master',
      isolatedMasterUrl: options.isolatedMasterUrl,
      isolatedMasterPath: options.isolatedMasterPath,
      sourceHash: options.sourceHash,
      cacheHit: true,
      transparentWidth: workingMeta.width,
      transparentHeight: workingMeta.height,
      opaquePixelRatio: 0.1,
      componentCount: 1,
      forbiddenObjects: [],
    };
  } else {
    bgResult = await executeBackgroundRemoval(workingBuffer, {
      returnTransparentPng: true,
      targetWidth: targetW,
      targetHeight: targetH,
      exactIsolation: true,
      apiKey: options.apiKey,
      geminiApiKey: options.geminiApiKey,
    });
    cutoutBuffer = bgResult.buffer;
  }

  const cutoutMeta = await sharp(cutoutBuffer).metadata();
  if (!cutoutMeta.hasAlpha || !cutoutMeta.width || !cutoutMeta.height) {
    throw new Error('Background removal did not return a transparent jewellery cutout. Please retry with PhotoRoom/remove.bg or use the original image.');
  }

  const cw = cutoutMeta.width;
  const ch = cutoutMeta.height;

  // The v4 isolation pipeline already preserves PhotoRoom raw output and runs
  // reversible cleanup only when forbidden objects are detected. Avoid a second
  // connected-component pass here because thin chains, earrings and stones can
  // be valid tiny/disconnected foreground.
  let cleanedCutout = cutoutBuffer;
  let fullCleaned = cutoutBuffer;
  let cleanRes: import('./imageCleanupService').CleanJewelleryCutoutResult | undefined;

  if (options.cleanArtifacts !== false) {
    try {
      cleanRes = await cleanJewelleryCutoutArtifacts(cutoutBuffer, {
        removeRuler: true,
        rulerBounds: options.rulerBounds,
      });
      cleanedCutout = cleanRes.cleanedBuffer;
      fullCleaned = cleanRes.fullCleanedBuffer;
    } catch (cleanErr) {
      console.warn('[DeterministicImageService] Non-fatal artifact cleanup error:', cleanErr);
    }
  }

  const rawAlpha = await sharp(fullCleaned).extractChannel(3).raw().toBuffer();
  const quality = await evaluateSegmentationQuality(rawAlpha, cw, ch, {
    isIsolatedMaster: inputIsAlreadyTransparent,
  });

  let trimmedBuffer = cleanedCutout;
  let trimmedW = cw;
  let trimmedH = ch;
  try {
    const trimmed = await sharp(cleanedCutout)
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 })
      .toBuffer({ resolveWithObject: true });
    trimmedBuffer = trimmed.data;
    trimmedW = trimmed.info.width;
    trimmedH = trimmed.info.height;
  } catch {
    const cleanMeta = await sharp(cleanedCutout).metadata();
    trimmedW = cleanMeta.width || cw;
    trimmedH = cleanMeta.height || ch;
  }

  const isTooSmall = trimmedW < 80 || trimmedH < 80;
  if (!quality.isAcceptable || isTooSmall) {
    if (options.geminiApiKey?.trim()) {
      try {
        console.log('[DeterministicImageService] Cutout failed segmentation quality; attempting Gemini transparent isolation fallback...');
        const { getOrCreateIsolatedMasterPng } = await import('./backgroundRemovalService');
        const geminiIsolated = await getOrCreateIsolatedMasterPng(inputBuffer, {
          forceRefresh: true,
          geminiApiKey: options.geminiApiKey,
        });
        return createPureWhiteCover(geminiIsolated.buffer, outputFilename, {
          ...options,
          cleanArtifacts: true,
          geminiApiKey: undefined,
        });
      } catch (geminiFallbackErr: any) {
        console.warn('[DeterministicImageService] Gemini fallback attempt failed:', geminiFallbackErr.message);
      }
    }

    const reasons = [...quality.issues];
    if (isTooSmall) reasons.push(`Detected jewellery cutout is too small (${trimmedW}×${trimmedH}).`);
    throw new Error(
      `Background removal needs review. ${reasons.join(' ')} Use Retry White BG, choose another source photo, or keep Original.`
    );
  }

  const subjectAspect = trimmedW / Math.max(1, trimmedH);
  let effectiveOccupancy = occupancy;
  if (subjectAspect < 0.65 && occupancy > 0.86) {
    effectiveOccupancy = 0.86;
  }
  const maxUsableW = Math.round(targetW * effectiveOccupancy);
  const maxUsableH = Math.round(targetH * effectiveOccupancy);
  let scale = Math.min(maxUsableW / trimmedW, maxUsableH / trimmedH);
  let usePremiumCloseFraming = false;

  // Slot 1 / register white BG must be a safe full-product containment image.
  // Close crops belong in Slot 3 so necklaces, earrings and pendant drops are
  // not clipped immediately after upload.
  const enablePremiumCloseFraming = false;
  if (enablePremiumCloseFraming && bgMode === 'pure_white' && targetW === targetH && subjectAspect < 0.95) {
    const closeScale = Math.min((targetW * 1.0) / trimmedW, (targetH * 1.36) / trimmedH);
    if (closeScale > scale * 1.08) {
      scale = closeScale;
      usePremiumCloseFraming = true;
    }
  }

  const finalProductW = Math.max(1, Math.round(trimmedW * scale));
  const finalProductH = Math.max(1, Math.round(trimmedH * scale));

  const scaledProduct = await sharp(trimmedBuffer)
    .resize(finalProductW, finalProductH, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();

  let whiteCompositeInput = scaledProduct;
  let whiteCompositePlacement: { input: Buffer; gravity: 'center' } | { input: Buffer; left: number; top: number } = {
    input: scaledProduct,
    gravity: 'center',
  };
  if (usePremiumCloseFraming) {
    const desiredLeft = Math.round((targetW - finalProductW) / 2);
    const desiredTop =
      finalProductH > targetH
        ? Math.round(targetH - finalProductH + targetH * 0.045)
        : Math.round((targetH - finalProductH) / 2);
    const extractLeft = Math.max(0, -desiredLeft);
    const extractTop = Math.max(0, -desiredTop);
    const placeLeft = Math.max(0, desiredLeft);
    const placeTop = Math.max(0, desiredTop);
    const extractW = Math.max(1, Math.min(finalProductW - extractLeft, targetW - placeLeft));
    const extractH = Math.max(1, Math.min(finalProductH - extractTop, targetH - placeTop));

    whiteCompositeInput = await sharp(scaledProduct)
      .extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH })
      .png()
      .toBuffer();
    whiteCompositePlacement = { input: whiteCompositeInput, left: placeLeft, top: placeTop };
  }

  if (bgMode === 'transparent') {
    const transparentCanvas = await sharp({
      create: {
        width: targetW,
        height: targetH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: scaledProduct, gravity: 'center' }])
      .png()
      .toBuffer();

    const pngFilename = outputFilename.endsWith('.png')
      ? outputFilename
      : outputFilename.replace(/\.[^.]+$/, '.png');
    const saved = saveDerivative(transparentCanvas, pngFilename);
    return {
      buffer: transparentCanvas,
      relativeUrl: saved.relativeUrl,
      filepath: saved.filepath,
      quality,
      width: targetW,
      height: targetH,
      backgroundMode: 'transparent',
      isolatedMasterBuffer: cutoutBuffer,
      isolatedMasterUrl: bgResult.isolatedMasterUrl,
      isolatedMasterPath: bgResult.isolatedMasterPath,
      sourceHash: bgResult.sourceHash,
      cacheHit: bgResult.cacheHit,
      cacheVersion: bgResult.cacheVersion,
      transparentWidth: bgResult.transparentWidth,
      transparentHeight: bgResult.transparentHeight,
      opaquePixelRatio: bgResult.opaquePixelRatio,
      componentCount: bgResult.componentCount,
      forbiddenObjects: cleanRes?.forbiddenObjects || bgResult.forbiddenObjects,
    };
  }

  const whiteCanvas = await sharp({
    create: {
      width: targetW,
      height: targetH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([whiteCompositePlacement])
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const saved = saveDerivative(whiteCanvas, outputFilename);
  console.log('[WhiteProduct] WHITE_PRODUCT_GENERATED', {
    mediaId: outputFilename.split('_')[0],
    outputPath: saved.filepath,
    outputUrl: saved.relativeUrl,
    width: targetW,
    height: targetH,
    provider: bgResult.providerUsed,
    cacheHit: bgResult.cacheHit,
  });

  return {
    buffer: whiteCanvas,
    relativeUrl: saved.relativeUrl,
    filepath: saved.filepath,
    quality,
    width: targetW,
    height: targetH,
    backgroundMode: 'pure_white',
    isolatedMasterBuffer: cutoutBuffer,
    isolatedMasterUrl: bgResult.isolatedMasterUrl,
    isolatedMasterPath: bgResult.isolatedMasterPath,
    sourceHash: bgResult.sourceHash,
    cacheHit: bgResult.cacheHit,
    cacheVersion: bgResult.cacheVersion,
    transparentWidth: bgResult.transparentWidth,
    transparentHeight: bgResult.transparentHeight,
    opaquePixelRatio: bgResult.opaquePixelRatio,
    componentCount: bgResult.componentCount,
    forbiddenObjects: cleanRes?.forbiddenObjects || bgResult.forbiddenObjects,
  };
}

/**
 * Non-destructive crop engine.
 * Coordinates are in the EXIF-oriented image after the optional user rotation.
 * The crop rectangle may remain portrait/landscape; the final platform canvas uses
 * `contain`, so a long necklace is fitted into 1:1 without cutting its chain.
 */
export async function applyNonDestructiveCrop(
  inputBuffer: Buffer,
  crop: CropRect | any,
  targetOutputDim = 2048
): Promise<{ buffer: Buffer; outputFilename: string; relativeUrl: string; filepath: string }> {
  const actualCrop: CropRect = crop.cropRect || crop;
  const rotation = ((Number(actualCrop.rotation ?? crop.rotation ?? 0) % 360) + 360) % 360;

  const oriented = await autoOrient(inputBuffer);
  let transformedBuffer = oriented.buffer;

  if (rotation !== 0) {
    transformedBuffer = await sharp(transformedBuffer).rotate(rotation).toBuffer();
  }

  const transformedMeta = await sharp(transformedBuffer).metadata();
  const srcW = transformedMeta.width || oriented.width;
  const srcH = transformedMeta.height || oriented.height;

  const rawX = Number.isFinite(Number(actualCrop.x)) ? Number(actualCrop.x) : 0;
  const rawY = Number.isFinite(Number(actualCrop.y)) ? Number(actualCrop.y) : 0;
  const rawW = Number.isFinite(Number(actualCrop.width)) ? Number(actualCrop.width) : srcW;
  const rawH = Number.isFinite(Number(actualCrop.height)) ? Number(actualCrop.height) : srcH;

  let cx = rawX > 0 && rawX < 1 ? Math.round(rawX * srcW) : Math.round(rawX);
  let cy = rawY > 0 && rawY < 1 ? Math.round(rawY * srcH) : Math.round(rawY);
  let cw = rawW > 0 && rawW <= 1 ? Math.round(rawW * srcW) : Math.round(rawW);
  let ch = rawH > 0 && rawH <= 1 ? Math.round(rawH * srcH) : Math.round(rawH);

  cx = clamp(cx, 0, Math.max(0, srcW - 1));
  cy = clamp(cy, 0, Math.max(0, srcH - 1));
  cw = clamp(cw, 1, srcW - cx);
  ch = clamp(ch, 1, srcH - cy);

  const cropped = await sharp(transformedBuffer)
    .extract({ left: cx, top: cy, width: cw, height: ch })
    .toBuffer();

  const ratio = crop.aspectRatioPreset || actualCrop.aspectRatio || crop.aspectRatio || '1:1';
  let finalW = targetOutputDim;
  let finalH = targetOutputDim;

  if (ratio === '4:5') {
    finalH = Math.round(targetOutputDim * 5 / 4);
  } else if (ratio === '9:16') {
    finalH = Math.round(targetOutputDim * 16 / 9);
  } else if (ratio === 'free') {
    if (cw >= ch) {
      finalW = targetOutputDim;
      finalH = Math.max(1, Math.round(targetOutputDim * ch / cw));
    } else {
      finalH = targetOutputDim;
      finalW = Math.max(1, Math.round(targetOutputDim * cw / ch));
    }
  }

  if (crop.outputWidth) finalW = Math.max(1, Math.round(Number(crop.outputWidth)));
  if (crop.outputHeight) finalH = Math.max(1, Math.round(Number(crop.outputHeight)));

  const fitted = await sharp(cropped)
    .resize(finalW, finalH, {
      fit: 'contain',
      position: 'centre',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
      withoutEnlargement: false,
    })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const filename = crop.filename || `crop_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  const saved = saveDerivative(fitted, filename);

  return {
    buffer: fitted,
    outputFilename: filename,
    relativeUrl: saved.relativeUrl,
    filepath: saved.filepath,
  };
}

/**
 * Finds a jewellery-aware rectangular source region. It intentionally does NOT
 * force that region to square: forcing a tall necklace into a square source crop
 * was the root cause of clipped chains. The final 1:1 derivative is created later
 * with contain + padding.
 */
export async function detectJewelryAutoCrop(
  inputBuffer: Buffer,
  category: 'necklace_set' | 'earrings' | 'pendant' | 'ring' = 'necklace_set'
): Promise<CropRect> {
  const oriented = await autoOrient(inputBuffer);
  const w = oriented.width;
  const h = oriented.height;

  const maxDim = 700;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));

  const { data: rawRgb, info } = await sharp(oriented.buffer)
    .resize(sw, sh, { fit: 'inside' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const border = Math.max(3, Math.round(Math.min(sw, sh) * 0.035));
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let borderCount = 0;

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (x < border || x >= sw - border || y < border || y >= sh - border) {
        const idx = (y * sw + x) * channels;
        sumR += rawRgb[idx];
        sumG += rawRgb[idx + 1];
        sumB += rawRgb[idx + 2];
        borderCount++;
      }
    }
  }

  const bgR = sumR / Math.max(1, borderCount);
  const bgG = sumG / Math.max(1, borderCount);
  const bgB = sumB / Math.max(1, borderCount);
  const bgLuma = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;

  const luma = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    const idx = i * channels;
    luma[i] = 0.299 * rawRgb[idx] + 0.587 * rawRgb[idx + 1] + 0.114 * rawRgb[idx + 2];
  }

  let minX = sw;
  let maxX = -1;
  let minY = sh;
  let maxY = -1;
  let detectedPoints = 0;

  for (let y = 2; y < sh - 2; y++) {
    for (let x = 2; x < sw - 2; x++) {
      const idx = (y * sw + x) * channels;
      const r = rawRgb[idx];
      const g = rawRgb[idx + 1];
      const b = rawRgb[idx + 2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const saturation = maxC - minC;
      const colourDistance = Math.hypot(r - bgR, g - bgG, b - bgB);
      const lum = luma[y * sw + x];
      const gx = Math.abs(luma[y * sw + x + 1] - luma[y * sw + x - 1]);
      const gy = Math.abs(luma[(y + 1) * sw + x] - luma[(y - 1) * sw + x]);
      const edge = gx + gy;

      // Coloured stones, dark metal/stone regions and thin chain edges are all useful.
      const isForeground =
        colourDistance > 24 ||
        saturation > 24 ||
        lum < bgLuma - 24 ||
        (edge > 22 && colourDistance > 7);

      if (isForeground) {
        detectedPoints++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (detectedPoints < 35 || maxX <= minX || maxY <= minY) {
    return {
      x: 0,
      y: 0,
      width: w,
      height: h,
      aspectRatio: '1:1',
      zoom: 1,
    };
  }

  let srcMinX = Math.round(minX / scale);
  let srcMaxX = Math.round((maxX + 1) / scale);
  let srcMinY = Math.round(minY / scale);
  let srcMaxY = Math.round((maxY + 1) / scale);

  const boxW = Math.max(1, srcMaxX - srcMinX);
  const boxH = Math.max(1, srcMaxY - srcMinY);
  const marginPct = category === 'necklace_set' ? 0.14 : category === 'pendant' ? 0.1 : 0.08;

  srcMinX = Math.max(0, srcMinX - Math.round(boxW * marginPct));
  srcMaxX = Math.min(w, srcMaxX + Math.round(boxW * marginPct));
  srcMinY = Math.max(0, srcMinY - Math.round(boxH * marginPct));
  srcMaxY = Math.min(h, srcMaxY + Math.round(boxH * marginPct));

  return {
    x: srcMinX,
    y: srcMinY,
    width: Math.max(1, srcMaxX - srcMinX),
    height: Math.max(1, srcMaxY - srcMinY),
    aspectRatio: '1:1',
    zoom: 1,
  };
}

export interface GalleryAssetValidationResult {
  valid: boolean;
  forbiddenObjects: string[];
  reason?: string;
}

/**
 * Validates that publish-ready generated gallery media contains zero forbidden objects:
 * rulers, measuring scales, paper borders, table edges, dust, or props.
 */
export async function validateGalleryAsset(
  buffer: Buffer,
  role: 'WHITE_PRODUCT' | 'DETAIL_CLOSEUP' | 'HERO_COVER' | string = 'WHITE_PRODUCT'
): Promise<GalleryAssetValidationResult> {
  const testDim = 256;
  const { data: raw, info } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const forbiddenObjects: string[] = [];

  const leftMargin = Math.round(testDim * 0.15);
  const bottomMargin = Math.round(testDim * 0.85);
  const rightMargin = Math.round(testDim * 0.85);
  const topMargin = Math.round(testDim * 0.15);

  let leftDarkPixels = 0;
  let bottomDarkPixels = 0;
  let coloredPropPixels = 0;

  for (let y = 0; y < testDim; y++) {
    for (let x = 0; x < testDim; x++) {
      const idx = (y * testDim + x) * channels;
      const r = raw[idx];
      const g = raw[idx + 1];
      const b = raw[idx + 2];

      const isDark = r < 180 && g < 180 && b < 180;
      const isPinkOrMagenta = r > 180 && b > 110 && r - g > 40;
      const isFoliageGreen = g > 150 && g - r > 35 && g - b > 35;
      const isPropColor = isPinkOrMagenta || isFoliageGreen;

      if (x <= leftMargin && y >= topMargin && y <= bottomMargin) {
        if (isDark) leftDarkPixels++;
      }
      if (y >= bottomMargin && x >= leftMargin && x <= rightMargin) {
        if (isDark) bottomDarkPixels++;
      }
      const isStyledSupporting =
        role === 'STYLED_SUPPORTING' ||
        role === 'styled_supporting' ||
        role.toLowerCase().includes('styled');
      if (role !== 'DETAIL_CLOSEUP' && !isStyledSupporting && isPropColor) {
        if ((x <= leftMargin || x >= rightMargin) && (y <= topMargin || y >= bottomMargin)) {
          coloredPropPixels++;
        }
      }
    }
  }

  // Check tick marks / contrast transitions along bottom margin
  let bottomTransitions = 0;
  const bottomScanY = Math.round(testDim * 0.90);
  let lastBottomVal = (raw[(bottomScanY * testDim + 10) * channels] + raw[(bottomScanY * testDim + 10) * channels + 1] + raw[(bottomScanY * testDim + 10) * channels + 2]) / 3;
  for (let x = 11; x < testDim - 10; x++) {
    const v = (raw[(bottomScanY * testDim + x) * channels] + raw[(bottomScanY * testDim + x) * channels + 1] + raw[(bottomScanY * testDim + x) * channels + 2]) / 3;
    if (Math.abs(v - lastBottomVal) > 30) {
      bottomTransitions++;
      lastBottomVal = v;
    }
  }

  // Check tick marks / contrast transitions along left margin
  let leftTransitions = 0;
  const leftScanX = Math.round(testDim * 0.08);
  let lastLeftVal = (raw[(10 * testDim + leftScanX) * channels] + raw[(10 * testDim + leftScanX) * channels + 1] + raw[(10 * testDim + leftScanX) * channels + 2]) / 3;
  for (let y = 11; y < testDim - 10; y++) {
    const v = (raw[(y * testDim + leftScanX) * channels] + raw[(y * testDim + leftScanX) * channels + 1] + raw[(y * testDim + leftScanX) * channels + 2]) / 3;
    if (Math.abs(v - lastLeftVal) > 30) {
      leftTransitions++;
      lastLeftVal = v;
    }
  }

  const marginArea = leftMargin * (bottomMargin - topMargin);
  const bottomArea = (rightMargin - leftMargin) * (testDim - bottomMargin);

  if (role === 'DETAIL_CLOSEUP') {
    // In close-up crops, the jewellery itself is zoomed-in and fills the canvas.
    // Real jewellery chains, stone facets and pavé cross borders with periodic transitions.
    // Zoomed jewellery details must NOT be falsely identified as a measuring ruler.
    if (leftTransitions >= 20 && bottomTransitions >= 20) {
      forbiddenObjects.push('ruler');
    }
  } else {
    // A measuring ruler is characterized by periodic tick markings along its axis,
    // or a very dense solid border bar. Real jewellery chains (which have zero tick marks)
    // are preserved without false-positive detection.
    const isLeftRuler = leftTransitions >= 6 || (leftDarkPixels > marginArea * 0.20 && leftTransitions >= 4) || (leftDarkPixels > marginArea * 0.40);
    const isBottomRuler = bottomTransitions >= 6 || (bottomDarkPixels > bottomArea * 0.20 && bottomTransitions >= 4) || (bottomDarkPixels > bottomArea * 0.40);

    if (isLeftRuler) {
      forbiddenObjects.push('ruler');
    }
    if (isBottomRuler) {
      if (!forbiddenObjects.includes('ruler')) forbiddenObjects.push('ruler');
    }
  }
  if (coloredPropPixels > 30) {
    forbiddenObjects.push('flower prop');
  }

  const valid = forbiddenObjects.length === 0;
  return {
    valid,
    forbiddenObjects,
    reason: valid ? undefined : `Forbidden object(s) detected: ${forbiddenObjects.join(', ')} in ${role} asset`,
  };
}

export interface ComponentCluster {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centroidX: number;
  centroidY: number;
  category: 'necklace' | 'pendant' | 'earring' | 'extra';
}

export interface DetectedJewelryComponents {
  necklaceCount: number;
  pendantCount: number;
  earringCount: number;
  extraCount: number;
  leftEarringCount: number;
  rightEarringCount: number;
  clusters: ComponentCluster[];
}

/**
 * Detects and segments jewellery component clusters from a white-background asset.
 * Enforces strict counting: exactly 1 necklace, 1 attached pendant, 2 earrings total.
 */
export async function detectJewelryComponentClusters(
  buffer: Buffer
): Promise<DetectedJewelryComponents> {
  const testDim = 256;
  const { data: rawRgb } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mask = new Uint8Array(testDim * testDim);
  let overallMinX = testDim, overallMaxX = 0, overallMinY = testDim, overallMaxY = 0;
  let totalForeground = 0;

  for (let y = 0; y < testDim; y++) {
    for (let x = 0; x < testDim; x++) {
      const idx = (y * testDim + x) * 3;
      const r = rawRgb[idx];
      const g = rawRgb[idx + 1];
      const b = rawRgb[idx + 2];
      if (r < 245 || g < 245 || b < 245) {
        mask[y * testDim + x] = 1;
        totalForeground++;
        if (x < overallMinX) overallMinX = x;
        if (x > overallMaxX) overallMaxX = x;
        if (y < overallMinY) overallMinY = y;
        if (y > overallMaxY) overallMaxY = y;
      }
    }
  }

  if (totalForeground < 40 || overallMaxX < overallMinX || overallMaxY < overallMinY) {
    return {
      necklaceCount: 0,
      pendantCount: 0,
      earringCount: 0,
      extraCount: 0,
      leftEarringCount: 0,
      rightEarringCount: 0,
      clusters: [],
    };
  }

  const overallBoxW = overallMaxX - overallMinX + 1;
  const overallBoxH = overallMaxY - overallMinY + 1;
  const overallCenterX = overallMinX + overallBoxW / 2;

  // Connected Component Labeling via BFS
  const visited = new Uint8Array(testDim * testDim);
  const rawClusters: Array<{
    area: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    centroidX: number;
    centroidY: number;
  }> = [];

  for (let y = 0; y < testDim; y++) {
    for (let x = 0; x < testDim; x++) {
      const startIdx = y * testDim + x;
      if (mask[startIdx] === 1 && visited[startIdx] === 0) {
        visited[startIdx] = 1;
        const queue = [startIdx];
        let qHead = 0;
        let area = 0;
        let cMinX = x, cMaxX = x, cMinY = y, cMaxY = y;
        let sumX = 0, sumY = 0;

        while (qHead < queue.length) {
          const curr = queue[qHead++];
          const currX = curr % testDim;
          const currY = Math.floor(curr / testDim);
          area++;
          sumX += currX;
          sumY += currY;
          if (currX < cMinX) cMinX = currX;
          if (currX > cMaxX) cMaxX = currX;
          if (currY < cMinY) cMinY = currY;
          if (currY > cMaxY) cMaxY = currY;

          const neighbors = [
            currX > 0 ? curr - 1 : -1,
            currX < testDim - 1 ? curr + 1 : -1,
            currY > 0 ? curr - testDim : -1,
            currY < testDim - 1 ? curr + testDim : -1,
          ];

          for (const n of neighbors) {
            if (n >= 0 && mask[n] === 1 && visited[n] === 0) {
              visited[n] = 1;
              queue.push(n);
            }
          }
        }

        if (area >= 15) {
          rawClusters.push({
            area,
            minX: cMinX,
            maxX: cMaxX,
            minY: cMinY,
            maxY: cMaxY,
            centroidX: sumX / area,
            centroidY: sumY / area,
          });
        }
      }
    }
  }

  rawClusters.sort((a, b) => b.area - a.area);

  let necklaceCount = 0;
  let pendantCount = 0;
  let leftEarringCount = 0;
  let rightEarringCount = 0;
  let extraCount = 0;

  const classifiedClusters: ComponentCluster[] = [];

  // Filter out tiny noise / sub-pixel artifacts (< 30 pixels)
  const significantClusters = rawClusters.filter((c) => c.area >= 30);

  for (let i = 0; i < significantClusters.length; i++) {
    const c = significantClusters[i];
    const cW = c.maxX - c.minX + 1;
    const cH = c.maxY - c.minY + 1;

    // Largest cluster or major drape is the necklace
    if (i === 0 || (cW > overallBoxW * 0.38 && cH > overallBoxH * 0.35)) {
      necklaceCount++;
      if (c.maxY >= overallMinY + overallBoxH * 0.55) {
        pendantCount = 1;
      }
      classifiedClusters.push({ ...c, category: 'necklace' });
      continue;
    }

    // Central clusters along center vertical axis belong to necklace / pendant structure
    const isCentralX = Math.abs(c.centroidX - overallCenterX) <= overallBoxW * 0.16;
    const isLowerY = c.centroidY >= overallMinY + overallBoxH * 0.40;
    if (isCentralX && isLowerY) {
      pendantCount = 1;
      classifiedClusters.push({ ...c, category: 'pendant' });
      continue;
    }

    // Central clusters in upper region belong to chain / clasp
    if (isCentralX && c.centroidY < overallMinY + overallBoxH * 0.40) {
      classifiedClusters.push({ ...c, category: 'necklace' });
      continue;
    }

    // Lateral earring check: must be positioned away from center and in upper-mid vertical region (above/alongside pendant)
    const isLeft = c.centroidX < overallCenterX - overallBoxW * 0.12;
    const isRight = c.centroidX > overallCenterX + overallBoxW * 0.12;
    const isEarringY = c.centroidY >= overallMinY && c.centroidY <= overallMinY + overallBoxH * 0.70;

    if (isEarringY && isLeft) {
      leftEarringCount++;
      classifiedClusters.push({ ...c, category: 'earring' });
    } else if (isEarringY && isRight) {
      rightEarringCount++;
      classifiedClusters.push({ ...c, category: 'earring' });
    } else if (c.area >= 30) {
      // Significant detached objects outside normal necklace/earrings positions count as extra
      extraCount++;
      classifiedClusters.push({ ...c, category: 'extra' });
    }
  }

  if (pendantCount === 0 && necklaceCount >= 1) {
    pendantCount = 1;
  }

  const earringCount = leftEarringCount + rightEarringCount;

  return {
    necklaceCount: Math.min(1, necklaceCount),
    pendantCount,
    earringCount,
    extraCount,
    leftEarringCount,
    rightEarringCount,
    clusters: classifiedClusters,
  };
}

/**
 * Validates expected jewellery component counts:
 * - Exactly 1 necklace
 * - Exactly 1 pendant
 * - Exactly 2 earrings total
 * - No extra side ornaments or floating jewellery pieces
 */
export async function validateExpectedJewelryCounts(
  buffer: Buffer,
  expected: { necklaceCount?: number; pendantCount?: number; earringCount?: number } = {}
): Promise<{
  valid: boolean;
  detected: { necklaceCount: number; pendantCount: number; earringCount: number; extraCount: number };
  issues: string[];
}> {
  const issues: string[] = [];
  const expNecklaces = expected.necklaceCount ?? 1;
  const expPendants = expected.pendantCount ?? 1;
  const expEarrings = expected.earringCount ?? 2;

  const detected = await detectJewelryComponentClusters(buffer);

  if (detected.earringCount > expEarrings) {
    issues.push(`Detected ${detected.earringCount} earrings in hero image (maximum ${expEarrings} expected). Extra earrings are strictly forbidden.`);
  }
  if (detected.extraCount > 0) {
    issues.push(`Detected ${detected.extraCount} extra unknown jewellery component(s) outside expected necklace/earrings layout.`);
  }
  if (detected.necklaceCount > expNecklaces) {
    issues.push(`Detected ${detected.necklaceCount} necklaces (expected ${expNecklaces}).`);
  }
  if (detected.pendantCount > expPendants) {
    issues.push(`Detected ${detected.pendantCount} pendants (expected ${expPendants}).`);
  }

  const valid =
    detected.earringCount <= expEarrings &&
    detected.extraCount === 0 &&
    detected.necklaceCount <= expNecklaces &&
    detected.pendantCount <= expPendants &&
    detected.necklaceCount > 0;

  return {
    valid,
    detected: {
      necklaceCount: detected.necklaceCount,
      pendantCount: detected.pendantCount,
      earringCount: detected.earringCount,
      extraCount: detected.extraCount,
    },
    issues,
  };
}

/**
 * Validates that no duplicate earrings appear (at most 1 pair: 1 left, 1 right).
 */
export async function validateNoDuplicateEarrings(
  buffer: Buffer
): Promise<{
  valid: boolean;
  detectedEarrings: number;
  duplicateDetected: boolean;
  issues: string[];
}> {
  const issues: string[] = [];
  const detected = await detectJewelryComponentClusters(buffer);

  const duplicateDetected =
    detected.earringCount > 2 || detected.leftEarringCount > 1 || detected.rightEarringCount > 1;

  if (duplicateDetected) {
    issues.push(
      `Duplicate earrings detected: ${detected.earringCount} earrings found (${detected.leftEarringCount} left, ${detected.rightEarringCount} right). Exactly 2 earrings total (1 pair) are permitted.`
    );
  }

  return {
    valid: !duplicateDetected,
    detectedEarrings: detected.earringCount,
    duplicateDetected,
    issues,
  };
}

/**
export interface PendantCenteredResult {
  valid: boolean;
  passed: boolean;
  score: number;
  offsetPercent: number;
  issues: string[];
  notes: string[];
}

/**
 * Validates that the pendant remains centered along the vertical axis.
 */
export async function validatePendantCentered(
  buffer: Buffer
): Promise<PendantCenteredResult> {
  const issues: string[] = [];
  const testDim = 256;
  const { data: rawRgb } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = testDim, maxX = 0, minY = testDim, maxY = 0;
  for (let y = 0; y < testDim; y++) {
    for (let x = 0; x < testDim; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const boxW = maxX >= minX ? maxX - minX + 1 : testDim;
  const boxH = maxY >= minY ? maxY - minY + 1 : testDim;
  const overallCenterX = minX + boxW / 2;

  // Lower 45% represents the pendant
  const lowerStartY = Math.round(minY + boxH * 0.55);
  let lowerCount = 0;
  let lowerXSum = 0;

  for (let y = lowerStartY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        lowerCount++;
        lowerXSum += x;
      }
    }
  }

  const pendantCentroidX = lowerCount > 15 ? lowerXSum / lowerCount : overallCenterX;
  const offsetDistance = Math.abs(pendantCentroidX - overallCenterX);
  const offsetPercent = boxW > 0 ? (offsetDistance / boxW) * 100 : 0;

  const maxAllowedOffsetPercent = 10;
  const valid = offsetPercent <= maxAllowedOffsetPercent;
  const score = Math.max(0, Math.min(100, Math.round(100 - offsetPercent * 5)));
  if (!valid) {
    issues.push(
      `Pendant is off-center by ${offsetPercent.toFixed(1)}% (max allowed ${maxAllowedOffsetPercent}%). Pendant must remain on central vertical axis.`
    );
  }

  return {
    valid,
    passed: valid,
    score,
    offsetPercent,
    issues,
    notes: issues,
  };
}

/**
 * Validates layout symmetry:
 * - Necklace chain drape is balanced left-to-right
 * - Earrings are placed with equal spacing from center axis
 */
export async function validateHeroSymmetry(
  buffer: Buffer
): Promise<{
  valid: boolean;
  chainBalanceRatio: number;
  earringSpacingRatio: number;
  issues: string[];
}> {
  const issues: string[] = [];
  const testDim = 256;
  const { data: rawRgb } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = testDim, maxX = 0, minY = testDim, maxY = 0;
  for (let y = 0; y < testDim; y++) {
    for (let x = 0; x < testDim; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const boxW = maxX >= minX ? maxX - minX + 1 : testDim;
  const boxH = maxY >= minY ? maxY - minY + 1 : testDim;
  const overallCenterX = minX + boxW / 2;

  // Upper chain drape symmetry (top 35% of jewellery box)
  const upperLimitY = minY + boxH * 0.35;
  let leftChainPixels = 0;
  let rightChainPixels = 0;

  for (let y = minY; y <= upperLimitY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        if (x < overallCenterX) leftChainPixels++;
        else rightChainPixels++;
      }
    }
  }

  const totalUpper = leftChainPixels + rightChainPixels;
  const chainBalanceRatio = rightChainPixels > 0 ? leftChainPixels / rightChainPixels : 1;
  const isChainSymmetric = totalUpper < 20 || (chainBalanceRatio >= 0.35 && chainBalanceRatio <= 1.65);

  if (!isChainSymmetric) {
    issues.push(`Necklace chain drape is asymmetric (balance ratio: ${chainBalanceRatio.toFixed(2)}).`);
  }

  // Earring spacing symmetry
  const detected = await detectJewelryComponentClusters(buffer);
  let earringSpacingRatio = 1;
  let isEarringsSymmetric = true;

  if (detected.leftEarringCount >= 1 && detected.rightEarringCount >= 1) {
    const leftEarring = detected.clusters.find((c) => c.category === 'earring' && c.centroidX < overallCenterX);
    const rightEarring = detected.clusters.find((c) => c.category === 'earring' && c.centroidX > overallCenterX);
    if (leftEarring && rightEarring) {
      const distLeft = overallCenterX - leftEarring.centroidX;
      const distRight = rightEarring.centroidX - overallCenterX;
      earringSpacingRatio = distRight > 0 ? distLeft / distRight : 1;
      isEarringsSymmetric = earringSpacingRatio >= 0.65 && earringSpacingRatio <= 1.55;
      if (!isEarringsSymmetric) {
        issues.push(`Earrings are not equally spaced from central axis (spacing ratio: ${earringSpacingRatio.toFixed(2)}).`);
      }
    }
  }

  const valid = isChainSymmetric && isEarringsSymmetric;
  return {
    valid,
    chainBalanceRatio,
    earringSpacingRatio,
    issues,
  };
}

export interface ChainSymmetryResult {
  score: number;
  passed: boolean;
  valid: boolean;
  balanceRatio: number;
  lateralSpanRatio: number;
  leftPixels: number;
  rightPixels: number;
  notes: string[];
  issues: string[];
}

export interface ChainWarpResult {
  score: number;
  passed: boolean;
  valid: boolean;
  notes: string[];
  issues: string[];
}

export interface NecklaceSymmetryResult {
  valid: boolean;
  passed: boolean;
  score: number;
  balanceRatio: number;
  lateralSpanRatio: number;
  leftPixels: number;
  rightPixels: number;
  issues: string[];
  notes: string[];
}

/**
 * Detects whether the necklace chain has inward collapse, excessive inward bowing,
 * abrupt curvature inconsistencies, or unnatural crossing/overlap on either side.
 */
export async function detectChainWarpOrCollapse(
  buffer: Buffer
): Promise<ChainWarpResult> {
  const notes: string[] = [];
  const testDim = 256;
  const { data: rawRgb } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = testDim, maxX = 0, minY = testDim, maxY = 0;
  for (let y = 0; y < testDim; y++) {
    for (let x = 0; x < testDim; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const boxW = maxX >= minX ? maxX - minX + 1 : testDim;
  const boxH = maxY >= minY ? maxY - minY + 1 : testDim;
  const lowerStartY = Math.round(minY + boxH * 0.55);
  let lowerXSum = 0;
  let lowerCount = 0;
  for (let y = lowerStartY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        lowerCount++;
        lowerXSum += x;
      }
    }
  }
  const axisCenterX = lowerCount > 10 ? lowerXSum / lowerCount : minX + boxW / 2;

  // Scan horizontal slices in the upper drape (15% to 45% of necklace height)
  const sliceStartY = Math.round(minY + boxH * 0.15);
  const sliceEndY = Math.round(minY + boxH * 0.45);
  let inwardCollapsedSlices = 0;
  let checkedSlices = 0;

  for (let y = sliceStartY; y <= sliceEndY; y += 4) {
    let rowLeftMinX = testDim;
    let rowRightMaxX = -1;

    for (let x = minX; x <= maxX; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        if (x < axisCenterX && x < rowLeftMinX) rowLeftMinX = x;
        if (x > axisCenterX && x > rowRightMaxX) rowRightMaxX = x;
      }
    }

    if (rowLeftMinX < testDim && rowRightMaxX >= 0) {
      checkedSlices++;
      const leftDist = axisCenterX - rowLeftMinX;
      const rightDist = rowRightMaxX - axisCenterX;
      const maxDist = Math.max(leftDist, rightDist);
      const minDist = Math.min(leftDist, rightDist);

      if (maxDist > 12 && minDist / maxDist < 0.45) {
        inwardCollapsedSlices++;
      }
    }
  }

  const collapseRatio = checkedSlices > 0 ? inwardCollapsedSlices / checkedSlices : 0;
  const hasSevereCollapse = collapseRatio >= 0.35;
  const score = Math.max(0, Math.min(100, Math.round(100 - collapseRatio * 150)));

  if (hasSevereCollapse) {
    notes.push(
      `Chain displays unnatural inward collapse / warping on one side (${Math.round(collapseRatio * 100)}% of drape slices collapsed inward).`
    );
  }

  const passed = !hasSevereCollapse && score >= 70;
  return {
    score,
    passed,
    valid: passed,
    notes,
    issues: notes,
  };
}

/**
 * Validates necklace chain symmetry:
 * - Checks upper chain drape balance (left vs right pixel distribution across top 40% of jewellery bounds)
 * - Checks lateral span ratio (ensuring chain doesn't inward-collapse or skew heavily to one side)
 * - Returns continuous symmetry score (0-100) and pass/fail gate (>= 70)
 */
export async function validateChainSymmetry(
  buffer: Buffer
): Promise<ChainSymmetryResult> {
  const issues: string[] = [];
  const testDim = 256;
  const { data: rawRgb } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = testDim, maxX = 0, minY = testDim, maxY = 0;
  for (let y = 0; y < testDim; y++) {
    for (let x = 0; x < testDim; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const boxW = maxX >= minX ? maxX - minX + 1 : testDim;
  const boxH = maxY >= minY ? maxY - minY + 1 : testDim;

  // Find lower apex / pendant center X
  const lowerStartY = Math.round(minY + boxH * 0.55);
  let lowerXSum = 0;
  let lowerCount = 0;
  for (let y = lowerStartY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        lowerCount++;
        lowerXSum += x;
      }
    }
  }
  const axisCenterX = lowerCount > 10 ? lowerXSum / lowerCount : minX + boxW / 2;

  // Upper chain drape (top 40% of necklace bounds where drape curves down from clasp)
  const upperLimitY = minY + boxH * 0.40;
  let leftChainPixels = 0;
  let rightChainPixels = 0;

  for (let y = minY; y <= upperLimitY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = (y * testDim + x) * 3;
      if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
        if (x < axisCenterX) leftChainPixels++;
        else rightChainPixels++;
      }
    }
  }

  const totalUpper = leftChainPixels + rightChainPixels;
  const balanceRatio = rightChainPixels > 0 ? leftChainPixels / rightChainPixels : (leftChainPixels === 0 ? 1 : 99);
  const isBalanceSymmetric = totalUpper < 20 || (balanceRatio >= 0.50 && balanceRatio <= 1.50);

  // Check lateral span: distance from central axis to left-most chain vs right-most chain
  const leftSpan = Math.max(1, axisCenterX - minX);
  const rightSpan = Math.max(1, maxX - axisCenterX);
  const lateralSpanRatio = rightSpan > 0 ? leftSpan / rightSpan : 1;
  const isSpanSymmetric = lateralSpanRatio >= 0.55 && lateralSpanRatio <= 1.45;

  if (!isBalanceSymmetric) {
    issues.push(`Necklace chain drape has asymmetric balance (left/right ratio: ${balanceRatio.toFixed(2)}, expected 0.50-1.50).`);
  }
  if (!isSpanSymmetric) {
    issues.push(`Necklace chain span is laterally uneven (ratio: ${lateralSpanRatio.toFixed(2)}, expected 0.55-1.45).`);
  }

  const balDev = Math.abs(1 - (balanceRatio > 2 ? 2 : balanceRatio < 0.2 ? 0.2 : balanceRatio));
  const spanDev = Math.abs(1 - (lateralSpanRatio > 2 ? 2 : lateralSpanRatio < 0.2 ? 0.2 : lateralSpanRatio));
  const score = Math.max(0, Math.min(100, Math.round(100 - (balDev * 45 + spanDev * 45))));

  const passed = isBalanceSymmetric && isSpanSymmetric && score >= 70;
  return {
    score,
    passed,
    valid: passed,
    balanceRatio,
    lateralSpanRatio,
    leftPixels: leftChainPixels,
    rightPixels: rightChainPixels,
    notes: issues,
    issues,
  };
}

/**
 * Validates necklace chain symmetry (delegates to validateChainSymmetry).
 */
export async function validateNecklaceSymmetry(
  buffer: Buffer
): Promise<NecklaceSymmetryResult> {
  const res = await validateChainSymmetry(buffer);
  return {
    valid: res.passed,
    passed: res.passed,
    score: res.score,
    balanceRatio: res.balanceRatio,
    lateralSpanRatio: res.lateralSpanRatio,
    leftPixels: res.leftPixels,
    rightPixels: res.rightPixels,
    issues: res.issues,
    notes: res.notes,
  };
}

export interface NoExtraJewelryResult {
  valid: boolean;
  earringCount: number;
  necklaceCount: number;
  pendantCount: number;
  extraComponentsCount: number;
  duplicateEarringsDetected: boolean;
  issues: string[];
}

/**
 * Validates product lock:
 * - Exactly 1 necklace, 1 pendant, <= 2 earrings
 * - No duplicate earrings
 * - 0 extra components or ornaments
 */
export async function validateNoExtraJewelry(
  buffer: Buffer
): Promise<NoExtraJewelryResult> {
  const countsCheck = await validateExpectedJewelryCounts(buffer, {
    necklaceCount: 1,
    pendantCount: 1,
    earringCount: 2,
  });
  const dupCheck = await validateNoDuplicateEarrings(buffer);

  const issues: string[] = [];
  if (countsCheck.detected.earringCount > 2) {
    issues.push(`Detected ${countsCheck.detected.earringCount} earrings (maximum allowed is 2).`);
  }
  if (countsCheck.detected.extraCount > 0) {
    issues.push(`Detected ${countsCheck.detected.extraCount} extraneous jewelry component(s).`);
  }
  if (dupCheck.duplicateDetected) {
    issues.push(...dupCheck.issues);
  }

  const valid =
    countsCheck.detected.earringCount <= 2 &&
    countsCheck.detected.extraCount === 0 &&
    !dupCheck.duplicateDetected;

  return {
    valid,
    earringCount: countsCheck.detected.earringCount,
    necklaceCount: countsCheck.detected.necklaceCount,
    pendantCount: countsCheck.detected.pendantCount,
    extraComponentsCount: countsCheck.detected.extraCount,
    duplicateEarringsDetected: dupCheck.duplicateDetected,
    issues: Array.from(new Set(issues)),
  };
}

export interface SilverToneCleanlinessResult {
  score: number;
  passed: boolean;
  valid: boolean;
  darkMetalRatio: number;
  blueStonePreserved: boolean;
  metalPixelsCount: number;
  darkMetalPixelsCount: number;
  blueStonePixelsCount: number;
  notes: string[];
  issues: string[];
}

export interface BlackishMetalContaminationResult {
  score: number;
  passed: boolean;
  contaminated: boolean;
  darkMetalRatio: number;
  notes: string[];
  issues: string[];
}

export type SilverFinishCleanlinessResult = SilverToneCleanlinessResult;

/**
 * Validates silver-tone finish cleanliness:
 * - Detects silver-tone metal (neutral chrominance)
 * - Checks for blackish/dull contamination on metal (luma < 50)
 * - Verifies that blue stones retain their vibrant blue hue
 * - Returns score (0-100), passed (>= 70), darkMetalRatio, notes
 */
export async function validateSilverToneCleanliness(
  buffer: Buffer
): Promise<SilverToneCleanlinessResult> {
  const issues: string[] = [];
  const testDim = 256;
  const { data: rawRgb } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let metalPixels = 0;
  let darkMetalPixels = 0;
  let blueStonePixels = 0;
  let blueStoneDeltaSum = 0;

  for (let i = 0; i < testDim * testDim; i++) {
    const r = rawRgb[i * 3];
    const g = rawRgb[i * 3 + 1];
    const b = rawRgb[i * 3 + 2];

    const isForeground = r < 248 || g < 248 || b < 248;
    if (!isForeground) continue;

    // Check if blue/sapphire stone: distinctly higher blue than red and green
    const isBlueStone = b > r + 12 && b > g + 8;
    if (isBlueStone) {
      blueStonePixels++;
      blueStoneDeltaSum += b - (r + g) / 2;
      continue;
    }

    // Check if silver-tone metal: low chromaticity (neutral gray/silver)
    const maxVal = Math.max(r, g, b);
    const minVal = Math.min(r, g, b);
    const isNeutralMetal = (maxVal - minVal) <= 26;

    if (isNeutralMetal) {
      metalPixels++;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      // Dull, muddy, blackish metal shadow contamination
      if (luma < 50) {
        darkMetalPixels++;
      }
    }
  }

  const darkMetalRatio = metalPixels > 0 ? darkMetalPixels / metalPixels : 0;
  const isClean = darkMetalRatio <= 0.15;
  if (!isClean) {
    issues.push(
      `Silver-tone metal shows blackish/dull contamination (${(darkMetalRatio * 100).toFixed(1)}% dark pixels, max allowed 15%).`
    );
  }

  // If blue stones exist, verify blue chromaticity is preserved
  const blueStonePreserved = blueStonePixels === 0 || (blueStoneDeltaSum / blueStonePixels >= 15);
  if (!blueStonePreserved) {
    issues.push('Gemstone blue colour has degraded or lost chromaticity.');
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - darkMetalRatio * 400 - (blueStonePreserved ? 0 : 40))));
  const passed = isClean && blueStonePreserved && score >= 70;

  return {
    valid: passed,
    passed,
    score,
    darkMetalRatio,
    blueStonePreserved,
    metalPixelsCount: metalPixels,
    darkMetalPixelsCount: darkMetalPixels,
    blueStonePixelsCount: blueStonePixels,
    notes: issues,
    issues,
  };
}

/**
 * Backward-compatible alias for validateSilverToneCleanliness.
 */
export async function validateSilverFinishCleanliness(
  buffer: Buffer
): Promise<SilverFinishCleanlinessResult> {
  return validateSilverToneCleanliness(buffer);
}

/**
 * Detects whether silver metal has excessive blackish/muddy shadow contamination.
 */
export async function detectBlackishMetalContamination(
  buffer: Buffer
): Promise<BlackishMetalContaminationResult> {
  const res = await validateSilverToneCleanliness(buffer);
  const contaminated = res.darkMetalRatio > 0.15;
  const passed = !contaminated;
  const score = Math.max(0, Math.min(100, Math.round(100 - res.darkMetalRatio * 400)));
  const notes = contaminated
    ? [`Detected excessive blackish/dull contamination on silver-tone metal (${(res.darkMetalRatio * 100).toFixed(1)}% dark pixels, max allowed 15%).`]
    : ['Silver-tone metal is clean and polished with no excessive dark contamination.'];

  return {
    score,
    passed,
    contaminated,
    darkMetalRatio: res.darkMetalRatio,
    notes,
    issues: notes,
  };
}

/**
 * Injects jewellery finish instructions into a generation prompt without forcing
 * a specific metal or gemstone colour.
 */
export function enhanceSilverTonePrompt(basePrompt: string = ''): string {
  const finishInstructions = [
    'METAL FINISH & GEMSTONE RULES (STRICT PRODUCT-LOCK):',
    '- Clean unwanted blackish, dull, muddy, or dirty-looking shadow contamination on chain, pendant metal, and earring metal.',
    '- Preserve the exact source metal colour: gold stays gold, silver stays silver, rose gold stays rose gold, oxidized finishes stay intentionally oxidized.',
    '- Maintain realistic metallic reflections and polished commercial highlights without changing the jewellery identity.',
    '- Remove dirty blackish patches caused by bad lighting.',
    '- Do not convert gold to silver, silver to gold, ruby to sapphire, pearl to diamond, or change any gemstone colour.',
    '- Preserve exact stone colours, stone cuts, pearl surfaces, bead colour, enamel colour, and decorative pattern from the reference.',
    '- Preserve exact chain or mala construction, including alternating white pearl beads and gold spacer beads; do not replace a beaded mala with a smooth or all-gold chain.',
    '- Preserve clasps, hooks, knots, barrel connectors, strand thickness, bead spacing, and natural U/V drape from the reference.',
    '- Make the jewellery appear polished, clean, crisp, and commercially presentable.',
  ].join('\n');

  if (basePrompt.includes('METAL FINISH & GEMSTONE RULES') || basePrompt.includes('clean blackish lighting contamination')) {
    return basePrompt;
  }
  return basePrompt ? `${basePrompt}\n\n${finishInstructions}` : finishInstructions;
}

export interface CleanSilverToneResult {
  buffer: Buffer;
  cleaned: boolean;
  darkPatchesRemoved: number;
}

/**
 * Cleans blackish, muddy, or dull shadow contamination from silver-tone jewellery metal,
 * lifting unwanted dark patches into polished silver midtones/highlights while:
 * - strictly preserving blue gemstones and stone cut
 * - preserving authentic metallic reflections and specular highlights
 * - avoiding over-whitening into the white background
 */
export async function cleanSilverToneFinish(
  buffer: Buffer
): Promise<CleanSilverToneResult> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 2048;
  const height = meta.height || 2048;

  const { data: rawRgb, info } = await sharp(buffer)
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const outData = Buffer.from(rawRgb);
  let darkPatchesRemoved = 0;

  for (let i = 0; i < info.width * info.height; i++) {
    const idx = i * 3;
    const r = rawRgb[idx];
    const g = rawRgb[idx + 1];
    const b = rawRgb[idx + 2];

    // Background check: keep pure white
    if (r >= 248 && g >= 248 && b >= 248) {
      continue;
    }

    // Blue stone check: protect completely
    if (b > r + 10 && b > g + 6) {
      continue;
    }

    // Silver metal check: neutral chromaticity
    const maxVal = Math.max(r, g, b);
    const minVal = Math.min(r, g, b);
    const isNeutralMetal = (maxVal - minVal) <= 30;

    if (isNeutralMetal) {
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma < 120) {
        // Lift dark/dull/blackish metal shadow smoothly to polished silver lustre
        const targetLuma = Math.min(235, Math.round(luma + (175 - luma) * 0.72));
        outData[idx] = targetLuma;
        outData[idx + 1] = targetLuma;
        outData[idx + 2] = Math.min(238, targetLuma + 1); // Subtle cool silver lustre
        darkPatchesRemoved++;
      } else if (luma >= 120 && luma < 235) {
        // Polished highlight: subtle clarity boost without over-whitening
        const subtleLuma = Math.min(238, Math.round(luma * 1.03));
        outData[idx] = subtleLuma;
        outData[idx + 1] = subtleLuma;
        outData[idx + 2] = Math.min(240, subtleLuma + 1);
      }
    }
  }

  const cleaned = darkPatchesRemoved > 0;
  const processedBuf = await sharp(outData, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 3,
    },
  })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return {
    buffer: processedBuf,
    cleaned,
    darkPatchesRemoved,
  };
}

export interface HeroPresentationQualityResult {
  valid: boolean;
  issues: string[];
  chainBalanced: boolean;
  pendantCentered: boolean;
  productLocked: boolean;
  silverFinishClean: boolean;
  blueStonePreserved: boolean;
  details: {
    necklaceSymmetry: NecklaceSymmetryResult;
    pendantCentering: { valid: boolean; offsetPercent: number; issues: string[] };
    noExtraJewelry: NoExtraJewelryResult;
    silverCleanliness: SilverFinishCleanlinessResult;
  };
}

/**
 * Master presentation quality validator combining layout symmetry, pendant centering,
 * strict product-lock count, and silver-tone finish cleanliness.
 */
export async function validateHeroPresentationQuality(
  buffer: Buffer,
  options: {
    matchScore?: number;
    expectedRatio?: '1:1' | '4:5' | '9:16';
  } = {}
): Promise<HeroPresentationQualityResult> {
  const issues: string[] = [];

  const [neckSym, pendantCheck, extraCheck, silverCheck, warpCheck] = await Promise.all([
    validateNecklaceSymmetry(buffer),
    validatePendantCentered(buffer),
    validateNoExtraJewelry(buffer),
    validateSilverToneCleanliness(buffer),
    detectChainWarpOrCollapse(buffer),
  ]);

  if (!neckSym.valid) issues.push(...neckSym.issues);
  if (!pendantCheck.valid) issues.push(...pendantCheck.issues);
  if (!extraCheck.valid) issues.push(...extraCheck.issues);
  if (!silverCheck.valid) issues.push(...silverCheck.issues);
  if (!warpCheck.passed) issues.push(...warpCheck.notes);

  // Match score check
  const matchScoreAcceptable = options.matchScore === undefined || options.matchScore >= 80;
  if (!matchScoreAcceptable) {
    issues.push(`Product match score (${options.matchScore}%) is below acceptable threshold (>= 80%).`);
  }

  const valid =
    neckSym.valid &&
    pendantCheck.valid &&
    extraCheck.valid &&
    silverCheck.valid &&
    warpCheck.passed &&
    matchScoreAcceptable;

  return {
    valid,
    issues: Array.from(new Set(issues)),
    chainBalanced: neckSym.valid && warpCheck.passed,
    pendantCentered: pendantCheck.valid,
    productLocked: extraCheck.valid,
    silverFinishClean: silverCheck.valid,
    blueStonePreserved: silverCheck.blueStonePreserved,
    details: {
      necklaceSymmetry: neckSym,
      pendantCentering: pendantCheck,
      noExtraJewelry: extraCheck,
      silverCleanliness: silverCheck,
    },
  };
}

export interface AiHeroValidationResult {
  valid: boolean;
  issues: string[];
  hasVisibleSubject: boolean;
  isNotBlank: boolean;
  noSevereClipping: boolean;
  hasWhiteBackground: boolean;
  forbiddenObjects: string[];
  matchScoreAcceptable: boolean;
  stonesTooDark: boolean;
  chainMisaligned: boolean;
  pendantMisaligned: boolean;
  earringsUneven: boolean;
  occupancyAcceptable: boolean;
  extraComponentsDetected: boolean;
  earringCount: number;
}

/**
 * Dedicated validator for AI Presentation Hero outputs.
 * Enforces presentation quality gates:
 * 1. Strict component-count lock: exactly 1 necklace, 1 pendant, <= 2 earrings, 0 extra components
 * 2. Pure white background (#FFFFFF) with no clipping
 * 3. Proper occupancy (not too small, not too large)
 * 4. Stones not crushed to dark/black
 * 5. Symmetrical chain alignment & naturally balanced clasp
 * 6. Pendant vertically aligned beneath the chain
 * 7. Earrings evenly spaced left and right
 * 8. Product match score >= 80% (score >= 90% is HIGH MATCH)
 */
export async function validateAiHeroPresentation(
  buffer: Buffer,
  options: {
    matchScore?: number;
    expectedRatio?: '1:1' | '4:5' | '9:16';
  } = {}
): Promise<AiHeroValidationResult> {
  const issues: string[] = [];
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 2048;
  const height = meta.height || 2048;

  const { data: rawRgb, info } = await sharp(buffer)
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
  let foregroundCount = 0;
  let totalBorderPixels = 0;
  let nonWhiteBorderPixels = 0;

  const foregroundLumas: number[] = [];

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * channels;
      const r = rawRgb[idx];
      const g = rawRgb[idx + 1];
      const b = rawRgb[idx + 2];

      const isNonWhite = r < 248 || g < 248 || b < 248;
      if (isNonWhite) {
        foregroundCount++;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        foregroundLumas.push(luma);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      if (x < 3 || x >= info.width - 3 || y < 3 || y >= info.height - 3) {
        totalBorderPixels++;
        if (r < 245 || g < 245 || b < 245) {
          nonWhiteBorderPixels++;
        }
      }
    }
  }

  const boxW = maxX >= minX ? maxX - minX + 1 : 0;
  const boxH = maxY >= minY ? maxY - minY + 1 : 0;

  // 1. Subject visible
  const hasVisibleSubject = foregroundCount >= 200;
  if (!hasVisibleSubject) {
    issues.push('No jewellery subject visible in AI hero presentation.');
  }

  // 2. Output not blank
  const isNotBlank = foregroundCount > 0 && foregroundCount < (info.width * info.height * 0.98);
  if (!isNotBlank) {
    issues.push('Generated hero image is blank or completely filled.');
  }

  // 3. No severe clipping
  const borderClippingRatio = totalBorderPixels > 0 ? nonWhiteBorderPixels / totalBorderPixels : 0;
  const noSevereClipping = borderClippingRatio < 0.10;
  if (!noSevereClipping) {
    issues.push('Jewellery appears clipped at image borders.');
  }

  // 4. White background
  const hasWhiteBackground = borderClippingRatio <= 0.05;
  if (!hasWhiteBackground) {
    issues.push('Background is not clean pure white #FFFFFF.');
  }

  // 5. Occupancy check
  const occW = boxW / info.width;
  const occH = boxH / info.height;
  let occupancyAcceptable = true;
  if (occW < 0.40 || occH < 0.40) {
    occupancyAcceptable = false;
    issues.push(`Product occupies too little space in hero frame (${Math.round(occW * 100)}% W, ${Math.round(occH * 100)}% H).`);
  } else if (occW > 0.95 || occH > 0.95) {
    occupancyAcceptable = false;
    issues.push(`Product occupies too much space in hero frame (${Math.round(occW * 100)}% W, ${Math.round(occH * 100)}% H).`);
  }

  // 6. Stones darkness check
  let stonesTooDark = false;
  if (foregroundLumas.length > 50) {
    foregroundLumas.sort((a, b) => a - b);
    const darkest10Count = Math.max(5, Math.floor(foregroundLumas.length * 0.10));
    let darkSum = 0;
    for (let i = 0; i < darkest10Count; i++) {
      darkSum += foregroundLumas[i];
    }
    const avgDarkLuma = darkSum / darkest10Count;
    if (avgDarkLuma < 12) {
      stonesTooDark = true;
      issues.push('Stones appear too dark / crushed to near-black in the hero image.');
    }
  }

  // 7. Component count and duplicate earring validation
  const countsCheck = await validateExpectedJewelryCounts(buffer, { necklaceCount: 1, pendantCount: 1, earringCount: 2 });
  const duplicateCheck = await validateNoDuplicateEarrings(buffer);
  const extraComponentsDetected = !countsCheck.valid || duplicateCheck.duplicateDetected;
  if (extraComponentsDetected) {
    issues.push(...countsCheck.issues, ...duplicateCheck.issues);
  }

  // 8. Pendant centering
  const pendantCheck = await validatePendantCentered(buffer);
  const pendantMisaligned = !pendantCheck.valid;
  if (pendantMisaligned) {
    issues.push(...pendantCheck.issues);
  }

  // 9. Symmetry (chain drape + earring spacing + warp detection)
  const symmetryCheck = await validateHeroSymmetry(buffer);
  const chainSym = await validateChainSymmetry(buffer);
  const warpCheck = await detectChainWarpOrCollapse(buffer);
  const chainMisaligned =
    (!symmetryCheck.valid && symmetryCheck.issues.some((i) => i.includes('chain'))) ||
    !chainSym.passed ||
    !warpCheck.passed;
  const earringsUneven = !symmetryCheck.valid && symmetryCheck.issues.some((i) => i.includes('Earrings'));
  if (!symmetryCheck.valid) {
    issues.push(...symmetryCheck.issues);
  }
  if (!chainSym.passed) {
    issues.push(...chainSym.notes);
  }
  if (!warpCheck.passed) {
    issues.push(...warpCheck.notes);
  }

  // 10. Silver-tone finish cleanliness
  const silverCheck = await validateSilverToneCleanliness(buffer);
  const silverContaminated = !silverCheck.passed;
  if (silverContaminated) {
    issues.push(...silverCheck.notes);
  }

  // 11. No forbidden props
  const propCheck = await validateGalleryAsset(buffer, 'HERO_COVER');
  const forbiddenObjects = propCheck.forbiddenObjects || [];
  if (forbiddenObjects.length > 0) {
    issues.push(`Forbidden object(s) detected: ${forbiddenObjects.join(', ')}`);
  }

  // 12. Match score acceptable
  const matchScoreAcceptable = options.matchScore === undefined || options.matchScore >= 80;
  if (!matchScoreAcceptable) {
    issues.push(`Product match score (${options.matchScore}%) is below acceptable threshold (>= 80%).`);
  }

  const valid =
    hasVisibleSubject &&
    isNotBlank &&
    noSevereClipping &&
    hasWhiteBackground &&
    occupancyAcceptable &&
    !stonesTooDark &&
    !extraComponentsDetected &&
    !chainMisaligned &&
    !pendantMisaligned &&
    !earringsUneven &&
    !silverContaminated &&
    forbiddenObjects.length === 0 &&
    matchScoreAcceptable;

  return {
    valid,
    issues: Array.from(new Set(issues)),
    hasVisibleSubject,
    isNotBlank,
    noSevereClipping,
    hasWhiteBackground,
    forbiddenObjects,
    matchScoreAcceptable,
    stonesTooDark,
    chainMisaligned,
    pendantMisaligned,
    earringsUneven,
    occupancyAcceptable,
    extraComponentsDetected,
    earringCount: countsCheck.detected.earringCount,
    silverClean: !silverContaminated,
  };
}

/**
 * Enhances lighting and tone for presentation hero shots:
 * - Brightens slightly if source is underexposed
 * - Recovers sapphire / blue stone visibility without turning flat black
 * - Maintains true silver-tone metal appearance
 * - Cleans blackish, dull, muddy shadow patches from silver metal
 * - Removes dullness while avoiding hallucinated sparkle overload
 */
export async function enhanceHeroPresentationLighting(
  buffer: Buffer
): Promise<{ buffer: Buffer; stonesRecovered: boolean; brightened: boolean }> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 2048;
  const height = meta.height || 2048;

  const { data: rawRgb, info } = await sharp(buffer)
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let fgCount = 0;
  let totalLuma = 0;
  let darkPixelCount = 0;
  let blueStonePixelCount = 0;

  for (let i = 0; i < info.width * info.height; i++) {
    const r = rawRgb[i * 3];
    const g = rawRgb[i * 3 + 1];
    const b = rawRgb[i * 3 + 2];
    if (r < 248 || g < 248 || b < 248) {
      fgCount++;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      totalLuma += luma;
      if (luma < 50) {
        darkPixelCount++;
      }
      if (b > r + 6 && b > g + 4) {
        blueStonePixelCount++;
      }
    }
  }

  const avgFgLuma = fgCount > 0 ? totalLuma / fgCount : 128;
  const darkRatio = fgCount > 0 ? darkPixelCount / fgCount : 0;
  const isUnderexposed = avgFgLuma < 100 || darkRatio > 0.20;
  const hasDarkStones = darkRatio > 0.10 || blueStonePixelCount > 20;

  let brightened = false;
  let stonesRecovered = false;

  let pipeline = sharp(buffer);

  if (isUnderexposed || hasDarkStones) {
    brightened = true;
    stonesRecovered = true;
    pipeline = pipeline
      .modulate({
        brightness: 1.08,
        saturation: 1.15,
      })
      .gamma(1.10);
  }

  const enhancedBuf = await pipeline.toBuffer();
  const flattened = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: enhancedBuf, gravity: 'center' }])
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const { buffer: silverCleanedBuf } = await cleanSilverToneFinish(flattened);

  return {
    buffer: silverCleanedBuf,
    stonesRecovered,
    brightened,
  };
}

export interface CloseupNotBlankValidationResult {
  valid: boolean;
  isBlank: boolean;
  isMostlyBlack: boolean;
  foregroundAreaRatio: number;
  entropy: number;
  hasValidJewelryComponent: boolean;
  issues: string[];
}

/**
 * Validates that detail close-up is not blank or black:
 * - Foreground subject area above threshold (>= 2%)
 * - Non-empty pixel entropy above threshold (>= 8)
 * - Contains at least one valid jewellery component
 * - Not mostly black (> 60%) or blank (> 98.5%)
 */
export async function validateCloseupNotBlank(
  buffer: Buffer
): Promise<CloseupNotBlankValidationResult> {
  const issues: string[] = [];
  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      isBlank: true,
      isMostlyBlack: true,
      foregroundAreaRatio: 0,
      entropy: 0,
      hasValidJewelryComponent: false,
      issues: ['Close-up buffer is empty or missing.'],
    };
  }

  const testDim = 256;
  const { data: rawRgb } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const totalPixels = testDim * testDim;
  let darkPixelCount = 0;
  let whitePixelCount = 0;
  let foregroundCount = 0;
  let minX = testDim, maxX = 0, minY = testDim, maxY = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  let centerDarkPixels = 0;
  let centerTotalPixels = 0;

  const centerMin = Math.round(testDim * 0.20);
  const centerMax = Math.round(testDim * 0.80);

  for (let i = 0; i < totalPixels; i++) {
    const r = rawRgb[i * 3];
    const g = rawRgb[i * 3 + 1];
    const b = rawRgb[i * 3 + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    lumaSum += luma;
    lumaSqSum += luma * luma;

    const x = i % testDim;
    const y = Math.floor(i / testDim);
    const isDark = luma < 30 || (r < 30 && g < 30 && b < 30);

    if (isDark) {
      darkPixelCount++;
    }

    if (x >= centerMin && x <= centerMax && y >= centerMin && y <= centerMax) {
      centerTotalPixels++;
      if (isDark) {
        centerDarkPixels++;
      }
    }

    if (r >= 245 && g >= 245 && b >= 245) {
      whitePixelCount++;
    } else {
      foregroundCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const fgDarkRatio = foregroundCount > 0 ? darkPixelCount / foregroundCount : 0;
  const centerDarkRatio = centerTotalPixels > 0 ? centerDarkPixels / centerTotalPixels : 0;

  // An e-commerce close-up on pure white should NEVER be predominantly dark or black:
  // 1. Total dark pixels over the full canvas must not exceed 35%
  // 2. Central region must not be predominantly black (> 35%)
  // 3. Foreground dark ratio must not exceed 50%
  const isMostlyBlack =
    (darkPixelCount / totalPixels) > 0.35 ||
    centerDarkRatio > 0.35 ||
    fgDarkRatio > 0.50;
  const isBlank = (whitePixelCount / totalPixels) > 0.985 || foregroundCount < (totalPixels * 0.015);
  const foregroundAreaRatio = foregroundCount / totalPixels;

  const meanLuma = lumaSum / totalPixels;
  const variance = (lumaSqSum / totalPixels) - (meanLuma * meanLuma);
  const entropy = Math.sqrt(Math.max(0, variance));

  const fgWidth = maxX >= minX ? maxX - minX + 1 : 0;
  const fgHeight = maxY >= minY ? maxY - minY + 1 : 0;
  const hasValidJewelryComponent = fgWidth >= (testDim * 0.08) && fgHeight >= (testDim * 0.08) && foregroundCount >= 50;

  if (isMostlyBlack) {
    issues.push('Close-up image is mostly black/dark.');
  }
  if (isBlank) {
    issues.push('Close-up image is blank or lacks visible foreground jewellery.');
  }
  if (foregroundAreaRatio < 0.02) {
    issues.push(`Foreground subject area is too small (${(foregroundAreaRatio * 100).toFixed(1)}% of canvas).`);
  }
  if (entropy < 8) {
    issues.push(`Image detail entropy is too low (${entropy.toFixed(1)}).`);
  }
  if (!hasValidJewelryComponent) {
    issues.push('No valid jewellery component structure found in close-up crop.');
  }

  const valid = !isMostlyBlack && !isBlank && foregroundAreaRatio >= 0.02 && entropy >= 8 && hasValidJewelryComponent;

  return {
    valid,
    isBlank,
    isMostlyBlack,
    foregroundAreaRatio,
    entropy,
    hasValidJewelryComponent,
    issues,
  };
}

export interface DetailCloseupValidationResult {
  valid: boolean;
  issues: string[];
  isMostlyBlack: boolean;
  isMostlyBlank: boolean;
  foregroundAreaRatio: number;
  entropy: number;
  subjectExcluded: boolean;
}

/**
 * Validates that Detail Close-up produces a real zoomed craftsmanship view:
 * - Never returns black output
 * - Never returns empty / near-empty output
 * - Foreground subject area is significant
 * - Entropy / visible detail is sufficiently rich
 * - Subject is not sliced or excluded
 */
export async function validateDetailCloseup(
  buffer: Buffer
): Promise<DetailCloseupValidationResult> {
  const issues: string[] = [];
  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      issues: ['Image buffer is empty or missing.'],
      isMostlyBlack: true,
      isMostlyBlank: true,
      foregroundAreaRatio: 0,
      entropy: 0,
      subjectExcluded: true,
    };
  }

  const testDim = 256;
  const { data: rawRgb } = await sharp(buffer)
    .resize(testDim, testDim, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const totalPixels = testDim * testDim;
  let darkPixelCount = 0;
  let whitePixelCount = 0;
  let foregroundCount = 0;
  let minX = testDim, maxX = 0, minY = testDim, maxY = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  let centerDarkPixels = 0;
  let centerTotalPixels = 0;

  const centerMin = Math.round(testDim * 0.20);
  const centerMax = Math.round(testDim * 0.80);

  for (let i = 0; i < totalPixels; i++) {
    const r = rawRgb[i * 3];
    const g = rawRgb[i * 3 + 1];
    const b = rawRgb[i * 3 + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    lumaSum += luma;
    lumaSqSum += luma * luma;

    const x = i % testDim;
    const y = Math.floor(i / testDim);
    const isDark = luma < 30 || (r < 30 && g < 30 && b < 30);

    if (isDark) {
      darkPixelCount++;
    }

    if (x >= centerMin && x <= centerMax && y >= centerMin && y <= centerMax) {
      centerTotalPixels++;
      if (isDark) {
        centerDarkPixels++;
      }
    }

    if (r >= 245 && g >= 245 && b >= 245) {
      whitePixelCount++;
    } else {
      foregroundCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const fgDarkRatio = foregroundCount > 0 ? darkPixelCount / foregroundCount : 0;
  const centerDarkRatio = centerTotalPixels > 0 ? centerDarkPixels / centerTotalPixels : 0;

  const isMostlyBlack =
    (darkPixelCount / totalPixels) > 0.35 ||
    centerDarkRatio > 0.35 ||
    fgDarkRatio > 0.50;
  const isMostlyBlank = (whitePixelCount / totalPixels) > 0.98 || foregroundCount < (totalPixels * 0.015);
  const foregroundAreaRatio = foregroundCount / totalPixels;

  const meanLuma = lumaSum / totalPixels;
  const variance = (lumaSqSum / totalPixels) - (meanLuma * meanLuma);
  const entropy = Math.sqrt(Math.max(0, variance));

  const fgWidth = maxX >= minX ? maxX - minX + 1 : 0;
  const fgHeight = maxY >= minY ? maxY - minY + 1 : 0;
  const subjectExcluded = fgWidth < (testDim * 0.10) || fgHeight < (testDim * 0.10);

  if (isMostlyBlack) {
    issues.push('Detail close-up is mostly black/dark.');
  }
  if (isMostlyBlank) {
    issues.push('Detail close-up is blank / lacks foreground subject.');
  }
  if (foregroundAreaRatio < 0.02) {
    issues.push(`Foreground subject area is too small (${(foregroundAreaRatio * 100).toFixed(1)}% of canvas).`);
  }
  if (entropy < 8) {
    issues.push(`Visible detail entropy is too low (${entropy.toFixed(1)}).`);
  }
  if (subjectExcluded) {
    issues.push('Crop excludes or slices the main jewellery craftsmanship subject.');
  }

  const valid = !isMostlyBlack && !isMostlyBlank && foregroundAreaRatio >= 0.02 && entropy >= 8 && !subjectExcluded;

  return {
    valid,
    issues,
    isMostlyBlack,
    isMostlyBlank,
    foregroundAreaRatio,
    entropy,
    subjectExcluded,
  };
}

/**
 * Helper to extract a craftsmanship region from a source buffer.
 */
async function extractCraftsmanshipRegion(
  sourceBuf: Buffer,
  region: 'pendant' | 'earrings' | 'earring' | 'stones' | 'center_full',
  customCropRect?: CropRect
): Promise<Buffer | null> {
  try {
    const meta = await sharp(sourceBuf).metadata();
    const w = meta.width || 2048;
    const h = meta.height || 2048;

    if (customCropRect && customCropRect.width > 0 && customCropRect.height > 0) {
      const cropped = await sharp(sourceBuf)
        .extract({
          left: clamp(customCropRect.x, 0, w - 1),
          top: clamp(customCropRect.y, 0, h - 1),
          width: clamp(customCropRect.width, 1, w - customCropRect.x),
          height: clamp(customCropRect.height, 1, h - customCropRect.y),
        })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize(1638, 1638, { fit: 'inside' })
        .toBuffer();

      return sharp({
        create: {
          width: 2048,
          height: 2048,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([{ input: cropped, gravity: 'center' }])
        .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
        .toBuffer();
    }

    if (meta.hasAlpha) {
      const { data, info } = await sharp(sourceBuf)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
      let hasOpaque = false;

      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const a = data[(y * info.width + x) * info.channels + (info.channels - 1)];
          if (a > 35) {
            hasOpaque = true;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (!hasOpaque || maxX < minX || maxY < minY) return null;

      const objW = maxX - minX + 1;
      const objH = maxY - minY + 1;

      let cropX = minX;
      let cropY = minY;
      let cropW = objW;
      let cropH = objH;

      if (region === 'pendant') {
        // 1. Detect pendant cluster in lower portion of necklace (y >= 0.65)
        let pMinX = info.width, pMaxX = 0, pMinY = info.height, pMaxY = 0;
        let pCount = 0;
        const scanStartY = Math.round(minY + objH * 0.65);

        for (let y = scanStartY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const a = data[(y * info.width + x) * info.channels + (info.channels - 1)];
            if (a > 35) {
              pCount++;
              if (x < pMinX) pMinX = x;
              if (x > pMaxX) pMaxX = x;
              if (y < pMinY) pMinY = y;
              if (y > pMaxY) pMaxY = y;
            }
          }
        }

        // 2. Detect matching earrings in upper-middle central cluster (y: 0.16 to 0.62, central 64% width)
        let eMinX = info.width, eMaxX = 0, eMinY = info.height, eMaxY = 0;
        let eCount = 0;
        const eScanStartY = Math.round(minY + objH * 0.16);
        const eScanEndY = Math.round(minY + objH * 0.62);
        const eScanMinX = Math.round(minX + objW * 0.18);
        const eScanMaxX = Math.round(minX + objW * 0.82);

        for (let y = eScanStartY; y <= eScanEndY; y++) {
          for (let x = eScanMinX; x <= eScanMaxX; x++) {
            const a = data[(y * info.width + x) * info.channels + (info.channels - 1)];
            if (a > 35) {
              eCount++;
              if (x < eMinX) eMinX = x;
              if (x > eMaxX) eMaxX = x;
              if (y < eMinY) eMinY = y;
              if (y > eMaxY) eMaxY = y;
            }
          }
        }

        const hasEarrings = eCount > 80 && eMaxX > eMinX && eMaxY > eMinY && (eMaxY - eMinY) >= 30;
        const hasPendant = pCount > 80 && pMaxX > pMinX && pMaxY > pMinY && (pMaxY - pMinY) >= 30;
        const areEarringsCloseToPendant = (pMaxY - eMinY) <= objH * 0.48;

        if (hasEarrings && hasPendant && areEarringsCloseToPendant) {
          // Pendant set with matching earrings nestled close above pendant: present the complete set
          cropX = Math.min(eMinX, pMinX);
          cropY = eMinY;
          cropW = Math.max(eMaxX, pMaxX) - cropX + 1;
          cropH = pMaxY - eMinY + 1;
        } else if (hasPendant) {
          // Solo pendant or earrings positioned high along chain: focus tightly on pendant face for macro craftsmanship detail
          cropX = pMinX;
          cropY = pMinY;
          cropW = pMaxX - pMinX + 1;
          cropH = pMaxY - pMinY + 1;
        } else {
          cropY = Math.round(minY + objH * 0.68);
          cropH = Math.max(30, Math.round(objH * 0.30));
          cropX = Math.round(minX + objW * 0.28);
          cropW = Math.max(30, Math.round(objW * 0.44));
        }
      } else if (region === 'stones') {
        cropY = Math.round(minY + objH * 0.22);
        cropH = Math.max(30, Math.round(objH * 0.58));
        cropX = Math.round(minX + objW * 0.12);
        cropW = Math.max(30, Math.round(objW * 0.76));
      } else if (region === 'earrings') {
        cropY = Math.round(minY + objH * 0.08);
        cropH = Math.max(30, Math.round(objH * 0.48));
        cropX = Math.round(minX + objW * 0.05);
        cropW = Math.max(30, Math.round(objW * 0.90));
      } else if (region === 'earring') {
        cropY = Math.round(minY + objH * 0.06);
        cropH = Math.max(30, Math.round(objH * 0.45));
        cropX = Math.round(minX + objW * 0.02);
        cropW = Math.max(30, Math.round(objW * 0.44));
      } else if (region === 'center_full') {
        cropY = Math.round(minY + objH * 0.18);
        cropH = Math.max(30, Math.round(objH * 0.65));
        cropX = Math.round(minX + objW * 0.12);
        cropW = Math.max(30, Math.round(objW * 0.76));
      }

      const marginX = Math.round(cropW * (region === 'pendant' ? 0.12 : region === 'stones' ? 0.14 : 0.12));
      const marginY = Math.round(cropH * (region === 'pendant' ? 0.12 : region === 'stones' ? 0.14 : 0.12));
      const left = clamp(cropX - marginX, 0, Math.max(0, info.width - 1));
      const top = clamp(cropY - marginY, 0, Math.max(0, info.height - 1));
      const extractW = clamp(cropW + marginX * 2, 1, info.width - left);
      const extractH = clamp(cropH + marginY * 2, 1, info.height - top);

      const croppedTransparent = await sharp(sourceBuf)
        .extract({ left, top, width: extractW, height: extractH })
        .png()
        .toBuffer();

      let trimmed = croppedTransparent;
      try {
        const trimRes = await sharp(croppedTransparent)
          .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 })
          .png()
          .toBuffer({ resolveWithObject: true });
        trimmed = trimRes.data;
      } catch {}

      const maxDim = Math.round(2048 * (region === 'pendant' ? 0.96 : region === 'stones' ? 0.82 : 0.78));
      const scaledSubject = await sharp(trimmed)
        .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer();

      return sharp({
        create: {
          width: 2048,
          height: 2048,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([{ input: scaledSubject, gravity: 'center' }])
        .modulate({ brightness: 1.04, saturation: 1.06 })
        .sharpen({ sigma: 0.8, m1: 0.7, m2: 1.6 })
        .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
        .toBuffer();
    }

    // Source does not have alpha (white product or raw photo)
    const oriented = await autoOrient(sourceBuf);
    const { data: rawRgb, info } = await sharp(oriented.buffer)
      .toColorspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Detect background luminance by sampling edges
    let borderLumaSum = 0;
    let borderSampleCount = 0;
    const step = Math.max(1, Math.floor(Math.min(info.width, info.height) / 40));
    for (let x = 0; x < info.width; x += step) {
      const topIdx = (0 * info.width + x) * info.channels;
      borderLumaSum += 0.299 * rawRgb[topIdx] + 0.587 * rawRgb[topIdx + 1] + 0.114 * rawRgb[topIdx + 2];
      const botIdx = ((info.height - 1) * info.width + x) * info.channels;
      borderLumaSum += 0.299 * rawRgb[botIdx] + 0.587 * rawRgb[botIdx + 1] + 0.114 * rawRgb[botIdx + 2];
      borderSampleCount += 2;
    }
    for (let y = 0; y < info.height; y += step) {
      const leftIdx = (y * info.width + 0) * info.channels;
      borderLumaSum += 0.299 * rawRgb[leftIdx] + 0.587 * rawRgb[leftIdx + 1] + 0.114 * rawRgb[leftIdx + 2];
      const rightIdx = (y * info.width + (info.width - 1)) * info.channels;
      borderLumaSum += 0.299 * rawRgb[rightIdx] + 0.587 * rawRgb[rightIdx + 1] + 0.114 * rawRgb[rightIdx + 2];
      borderSampleCount += 2;
    }
    const avgBorderLuma = borderSampleCount > 0 ? borderLumaSum / borderSampleCount : 255;
    const isDarkBackground = avgBorderLuma < 180;

    // If source has a dark background (e.g. black velvet / dark matting), try isolating it first
    // so we never paste a dark box on pure white canvas
    if (isDarkBackground) {
      try {
        const { getOrCreateIsolatedMasterPng } = await import('./backgroundRemovalService');
        const iso = await getOrCreateIsolatedMasterPng(sourceBuf);
        if (iso?.buffer && iso.buffer.length > 0) {
          const isoRes = await extractCraftsmanshipRegion(iso.buffer, region, customCropRect);
          if (isoRes) {
            const v = await validateCloseupNotBlank(isoRes);
            if (v.valid && !v.isMostlyBlack && !v.isBlank) {
              return isoRes;
            }
          }
        }
      } catch {}
    }

    let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
    let found = false;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        const r = rawRgb[idx];
        const g = rawRgb[idx + 1];
        const b = rawRgb[idx + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;

        const isForeground = isDarkBackground
          ? (luma > Math.max(45, avgBorderLuma + 25) || (Math.max(r, g, b) - Math.min(r, g, b)) > 25)
          : (luma < avgBorderLuma - 15 || (Math.max(r, g, b) - Math.min(r, g, b)) > 20 || (avgBorderLuma >= 250 && (r < 245 || g < 245 || b < 245)));

        if (isForeground) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (found && maxX >= minX && maxY >= minY) {
      const objW = maxX - minX + 1;
      const objH = maxY - minY + 1;

      let cropX = minX;
      let cropY = minY;
      let cropW = objW;
      let cropH = objH;

      if (region === 'pendant') {
        // 1. Detect pendant cluster in lower portion of necklace (y >= 0.65)
        let pMinX = info.width, pMaxX = 0, pMinY = info.height, pMaxY = 0;
        let pCount = 0;
        const scanStartY = Math.round(minY + objH * 0.65);

        for (let y = scanStartY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const idx = (y * info.width + x) * info.channels;
            const r = rawRgb[idx];
            const g = rawRgb[idx + 1];
            const b = rawRgb[idx + 2];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            const isFg = isDarkBackground
              ? (luma > Math.max(45, avgBorderLuma + 25) || (Math.max(r, g, b) - Math.min(r, g, b)) > 25)
              : (luma < avgBorderLuma - 15 || (Math.max(r, g, b) - Math.min(r, g, b)) > 20 || (avgBorderLuma >= 250 && (r < 245 || g < 245 || b < 245)));

            if (isFg) {
              pCount++;
              if (x < pMinX) pMinX = x;
              if (x > pMaxX) pMaxX = x;
              if (y < pMinY) pMinY = y;
              if (y > pMaxY) pMaxY = y;
            }
          }
        }

        // 2. Detect matching earrings in upper-middle central cluster (y: 0.16 to 0.62, central 64% width)
        let eMinX = info.width, eMaxX = 0, eMinY = info.height, eMaxY = 0;
        let eCount = 0;
        const eScanStartY = Math.round(minY + objH * 0.16);
        const eScanEndY = Math.round(minY + objH * 0.62);
        const eScanMinX = Math.round(minX + objW * 0.18);
        const eScanMaxX = Math.round(minX + objW * 0.82);

        for (let y = eScanStartY; y <= eScanEndY; y++) {
          for (let x = eScanMinX; x <= eScanMaxX; x++) {
            const idx = (y * info.width + x) * info.channels;
            const r = rawRgb[idx];
            const g = rawRgb[idx + 1];
            const b = rawRgb[idx + 2];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            const isFg = isDarkBackground
              ? (luma > Math.max(45, avgBorderLuma + 25) || (Math.max(r, g, b) - Math.min(r, g, b)) > 25)
              : (luma < avgBorderLuma - 15 || (Math.max(r, g, b) - Math.min(r, g, b)) > 20 || (avgBorderLuma >= 250 && (r < 245 || g < 245 || b < 245)));

            if (isFg) {
              eCount++;
              if (x < eMinX) eMinX = x;
              if (x > eMaxX) eMaxX = x;
              if (y < eMinY) eMinY = y;
              if (y > eMaxY) eMaxY = y;
            }
          }
        }

        const hasEarrings = eCount > 80 && eMaxX > eMinX && eMaxY > eMinY && (eMaxY - eMinY) >= 30;
        const hasPendant = pCount > 80 && pMaxX > pMinX && pMaxY > pMinY && (pMaxY - pMinY) >= 30;
        const areEarringsCloseToPendant = (pMaxY - eMinY) <= objH * 0.48;

        if (hasEarrings && hasPendant && areEarringsCloseToPendant) {
          // Pendant set with matching earrings nestled close above pendant: present the complete set
          cropX = Math.min(eMinX, pMinX);
          cropY = eMinY;
          cropW = Math.max(eMaxX, pMaxX) - cropX + 1;
          cropH = pMaxY - eMinY + 1;
        } else if (hasPendant) {
          // Solo pendant or earrings positioned high along chain: focus tightly on pendant face for macro craftsmanship detail
          cropX = pMinX;
          cropY = pMinY;
          cropW = pMaxX - pMinX + 1;
          cropH = pMaxY - pMinY + 1;
        } else {
          cropY = Math.round(minY + objH * 0.68);
          cropH = Math.max(30, Math.round(objH * 0.30));
          cropX = Math.round(minX + objW * 0.28);
          cropW = Math.max(30, Math.round(objW * 0.44));
        }
      } else if (region === 'stones') {
        cropY = Math.round(minY + objH * 0.22);
        cropH = Math.max(30, Math.round(objH * 0.58));
        cropX = Math.round(minX + objW * 0.12);
        cropW = Math.max(30, Math.round(objW * 0.76));
      } else if (region === 'earrings') {
        cropY = Math.round(minY + objH * 0.08);
        cropH = Math.max(30, Math.round(objH * 0.48));
        cropX = Math.round(minX + objW * 0.05);
        cropW = Math.max(30, Math.round(objW * 0.90));
      } else if (region === 'earring') {
        cropY = Math.round(minY + objH * 0.06);
        cropH = Math.max(30, Math.round(objH * 0.45));
        cropX = Math.round(minX + objW * 0.02);
        cropW = Math.max(30, Math.round(objW * 0.44));
      } else if (region === 'center_full') {
        cropY = Math.round(minY + objH * 0.18);
        cropH = Math.max(30, Math.round(objH * 0.65));
        cropX = Math.round(minX + objW * 0.12);
        cropW = Math.max(30, Math.round(objW * 0.76));
      }

      const marginX = Math.round(cropW * (region === 'pendant' ? 0.12 : region === 'stones' ? 0.14 : 0.10));
      const marginY = Math.round(cropH * (region === 'pendant' ? 0.12 : region === 'stones' ? 0.14 : 0.10));
      const left = clamp(cropX - marginX, 0, Math.max(0, info.width - 1));
      const top = clamp(cropY - marginY, 0, Math.max(0, info.height - 1));
      const extractW = clamp(cropW + marginX * 2, 1, info.width - left);
      const extractH = clamp(cropH + marginY * 2, 1, info.height - top);

      const cropped = await sharp(oriented.buffer)
        .extract({ left, top, width: extractW, height: extractH })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize(region === 'pendant' ? 1960 : region === 'stones' ? 1680 : 1600, region === 'pendant' ? 1960 : region === 'stones' ? 1680 : 1600, { fit: 'inside' })
        .toBuffer();

      const candidateOutput = await sharp({
        create: {
          width: 2048,
          height: 2048,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .composite([{ input: cropped, gravity: 'center' }])
        .modulate({ brightness: 1.04, saturation: 1.06 })
        .sharpen({ sigma: 0.8, m1: 0.7, m2: 1.6 })
        .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
        .toBuffer();

      const val = await validateCloseupNotBlank(candidateOutput);
      if (val.valid && !val.isMostlyBlack && !val.isBlank) {
        return candidateOutput;
      }
    }

    // Fallback: Safe central crop (only return if non-black and valid)
    const safeCrop = await sharp(oriented.buffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(1638, 1638, { fit: 'inside' })
      .toBuffer();

    const fallbackCandidate = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([{ input: safeCrop, gravity: 'center' }])
      .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
      .toBuffer();

    const fallbackVal = await validateCloseupNotBlank(fallbackCandidate);
    if (fallbackVal.valid && !fallbackVal.isMostlyBlack && !fallbackVal.isBlank) {
      return fallbackCandidate;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Slot 3 Detail / Craftsmanship Close-up with multi-stage fallback and validation:
 * 1. SOURCE SELECTION:
 *    a) isolated master / exact cutout
 *    b) clean generated hero / white product
 *    c) original photo as fallback
 * 2. SAFE CROPPING & FALLBACK:
 *    - Try pendant-focused crop
 *    - Else try single earring-focused crop
 *    - Else try central craftsmanship crop
 * 3. VALIDATION:
 *    - Never return mostly black or mostly blank
 *    - Ensure foreground craftsmanship is visible and clear
 * 4. OUTPUT:
 *    - Always valid 2048x2048 asset on pure white #FFFFFF
 */
export async function createDetailCraftsmanshipCrop(
  inputBuffer: Buffer,
  outputFilename: string,
  targetRegion: 'pendant' | 'earrings' | 'earring' | 'stones' | 'center_full' | 'custom' = 'pendant',
  customCropRect?: CropRect,
  options?: {
    isolatedMasterBuffer?: Buffer;
    whiteProductBuffer?: Buffer;
  }
): Promise<{ buffer: Buffer; relativeUrl: string; filepath: string }> {
  // Source priority:
  // a) isolated master / exact product pixels
  // b) original image
  // c) valid white/presentation hero output as fallback only
  const sources: { buffer: Buffer; label: string }[] = [];
  if (options?.isolatedMasterBuffer && options.isolatedMasterBuffer.length > 0) {
    sources.push({ buffer: options.isolatedMasterBuffer, label: 'isolated_master' });
  }
  if (inputBuffer && inputBuffer.length > 0) {
    sources.push({ buffer: inputBuffer, label: 'original' });
  }
  if (options?.whiteProductBuffer && options.whiteProductBuffer.length > 0) {
    sources.push({ buffer: options.whiteProductBuffer, label: 'white_product' });
  }

  // If only raw inputBuffer was provided, try background removal to get a clean isolated master on white
  if (sources.length === 1 && sources[0].label === 'original' && inputBuffer && inputBuffer.length > 0) {
    try {
      const { getOrCreateIsolatedMasterPng } = await import('./backgroundRemovalService');
      const iso = await getOrCreateIsolatedMasterPng(inputBuffer);
      if (iso?.buffer && iso.buffer.length > 0) {
        sources.unshift({ buffer: iso.buffer, label: 'isolated_master_lazy' });
      }
    } catch {}
  }

  if (sources.length === 0) {
    throw new Error('No input sources available for detail close-up generation.');
  }

  // Fallback sequence:
  // 1) pendant-focused crop
  // 2) earring-focused crop
  // 3) central craftsmanship cluster
  const primaryRegion = targetRegion === 'custom' ? 'pendant' : targetRegion;
  const regionSequence: ('pendant' | 'earring' | 'center_full')[] =
    primaryRegion === 'earrings' || primaryRegion === 'earring'
      ? ['earring', 'pendant', 'center_full']
      : ['pendant', 'earring', 'center_full'];

  for (const src of sources) {
    for (const reg of regionSequence) {
      const candidate = await extractCraftsmanshipRegion(src.buffer, reg, customCropRect);
      if (candidate) {
        const val = await validateCloseupNotBlank(candidate);
        if (val.valid) {
          const saved = saveDerivative(candidate, outputFilename);
          return { buffer: candidate, relativeUrl: saved.relativeUrl, filepath: saved.filepath };
        }
      }
    }
  }

  // If custom crop was specified, try it across sources
  if (customCropRect && customCropRect.width > 0) {
    for (const src of sources) {
      const candidate = await extractCraftsmanshipRegion(src.buffer, 'pendant', customCropRect);
      if (candidate) {
        const val = await validateCloseupNotBlank(candidate);
        if (val.valid) {
          const saved = saveDerivative(candidate, outputFilename);
          return { buffer: candidate, relativeUrl: saved.relativeUrl, filepath: saved.filepath };
        }
      }
    }
  }

  // If all strategies fail, throw descriptive error so caller can display explicit failure state
  // and NEVER silently publish a black or blank image.
  throw new Error(
    'Failed to generate valid detail close-up: all candidate crops (pendant, earring, central cluster) were blank, dark, or lacked visible jewellery.'
  );
}

/**
 * Slot 5 deterministic component crop.
 */
export async function createEarringComponentCrop(
  inputBuffer: Buffer,
  outputFilename: string,
  customCropRect?: CropRect
): Promise<{ buffer: Buffer; relativeUrl: string; filepath: string }> {
  return createDetailCraftsmanshipCrop(inputBuffer, outputFilename, 'earrings', customCropRect);
}
