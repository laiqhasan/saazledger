import sharp from 'sharp';

export type ProductFidelityStatus = 'verified' | 'manual_review' | 'failed';

export interface ProductFidelityResult {
  score: number;
  status: ProductFidelityStatus;
  issues: string[];
  metrics: {
    silhouetteIoU: number;
    edgeSimilarity: number;
    perceptualSimilarity: number;
    areaDrift: number;
    aspectDrift: number;
    blueStoneRetention: number | null;
  };
}

interface NormalizedImageFeatures {
  rgb: Uint8Array;
  gray: Uint8Array;
  mask: Uint8Array;
  edges: Uint8Array;
  hash: Uint8Array;
  width: number;
  height: number;
  sourceAreaRatio: number;
  sourceAspectRatio: number;
  blueRatio: number;
  blueMean: { r: number; g: number; b: number } | null;
}

const NORMALIZED_SIZE = 256;

function isForeground(r: number, g: number, b: number, a = 255): boolean {
  if (a < 24) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max - min;
  return max < 248 || min < 238 || saturation > 10;
}

function isBlueStone(r: number, g: number, b: number): boolean {
  return b > 65 && b > r + 24 && b > g + 12;
}

async function normalizeForComparison(buffer: Buffer): Promise<NormalizedImageFeatures> {
  const rgba = await sharp(buffer)
    .rotate()
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = rgba.info.width;
  let minY = rgba.info.height;
  let maxX = -1;
  let maxY = -1;
  let foregroundCount = 0;

  for (let y = 0; y < rgba.info.height; y++) {
    for (let x = 0; x < rgba.info.width; x++) {
      const idx = (y * rgba.info.width + x) * 4;
      if (isForeground(rgba.data[idx], rgba.data[idx + 1], rgba.data[idx + 2], rgba.data[idx + 3])) {
        foregroundCount++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < minX || maxY < minY || foregroundCount < 30) {
    minX = 0;
    minY = 0;
    maxX = rgba.info.width - 1;
    maxY = rgba.info.height - 1;
  }

  const cropW = Math.max(1, maxX - minX + 1);
  const cropH = Math.max(1, maxY - minY + 1);
  const padX = Math.round(cropW * 0.05);
  const padY = Math.round(cropH * 0.05);
  const left = Math.max(0, minX - padX);
  const top = Math.max(0, minY - padY);
  const width = Math.min(rgba.info.width - left, cropW + padX * 2);
  const height = Math.min(rgba.info.height - top, cropH + padY * 2);

  const normalized = await sharp(buffer)
    .rotate()
    .extract({ left, top, width, height })
    .resize(NORMALIZED_SIZE, NORMALIZED_SIZE, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = normalized.info.width * normalized.info.height;
  const rgb = new Uint8Array(normalized.data);
  const gray = new Uint8Array(pixelCount);
  const mask = new Uint8Array(pixelCount);
  let blueCount = 0;
  let blueR = 0;
  let blueG = 0;
  let blueB = 0;

  for (let i = 0; i < pixelCount; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    mask[i] = isForeground(r, g, b) ? 1 : 0;
    if (isBlueStone(r, g, b)) {
      blueCount++;
      blueR += r;
      blueG += g;
      blueB += b;
    }
  }

  const edges = buildEdgeMap(gray, mask, normalized.info.width, normalized.info.height);
  const hash = buildAverageHash(gray, normalized.info.width, normalized.info.height);

  return {
    rgb,
    gray,
    mask,
    edges,
    hash,
    width: normalized.info.width,
    height: normalized.info.height,
    sourceAreaRatio: foregroundCount / (rgba.info.width * rgba.info.height),
    sourceAspectRatio: cropW / cropH,
    blueRatio: blueCount / pixelCount,
    blueMean: blueCount > 0 ? { r: blueR / blueCount, g: blueG / blueCount, b: blueB / blueCount } : null,
  };
}

function buildEdgeMap(gray: Uint8Array, mask: Uint8Array, width: number, height: number): Uint8Array {
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      const gx =
        -gray[idx - width - 1] -
        2 * gray[idx - 1] -
        gray[idx + width - 1] +
        gray[idx - width + 1] +
        2 * gray[idx + 1] +
        gray[idx + width + 1];
      const gy =
        -gray[idx - width - 1] -
        2 * gray[idx - width] -
        gray[idx - width + 1] +
        gray[idx + width - 1] +
        2 * gray[idx + width] +
        gray[idx + width + 1];
      if (Math.sqrt(gx * gx + gy * gy) > 52) {
        edges[idx] = 1;
      }
    }
  }
  return edges;
}

function buildAverageHash(gray: Uint8Array, width: number, height: number): Uint8Array {
  const cellW = width / 16;
  const cellH = height / 16;
  const samples = new Uint8Array(256);
  let total = 0;

  for (let cy = 0; cy < 16; cy++) {
    for (let cx = 0; cx < 16; cx++) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(cx * cellW);
      const x1 = Math.floor((cx + 1) * cellW);
      const y0 = Math.floor(cy * cellH);
      const y1 = Math.floor((cy + 1) * cellH);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += gray[y * width + x];
          count++;
        }
      }
      const value = Math.round(sum / Math.max(1, count));
      samples[cy * 16 + cx] = value;
      total += value;
    }
  }

  const mean = total / samples.length;
  return samples.map((value) => (value < mean ? 1 : 0));
}

function binarySimilarity(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) union++;
    if (a[i] && b[i]) intersection++;
  }
  return union === 0 ? 1 : intersection / union;
}

function edgeSimilarity(a: Uint8Array, b: Uint8Array): number {
  let common = 0;
  let totalA = 0;
  let totalB = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]) totalA++;
    if (b[i]) totalB++;
    if (a[i] && b[i]) common++;
  }
  if (totalA === 0 && totalB === 0) return 1;
  return (2 * common) / Math.max(1, totalA + totalB);
}

function hashSimilarity(a: Uint8Array, b: Uint8Array): number {
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) same++;
  }
  return same / Math.max(1, a.length);
}

export async function validateProductFidelity(
  originalBuffer: Buffer,
  editedBuffer: Buffer
): Promise<ProductFidelityResult> {
  const original = await normalizeForComparison(originalBuffer);
  const edited = await normalizeForComparison(editedBuffer);

  const silhouetteIoU = binarySimilarity(original.mask, edited.mask);
  const edges = edgeSimilarity(original.edges, edited.edges);
  const perceptual = hashSimilarity(original.hash, edited.hash);
  const areaDrift = Math.abs(original.sourceAreaRatio - edited.sourceAreaRatio) / Math.max(original.sourceAreaRatio, 0.001);
  const aspectDrift = Math.abs(original.sourceAspectRatio - edited.sourceAspectRatio) / Math.max(original.sourceAspectRatio, 0.001);

  let score =
    silhouetteIoU * 44 +
    edges * 30 +
    perceptual * 16 +
    Math.max(0, 1 - Math.min(areaDrift, 1)) * 6 +
    Math.max(0, 1 - Math.min(aspectDrift, 1)) * 4;

  const issues: string[] = [];
  if (silhouetteIoU < 0.78) issues.push('Silhouette changed materially versus the source image.');
  if (edges < 0.52) issues.push('Fine structure or chain/detail edges changed materially.');
  if (aspectDrift > 0.22) issues.push('Overall product proportions changed materially.');
  if (areaDrift > 0.35) issues.push('Product scale/occupied area changed materially.');

  let blueStoneRetention: number | null = null;
  if (original.blueRatio > 0.0015) {
    blueStoneRetention = edited.blueRatio / Math.max(original.blueRatio, 0.0001);
    if (blueStoneRetention < 0.6) {
      score -= 12;
      issues.push('Blue gemstone colour presence dropped or shifted.');
    }
    if (original.blueMean && edited.blueMean) {
      const blueDistance = Math.sqrt(
        Math.pow(original.blueMean.r - edited.blueMean.r, 2) +
          Math.pow(original.blueMean.g - edited.blueMean.g, 2) +
          Math.pow(original.blueMean.b - edited.blueMean.b, 2)
      );
      if (blueDistance > 62) {
        score -= 8;
        issues.push('Blue gemstone tone drift detected.');
      }
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const status: ProductFidelityStatus = score >= 95 ? 'verified' : score >= 90 ? 'manual_review' : 'failed';
  if (status === 'manual_review') issues.push('AI precision edit requires manual review before use as a main product image.');
  if (status === 'failed') issues.push('AI precision edit is not safe for the main e-commerce image.');

  return {
    score,
    status,
    issues: Array.from(new Set(issues)),
    metrics: {
      silhouetteIoU: Number(silhouetteIoU.toFixed(4)),
      edgeSimilarity: Number(edges.toFixed(4)),
      perceptualSimilarity: Number(perceptual.toFixed(4)),
      areaDrift: Number(areaDrift.toFixed(4)),
      aspectDrift: Number(aspectDrift.toFixed(4)),
      blueStoneRetention: blueStoneRetention === null ? null : Number(blueStoneRetention.toFixed(4)),
    },
  };
}
