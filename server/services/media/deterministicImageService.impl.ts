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
    // A ruler is characterized by periodic tick transitions along either margin.
    if (leftTransitions >= 6 || bottomTransitions >= 6) {
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

export interface AiHeroValidationResult {
  valid: boolean;
  issues: string[];
  hasVisibleSubject: boolean;
  isNotBlank: boolean;
  noSevereClipping: boolean;
  hasWhiteBackground: boolean;
  forbiddenObjects: string[];
  matchScoreAcceptable: boolean;
}

/**
 * Dedicated validator for AI Presentation Hero outputs.
 * Unlike raw background-removal masks, AI hero outputs are final composite images
 * and must NOT be rejected by full-frame alpha bounds checks.
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

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * channels;
      const r = rawRgb[idx];
      const g = rawRgb[idx + 1];
      const b = rawRgb[idx + 2];

      const isNonWhite = r < 248 || g < 248 || b < 248;
      if (isNonWhite) {
        foregroundCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      // Sample 2-pixel outer border
      if (x < 2 || x >= info.width - 2 || y < 2 || y >= info.height - 2) {
        totalBorderPixels++;
        if (r < 235 || g < 235 || b < 235) {
          nonWhiteBorderPixels++;
        }
      }
    }
  }

  // 1. jewellery subject visible
  const hasVisibleSubject = foregroundCount >= 200;
  if (!hasVisibleSubject) {
    issues.push('No jewellery subject visible in AI hero presentation.');
  }

  // 2. output not blank
  const isNotBlank = foregroundCount > 0 && foregroundCount < (info.width * info.height * 0.98);
  if (!isNotBlank) {
    issues.push('Generated hero image is blank or completely filled.');
  }

  // 3. no severe clipping
  const borderClippingRatio = totalBorderPixels > 0 ? nonWhiteBorderPixels / totalBorderPixels : 0;
  const noSevereClipping = borderClippingRatio < 0.20;
  if (!noSevereClipping) {
    issues.push('Jewellery appears severely clipped at image borders.');
  }

  // 4. white background
  const hasWhiteBackground = borderClippingRatio <= 0.10;
  if (!hasWhiteBackground) {
    issues.push('Background is not clean pure white #FFFFFF.');
  }

  // 5. no forbidden props
  const propCheck = await validateGalleryAsset(buffer, 'HERO_COVER');
  const forbiddenObjects = propCheck.forbiddenObjects || [];
  if (forbiddenObjects.length > 0) {
    issues.push(`Forbidden object(s) detected: ${forbiddenObjects.join(', ')}`);
  }

  // 6. product-match score acceptable
  const matchScoreAcceptable = options.matchScore === undefined || options.matchScore >= 80;
  if (!matchScoreAcceptable) {
    issues.push(`Product match score (${options.matchScore}%) is below the acceptable threshold (>= 80%).`);
  }

  const valid =
    hasVisibleSubject &&
    isNotBlank &&
    noSevereClipping &&
    hasWhiteBackground &&
    forbiddenObjects.length === 0 &&
    matchScoreAcceptable;

  return {
    valid,
    issues,
    hasVisibleSubject,
    isNotBlank,
    noSevereClipping,
    hasWhiteBackground,
    forbiddenObjects,
    matchScoreAcceptable,
  };
}

/**
 * Slot 3 deterministic detail crop.
 * Prioritizes isolatedMaster transparent PNG to guarantee ZERO rulers and pure #FFFFFF background.
 */
export async function createDetailCraftsmanshipCrop(
  inputBuffer: Buffer,
  outputFilename: string,
  targetRegion: 'pendant' | 'earrings' | 'stones' | 'custom' = 'pendant',
  customCropRect?: CropRect,
  options?: {
    isolatedMasterBuffer?: Buffer;
    whiteProductBuffer?: Buffer;
  }
): Promise<{ buffer: Buffer; relativeUrl: string; filepath: string }> {
  // Priority 1: If isolated master buffer is supplied or inputBuffer has alpha
  const candidateBuf = options?.isolatedMasterBuffer || inputBuffer;
  const meta = await sharp(candidateBuf).metadata();

  if (meta.hasAlpha) {
    const { data, info } = await sharp(candidateBuf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    let hasOpaque = false;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = data[(y * w + x) * info.channels + (info.channels - 1)];
        if (a > 35) {
          hasOpaque = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (hasOpaque && maxX >= minX && maxY >= minY) {
      const objW = maxX - minX + 1;
      const objH = maxY - minY + 1;

      let cropX = minX;
      let cropY = minY;
      let cropW = objW;
      let cropH = objH;

      if (targetRegion === 'pendant' || targetRegion === 'stones') {
        cropY = Math.round(minY + objH * (targetRegion === 'pendant' ? 0.46 : 0.35));
        cropH = Math.max(30, Math.round(objH * (targetRegion === 'pendant' ? 0.54 : 0.65)));
        cropX = Math.round(minX + objW * 0.12);
        cropW = Math.max(30, Math.round(objW * 0.76));
      } else if (targetRegion === 'earrings') {
        cropY = Math.round(minY + objH * 0.10);
        cropH = Math.max(30, Math.round(objH * 0.50));
        cropX = Math.round(minX + objW * 0.05);
        cropW = Math.max(30, Math.round(objW * 0.90));
      }

      // Add breathing margin around craftsmanship region
      const marginX = Math.round(cropW * 0.10);
      const marginY = Math.round(cropH * 0.10);
      const left = clamp(cropX - marginX, 0, Math.max(0, w - 1));
      const top = clamp(cropY - marginY, 0, Math.max(0, h - 1));
      const extractW = clamp(cropW + marginX * 2, 1, w - left);
      const extractH = clamp(cropH + marginY * 2, 1, h - top);

      const croppedTransparent = await sharp(candidateBuf)
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

      const finalWhiteDetail = await sharp({
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

      const saved = saveDerivative(finalWhiteDetail, outputFilename);
      return { buffer: finalWhiteDetail, relativeUrl: saved.relativeUrl, filepath: saved.filepath };
    }
  }

  // Priority 2: If white product buffer is supplied, crop from the clean white product
  if (options?.whiteProductBuffer) {
    const wpBuf = options.whiteProductBuffer;
    const orientedWp = await autoOrient(wpBuf);
    const { data: rawRgb, info } = await sharp(orientedWp.buffer)
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

      if (targetRegion === 'pendant' || targetRegion === 'stones') {
        cropY = Math.round(minY + objH * (targetRegion === 'pendant' ? 0.46 : 0.35));
        cropH = Math.max(30, Math.round(objH * (targetRegion === 'pendant' ? 0.54 : 0.65)));
        cropX = Math.round(minX + objW * 0.12);
        cropW = Math.max(30, Math.round(objW * 0.76));
      } else if (targetRegion === 'earrings') {
        cropY = Math.round(minY + objH * 0.10);
        cropH = Math.max(30, Math.round(objH * 0.50));
        cropX = Math.round(minX + objW * 0.05);
        cropW = Math.max(30, Math.round(objW * 0.90));
      }

      const marginX = Math.round(cropW * 0.08);
      const marginY = Math.round(cropH * 0.08);
      const left = clamp(cropX - marginX, 0, Math.max(0, info.width - 1));
      const top = clamp(cropY - marginY, 0, Math.max(0, info.height - 1));
      const extractW = clamp(cropW + marginX * 2, 1, info.width - left);
      const extractH = clamp(cropH + marginY * 2, 1, info.height - top);

      const cropped = await sharp(orientedWp.buffer)
        .extract({ left, top, width: extractW, height: extractH })
        .resize(1638, 1638, { fit: 'inside' })
        .toBuffer();

      const finalCanvas = await sharp({
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

      const saved = saveDerivative(finalCanvas, outputFilename);
      return { buffer: finalCanvas, relativeUrl: saved.relativeUrl, filepath: saved.filepath };
    }
  }

  if (customCropRect && customCropRect.width > 0 && customCropRect.height > 0) {
    const res = await applyNonDestructiveCrop(inputBuffer, customCropRect, 2048);
    const flattened = await sharp(res.buffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const saved = saveDerivative(flattened, outputFilename);
    return { buffer: flattened, relativeUrl: saved.relativeUrl, filepath: saved.filepath };
  }

  const oriented = await autoOrient(inputBuffer);
  const w = oriented.width;
  const h = oriented.height;
  const autoBox = await detectJewelryAutoCrop(oriented.buffer, 'necklace_set');

  let cropX = autoBox.x;
  let cropY = autoBox.y;
  let cropW = autoBox.width;
  let cropH = autoBox.height;

  if (targetRegion === 'pendant' || targetRegion === 'stones') {
    const focusTop = targetRegion === 'pendant' ? 0.48 : 0.4;
    cropY = Math.round(autoBox.y + autoBox.height * focusTop);
    cropH = Math.max(1, Math.round(autoBox.height * (1 - focusTop)));
    cropX = Math.round(autoBox.x + autoBox.width * 0.12);
    cropW = Math.max(1, Math.round(autoBox.width * 0.76));
  } else if (targetRegion === 'earrings') {
    cropY = Math.round(autoBox.y + autoBox.height * 0.18);
    cropH = Math.max(1, Math.round(autoBox.height * 0.44));
    cropX = Math.round(autoBox.x + autoBox.width * 0.12);
    cropW = Math.max(1, Math.round(autoBox.width * 0.76));
  }

  cropX = clamp(cropX, 0, Math.max(0, w - 1));
  cropY = clamp(cropY, 0, Math.max(0, h - 1));
  cropW = clamp(cropW, 1, w - cropX);
  cropH = clamp(cropH, 1, h - cropY);

  const cropped = await applyNonDestructiveCrop(
    oriented.buffer,
    { x: cropX, y: cropY, width: cropW, height: cropH, aspectRatio: '1:1' },
    2048
  );

  const finalCanvas = await sharp(cropped.buffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const saved = saveDerivative(finalCanvas, outputFilename);
  return { buffer: finalCanvas, relativeUrl: saved.relativeUrl, filepath: saved.filepath };
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
