import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { db } from '../server/db/database';
import {
  createPureWhiteCover,
  evaluateSegmentationQuality,
  applyNonDestructiveCrop,
  detectJewelryAutoCrop,
  createDetailCraftsmanshipCrop,
  createEarringComponentCrop,
} from '../server/services/media/deterministicImageService';
import {
  generateStyledImage,
  generateModelImage,
} from '../server/services/media/imageGenerationProvider';
import {
  getBackgroundRemovalCreditMetrics,
  resetBackgroundRemovalCreditMetricsForTests,
  forceGeminiFallbackOnceForTests,
} from '../server/services/media/backgroundRemovalService';
import {
  buildRecommendedGalleryPack,
} from '../server/services/media/galleryPackService';
import { analyzeBatchMedia } from '../server/services/media/mediaAnalyzerService';
import { processListingMediaDerivatives } from '../server/services/media/mediaPipelineService';
import { getShopifyReadyGallerySlots } from '../server/services/media/shopifyMediaSyncService';

describe('Media Pack Studio 3.0 — Comprehensive Pipeline Acceptance Tests', () => {
  let sampleNecklaceBuffer: Buffer;

  beforeAll(async () => {
    // Create a 800x800 synthetic photo of a gold necklace on off-white/gray table
    sampleNecklaceBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 230, g: 228, b: 225 }, // Real photo background
      },
    })
      .composite([
        // Draw simulated golden pendant in center
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <!-- Golden chain -->
              <path d="M 250,150 Q 400,450 550,150" stroke="#d4af37" stroke-width="8" fill="none" />
              <!-- Diamond pendant -->
              <polygon points="400,430 450,510 400,590 350,510" fill="#f5d77f" stroke="#ffffff" stroke-width="4" />
              <!-- Center emerald/ruby stone -->
              <circle cx="400" cy="510" r="28" fill="#10b981" />
              <!-- Matching earrings on sides -->
              <circle cx="230" cy="220" r="18" fill="#f5d77f" />
              <circle cx="570" cy="220" r="18" fill="#f5d77f" />
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();
  });

  async function analyzeFixtureUploads(prefix: string, count = 1) {
    return analyzeBatchMedia(
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}_${index + 1}`,
        originalFilename: `${prefix}_${index + 1}.jpg`,
        buffer: sampleNecklaceBuffer,
      }))
    );
  }

  // TEST 1: Slot 1 Pure White Cover produces exact #FFFFFF RGB (255,255,255)
  it('TEST 1: createPureWhiteCover produces genuine 2048x2048 canvas with exact #FFFFFF (255,255,255) corners and borders', async () => {
    const result = await createPureWhiteCover(sampleNecklaceBuffer, 'test_white_cover.jpg', {
      canvasSize: 2048,
      targetOccupancy: 0.8,
      featherRadius: 1.0,
    });

    expect(result.relativeUrl).toContain('/api/photos/derivatives/');
    expect(fs.existsSync(result.filepath)).toBe(true);

    const metadata = await sharp(result.filepath).metadata();
    expect(metadata.width).toBe(2048);
    expect(metadata.height).toBe(2048);

    // Sample pixels at the outer edges/corners to ensure pure white #FFFFFF
    const rawPixels = await sharp(result.filepath).raw().toBuffer();
    const channels = metadata.channels || 3;

    // Corner (10, 10)
    const idxTopLeft = (10 * 2048 + 10) * channels;
    expect(rawPixels[idxTopLeft]).toBe(255); // R
    expect(rawPixels[idxTopLeft + 1]).toBe(255); // G
    expect(rawPixels[idxTopLeft + 2]).toBe(255); // B

    // Corner (2030, 10) - top right
    const idxTopRight = (10 * 2048 + 2030) * channels;
    expect(rawPixels[idxTopRight]).toBe(255);
    expect(rawPixels[idxTopRight + 1]).toBe(255);
    expect(rawPixels[idxTopRight + 2]).toBe(255);

    // Corner (10, 2030) - bottom left
    const idxBottomLeft = (2030 * 2048 + 10) * channels;
    expect(rawPixels[idxBottomLeft]).toBe(255);
    expect(rawPixels[idxBottomLeft + 1]).toBe(255);
    expect(rawPixels[idxBottomLeft + 2]).toBe(255);
  });

  it('TEST 1B: reuses one isolated master PNG for repeated exact-product derivatives from the same source', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    const uniqueSource = await sharp(sampleNecklaceBuffer)
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800"><text x="20" y="780" font-size="16" fill="#232323">cache-${Date.now()}</text></svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();

    const white = await createPureWhiteCover(uniqueSource, 'test_credit_white.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      backgroundMode: 'pure_white',
    });
    const premium = await createPureWhiteCover(uniqueSource, 'test_credit_premium.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      backgroundMode: 'pure_white',
      occupancyPercent: 86,
    });

    expect(white.isolatedMasterUrl).toBeTruthy();
    expect(premium.isolatedMasterUrl).toBe(white.isolatedMasterUrl);
    expect(getBackgroundRemovalCreditMetrics().sourceIsolationCreateCount).toBe(1);
  });

  it('TEST 1C: calls PhotoRoom only once when White Product and Detail Close-up share the same source', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    const uniqueSource = await sharp(sampleNecklaceBuffer)
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800"><text x="20" y="760" font-size="16" fill="#232323">derivatives-${Date.now()}</text></svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();

    const derivatives = await processListingMediaDerivatives(uniqueSource, `white_detail_${Date.now()}`);

    expect(derivatives.cleanCoverUrl).toBeTruthy();
    expect(derivatives.isolatedMasterUrl).toBeTruthy();
    expect(derivatives.detailCropUrl).toBeTruthy();
    expect(getBackgroundRemovalCreditMetrics().sourceIsolationCreateCount).toBe(1);
  });

  // TEST 2: Segmentation Quality Evaluation
  it('TEST 2: evaluateSegmentationQuality detects alpha continuity and occupancy correctly', async () => {
    // Create an alpha mask with solid center
    const maskBuffer = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="400" height="400">
              <circle cx="200" cy="200" r="100" fill="#ffffff" />
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .extractChannel(0)
      .raw()
      .toBuffer();

    const quality = await evaluateSegmentationQuality(maskBuffer, 400, 400);
    expect(quality.isValid).toBe(true);
    expect(quality.chainContinuityScore).toBeGreaterThan(70);
    expect(quality.occupancyRatio).toBeGreaterThan(0.15);
    expect(quality.occupancyRatio).toBeLessThan(0.35);
  });

  // TEST 3: Non-Destructive Crop & Frame Editor (1:1, 4:5, 9:16)
  it('TEST 3: applyNonDestructiveCrop respects aspect ratio, zoom, and pan without mutating original master', async () => {
    // 1:1 square crop with 1.25x zoom
    const squareCrop = await applyNonDestructiveCrop(sampleNecklaceBuffer, {
      cropRect: { x: 50, y: 50, width: 700, height: 700 },
      zoom: 1.25,
      aspectRatioPreset: '1:1',
      outputWidth: 2048,
      outputHeight: 2048,
      filename: 'crop_test_1x1.jpg',
    });

    expect(fs.existsSync(squareCrop.filepath)).toBe(true);
    const sqMeta = await sharp(squareCrop.filepath).metadata();
    expect(sqMeta.width).toBe(2048);
    expect(sqMeta.height).toBe(2048);

    // 4:5 portrait crop
    const portraitCrop = await applyNonDestructiveCrop(sampleNecklaceBuffer, {
      cropRect: { x: 80, y: 0, width: 640, height: 800 },
      aspectRatioPreset: '4:5',
      outputWidth: 1638,
      outputHeight: 2048,
      filename: 'crop_test_4x5.jpg',
    });
    const portMeta = await sharp(portraitCrop.filepath).metadata();
    expect(portMeta.width).toBe(1638);
    expect(portMeta.height).toBe(2048);

    // 9:16 story crop
    const storyCrop = await applyNonDestructiveCrop(sampleNecklaceBuffer, {
      cropRect: { x: 175, y: 0, width: 450, height: 800 },
      aspectRatioPreset: '9:16',
      outputWidth: 1080,
      outputHeight: 1920,
      filename: 'crop_test_9x16.jpg',
    });
    const storyMeta = await sharp(storyCrop.filepath).metadata();
    expect(storyMeta.width).toBe(1080);
    expect(storyMeta.height).toBe(1920);
  });

  // TEST 4: Auto-Crop detects jewelry bounding box with safe margin
  it('TEST 4: detectJewelryAutoCrop calculates safe jewelry bounding box with margin', async () => {
    const autoCrop = await detectJewelryAutoCrop(sampleNecklaceBuffer, '1:1', 0.12);

    expect(autoCrop.confidence).toBeGreaterThan(0.5);
    expect(autoCrop.cropRect.width).toBeGreaterThan(300);
    expect(autoCrop.cropRect.height).toBeGreaterThan(300);
    // Should preserve necklace width and height within 800x800 bounds
    expect(autoCrop.cropRect.x + autoCrop.cropRect.width).toBeLessThanOrEqual(800);
    expect(autoCrop.cropRect.y + autoCrop.cropRect.height).toBeLessThanOrEqual(800);
  });

  // TEST 5: Deterministic Slot 3 Craftsmanship Crop & Slot 5 Earring Focus
  it('TEST 5: createDetailCraftsmanshipCrop and createEarringComponentCrop extract authentic regions', async () => {
    const detailCrop = await createDetailCraftsmanshipCrop(
      sampleNecklaceBuffer,
      'test_detail_pendant.jpg',
      'pendant'
    );
    expect(fs.existsSync(detailCrop.filepath)).toBe(true);
    const dMeta = await sharp(detailCrop.filepath).metadata();
    expect(dMeta.width).toBe(2048);
    expect(dMeta.height).toBe(2048);

    const earringCrop = await createEarringComponentCrop(
      sampleNecklaceBuffer,
      'test_earring_focus.jpg'
    );
    expect(fs.existsSync(earringCrop.filepath)).toBe(true);
    const eMeta = await sharp(earringCrop.filepath).metadata();
    expect(eMeta.width).toBe(2048);
    expect(eMeta.height).toBe(2048);
  });

  // TEST 6: Strict AI Image Failure Reporting (NO Fake Ring / Marble Fallbacks)
  it('TEST 6: imageGenerationProvider returns clean error without fake red ring or random assets when credentials absent', async () => {
    // Force absent credentials in non-test mode simulation
    const originalVitest = process.env.VITEST;
    try {
      delete process.env.VITEST;

      const failedStyled = await generateStyledImage({
        sourceImageUrl: '/api/photos/test.jpg',
        productTitle: 'Emerald Choker Set',
        styleOption: 'silk_and_flower',
        geminiApiKey: '',
        openaiApiKey: '',
      });

      expect(failedStyled.success).toBe(false);
      expect(failedStyled.generatedImageUrl).toBeUndefined();
      expect(failedStyled.error).toContain('No AI Image Generation credentials configured');

      const failedModel = await generateModelImage({
        sourceImageUrl: '/api/photos/test.jpg',
        productTitle: 'Emerald Choker Set',
        presetKey: 'office_to_occasion',
        geminiApiKey: '',
        openaiApiKey: '',
      });

      expect(failedModel.success).toBe(false);
      expect(failedModel.generatedImageUrl).toBeUndefined();
      expect(failedModel.error).toContain('No AI Image Generation credentials configured');
    } finally {
      process.env.VITEST = originalVitest;
    }
  });

  // TEST 7: Gallery Pack builds strictly adhering to Media Pack Studio 3.0 Roles
  it('TEST 7: buildRecommendedGalleryPack constructs 5 slots with Pure White Slot 1, Deterministic Slot 3 & 5', async () => {
    const clustered = await analyzeBatchMedia([
      { id: 'item_1', originalFilename: 'neck_hero.jpg', buffer: sampleNecklaceBuffer },
      { id: 'item_2', originalFilename: 'neck_angle.jpg', buffer: sampleNecklaceBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-studio-3-test',
      productTitle: 'Kundan Diamond Choker Set with Emeralds',
      clusteredItems: clustered,
      targetSlotCount: 5,
      enableStyledSlot2: true,
      enableModelGeneration: true,
      modelPresetKey: 'indian_festive',
    });

    expect(pack.slots.length).toBe(5);

    // Slot 1: Pure White E-Commerce Hero
    const slot1 = pack.slots[0];
    expect(slot1.slotNumber).toBe(1);
    expect(slot1.slotRole).toBe('HERO_COVER');
    expect(slot1.isCover).toBe(true);
    expect(slot1.slotTitle).toContain('Pure White');
    expect(slot1.currentBgMode).toBe('pure_white');
    expect(slot1.sourceType).toBe('real_photo');

    // Slot 2: Styled Supporting
    const slot2 = pack.slots[1];
    expect(slot2.slotNumber).toBe(2);
    expect(slot2.slotRole).toBe('STYLED_SUPPORTING');

    // Slot 3: Craftsmanship / Pendant Close-up (Deterministic)
    const slot3 = pack.slots[2];
    expect(slot3.slotNumber).toBe(3);
    expect(slot3.slotRole).toBe('DETAIL_CLOSEUP');
    expect(slot3.sourceType).toBe('detail_crop');
    expect(slot3.isAiGenerated).toBe(false);

    // Slot 4: Fashion Model
    const slot4 = pack.slots[3];
    expect(slot4.slotNumber).toBe(4);
    expect(slot4.slotRole).toBe('MODEL_1');

    // Slot 5: Original Photo remains separate from White Product
    const slot5 = pack.slots[4];
    expect(slot5.slotNumber).toBe(5);
    expect(slot5.slotRole).toBe('REAL_PHOTO_FALLBACK');
    expect(slot5.slotTitle).toBe('Original Photo');
    expect(slot5.url).not.toBe(slot1.url);
    expect(slot5.currentBgMode).not.toBe('pure_white');
    expect(slot5.isAiGenerated).toBe(false);
  });

  // TEST 8: Distortion Prevention Quality Gate in createPureWhiteCover
  it('TEST 8: createPureWhiteCover never outputs a distorted ghost outline when segmentation fails', async () => {
    // A difficult low-contrast synthetic image where background matting might produce an empty mask
    const difficultImage = await sharp({
      create: {
        width: 600,
        height: 600,
        channels: 3,
        background: { r: 245, g: 245, b: 245 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="600" height="600">
              <circle cx="300" cy="300" r="150" fill="#f0ece1" stroke="#e2ded3" stroke-width="2"/>
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    const result = await createPureWhiteCover(difficultImage, 'test_fallback_pure_white.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      occupancyPercent: 80,
    });

    expect(result.relativeUrl).toBeTruthy();
    expect(result.quality.isAcceptable).toBe(true);
    expect(result.width).toBe(2048);
    expect(result.height).toBe(2048);

    // Verify outer canvas corners are exact pure white #FFFFFF
    const raw = await sharp(result.buffer).raw().toBuffer();
    // Top-left corner (10, 10)
    expect(raw[0]).toBe(255);
    expect(raw[1]).toBe(255);
    expect(raw[2]).toBe(255);
  });

  // TEST 9: Foreign Jewelry Protection in Slot 5
  it('TEST 9: buildRecommendedGalleryPack never assigns an auto-seeded or foreign existing-hero into Slot 5', async () => {
    // Simulate a batch where one item is a legacy pre-loaded 'existing-hero' from another product
    const legacyForeignHero = {
      id: 'existing-hero',
      originalFilename: 'PDD01-00001-hero.jpg',
      buffer: sampleNecklaceBuffer,
      analysis: {
        qualityScore: 88,
        sharpnessScore: 90,
        blurScore: 10,
        exposureScore: 50,
        croppingSafetyScore: 95,
        backgroundClarityScore: 80,
        isCleanBackground: true,
        hasDistractingProps: false,
        isStyledCandidate: false,
        isBlurry: false,
        isExposureProblem: false,
        aspectRatio: '1:1',
        isMobilePortrait: false,
        roleSuggestion: 'EARRING_FOCUS' as const, // Legacy analyzer misclassified it as earring
        perceptualHash: '1111111111111111',
        notes: [],
      },
    };

    const authenticUpload = {
      id: 'upload_crescent_1',
      originalFilename: 'crescent_necklace_front.jpg',
      buffer: sampleNecklaceBuffer,
      analysis: {
        qualityScore: 95,
        sharpnessScore: 95,
        blurScore: 5,
        exposureScore: 52,
        croppingSafetyScore: 95,
        backgroundClarityScore: 85,
        isCleanBackground: true,
        hasDistractingProps: false,
        isStyledCandidate: false,
        isBlurry: false,
        isExposureProblem: false,
        aspectRatio: '1:1',
        isMobilePortrait: false,
        roleSuggestion: 'HERO_CANDIDATE' as const,
        perceptualHash: '2222222222222222',
        notes: [],
      },
    };

    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Multicolour American Diamond Gold-Tone Crescent Pendant Set',
      clusteredItems: [authenticUpload, legacyForeignHero],
      targetSlotCount: 5,
    });

    // Verify Original Photo did NOT pick legacyForeignHero
    const slot5 = pack.slots.find((s) => s.slotNumber === 5);
    expect(slot5).toBeDefined();
    expect(slot5?.mediaId).not.toBe('existing-hero');
    expect(slot5?.mediaId).toContain('original_slot5_upload_crescent_1');
    expect(slot5?.slotRole).toBe('REAL_PHOTO_FALLBACK');
  });

  it('TEST 10: manual Fashion Model and Silk Styled cards are not overwritten by Generate Selected', async () => {
    const clustered = await analyzeFixtureUploads('manual_guard', 2);

    const pack = await buildRecommendedGalleryPack({
      productId: 'manual-guard-test',
      productTitle: 'Manual Guard Necklace',
      clusteredItems: clustered,
      targetSlotCount: 5,
      enableStyledSlot2: true,
      enableModelGeneration: true,
      enableModelSlot4: true,
      sourceModes: {
        white: 'auto',
        model: 'manual',
        detail: 'auto',
        silk: 'manual',
        original: 'auto',
      },
    } as any);

    expect(pack.sourceModes?.model).toBe('manual');
    expect(pack.sourceModes?.silk).toBe('manual');
    expect(pack.slots.some((slot) => slot.slotRole === 'MODEL_1' || slot.slotNumber === 4)).toBe(false);
    expect(pack.slots.some((slot) => slot.slotRole === 'STYLED_SUPPORTING' || slot.slotNumber === 2)).toBe(false);

    const originalSlot = pack.slots.find((slot) => slot.slotRole === 'REAL_PHOTO_FALLBACK');
    expect(originalSlot).toBeDefined();
    expect(originalSlot?.currentBgMode).not.toBe('pure_white');
  });

  it('TEST 11: can generate only White Product without creating skipped roles', async () => {
    const clustered = await analyzeFixtureUploads('white_only', 1);

    const pack = await buildRecommendedGalleryPack({
      productId: 'white-only-test',
      productTitle: 'White Only Pendant',
      clusteredItems: clustered,
      targetSlotCount: 1,
      enableStyledSlot2: true,
      enableModelGeneration: true,
      enableModelSlot4: true,
      sourceModes: {
        white: 'auto',
        model: 'skip',
        detail: 'skip',
        silk: 'skip',
        original: 'skip',
      },
    } as any);

    expect(pack.slots).toHaveLength(1);
    expect(pack.slots[0].slotRole).toBe('HERO_COVER');
    expect(pack.slots[0].slotNumber).toBe(1);
  });

  it('TEST 12: can generate a selected combination of White Product, Detail Close-up, and Silk Styled', async () => {
    const clustered = await analyzeFixtureUploads('combo_selected', 1);

    const pack = await buildRecommendedGalleryPack({
      productId: 'combo-selected-test',
      productTitle: 'Combination Test Set',
      clusteredItems: clustered,
      targetSlotCount: 5,
      enableStyledSlot2: true,
      enableModelGeneration: true,
      enableModelSlot4: true,
      sourceModes: {
        white: 'auto',
        model: 'skip',
        detail: 'auto',
        silk: 'auto',
        original: 'skip',
      },
    } as any);

    const roles = pack.slots.map((slot) => slot.slotRole);
    expect(roles).toContain('HERO_COVER');
    expect(roles).toContain('DETAIL_CLOSEUP');
    expect(roles).toContain('STYLED_SUPPORTING');
    expect(roles).not.toContain('MODEL_1');
    expect(roles).not.toContain('REAL_PHOTO_FALLBACK');
  });

  it('TEST 13: White Product and Original Photo remain separate semantic assets', async () => {
    const clustered = await analyzeFixtureUploads('separate_assets', 1);

    const pack = await buildRecommendedGalleryPack({
      productId: 'separate-assets-test',
      productTitle: 'Separate Asset Pendant',
      clusteredItems: clustered,
      targetSlotCount: 5,
      sourceModes: {
        white: 'auto',
        model: 'skip',
        detail: 'skip',
        silk: 'skip',
        original: 'auto',
      },
    } as any);

    const white = pack.slots.find((slot) => slot.slotRole === 'HERO_COVER');
    const original = pack.slots.find((slot) => slot.slotRole === 'REAL_PHOTO_FALLBACK');

    expect(white).toBeDefined();
    expect(original).toBeDefined();
    expect(white?.url).not.toBe(original?.url);
    expect(white?.currentBgMode).toBe('pure_white');
    expect(original?.currentBgMode).not.toBe('pure_white');
  });

  it('TEST 14: legacy GalleryPack slots still publish in the new default semantic order', () => {
    const legacySlots = [
      { slotNumber: 2, slotRole: 'STYLED_SUPPORTING', url: 'silk.jpg', included: true },
      { slotNumber: 5, slotRole: 'REAL_PHOTO_FALLBACK', url: 'original.jpg', included: true },
      { slotNumber: 3, slotRole: 'DETAIL_CLOSEUP', url: 'detail.jpg', included: true },
      { slotNumber: 1, slotRole: 'HERO_COVER', url: 'white.jpg', included: true },
      { slotNumber: 4, slotRole: 'MODEL_1', url: 'model.jpg', included: true },
      { slotNumber: 6, slotRole: 'ALT_VIEW', url: 'disabled.jpg', included: false },
    ];

    const ordered = getShopifyReadyGallerySlots(legacySlots);
    expect(ordered.map((slot) => slot.url)).toEqual([
      'white.jpg',
      'model.jpg',
      'detail.jpg',
      'silk.jpg',
      'original.jpg',
    ]);
  });

  it('TEST 15: Shopify publishing keeps semantic UI reorder and filters disabled or empty cards', () => {
    const reorderedSlots = [
      { mediaPackRole: 'silk', slotNumber: 2, url: 'silk.jpg', included: true },
      { mediaPackRole: 'white', slotNumber: 1, url: 'white.jpg', included: true },
      { mediaPackRole: 'model', slotNumber: 4, url: 'model.jpg', included: false },
      { mediaPackRole: 'detail', slotNumber: 3, url: '', included: true },
      { mediaPackRole: 'original', slotNumber: 5, url: 'original.jpg', included: true },
    ];

    const ready = getShopifyReadyGallerySlots(reorderedSlots);
    expect(ready.map((slot) => slot.url)).toEqual(['silk.jpg', 'white.jpg', 'original.jpg']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PhotoRoom Credit Safety — exactly 1 PhotoRoom call per unique source hash
  // ─────────────────────────────────────────────────────────────────────────

  it('TEST 16A: easy source image calls PhotoRoom exactly once (sourceIsolationCreateCount = 1)', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    const uniqueSource = await sharp(sampleNecklaceBuffer)
      .composite([{
        input: Buffer.from(
          `<svg width="800" height="800"><text x="20" y="780" font-size="16" fill="#111111">credit-16A-${Date.now()}</text></svg>`
        ),
        top: 0,
        left: 0,
      }])
      .jpeg({ quality: 95 })
      .toBuffer();

    await createPureWhiteCover(uniqueSource, 'credit_16A.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      backgroundMode: 'pure_white',
    });

    const metrics = getBackgroundRemovalCreditMetrics();
    // sourceIsolationCreateCount is the proxy for PhotoRoom calls in tests
    // (the in-process stub increments it exactly as production would increment
    // photoroomCallCount — one time, no more).
    expect(metrics.sourceIsolationCreateCount).toBe(1);
    expect(metrics.geminiCallCount).toBe(0);
  });

  it('TEST 16B: calling PhotoRoom for the same source a second time reuses the cache (count stays at 1)', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    const uniqueSource = await sharp(sampleNecklaceBuffer)
      .composite([{
        input: Buffer.from(
          `<svg width="800" height="800"><text x="20" y="780" font-size="16" fill="#111111">credit-16B-${Date.now()}</text></svg>`
        ),
        top: 0,
        left: 0,
      }])
      .jpeg({ quality: 95 })
      .toBuffer();

    // First call — hits PhotoRoom stub (or production API)
    await createPureWhiteCover(uniqueSource, 'credit_16B_first.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      backgroundMode: 'pure_white',
    });

    const afterFirst = getBackgroundRemovalCreditMetrics();
    expect(afterFirst.sourceIsolationCreateCount).toBe(1);

    // Second call for identical source — must hit the disk cache, no new PhotoRoom call
    await createPureWhiteCover(uniqueSource, 'credit_16B_second.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      backgroundMode: 'pure_white',
    });

    const afterSecond = getBackgroundRemovalCreditMetrics();
    expect(afterSecond.sourceIsolationCreateCount).toBe(1); // unchanged
    expect(afterSecond.geminiCallCount).toBe(0);
  });

  it('TEST 16C: when PhotoRoom mask fails strict validation, Gemini fallback runs once and PhotoRoom is NOT called a second time', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    // Use a unique timestamp so this source is guaranteed not to be in the cache
    const uniqueSource = await sharp(sampleNecklaceBuffer)
      .composite([{
        input: Buffer.from(
          `<svg width="800" height="800"><text x="20" y="760" font-size="16" fill="#111111">credit-16C-${Date.now()}</text></svg>`
        ),
        top: 0,
        left: 0,
      }])
      .jpeg({ quality: 95 })
      .toBuffer();

    // Force the Gemini fallback path for the NEXT isolation call.
    // This simulates the production case where PhotoRoom mask quality fails
    // strict validation for a styled background.
    forceGeminiFallbackOnceForTests();

    await createPureWhiteCover(uniqueSource, 'credit_16C.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      backgroundMode: 'pure_white',
    });

    const metrics = getBackgroundRemovalCreditMetrics();
    // PhotoRoom was called once (the first/only call)
    expect(metrics.sourceIsolationCreateCount).toBe(1);
    // Gemini fallback was invoked once (increment in the test-env stub branch)
    expect(metrics.geminiCallCount).toBe(1);
    // sourceIsolationCreateCount must not exceed 1 — proves PhotoRoom was NOT
    // called a second time after the Gemini fallback.
    expect(metrics.sourceIsolationCreateCount).toBeLessThanOrEqual(1);
  });

  it('TEST 16D: after Gemini fallback result is persisted, a repeat request for the same source does not call PhotoRoom or Gemini again', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    const uniqueSource = await sharp(sampleNecklaceBuffer)
      .composite([{
        input: Buffer.from(
          `<svg width="800" height="800"><text x="20" y="760" font-size="16" fill="#111111">credit-16D-${Date.now()}</text></svg>`
        ),
        top: 0,
        left: 0,
      }])
      .jpeg({ quality: 95 })
      .toBuffer();

    // First call — force Gemini fallback so the persisted master comes from Gemini
    forceGeminiFallbackOnceForTests();
    await createPureWhiteCover(uniqueSource, 'credit_16D_first.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      backgroundMode: 'pure_white',
    });

    const afterFirst = getBackgroundRemovalCreditMetrics();
    expect(afterFirst.sourceIsolationCreateCount).toBe(1);
    expect(afterFirst.geminiCallCount).toBe(1);

    // Second call — same source, master already cached on disk
    // Neither PhotoRoom nor Gemini should be called
    await createPureWhiteCover(uniqueSource, 'credit_16D_second.jpg', {
      targetWidth: 2048,
      targetHeight: 2048,
      backgroundMode: 'pure_white',
    });

    const afterSecond = getBackgroundRemovalCreditMetrics();
    expect(afterSecond.sourceIsolationCreateCount).toBe(1); // unchanged
    expect(afterSecond.geminiCallCount).toBe(1); // unchanged
  });
});
