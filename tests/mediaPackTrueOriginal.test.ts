import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Spy on the white-product generator (real implementation runs; nothing is mocked away) so the
// test can assert WHICH source the generator received: the true 2276x4048 original, never the
// 2048x2048 derivative. No AI/provider is configured, so no network call can happen.
const generatorInputs: Array<{ width: number; height: number; sha256: string; mode?: string }> = [];
vi.mock('../server/services/media/mediaPipelineService', async (importOriginal) => {
  const actual: any = await importOriginal();
  const { getOrientedDimensions, sha256Hex } = await import('../server/services/media/outputIntegrityService');
  return {
    ...actual,
    generateWhiteProductImage: async (input: Buffer, mediaId: string, options: any) => {
      const dims = await getOrientedDimensions(input);
      generatorInputs.push({ ...dims, sha256: sha256Hex(input), mode: options?.mode });
      return actual.generateWhiteProductImage(input, mediaId, options);
    },
  };
});

import { buildRecommendedGalleryPack, regenerateSingleSlot, getItemBuffer } from '../server/services/media/galleryPackService';
import { analyzeBatchMedia } from '../server/services/media/mediaAnalyzerService';
import { sha256Hex, isDerivativeReference } from '../server/services/media/outputIntegrityService';
import { saveDerivativeBuffer, UPLOADS_DIR } from '../server/services/photoService';
import { getMatchLabel, getSlotOutputStatus } from '../src/utils/mediaPackStatus';
import { paperPhoto, PHOTO_W, PHOTO_H } from './helpers/jewelleryFixtures';

describe('True original is preserved and always used for generation / crop recovery', () => {
  let photo: Buffer;
  let photoHash: string;
  let pack: Awaited<ReturnType<typeof buildRecommendedGalleryPack>>;

  beforeAll(async () => {
    photo = await paperPhoto();
    photoHash = sha256Hex(photo);
    const clustered = await analyzeBatchMedia([
      { id: 'IMG_20261001_120958', originalFilename: 'IMG_20261001_120958.jpg', buffer: photo },
    ]);
    pack = await buildRecommendedGalleryPack({
      productId: 'true-original-test',
      productTitle: 'Blue Pear Halo Pendant Set with Earrings',
      clusteredItems: clustered,
      targetSlotCount: 5,
      enableStyledSlot2: false,
      enableModelGeneration: false,
      // NOTE: whiteProductMode intentionally omitted: Product Accuracy must be the default.
    });
  }, 180_000);

  it('records the immutable original (id/url/dimensions/hash) on the pack and on the white slot', () => {
    expect(pack.originalAssets).toHaveLength(1);
    const original = pack.originalAssets![0];
    expect(original.mediaId).toBe('IMG_20261001_120958');
    expect(original.width).toBe(PHOTO_W);
    expect(original.height).toBe(PHOTO_H);
    expect(original.sha256).toBe(photoHash);
    expect(isDerivativeReference(original.url)).toBe(false);

    const white = pack.slots.find((s) => s.slotRole === 'HERO_COVER')!;
    expect(white.sourceOriginal).toEqual(original);
    expect(white.originalUrl).toBe(original.url);
    expect(isDerivativeReference(white.originalUrl)).toBe(false);
    expect(white.isDerivative).toBe(true);
  });

  it('the original file bytes are unchanged after generation', () => {
    const original = pack.originalAssets![0];
    const stored = getItemBuffer({ url: original.url, originalUrl: original.url });
    expect(stored).not.toBeNull();
    expect(sha256Hex(stored!)).toBe(photoHash);
    expect(stored!.equals(photo)).toBe(true);
    // content-addressed upload on disk is byte-identical too
    const onDisk = fs.readFileSync(path.join(UPLOADS_DIR, path.basename(original.url)));
    expect(onDisk.equals(photo)).toBe(true);
  });

  it('white slot defaults to Product Accuracy (exact cutout) and the generator got the 2276x4048 original', () => {
    expect(generatorInputs.length).toBeGreaterThan(0);
    expect(generatorInputs[0]).toMatchObject({ width: PHOTO_W, height: PHOTO_H, sha256: photoHash, mode: 'exact_cutout' });
    const white = pack.slots.find((s) => s.slotRole === 'HERO_COVER')!;
    expect(white.whiteProductMode).toBe('exact_cutout');
    expect(white.processingMode).toBe('product_accuracy');
  });

  it('never shows a match label that contradicts a failed / needs-review state', () => {
    const white = pack.slots.find((s) => s.slotRole === 'HERO_COVER')!;
    const status = getSlotOutputStatus(white as any);
    if (status === 'ready') {
      expect(white.outputStatus).toBe('ready');
      expect(white.included).toBe(true);
      expect(getMatchLabel(white as any).text).toMatch(/HIGH MATCH/);
    } else {
      expect(white.productMatchScore).toBeUndefined();
      expect(white.included).toBe(false);
      expect(getMatchLabel(white as any).text).toBeNull();
      expect(white.outputIssues && white.outputIssues.length).toBeGreaterThan(0);
    }
  });

  it('media pack attaches photos to one piece and never auto-creates a listing', () => {
    expect(pack.sourceSummary).toMatchObject({ uploadedCount: 1, distinctOriginalCount: 1, pieceCount: 1, autoCreateListing: false });
  });

  it('regeneration after a bad generation starts from the TRUE original, not the 2048x2048 derivative', async () => {
    const before = generatorInputs.length;
    // The caller (e.g. an older client) hands over the bad 2048x2048 derivative as the source.
    const derivative = await sharp(photo).resize(2048, 2048, { fit: 'cover' }).jpeg().toBuffer();
    const derivativeUrl = saveDerivativeBuffer(derivative, 'IMG_20261001_120958_shopify_2048.jpg').url;
    const regenerated = await regenerateSingleSlot(pack, 1, {
      sourceImageUrl: derivativeUrl,
      sourceBase64: `data:image/jpeg;base64,${derivative.toString('base64')}`,
    } as any);

    expect(generatorInputs.length).toBe(before + 1);
    const last = generatorInputs[generatorInputs.length - 1];
    expect(last.width).toBe(PHOTO_W);
    expect(last.height).toBe(PHOTO_H);
    expect(last.width).not.toBe(2048);
    expect(last.sha256).toBe(photoHash);
    expect(last.mode).toBe('exact_cutout'); // Product Accuracy default on regeneration too

    const slot = regenerated.slots.find((s) => s.slotNumber === 1)!;
    expect(slot.sourceOriginal?.sha256).toBe(photoHash);
    expect(slot.originalUrl).toBe(pack.originalAssets![0].url);
  }, 180_000);

  it('fails loudly (no silent derivative fallback) when the true original cannot be found', async () => {
    const before = generatorInputs.length;
    const derivative = await sharp(photo).resize(2048, 2048, { fit: 'cover' }).jpeg().toBuffer();
    const derivativeUrl = saveDerivativeBuffer(derivative, 'orphan_clean_cover_2048.jpg').url;
    const orphanPack: any = {
      ...pack,
      originalAssets: undefined,
      slots: pack.slots.map((s) => ({ ...s, sourceOriginal: undefined, originalUrl: derivativeUrl })),
    };
    const result = await regenerateSingleSlot(orphanPack, 1, { sourceImageUrl: derivativeUrl } as any);
    const slot = result.slots.find((s) => s.slotNumber === 1)!;
    expect(generatorInputs.length).toBe(before); // generator never called with a derivative
    expect(slot.generationFailed).toBe(true);
    expect(slot.outputStatus).toBe('failed');
    expect(slot.generationError).toMatch(/true original/i);
    expect(slot.productMatchScore).toBeUndefined();
    expect(getMatchLabel(slot as any).text).toBeNull();
  }, 60_000);
});
