// Safe-crop wrapper around the original deterministic image implementation.
// The implementation is kept in deterministicImageService.impl.ts so this file
// can override only the product-detail crop without rewriting unrelated logic.

export {
  evaluateSegmentationQuality,
  createPureWhiteCover,
  applyNonDestructiveCrop,
  detectJewelryAutoCrop,
} from './deterministicImageService.impl';

export type {
  CropRect,
  SegmentationQualityResult,
  PureWhiteCoverResult,
} from './deterministicImageService.impl';

import {
  applyNonDestructiveCrop,
  detectJewelryAutoCrop,
} from './deterministicImageService.impl';
import type { CropRect } from './deterministicImageService.impl';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
  customCropRect?: CropRect
): Promise<{ buffer: Buffer; relativeUrl: string; filepath: string }> {
  if (customCropRect && customCropRect.width > 0 && customCropRect.height > 0) {
    const result = await applyNonDestructiveCrop(
      inputBuffer,
      { ...customCropRect, filename: outputFilename },
      2048
    );
    return {
      buffer: result.buffer,
      relativeUrl: result.relativeUrl,
      filepath: result.filepath,
    };
  }

  const autoBox = await detectJewelryAutoCrop(inputBuffer, 'necklace_set');

  let cropX = autoBox.x;
  let cropY = autoBox.y;
  let cropW = autoBox.width;
  let cropH = autoBox.height;

  if (targetRegion === 'pendant') {
    // Include complete earrings plus pendant. Remove mainly empty upper-chain area.
    const top = 0.18;
    const bottom = 0.99;
    cropX = Math.round(autoBox.x + autoBox.width * 0.04);
    cropY = Math.round(autoBox.y + autoBox.height * top);
    cropW = Math.round(autoBox.width * 0.92);
    cropH = Math.round(autoBox.height * (bottom - top));
  } else if (targetRegion === 'stones') {
    cropX = Math.round(autoBox.x + autoBox.width * 0.08);
    cropY = Math.round(autoBox.y + autoBox.height * 0.30);
    cropW = Math.round(autoBox.width * 0.84);
    cropH = Math.round(autoBox.height * 0.66);
  } else if (targetRegion === 'earrings') {
    // Give earrings extra top/bottom safety so hooks and drops are not clipped.
    cropX = Math.round(autoBox.x + autoBox.width * 0.08);
    cropY = Math.round(autoBox.y + autoBox.height * 0.14);
    cropW = Math.round(autoBox.width * 0.84);
    cropH = Math.round(autoBox.height * 0.50);
  }

  cropX = Math.max(0, cropX);
  cropY = Math.max(0, cropY);
  cropW = clamp(cropW, 1, Math.max(1, autoBox.x + autoBox.width - cropX));
  cropH = clamp(cropH, 1, Math.max(1, autoBox.y + autoBox.height - cropY));

  const result = await applyNonDestructiveCrop(
    inputBuffer,
    {
      x: cropX,
      y: cropY,
      width: cropW,
      height: cropH,
      aspectRatio: '1:1',
      filename: outputFilename,
    },
    2048
  );

  return {
    buffer: result.buffer,
    relativeUrl: result.relativeUrl,
    filepath: result.filepath,
  };
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
