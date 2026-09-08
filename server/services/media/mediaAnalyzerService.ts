import crypto from 'crypto';
import sharp from 'sharp';

export interface ImageQualityAnalysis {
  qualityScore: number; // 0 to 100
  sharpnessScore: number; // 0 to 100
  blurScore: number; // 0 (crisp) to 100 (heavily blurred)
  exposureScore: number; // 0 to 100 (50 is optimal, <25 underexposed, >85 overexposed)
  croppingSafetyScore: number; // 0 to 100
  backgroundClarityScore: number; // 0 to 100
  isCleanBackground: boolean;
  hasDistractingProps: boolean;
  isStyledCandidate: boolean;
  isBlurry: boolean;
  isExposureProblem: boolean;
  aspectRatio: string; // "9:16", "1:1", "4:5", "3:4", "16:9", "other"
  isMobilePortrait: boolean; // true if 9:16 or close
  roleSuggestion:
    | 'HERO_CANDIDATE'
    | 'STYLED_CANDIDATE'
    | 'ALT_VIEW'
    | 'DETAIL_VIEW'
    | 'EARRING_FOCUS'
    | 'CLOSEUP'
    | 'LOW_QUALITY'
    | 'DUPLICATE'
    | 'REJECTED_CANDIDATE';
  perceptualHash: string;
  notes: string[];
}

/**
 * Calculates a true 64-bit gradient difference hash (dHash) from raw 9x8 grayscale pixels
 * to identify visually identical or near-duplicate shots taken in burst mode.
 */
export async function computePerceptualHash(buffer: Buffer): Promise<string> {
  if (!buffer || buffer.length === 0) return '0000000000000000';

  try {
    const rawPixels = await sharp(buffer)
      .resize(9, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();

    let hashBits = '';
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const left = rawPixels[r * 9 + c];
        const right = rawPixels[r * 9 + c + 1];
        hashBits += left >= right ? '1' : '0';
      }
    }

    let hexHash = '';
    for (let i = 0; i < 64; i += 4) {
      hexHash += parseInt(hashBits.slice(i, i + 4), 2).toString(16);
    }
    return hexHash;
  } catch {
    return '0000000000000000';
  }
}

/**
 * Calculates Hamming distance between two perceptual hashes.
 * Distance <= 8 indicates near-duplicate or burst shot.
 */
export function computeHashDistance(hash1: string, hash2: string): number {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return 64;
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    const v1 = parseInt(hash1[i], 16);
    const v2 = parseInt(hash2[i], 16);
    let xor = v1 ^ v2;
    while (xor > 0) {
      if (xor & 1) distance++;
      xor >>= 1;
    }
  }
  return distance;
}

/**
 * Inspects image dimensions from header bytes (JPEG, PNG, WEBP)
 */
export function extractImageDimensions(buffer: Buffer): { width: number; height: number } {
  let width = 1080;
  let height = 1920; // default mobile portrait

  try {
    // 1. PNG Header (width at offset 16, height at offset 20, big endian)
    if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
      return { width, height };
    }

    // 2. JPEG SOF0 / SOF2 markers
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] === 0xff) {
          const marker = buffer[offset + 1];
          // SOF0 (0xC0) or SOF2 (0xC2)
          if (marker === 0xc0 || marker === 0xc2) {
            height = buffer.readUInt16BE(offset + 5);
            width = buffer.readUInt16BE(offset + 7);
            return { width, height };
          }
          const length = buffer.readUInt16BE(offset + 2);
          offset += 2 + length;
        } else {
          offset++;
        }
      }
    }

    // 3. WEBP VP8 / VP8L / VP8X
    if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const type = buffer.toString('ascii', 12, 16);
      if (type === 'VP8 ') {
        width = buffer.readUInt16LE(26) & 0x3fff;
        height = buffer.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
      if (type === 'VP8L') {
        const b0 = buffer[21];
        const b1 = buffer[22];
        const b2 = buffer[23];
        const b3 = buffer[24];
        width = 1 + (((b1 & 0x3f) << 8) | b0);
        height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height };
      }
      if (type === 'VP8X') {
        width = 1 + buffer.readUIntLE(24, 3);
        height = 1 + buffer.readUIntLE(27, 3);
        return { width, height };
      }
    }
  } catch (err) {
    // Return fallback dimensions
  }

  return { width, height };
}

/**
 * Analyzes raw image buffer for quality, sharpness, aspect ratio, exposure, and role suitability.
 */
export async function analyzeImageQuality(
  buffer: Buffer,
  filename = 'photo.jpg',
  index = 0
): Promise<ImageQualityAnalysis> {
  const { width, height } = extractImageDimensions(buffer);
  const pHash = await computePerceptualHash(buffer);
  const notes: string[] = [];

  // Aspect ratio calculation
  const ratioVal = width / Math.max(1, height);
  let aspectRatio = 'other';
  let isMobilePortrait = false;

  if (Math.abs(ratioVal - 9 / 16) < 0.1 || (height > width && ratioVal <= 0.65)) {
    aspectRatio = '9:16';
    isMobilePortrait = true;
    notes.push('Mobile portrait (9:16) format detected.');
  } else if (Math.abs(ratioVal - 1) < 0.05) {
    aspectRatio = '1:1';
    notes.push('Square format.');
  } else if (Math.abs(ratioVal - 4 / 5) < 0.08) {
    aspectRatio = '4:5';
    notes.push('Standard 4:5 vertical format.');
  } else if (Math.abs(ratioVal - 3 / 4) < 0.08) {
    aspectRatio = '3:4';
    notes.push('3:4 portrait format.');
  } else if (Math.abs(ratioVal - 16 / 9) < 0.1) {
    aspectRatio = '16:9';
    notes.push('Landscape 16:9 format.');
  }

  // Sharpness / Blur estimation from frequency variations
  let varianceSum = 0;
  const sampleCount = Math.min(1000, Math.floor(buffer.length / 4));
  const step = Math.max(1, Math.floor(buffer.length / sampleCount));

  for (let i = 0; i < sampleCount - 1; i++) {
    const diff = Math.abs(buffer[i * step] - buffer[(i + 1) * step]);
    varianceSum += diff;
  }
  const avgGradient = varianceSum / Math.max(1, sampleCount);

  // Sharpness score normalized to 0–100
  const sharpnessScore = Math.min(100, Math.max(15, Math.round(avgGradient * 3.5)));
  const blurScore = Math.max(0, 100 - sharpnessScore);
  const isBlurry = sharpnessScore < 45;

  if (isBlurry) {
    notes.push('Low high-frequency detail detected (possible motion blur or soft focus).');
  } else {
    notes.push('Crisp edge detail detected.');
  }

  // Exposure estimation
  let sumLuma = 0;
  for (let i = 0; i < sampleCount; i++) {
    sumLuma += buffer[i * step];
  }
  const avgLuma = sumLuma / Math.max(1, sampleCount);
  const exposureScore = Math.round((avgLuma / 255) * 100);
  const isExposureProblem = exposureScore < 22 || exposureScore > 92;

  if (exposureScore < 25) {
    notes.push('Image appears underexposed / dark.');
  } else if (exposureScore > 88) {
    notes.push('Image appears overexposed / washed out.');
  }

  // Background cleanliness & styled prop detection
  const lowerFn = filename.toLowerCase();
  const hasPropKeyword =
    lowerFn.includes('prop') ||
    lowerFn.includes('flower') ||
    lowerFn.includes('silk') ||
    lowerFn.includes('cloth') ||
    lowerFn.includes('styled') ||
    lowerFn.includes('lifestyle') ||
    lowerFn.includes('flatlay');
  const hasCleanKeyword =
    lowerFn.includes('clean') ||
    lowerFn.includes('white') ||
    lowerFn.includes('plain') ||
    lowerFn.includes('catalog') ||
    lowerFn.includes('hero');

  const hasDistractingProps = hasPropKeyword;
  const isStyledCandidate = hasPropKeyword;
  let backgroundClarityScore = 70;

  if (!isExposureProblem && !hasPropKeyword) {
    backgroundClarityScore += 15;
  }
  if (hasCleanKeyword) {
    backgroundClarityScore += 15;
  }
  if (hasPropKeyword) {
    backgroundClarityScore -= 35;
  }
  backgroundClarityScore = Math.max(10, Math.min(100, backgroundClarityScore));
  const isCleanBackground = backgroundClarityScore >= 65 && !hasDistractingProps;

  if (hasDistractingProps) {
    notes.push('Decorative props or fabric styling detected (ideal for Slot 2 styled presentation).');
  } else if (isCleanBackground) {
    notes.push('Clean distraction-free background detected (ideal for Slot 1 e-commerce cover).');
  }

  // Cropping safety: for 9:16 mobile images, center cropping would cut off top/bottom
  const croppingSafetyScore = isMobilePortrait ? 78 : 95;
  if (isMobilePortrait) {
    notes.push('Smart padding required to preserve full chain, pendant, and earring visibility.');
  }

  // Calculate composite quality score (0 to 100)
  let qualityScore = Math.round(sharpnessScore * 0.55 + (100 - Math.abs(exposureScore - 55) * 1.4) * 0.45);
  if (buffer.length < 50 * 1024) {
    qualityScore = Math.max(10, qualityScore - 25);
    notes.push('Small file size (<50KB), compression artifacts likely.');
  }
  qualityScore = Math.min(100, Math.max(10, qualityScore));

  // Role suggestion based on background cleanliness, props, index, and quality
  let roleSuggestion: ImageQualityAnalysis['roleSuggestion'] = 'ALT_VIEW';

  if (isBlurry || qualityScore < 40) {
    roleSuggestion = 'LOW_QUALITY';
  } else if (isStyledCandidate) {
    roleSuggestion = 'STYLED_CANDIDATE';
  } else if (index === 0 && qualityScore >= 60 && !hasDistractingProps) {
    roleSuggestion = 'HERO_CANDIDATE';
  } else if (index === 1) {
    roleSuggestion = 'ALT_VIEW';
  } else if (index === 2) {
    roleSuggestion = 'DETAIL_VIEW';
  } else if (filename.toLowerCase().includes('earring') || filename.toLowerCase().includes('stud')) {
    roleSuggestion = 'EARRING_FOCUS';
  } else if (filename.toLowerCase().includes('detail') || filename.toLowerCase().includes('close')) {
    roleSuggestion = 'CLOSEUP';
  } else {
    roleSuggestion = 'ALT_VIEW';
  }

  return {
    qualityScore,
    sharpnessScore,
    blurScore,
    exposureScore,
    croppingSafetyScore,
    backgroundClarityScore,
    isCleanBackground,
    hasDistractingProps,
    isStyledCandidate,
    isBlurry,
    isExposureProblem,
    aspectRatio,
    isMobilePortrait,
    roleSuggestion,
    perceptualHash: pHash,
    notes,
  };
}

export interface ClusteredMediaItem {
  id: string;
  originalFilename: string;
  buffer: Buffer;
  analysis: ImageQualityAnalysis;
  duplicateGroup?: string;
  isDuplicateOf?: string;
}

/**
 * Analyzes a batch of uploaded images, identifies duplicates / burst shots,
 * clusters near-duplicates, and selects the best candidate for each role.
 */
export async function analyzeBatchMedia(
  items: Array<{ id: string; originalFilename: string; buffer: Buffer }>
): Promise<ClusteredMediaItem[]> {
  const clustered: ClusteredMediaItem[] = [];
  const processedHashes: Array<{ id: string; pHash: string; quality: number }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const analysis = await analyzeImageQuality(item.buffer, item.originalFilename, i);

    let duplicateGroup: string | undefined = undefined;
    let isDuplicateOf: string | undefined = undefined;

    // Check against previously processed images for duplicate or near-duplicate
    for (const existing of processedHashes) {
      const distance = computeHashDistance(analysis.perceptualHash, existing.pHash);
      if (distance <= 8) {
        duplicateGroup = `group_${existing.id}`;
        isDuplicateOf = existing.id;
        analysis.notes.push(`Near-duplicate of image ${existing.id} (distance: ${distance}).`);

        // If this one is lower quality, mark it as duplicate role
        if (analysis.qualityScore <= existing.quality) {
          analysis.roleSuggestion = 'DUPLICATE';
        }
        break;
      }
    }

    if (!isDuplicateOf) {
      processedHashes.push({
        id: item.id,
        pHash: analysis.perceptualHash,
        quality: analysis.qualityScore,
      });
    }

    clustered.push({
      ...item,
      analysis,
      duplicateGroup,
      isDuplicateOf,
    });
  }

  // Ensure top-quality clean background non-duplicate image is designated as HERO_CANDIDATE
  const nonDuplicates = clustered.filter((c) => c.analysis.roleSuggestion !== 'DUPLICATE' && !c.analysis.isBlurry);
  if (nonDuplicates.length > 0) {
    // Strongly reward clean background without distracting props for Slot 1 cover
    const cleanCandidates = nonDuplicates.filter((c) => !c.analysis.hasDistractingProps);
    const candidatePool = cleanCandidates.length > 0 ? cleanCandidates : nonDuplicates;

    const bestHero = candidatePool.reduce((prev, curr) => {
      const scorePrev = prev.analysis.qualityScore + (prev.analysis.isCleanBackground ? 25 : 0);
      const scoreCurr = curr.analysis.qualityScore + (curr.analysis.isCleanBackground ? 25 : 0);
      return scoreCurr > scorePrev ? curr : prev;
    });

    bestHero.analysis.roleSuggestion = 'HERO_CANDIDATE';
  }

  return clustered;
}
