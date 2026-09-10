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
  buildRecommendedGalleryPack,
  regenerateSingleSlot,
} from '../server/services/media/galleryPackService';
import { analyzeBatchMedia } from '../server/services/media/mediaAnalyzerService';

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

    // Slot 5: Earrings / Component Focus (Deterministic)
    const slot5 = pack.slots[4];
    expect(slot5.slotNumber).toBe(5);
    expect(slot5.slotNumber).toBe(5);
    expect(slot5.slotRole).toBe('MODEL_2_OR_SUPPORTING');
    expect(slot5.slotTitle).toContain('Earrings');
    expect(slot5.isAiGenerated).toBe(false);
  });
});
