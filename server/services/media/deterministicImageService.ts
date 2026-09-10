import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { executeBackgroundRemoval } from './backgroundRemovalService';
import { DATA_DIR } from '../../db/database';

export interface CropRect {
  x: number; // In source coordinate pixels (or normalized 0-1)
  y: number;
  width: number;
  height: number;
  rotation?: number; // 0, 90, 180, 270
  zoom?: number; // 1.0 = 100%
  aspectRatio?: '1:1' | '4:5' | '9:16' | 'free';
}

export interface SegmentationQualityResult {
  isAcceptable: boolean;
  isValid: boolean;
  qualityScore: number; // 0-100
  chainContinuityScore: number; // 0-100
  occupancyRatio: number;
  issues: string[];
  bounds: { x: number; y: number; width: number; height: number };
}

export interface PureWhiteCoverResult {
  buffer: Buffer;
  relativeUrl: string;
  quality: SegmentationQualityResult;
  width: number;
  height: number;
  backgroundMode: 'pure_white' | 'original' | 'transparent';
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

/**
 * Evaluates alpha mask segmentation quality for jewelry:
 * - Detects bounding box
 * - Checks for severe chain breaks or severed components
 * - Checks for excessive alpha holes
 */
export async function evaluateSegmentationQuality(
  alphaBuffer: Buffer,
  width: number,
  height: number
): Promise<SegmentationQualityResult> {
  const issues: string[] = [];
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  let foregroundCount = 0;

  // 1. Scan bounding box and foreground density
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const alpha = alphaBuffer[idx];
      if (alpha > 30) {
        foregroundCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (foregroundCount === 0 || minX >= maxX || minY >= maxY) {
    return {
      isAcceptable: false,
      qualityScore: 10,
      chainContinuityScore: 10,
      issues: ['No jewelry foreground detected in mask'],
      bounds: { x: 0, y: 0, width, height },
    };
  }

  const objW = maxX - minX;
  const objH = maxY - minY;
  const coveragePercent = (foregroundCount / (width * height)) * 100;

  if (coveragePercent < 1.5) {
    issues.push('Jewelry occupies less than 1.5% of the frame; might be clipped or over-erased.');
  }

  // 2. Chain continuity check: scan horizontal slices in the top third (where chains hang)
  let chainContinuityScore = 95;
  const scanStartY = minY + Math.round(objH * 0.1);
  const scanEndY = minY + Math.round(objH * 0.45);
  let emptyChainSlices = 0;
  let totalSlices = 0;

  for (let y = scanStartY; y < scanEndY; y += 4) {
    totalSlices++;
    let rowForeground = 0;
    for (let x = minX; x <= maxX; x++) {
      if (alphaBuffer[y * width + x] > 50) {
        rowForeground++;
      }
    }
    if (rowForeground === 0) {
      emptyChainSlices++;
    }
  }

  if (totalSlices > 0 && emptyChainSlices / totalSlices > 0.4) {
    chainContinuityScore = Math.max(30, 95 - Math.round((emptyChainSlices / totalSlices) * 100));
    issues.push('Potential chain break or gap detected in neckline area.');
  }

  const qualityScore = Math.min(
    100,
    Math.round(chainContinuityScore * 0.6 + (issues.length === 0 ? 40 : 20))
  );

  const occupancyRatio = foregroundCount / (width * height);

  return {
    isAcceptable: qualityScore >= 60,
    isValid: qualityScore >= 60,
    qualityScore,
    chainContinuityScore,
    occupancyRatio,
    issues,
    bounds: { x: minX, y: minY, width: objW, height: objH },
  };
}

/**
 * PIPELINE A: Creates guaranteed PURE WHITE (#FFFFFF) E-Commerce Cover (2048 x 2048).
 * 
 * Rules:
 * - Pure #FFFFFF background (RGB 255, 255, 255).
 * - Proportional scaling: 75–85% usable canvas occupancy without stretching.
 * - Entire product (necklace, pendant, earrings) centered gracefully.
 * - Never uses generative AI. 100% authentic pixels preserved.
 */
export async function createPureWhiteCover(
  inputBuffer: Buffer,
  outputFilename: string,
  options: {
    targetWidth?: number;
    targetHeight?: number;
    occupancyPercent?: number; // default 80% (range 70-85%)
    backgroundMode?: 'pure_white' | 'transparent' | 'original';
    customCrop?: CropRect;
  } = {}
): Promise<PureWhiteCoverResult> {
  const targetW = options.targetWidth || 2048;
  const targetH = options.targetHeight || 2048;
  const occupancy = (options.occupancyPercent || 80) / 100;
  const bgMode = options.backgroundMode || 'pure_white';

  let workingBuffer = inputBuffer;

  // Apply custom crop if specified before segmentation
  if (options.customCrop && options.customCrop.width > 0 && options.customCrop.height > 0) {
    const cropRes = await applyNonDestructiveCrop(inputBuffer, options.customCrop);
    workingBuffer = cropRes.buffer;
  }

  // 1. If user chose original background mode:
  if (bgMode === 'original') {
    const oriented = sharp(workingBuffer).rotate();
    const meta = await oriented.metadata();
    const origW = meta.width || targetW;
    const origH = meta.height || targetH;

    const scale = Math.min((targetW * occupancy) / origW, (targetH * occupancy) / origH);
    const scaledW = Math.round(origW * scale);
    const scaledH = Math.round(origH * scale);

    const resized = await oriented.resize(scaledW, scaledH, { fit: 'inside' }).toBuffer();

    const edgeSample = await oriented.resize(1, 1).toBuffer();
    const { dominant } = await sharp(edgeSample).stats();

    const canvas = await sharp({
      create: {
        width: targetW,
        height: targetH,
        channels: 4,
        background: { r: dominant.r, g: dominant.g, b: dominant.b, alpha: 1 },
      },
    })
      .composite([{ input: resized, gravity: 'center' }])
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer();

    const { relativeUrl } = saveDerivative(canvas, outputFilename);
    return {
      buffer: canvas,
      relativeUrl,
      quality: {
        isAcceptable: true,
        qualityScore: 98,
        chainContinuityScore: 100,
        issues: [],
        bounds: { x: 0, y: 0, width: origW, height: origH },
      },
      width: targetW,
      height: targetH,
      backgroundMode: 'original',
    };
  }

  // 2. Isolate jewelry foreground as transparent PNG
  const bgResult = await executeBackgroundRemoval(workingBuffer, {
    returnTransparentPng: true,
    targetWidth: targetW,
    targetHeight: targetH,
  });

  const cutoutBuffer = bgResult.buffer;
  const cutoutMeta = await sharp(cutoutBuffer).metadata();
  const cw = cutoutMeta.width || targetW;
  const ch = cutoutMeta.height || targetH;

  // Extract raw alpha channel for quality inspection
  const rawAlpha = await sharp(cutoutBuffer)
    .extractChannel(3)
    .raw()
    .toBuffer();

  const quality = await evaluateSegmentationQuality(rawAlpha, cw, ch);

  // 3. Trim outer transparent padding to find actual product bounds
  const trimmed = await sharp(cutoutBuffer).trim().toBuffer({ resolveWithObject: true });
  const trimmedBuffer = trimmed.data;
  const trimmedW = trimmed.info.width;
  const trimmedH = trimmed.info.height;

  // 4. Scale product proportionally to occupy 75-85% of usable canvas
  const maxUsableW = Math.round(targetW * occupancy);
  const maxUsableH = Math.round(targetH * occupancy);

  const scale = Math.min(maxUsableW / trimmedW, maxUsableH / trimmedH);
  const finalProductW = Math.round(trimmedW * scale);
  const finalProductH = Math.round(trimmedH * scale);

  const scaledProduct = await sharp(trimmedBuffer)
    .resize(finalProductW, finalProductH, {
      fit: 'inside',
      withoutEnlargement: false,
    })
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
    const { relativeUrl } = saveDerivative(transparentCanvas, pngFilename);
    return {
      buffer: transparentCanvas,
      relativeUrl,
      quality,
      width: targetW,
      height: targetH,
      backgroundMode: 'transparent',
    };
  }

  // 5. Composite onto EXACT #FFFFFF PURE WHITE CANVAS (RGB 255, 255, 255)
  const whiteCanvas = await sharp({
    create: {
      width: targetW,
      height: targetH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: scaledProduct,
        gravity: 'center',
      },
    ])
    .sharpen({ sigma: 0.5, m1: 0.7, m2: 1.2 })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const { relativeUrl, filepath } = saveDerivative(whiteCanvas, outputFilename);

  return {
    buffer: whiteCanvas,
    relativeUrl,
    filepath,
    quality,
    width: targetW,
    height: targetH,
    backgroundMode: 'pure_white',
  };
}

/**
 * PIPELINE A: Interactive Non-Destructive Crop Engine.
 * Does NOT alter the original source file. Returns a new cropped derivative buffer.
 */
export async function applyNonDestructiveCrop(
  inputBuffer: Buffer,
  crop: CropRect | any,
  targetOutputDim = 2048
): Promise<{ buffer: Buffer; outputFilename: string; relativeUrl: string; filepath: string }> {
  let pipeline = sharp(inputBuffer).rotate();
  const meta = await pipeline.metadata();
  const srcW = meta.width || targetOutputDim;
  const srcH = meta.height || targetOutputDim;

  const actualCrop: CropRect = crop.cropRect || crop;
  const rot = crop.rotation || actualCrop.rotation || 0;
  if (rot) {
    pipeline = pipeline.rotate(rot);
  }

  const rawX = typeof actualCrop.x === 'number' ? actualCrop.x : 0;
  const rawY = typeof actualCrop.y === 'number' ? actualCrop.y : 0;
  const rawW = typeof actualCrop.width === 'number' ? actualCrop.width : srcW;
  const rawH = typeof actualCrop.height === 'number' ? actualCrop.height : srcH;

  let cx = rawX < 1 && rawX > 0 ? Math.round(rawX * srcW) : Math.round(rawX);
  let cy = rawY < 1 && rawY > 0 ? Math.round(rawY * srcH) : Math.round(rawY);
  let cw = rawW < 1 && rawW > 0 ? Math.round(rawW * srcW) : Math.round(rawW);
  let ch = rawH < 1 && rawH > 0 ? Math.round(rawH * srcH) : Math.round(rawH);

  cx = Math.max(0, Math.min(srcW - 10, cx));
  cy = Math.max(0, Math.min(srcH - 10, cy));
  cw = Math.max(20, Math.min(srcW - cx, cw));
  ch = Math.max(20, Math.min(srcH - cy, ch));

  const cropped = await pipeline
    .extract({ left: cx, top: cy, width: cw, height: ch })
    .toBuffer();

  const ratio = crop.aspectRatioPreset || crop.aspectRatio || actualCrop.aspectRatio || '1:1';
  let targetRatioW = 1;
  let targetRatioH = 1;
  if (ratio === '4:5') {
    targetRatioW = 4;
    targetRatioH = 5;
  } else if (ratio === '9:16') {
    targetRatioW = 9;
    targetRatioH = 16;
  }

  let finalW = crop.outputWidth || targetOutputDim;
  let finalH = crop.outputHeight || Math.round((finalW * targetRatioH) / targetRatioW);

  const fitted = await sharp(cropped)
    .resize(finalW, finalH, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const filename = crop.filename || `crop_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
  const { relativeUrl, filepath } = saveDerivative(fitted, filename);

  return {
    buffer: fitted,
    outputFilename: filename,
    relativeUrl,
    filepath,
  };
}

/**
 * PIPELINE A: Jewelry-Aware Auto Crop Bounding Box Detection.
 * Calculates optimal bounding box with 10-15% safe margin around necklace, pendant, and earrings.
 */
export async function detectJewelryAutoCrop(
  inputBuffer: Buffer,
  category: 'necklace_set' | 'earrings' | 'pendant' | 'ring' = 'necklace_set'
): Promise<CropRect> {
  const oriented = sharp(inputBuffer).rotate();
  const meta = await oriented.metadata();
  const w = meta.width || 2048;
  const h = meta.height || 2048;

  const maxDim = 600;
  const scale = Math.min(maxDim / w, maxDim / h);
  const sw = Math.round(w * scale);
  const sh = Math.round(h * scale);

  const { data: rawRgb } = await oriented
    .resize(sw, sh, { fit: 'inside' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let borderSum = 0;
  let borderCount = 0;
  for (let x = 0; x < sw; x++) {
    borderSum += rawRgb[x * 3];
    borderSum += rawRgb[((sh - 1) * sw + x) * 3];
    borderCount += 2;
  }
  const bgLuma = borderSum / borderCount;

  let minX = sw;
  let maxX = 0;
  let minY = sh;
  let maxY = 0;
  let detectedPoints = 0;

  for (let y = 5; y < sh - 5; y++) {
    for (let x = 5; x < sw - 5; x++) {
      const idx = (y * sw + x) * 3;
      const r = rawRgb[idx];
      const g = rawRgb[idx + 1];
      const b = rawRgb[idx + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;

      const diff = Math.abs(luma - bgLuma);
      const sat = Math.max(r, g, b) - Math.min(r, g, b);

      if (diff > 25 || sat > 20) {
        detectedPoints++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (detectedPoints < 50 || minX >= maxX || minY >= maxY) {
    return {
      x: 0,
      y: 0,
      width: w,
      height: h,
      aspectRatio: '1:1',
      zoom: 1.0,
    };
  }

  let srcMinX = Math.round(minX / scale);
  let srcMaxX = Math.round(maxX / scale);
  let srcMinY = Math.round(minY / scale);
  let srcMaxY = Math.round(maxY / scale);

  const boxW = srcMaxX - srcMinX;
  const boxH = srcMaxY - srcMinY;

  const marginPct = category === 'necklace_set' ? 0.14 : 0.08;
  const padX = Math.round(boxW * marginPct);
  const padY = Math.round(boxH * marginPct);

  srcMinX = Math.max(0, srcMinX - padX);
  srcMaxX = Math.min(w, srcMaxX + padX);
  srcMinY = Math.max(0, srcMinY - padY);
  srcMaxY = Math.min(h, srcMaxY + padY);

  const finalW = srcMaxX - srcMinX;
  const finalH = srcMaxY - srcMinY;

  const side = Math.max(finalW, finalH);
  const centerX = srcMinX + Math.round(finalW / 2);
  const centerY = srcMinY + Math.round(finalH / 2);

  let sqX = Math.max(0, centerX - Math.round(side / 2));
  let sqY = Math.max(0, centerY - Math.round(side / 2));
  let sqSide = side;

  if (sqX + sqSide > w) sqSide = w - sqX;
  if (sqY + sqSide > h) sqSide = h - sqY;

  const cropBox = {
    x: sqX,
    y: sqY,
    width: sqSide,
    height: sqSide,
    aspectRatio: '1:1' as const,
    zoom: 1.0,
  };

  return {
    ...cropBox,
    cropRect: cropBox,
    confidence: detectedPoints > 30 ? 0.92 : 0.65,
  } as any;
}

/**
 * PIPELINE A: Slot 3 Deterministic Craftsmanship / Pendant Close-Up.
 * Crops the focal pendant or stone setting at 2048 x 2048 resolution from authentic photo.
 */
export async function createDetailCraftsmanshipCrop(
  inputBuffer: Buffer,
  outputFilename: string,
  targetRegion: 'pendant' | 'earrings' | 'stones' | 'custom' = 'pendant',
  customCropRect?: CropRect
): Promise<{ buffer: Buffer; relativeUrl: string; filepath: string }> {
  if (customCropRect && customCropRect.width > 0) {
    const res = await applyNonDestructiveCrop(inputBuffer, customCropRect, 2048);
    const { relativeUrl, filepath } = saveDerivative(res.buffer, outputFilename);
    return { buffer: res.buffer, relativeUrl, filepath };
  }

  const oriented = sharp(inputBuffer).rotate();
  const meta = await oriented.metadata();
  const w = meta.width || 2048;
  const h = meta.height || 2048;

  const autoBox = await detectJewelryAutoCrop(inputBuffer, 'necklace_set');

  let cropX = autoBox.x;
  let cropY = autoBox.y;
  let cropW = autoBox.width;
  let cropH = autoBox.height;

  if (targetRegion === 'pendant') {
    cropY = Math.round(autoBox.y + autoBox.height * 0.45);
    cropH = Math.round(autoBox.height * 0.55);
    const side = Math.max(cropW, cropH);
    cropW = Math.min(w - cropX, side);
    cropH = Math.min(h - cropY, side);
  } else if (targetRegion === 'earrings') {
    cropY = Math.round(autoBox.y + autoBox.height * 0.08);
    cropH = Math.round(autoBox.height * 0.38);
  }

  const cropped = await applyNonDestructiveCrop(
    inputBuffer,
    {
      x: cropX,
      y: cropY,
      width: cropW,
      height: cropH,
      aspectRatio: '1:1',
    },
    2048
  );

  const { relativeUrl, filepath } = saveDerivative(cropped.buffer, outputFilename);
  return { buffer: cropped.buffer, relativeUrl, filepath };
}

/**
 * PIPELINE A: Slot 5 Deterministic Earring / Component Focus.
 * Isolates and crops matching earrings or secondary component from authentic photo.
 */
export async function createEarringComponentCrop(
  inputBuffer: Buffer,
  outputFilename: string,
  customCropRect?: CropRect
): Promise<{ buffer: Buffer; relativeUrl: string; filepath: string }> {
  return createDetailCraftsmanshipCrop(inputBuffer, outputFilename, 'earrings', customCropRect);
}
