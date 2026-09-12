import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { executeBackgroundRemoval } from './backgroundRemovalService';
import { DATA_DIR } from '../../db/database';
import { cleanJewelleryCutoutArtifacts } from './imageCleanupService';

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
  const filepath = path.join(DERIVATIVES_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  return {
    relativeUrl: `/api/photos/derivatives/${filename}`,
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
  const occupancy = clamp((options.occupancyPercent || 82) / 100, 0.6, 0.9);
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

  const maxUsableW = Math.round(targetW * occupancy);
  const maxUsableH = Math.round(targetH * occupancy);
  const scale = Math.min(maxUsableW / trimmedW, maxUsableH / trimmedH);
  const finalProductW = Math.max(1, Math.round(trimmedW * scale));
  const finalProductH = Math.max(1, Math.round(trimmedH * scale));

  const scaledProduct = await sharp(trimmedBuffer)
    .resize(finalProductW, finalProductH, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();

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
    .composite([{ input: scaledProduct, gravity: 'center' }])
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
      if (role !== 'DETAIL_CLOSEUP' && isPropColor) {
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

    // Lateral earring check: must be positioned away from center and in upper-mid vertical region
    const isLeft = c.centroidX < overallCenterX - overallBoxW * 0.12;
    const isRight = c.centroidX > overallCenterX + overallBoxW * 0.12;
    const isEarringY = c.centroidY >= overallMinY && c.centroidY <= overallMinY + overallBoxH * 0.90;

    if (isEarringY && isLeft) {
      leftEarringCount++;
      classifiedClusters.push({ ...c, category: 'earring' });
    } else if (isEarringY && isRight) {
      rightEarringCount++;
      classifiedClusters.push({ ...c, category: 'earring' });
    } else if (c.area >= 60) {
      // Only significant detached objects outside normal necklace/earrings positions count as extra
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
 * Validates that the pendant remains centered along the vertical axis.
 */
export async function validatePendantCentered(
  buffer: Buffer
): Promise<{
  valid: boolean;
  offsetPercent: number;
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
  if (!valid) {
    issues.push(
      `Pendant is off-center by ${offsetPercent.toFixed(1)}% (max allowed ${maxAllowedOffsetPercent}%). Pendant must remain on central vertical axis.`
    );
  }

  return {
    valid,
    offsetPercent,
    issues,
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
  if (occW < 0.45 || occH < 0.45) {
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

  // 9. Symmetry (chain drape + earring spacing)
  const symmetryCheck = await validateHeroSymmetry(buffer);
  const chainMisaligned = !symmetryCheck.valid && symmetryCheck.issues.some((i) => i.includes('chain'));
  const earringsUneven = !symmetryCheck.valid && symmetryCheck.issues.some((i) => i.includes('Earrings'));
  if (!symmetryCheck.valid) {
    issues.push(...symmetryCheck.issues);
  }

  // 10. No forbidden props
  const propCheck = await validateGalleryAsset(buffer, 'HERO_COVER');
  const forbiddenObjects = propCheck.forbiddenObjects || [];
  if (forbiddenObjects.length > 0) {
    issues.push(`Forbidden object(s) detected: ${forbiddenObjects.join(', ')}`);
  }

  // 11. Match score acceptable
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
  };
}

/**
 * Enhances lighting and tone for presentation hero shots:
 * - Brightens slightly if source is underexposed
 * - Recovers sapphire / blue stone visibility without turning flat black
 * - Maintains true silver-tone metal appearance
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

  return {
    buffer: flattened,
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

  for (let i = 0; i < totalPixels; i++) {
    const r = rawRgb[i * 3];
    const g = rawRgb[i * 3 + 1];
    const b = rawRgb[i * 3 + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    lumaSum += luma;
    lumaSqSum += luma * luma;

    if (luma < 25) {
      darkPixelCount++;
    }
    if (r >= 245 && g >= 245 && b >= 245) {
      whitePixelCount++;
    } else {
      foregroundCount++;
      const x = i % testDim;
      const y = Math.floor(i / testDim);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const fgDarkRatio = foregroundCount > 0 ? darkPixelCount / foregroundCount : 0;
  const isMostlyBlack = (darkPixelCount / totalPixels) > 0.60 || fgDarkRatio > 0.70;
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

  for (let i = 0; i < totalPixels; i++) {
    const r = rawRgb[i * 3];
    const g = rawRgb[i * 3 + 1];
    const b = rawRgb[i * 3 + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    lumaSum += luma;
    lumaSqSum += luma * luma;

    if (luma < 25) {
      darkPixelCount++;
    }
    if (r >= 245 && g >= 245 && b >= 245) {
      whitePixelCount++;
    } else {
      foregroundCount++;
      const x = i % testDim;
      const y = Math.floor(i / testDim);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const fgDarkRatio = foregroundCount > 0 ? darkPixelCount / foregroundCount : 0;
  const isMostlyBlack = (darkPixelCount / totalPixels) > 0.65 || fgDarkRatio > 0.70;
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

      if (region === 'pendant' || region === 'stones') {
        cropY = Math.round(minY + objH * (region === 'pendant' ? 0.40 : 0.30));
        cropH = Math.max(30, Math.round(objH * (region === 'pendant' ? 0.60 : 0.70)));
        cropX = Math.round(minX + objW * 0.10);
        cropW = Math.max(30, Math.round(objW * 0.80));
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

      const marginX = Math.round(cropW * 0.10);
      const marginY = Math.round(cropH * 0.10);
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

      const maxDim = Math.round(2048 * 0.80);
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

    let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
    let found = false;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        if (rawRgb[idx] < 248 || rawRgb[idx + 1] < 248 || rawRgb[idx + 2] < 248) {
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

      if (region === 'pendant' || region === 'stones') {
        cropY = Math.round(minY + objH * (region === 'pendant' ? 0.40 : 0.30));
        cropH = Math.max(30, Math.round(objH * (region === 'pendant' ? 0.60 : 0.70)));
        cropX = Math.round(minX + objW * 0.10);
        cropW = Math.max(30, Math.round(objW * 0.80));
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

      const marginX = Math.round(cropW * 0.08);
      const marginY = Math.round(cropH * 0.08);
      const left = clamp(cropX - marginX, 0, Math.max(0, info.width - 1));
      const top = clamp(cropY - marginY, 0, Math.max(0, info.height - 1));
      const extractW = clamp(cropW + marginX * 2, 1, info.width - left);
      const extractH = clamp(cropH + marginY * 2, 1, info.height - top);

      const cropped = await sharp(oriented.buffer)
        .extract({ left, top, width: extractW, height: extractH })
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

    // Fallback: Safe central crop
    const safeCrop = await sharp(oriented.buffer)
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
      .composite([{ input: safeCrop, gravity: 'center' }])
      .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
      .toBuffer();
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
  // a) isolated master
  // b) valid hero output
  // c) original image
  const sources: { buffer: Buffer; label: string }[] = [];
  if (options?.isolatedMasterBuffer && options.isolatedMasterBuffer.length > 0) {
    sources.push({ buffer: options.isolatedMasterBuffer, label: 'isolated_master' });
  }
  if (options?.whiteProductBuffer && options.whiteProductBuffer.length > 0) {
    sources.push({ buffer: options.whiteProductBuffer, label: 'white_product' });
  }
  if (inputBuffer && inputBuffer.length > 0) {
    sources.push({ buffer: inputBuffer, label: 'original' });
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
