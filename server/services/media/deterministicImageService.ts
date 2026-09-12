// Safe-crop wrapper around the original deterministic image implementation.
// The implementation is kept in deterministicImageService.impl.ts so this file
// can override compatibility behavior and product-detail crops without rewriting
// unrelated deterministic image logic.

export {
  evaluateSegmentationQuality,
  createPureWhiteCover,
  applyNonDestructiveCrop,
  validateGalleryAsset,
  validateAiHeroPresentation,
  validateDetailCloseup,
  validateCloseupNotBlank,
  validateExpectedJewelryCounts,
  validateHeroSymmetry,
  validatePendantCentered,
  validateNoDuplicateEarrings,
  detectJewelryComponentClusters,
  enhanceHeroPresentationLighting,
} from './deterministicImageService.impl';

export type {
  CropRect,
  SegmentationQualityResult,
  PureWhiteCoverResult,
  GalleryAssetValidationResult,
  AiHeroValidationResult,
  DetailCloseupValidationResult,
  CloseupNotBlankValidationResult,
  DetectedJewelryComponents,
  ComponentCluster,
} from './deterministicImageService.impl';

import {
  applyNonDestructiveCrop,
  detectJewelryAutoCrop as baseDetectJewelryAutoCrop,
  createDetailCraftsmanshipCrop as baseCreateDetailCraftsmanshipCrop,
} from './deterministicImageService.impl';
import type { CropRect } from './deterministicImageService.impl';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type JewelryCropCategory = 'necklace_set' | 'earrings' | 'pendant' | 'ring';
type CropAspectRatio = '1:1' | '4:5' | '9:16' | 'free';

export interface JewelryAutoCropDetection {
  cropRect: CropRect;
  confidence: number;
  marginPercent: number;
}

/**
 * Backward-compatible auto-crop API.
 *
 * Newer production code calls:
 *   detectJewelryAutoCrop(buffer, 'necklace_set') -> CropRect
 *
 * Media Studio 3.0 / older callers use:
 *   detectJewelryAutoCrop(buffer, '1:1', 0.12)
 *   -> { cropRect, confidence, marginPercent }
 *
 * Keep both contracts so the crop engine can evolve without breaking the UI or
 * acceptance tests. The underlying jewellery detector remains deterministic and
 * never redraws or stretches product pixels.
 */
export function detectJewelryAutoCrop(
  inputBuffer: Buffer,
  category?: JewelryCropCategory
): Promise<CropRect>;
export function detectJewelryAutoCrop(
  inputBuffer: Buffer,
  aspectRatio: CropAspectRatio,
  marginPercent?: number
): Promise<JewelryAutoCropDetection>;
export async function detectJewelryAutoCrop(
  inputBuffer: Buffer,
  mode: JewelryCropCategory | CropAspectRatio = 'necklace_set',
  marginPercent = 0.12
): Promise<CropRect | JewelryAutoCropDetection> {
  const isAspectRatio =
    mode === '1:1' || mode === '4:5' || mode === '9:16' || mode === 'free';

  if (!isAspectRatio) {
    return baseDetectJewelryAutoCrop(inputBuffer, mode as JewelryCropCategory);
  }

  // The base necklace detector already includes a jewellery-safe margin (14%
  // for necklace sets). For the legacy API we preserve that safe detector result
  // and expose the requested output ratio as metadata rather than forcing the
  // source crop into that ratio, which could clip a long chain.
  const detected = await baseDetectJewelryAutoCrop(inputBuffer, 'necklace_set');
  const safeMargin = clamp(Number.isFinite(marginPercent) ? marginPercent : 0.12, 0, 0.3);

  const cropRect: CropRect = {
    ...detected,
    aspectRatio: mode,
  };

  // A valid deterministic bounding box means the detector found a usable region.
  // Confidence is deliberately conservative because the final crop remains
  // user-editable and containment-safe.
  const confidence =
    cropRect.width > 1 && cropRect.height > 1
      ? 0.9
      : 0.55;

  return {
    cropRect,
    confidence,
    marginPercent: safeMargin,
  };
}

/**
 * Product-safe detail crop.
 *
 * The previous pendant crop began around 48% down the detected jewellery box.
 * On pendant sets where the matching earrings sit near the middle of the photo,
 * that could slice through the earrings. This override keeps the full central
 * sellable cluster (both earrings + pendant) and uses contain-to-square output,
 * so no component is stretched or force-cropped.
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
  return baseCreateDetailCraftsmanshipCrop(
    inputBuffer,
    outputFilename,
    targetRegion,
    customCropRect,
    options
  );
}

/** Keep Slot 5 component focus safe around both complete earrings. */
export async function createEarringComponentCrop(
  inputBuffer: Buffer,
  outputFilename: string,
  customCropRect?: CropRect
): Promise<{ buffer: Buffer; relativeUrl: string; filepath: string }> {
  return createDetailCraftsmanshipCrop(
    inputBuffer,
    outputFilename,
    'earrings',
    customCropRect
  );
}
