import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { db } from '../server/db/database';
import {
  generateWhiteProductImage,
  generateDetailCloseup,
  normalizeOriginalPhoto,
  resolveWhiteProductDimensions,
} from '../server/services/media/mediaPipelineService';
import {
  createPureWhiteCover,
  createDetailCraftsmanshipCrop,
  evaluateSegmentationQuality,
  validateAiHeroPresentation,
  validateDetailCloseup,
} from '../server/services/media/deterministicImageService';
import {
  generateStyledImage,
  generateModelImage,
  generateWhiteProductPresentationImage,
} from '../server/services/media/imageGenerationProvider';
import {
  buildRecommendedGalleryPack,
  regenerateSingleSlot,
} from '../server/services/media/galleryPackService';
import {
  getBackgroundRemovalCreditMetrics,
  resetBackgroundRemovalCreditMetricsForTests,
} from '../server/services/media/backgroundRemovalService';
import { DERIVATIVES_DIR } from '../server/services/photoService';

describe('Media Pack Workflow — 5-Role Jewellery Generation & Isolation Suite', () => {
  let sampleNecklaceBuffer: Buffer;

  beforeAll(async () => {
    // Generate a synthetic test necklace with chain, pendant and emerald stone
    sampleNecklaceBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 235, g: 232, b: 228 }, // Realistic studio tabletop
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <!-- Gold chain -->
              <path d="M 250,150 Q 400,450 550,150" stroke="#d4af37" stroke-width="8" fill="none" />
              <!-- Diamond pendant casing -->
              <polygon points="400,430 450,510 400,590 350,510" fill="#f5d77f" stroke="#ffffff" stroke-width="4" />
              <!-- Emerald stone -->
              <circle cx="400" cy="510" r="28" fill="#10b981" />
              <!-- Matching pair of earrings -->
              <circle cx="230" cy="220" r="18" fill="#f5d77f" />
              <circle cx="570" cy="220" r="18" fill="#f5d77f" />
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: White Product generation (#FFFFFF background, exact jewellery identity)
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 1: generates a pure white background product image with #FFFFFF corners and intact jewellery', async () => {
    const result = await generateWhiteProductImage(sampleNecklaceBuffer, 'test_item_white_sc1', {
      outputRatio: '1:1',
      occupancyPercent: 80,
    });

    expect(result.url).toBeDefined();
    expect(result.width).toBe(2048);
    expect(result.height).toBe(2048);
    expect(result.quality).toBeDefined();

    // Verify background corners are pure white (#FFFFFF)
    const localPath = path.join(DERIVATIVES_DIR, path.basename(result.url));
    expect(fs.existsSync(localPath)).toBe(true);

    const { data, info } = await sharp(localPath)
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Sample top-left corner pixel (0, 0)
    const r = data[0];
    const g = data[1];
    const b = data[2];
    expect(r).toBeGreaterThanOrEqual(250);
    expect(g).toBeGreaterThanOrEqual(250);
    expect(b).toBeGreaterThanOrEqual(250);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: White Product aspect ratio support (1:1, 4:5, 9:16)
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 2: supports 1:1, 4:5, and 9:16 aspect ratios for White Product images', async () => {
    expect(resolveWhiteProductDimensions('1:1')).toEqual({ width: 2048, height: 2048 });
    expect(resolveWhiteProductDimensions('4:5')).toEqual({ width: 1638, height: 2048 });
    expect(resolveWhiteProductDimensions('9:16')).toEqual({ width: 1152, height: 2048 });

    // Generate 4:5 portrait format
    const res45 = await generateWhiteProductImage(sampleNecklaceBuffer, 'test_item_ratio_45', {
      outputRatio: '4:5',
    });
    expect(res45.width).toBe(1638);
    expect(res45.height).toBe(2048);

    const path45 = path.join(DERIVATIVES_DIR, path.basename(res45.url));
    const meta45 = await sharp(path45).metadata();
    expect(meta45.width).toBe(1638);
    expect(meta45.height).toBe(2048);

    // Generate 9:16 story format
    const res916 = await generateWhiteProductImage(sampleNecklaceBuffer, 'test_item_ratio_916', {
      outputRatio: '9:16',
    });
    expect(res916.width).toBe(1152);
    expect(res916.height).toBe(2048);

    const path916 = path.join(DERIVATIVES_DIR, path.basename(res916.url));
    const meta916 = await sharp(path916).metadata();
    expect(meta916.width).toBe(1152);
    expect(meta916.height).toBe(2048);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: Fashion Model generation uses preset and maintains jewellery identity
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 3: Fashion Model generation uses specified styling preset and maintains product context', async () => {
    const modelRes = await generateModelImage({
      sourceImageUrl: '/api/photos/sample_necklace.jpg',
      sourceBuffer: sampleNecklaceBuffer,
      productTitle: 'Royal Kundan Emerald Necklace Set',
      presetKey: 'indian_festive',
      mediaId: 'test_model_sc3',
    });

    expect(modelRes.success).toBe(true);
    expect(modelRes.generatedImageUrl).toBeDefined();
    expect(modelRes.isDesignLocked).toBe(true);

    // Also verify via gallery pack that Slot 4 receives MODEL_1 role
    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Royal Kundan Emerald Necklace Set',
      clusteredItems: [
        {
          id: 'test_model_item_1',
          originalFilename: 'test_model_item_1.jpg',
          buffer: sampleNecklaceBuffer,
          analysis: { isBlurry: false, qualityScore: 90, sharpness: 90, lighting: 90, roleSuggestion: 'HERO', category: 'necklace' },
        } as any,
      ],
      enableModelGeneration: true,
      enableStyledSlot2: false,
      modelPresetKey: 'indian_festive',
    });
    const modelSlot = pack.slots.find((s) => s.slotNumber === 4);
    expect(modelSlot).toBeDefined();
    expect(modelSlot?.slotRole).toBe('MODEL_1');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 4: Detail Close-up generation avoids cutting important components
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 4: Detail Close-up generation creates a focused crop preserving jewellery craftsmanship', async () => {
    const detail = await generateDetailCloseup(sampleNecklaceBuffer, 'test_detail_sc4', {
      targetRegion: 'pendant',
    });

    expect(detail.url).toBeDefined();
    expect(detail.targetRegion).toBe('pendant');

    const localDetailPath = path.join(DERIVATIVES_DIR, path.basename(detail.url));
    expect(fs.existsSync(localDetailPath)).toBe(true);

    const meta = await sharp(localDetailPath).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(2048);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 5: Silk Styled image generation uses specified silk styling option
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 5: Silk Styled image generation produces flat-lay presentation with requested style option', async () => {
    const silkRes = await generateStyledImage({
      sourceImageUrl: '/api/photos/sample_necklace.jpg',
      sourceBuffer: sampleNecklaceBuffer,
      productTitle: 'Royal Kundan Emerald Necklace Set',
      styleOption: 'silk_and_flower',
      mediaId: 'test_silk_sc5',
    });

    expect(silkRes.success).toBe(true);
    expect(silkRes.generatedImageUrl).toBeDefined();

    // Also verify via gallery pack that Slot 2 receives STYLED_SUPPORTING role
    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Royal Kundan Emerald Necklace Set',
      clusteredItems: [
        {
          id: 'test_silk_item_1',
          originalFilename: 'test_silk_item_1.jpg',
          buffer: sampleNecklaceBuffer,
          analysis: { isBlurry: false, qualityScore: 90, sharpness: 90, lighting: 90, roleSuggestion: 'HERO', category: 'necklace' },
        } as any,
      ],
      enableModelGeneration: false,
      enableStyledSlot2: true,
      slot2StyleOption: 'silk_and_flower',
    });
    const silkSlot = pack.slots.find((s) => s.slotNumber === 2);
    expect(silkSlot).toBeDefined();
    expect(silkSlot?.slotRole).toBe('STYLED_SUPPORTING');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 6: Original Photo normalization preserves raw image separate from White Product
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 6: Original Photo normalization preserves raw photo and stays distinct from White Product', async () => {
    const origRes = await normalizeOriginalPhoto(sampleNecklaceBuffer, 'test_orig_sc6');
    expect(origRes.url).toBeDefined();
    expect(origRes.width).toBe(800);
    expect(origRes.height).toBe(800);

    const whiteRes = await generateWhiteProductImage(sampleNecklaceBuffer, 'test_white_sc6', {
      outputRatio: '1:1',
    });

    // URLs and derivatives must be distinct files
    expect(origRes.url).not.toEqual(whiteRes.url);

    // Original must keep original dimensions / background, while White Product is 2048x2048 pure white
    expect(whiteRes.width).toBe(2048);
    expect(whiteRes.height).toBe(2048);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 7: Selective generation allows picking any combination of the 5 roles
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 7: supports selective generation of any combination of the 5 roles', async () => {
    // Only generate white and detail
    const packSubset = await buildRecommendedGalleryPack({
      productTitle: 'Selected Roles Necklace',
      clusteredItems: [
        {
          id: 'item_subset_1',
          originalFilename: 'item_subset_1.jpg',
          buffer: sampleNecklaceBuffer,
          analysis: {
            isBlurry: false,
            qualityScore: 92,
            sharpness: 90,
            lighting: 85,
            roleSuggestion: 'HERO',
            category: 'necklace',
          },
        } as any,
      ],
      enableModelGeneration: false,
      enableStyledSlot2: false,
      sourceModes: {
        white: 'auto',
        model: 'skip',
        detail: 'auto',
        silk: 'skip',
        original: 'skip',
      },
      selectedOutputTypes: ['white', 'detail'],
    });

    const activeRoles = packSubset.slots.map((s) => s.slotRole);
    expect(activeRoles).toContain('HERO_COVER');
    expect(activeRoles).toContain('DETAIL_CLOSEUP');
    expect(activeRoles).not.toContain('MODEL_1');
    expect(activeRoles).not.toContain('REAL_PHOTO_FALLBACK');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 8: Manual upload slots are preserved and not overwritten
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 8: manual upload slots are preserved and not overwritten during automated generation', async () => {
    const packManual = await buildRecommendedGalleryPack({
      productTitle: 'Manual Protected Necklace',
      clusteredItems: [
        {
          id: 'item_manual_hero',
          originalFilename: 'item_manual_hero.jpg',
          buffer: sampleNecklaceBuffer,
          analysis: {
            isBlurry: false,
            qualityScore: 95,
            sharpness: 90,
            lighting: 88,
            roleSuggestion: 'HERO',
            category: 'necklace',
          },
        } as any,
      ],
      enableModelGeneration: true,
      enableStyledSlot2: true,
      sourceModes: {
        white: 'auto',
        model: 'manual', // Manual upload selected by user
        detail: 'auto',
        silk: 'manual',  // Manual upload selected by user
        original: 'auto',
      },
    });

    // Model and Silk should not have automated AI generation runs
    const modelSlot = packManual.slots.find((s) => s.slotRole === 'MODEL_1');
    const silkSlot = packManual.slots.find((s) => s.slotRole === 'STYLED_SUPPORTING');

    expect(modelSlot).toBeUndefined();
    expect(silkSlot).toBeUndefined();

    // White and Detail and Original slots are generated normally
    const heroSlot = packManual.slots.find((s) => s.slotRole === 'HERO_COVER');
    const detailSlot = packManual.slots.find((s) => s.slotRole === 'DETAIL_CLOSEUP');
    expect(heroSlot).toBeDefined();
    expect(detailSlot).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SCENARIO 9: Persistent isolated-master cache reuse
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 9: reuses cached isolated master on subsequent calls for the same source', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    // Call 1
    const res1 = await generateWhiteProductImage(sampleNecklaceBuffer, 'cached_source_test_1');
    expect(res1.url).toBeDefined();
    expect(res1.sourceHash).toBeDefined();

    // Call 2 with the same source image buffer
    const res2 = await generateWhiteProductImage(sampleNecklaceBuffer, 'cached_source_test_2');
    expect(res2.url).toBeDefined();
    expect(res2.cacheHit).toBe(true);
    expect(res2.sourceHash).toBe(res1.sourceHash);

    // Regenerate Slot 1 with different ratio reusing isolated master
    const testPack = await buildRecommendedGalleryPack({
      productTitle: 'Cache Test Necklace',
      clusteredItems: [
        {
          id: 'cache_source_item',
          originalFilename: 'cache_source.jpg',
          buffer: sampleNecklaceBuffer,
          analysis: {
            isBlurry: false,
            qualityScore: 90,
            sharpness: 88,
            lighting: 85,
            roleSuggestion: 'HERO',
            category: 'necklace',
          },
        } as any,
      ],
      enableModelGeneration: false,
      enableStyledSlot2: false,
    });

    const regeneratedPack = await regenerateSingleSlot(testPack, 1, {
      whiteProductOutputRatio: '4:5',
    });

    const slot1 = regeneratedPack.slots.find((s) => s.slotNumber === 1);
    expect(slot1).toBeDefined();
    expect(slot1?.dimensions).toEqual({ width: 1638, height: 2048 });
    expect(slot1?.outputRatio).toBe('4:5');
  });
});

describe('Media Pack Workflow — White Product AI Presentation & Exact Cutout Suite', () => {
  let sampleNecklaceBuffer: Buffer;

  beforeAll(async () => {
    sampleNecklaceBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 240, g: 238, b: 235 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <path d="M 200,100 Q 400,500 600,100" stroke="#d4af37" stroke-width="10" fill="none" />
              <circle cx="400" cy="500" r="35" fill="#ef4444" stroke="#d4af37" stroke-width="6" />
              <circle cx="180" cy="180" r="20" fill="#ef4444" />
              <circle cx="620" cy="180" r="20" fill="#ef4444" />
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();
  });

  // 1. White Product defaults to 1:1
  it('1. White Product defaults to 1:1 ratio and 2048x2048 dimensions', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, 'white_prod_default_test');
    expect(res.outputRatio).toBe('1:1');
    expect(res.width).toBe(2048);
    expect(res.height).toBe(2048);
  });

  // 2. Exact Cutout mode does not call generative AI
  it('2. Exact Cutout mode does not call generative AI and maintains pixel fidelity', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, 'white_prod_exact_test', {
      whiteProductMode: 'exact_cutout',
    });
    expect(res.mode).toBe('exact_cutout');
    expect(res.productMatchScore).toBe(100);
    expect(res.matchVerdict).toBe('HIGH_MATCH');
    expect(res.exactCutoutUrl).toBe(res.url);
  });

  // 3. AI Presentation invokes configured image provider
  it('3. AI Presentation invokes configured image provider (Gemini / OpenAI)', async () => {
    const resGemini = await generateWhiteProductImage(sampleNecklaceBuffer, 'white_prod_ai_gemini', {
      whiteProductMode: 'ai_presentation',
      aiProvider: 'gemini',
    });
    expect(resGemini.mode).toBe('ai_presentation');
    expect(resGemini.url).toBeDefined();

    const resOpenAI = await generateWhiteProductImage(sampleNecklaceBuffer, 'white_prod_ai_openai', {
      whiteProductMode: 'ai_presentation',
      aiProvider: 'openai',
    });
    expect(resOpenAI.mode).toBe('ai_presentation');
    expect(resOpenAI.url).toBeDefined();
  });

  // 4. AI Presentation reuses cached isolated master and causes zero additional PhotoRoom calls
  it('4. AI Presentation reuses cached isolated master and causes zero additional PhotoRoom calls', async () => {
    const freshSourceBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 242, g: 231, b: 219 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <rect x="250" y="250" width="300" height="300" fill="#d4af37" />
              <text x="50" y="750">fresh-${Date.now()}-${Math.random()}</text>
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    resetBackgroundRemovalCreditMetricsForTests();

    // Call 1: Pre-warm / create isolated master
    const exactRes = await generateWhiteProductImage(freshSourceBuffer, 'white_prod_reuse_master', {
      whiteProductMode: 'exact_cutout',
    });
    const metricsFirst = getBackgroundRemovalCreditMetrics();
    expect(metricsFirst.sourceIsolationCreateCount).toBe(1);

    // Call 2: AI Presentation on the same source
    const aiRes = await generateWhiteProductImage(freshSourceBuffer, 'white_prod_reuse_master_ai', {
      whiteProductMode: 'ai_presentation',
    });
    const metricsSecond = getBackgroundRemovalCreditMetrics();
    // Verification: zero additional PhotoRoom calls
    expect(metricsSecond.sourceIsolationCreateCount).toBe(metricsFirst.sourceIsolationCreateCount);
    expect(aiRes.cacheHit).toBe(true);
    expect(aiRes.sourceHash).toBe(exactRes.sourceHash);
  });

  // 5. AI Presentation output is normalized to exact dimensions (2048x2048, 1638x2048, 1152x2048)
  it('5. AI Presentation output is normalized to exact dimensions: 2048x2048 for 1:1, 1638x2048 for 4:5, 1152x2048 for 9:16', async () => {
    const res1 = await generateWhiteProductImage(sampleNecklaceBuffer, 'norm_1_1', {
      whiteProductMode: 'ai_presentation',
      outputRatio: '1:1',
    });
    const file1 = path.join(DERIVATIVES_DIR, path.basename(res1.url));
    const meta1 = await sharp(file1).metadata();
    expect(meta1.width).toBe(2048);
    expect(meta1.height).toBe(2048);

    const res2 = await generateWhiteProductImage(sampleNecklaceBuffer, 'norm_4_5', {
      whiteProductMode: 'ai_presentation',
      outputRatio: '4:5',
    });
    const file2 = path.join(DERIVATIVES_DIR, path.basename(res2.url));
    const meta2 = await sharp(file2).metadata();
    expect(meta2.width).toBe(1638);
    expect(meta2.height).toBe(2048);

    const res3 = await generateWhiteProductImage(sampleNecklaceBuffer, 'norm_9_16', {
      whiteProductMode: 'ai_presentation',
      outputRatio: '9:16',
    });
    const file3 = path.join(DERIVATIVES_DIR, path.basename(res3.url));
    const meta3 = await sharp(file3).metadata();
    expect(meta3.width).toBe(1152);
    expect(meta3.height).toBe(2048);
  });

  // 6. Product Match analysis runs after AI Presentation
  it('6. Product Match analysis runs after AI Presentation returning score and verdict', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, 'white_prod_match_analysis', {
      whiteProductMode: 'ai_presentation',
    });
    expect(res.productMatchScore).toBeDefined();
    expect(typeof res.productMatchScore).toBe('number');
    expect(res.productMatchScore).toBeGreaterThanOrEqual(0);
    expect(res.productMatchScore).toBeLessThanOrEqual(100);
    expect(res.matchVerdict).toBeDefined();
    expect(['HIGH_MATCH', 'REVIEW_RECOMMENDED', 'NEEDS_REVIEW']).toContain(res.matchVerdict);
  });

  // 7. Score < 80 marks output NEEDS REVIEW
  it('7. Score < 80 marks output NEEDS REVIEW', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, 'white_prod_score_low', {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 74,
    });
    expect(res.productMatchScore).toBe(74);
    expect(res.matchVerdict).toBe('NEEDS_REVIEW');
  });

  // 8. Score >= 90 marks HIGH MATCH
  it('8. Score >= 90 marks HIGH MATCH', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, 'white_prod_score_high', {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 96,
    });
    expect(res.productMatchScore).toBe(96);
    expect(res.matchVerdict).toBe('HIGH_MATCH');
  });

  // 9. AI generation never overwrites Original Photo
  it('9. AI generation never overwrites Original Photo (Slot 5 preserves authentic raw photo)', async () => {
    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Original Safeguard Necklace',
      clusteredItems: [
        {
          id: 'item_original_safeguard',
          originalFilename: 'real_source_photo.jpg',
          buffer: sampleNecklaceBuffer,
          analysis: {
            isBlurry: false,
            qualityScore: 90,
            sharpness: 88,
            lighting: 85,
            roleSuggestion: 'HERO',
            category: 'necklace',
          },
        } as any,
      ],
      whiteProductMode: 'ai_presentation',
      enableModelGeneration: false,
      enableStyledSlot2: false,
    });

    const slot1 = pack.slots.find((s) => s.slotNumber === 1);
    const slot5 = pack.slots.find((s) => s.slotNumber === 5);

    expect(slot1).toBeDefined();
    expect(slot5).toBeDefined();
    expect(slot1?.slotRole).toBe('HERO_COVER');
    expect(slot5?.slotRole).toBe('REAL_PHOTO_FALLBACK');
    // White Product and Original Photo have distinct URLs
    expect(slot1?.url).not.toBe(slot5?.url);
    // Original photo URL is untouched
    expect(slot5?.url).toContain('real_source_photo.jpg');
  });

  // 10. Regeneration does not invoke PhotoRoom again
  it('10. Regeneration of AI Presentation does not invoke PhotoRoom again', async () => {
    const regenFilename = `regen_source_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`;
    const regenSourceBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 243, g: 232, b: 221 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <circle cx="400" cy="400" r="150" fill="#10b981" />
              <text x="50" y="750">regen-${Date.now()}-${Math.random()}</text>
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    resetBackgroundRemovalCreditMetricsForTests();

    // Initial pack generation
    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Regen Test Jewellery',
      clusteredItems: [
        {
          id: 'item_regen_source',
          originalFilename: regenFilename,
          buffer: regenSourceBuffer,
          analysis: {
            isBlurry: false,
            qualityScore: 92,
            sharpness: 90,
            lighting: 88,
            roleSuggestion: 'HERO',
            category: 'necklace',
          },
        } as any,
      ],
      whiteProductMode: 'ai_presentation',
      enableModelGeneration: false,
      enableStyledSlot2: false,
    });

    const metricsAfterBuild = getBackgroundRemovalCreditMetrics();
    expect(metricsAfterBuild.sourceIsolationCreateCount).toBe(1);

    // Regeneration with different provider and ratio
    const regenPack = await regenerateSingleSlot(pack, 1, {
      whiteProductMode: 'ai_presentation',
      whiteProductOutputRatio: '4:5',
      whiteProductAiProvider: 'openai',
    });

    const metricsAfterRegen = getBackgroundRemovalCreditMetrics();
    // Credit safety guarantee: count does not increase!
    expect(metricsAfterRegen.sourceIsolationCreateCount).toBe(metricsAfterBuild.sourceIsolationCreateCount);

    const regeneratedSlot1 = regenPack.slots.find((s) => s.slotNumber === 1);
    expect(regeneratedSlot1).toBeDefined();
    expect(regeneratedSlot1?.outputRatio).toBe('4:5');
    expect(regeneratedSlot1?.dimensions).toEqual({ width: 1638, height: 2048 });
  });
});

describe('Media Pack Studio — Acceptance Suite: AI Hero & Detail Close-Up Pipeline', () => {
  let sampleNecklaceBuffer: Buffer;

  beforeAll(async () => {
    sampleNecklaceBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 238, g: 235, b: 230 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <polygon points="400,430 450,510 400,590 350,510" fill="#2563eb" stroke="#cbd5e1" stroke-width="4" />
              <circle cx="400" cy="510" r="26" fill="#1d4ed8" />
              <circle cx="250" cy="240" r="16" fill="#1d4ed8" />
              <circle cx="550" cy="240" r="16" fill="#1d4ed8" />
              <path d="M 250 240 Q 400 380 400 430 Q 400 380 550 240" fill="none" stroke="#94a3b8" stroke-width="5" />
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();
  });

  // AI HERO ACCEPTANCE TESTS (1 to 9)

  // 1. AI Presentation improves presentability while preserving product identity
  it('1. AI Presentation improves presentability while preserving product identity', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, `pres_id_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 95,
      productTitle: 'Royal Blue Sapphire Necklace Set',
    });
    expect(res.mode).toBe('ai_presentation');
    expect(res.isolatedMasterUrl).toBeDefined();
    expect(res.inputReferenceUsed).toBe('ISOLATED_MASTER');
    expect(res.url).toContain('/api/photos/derivatives/');
    expect(res.occupancyPercent).toBeDefined();
    expect(res.occupancyPercent!.width).toBeGreaterThanOrEqual(60);
    expect(res.occupancyPercent!.height).toBeGreaterThanOrEqual(65);
  });

  // 2. AI hero output stays pure white
  it('2. AI hero output stays pure white', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, `pure_white_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      outputRatio: '1:1',
      mockScoreForTests: 95,
    });
    const diskPath = path.join(DERIVATIVES_DIR, path.basename(res.url));
    const heroBuf = fs.readFileSync(diskPath);
    const val = await validateAiHeroPresentation(heroBuf, { matchScore: 95 });
    expect(val.hasWhiteBackground).toBe(true);
    expect(val.valid).toBe(true);

    const { data } = await sharp(heroBuf).raw().toBuffer({ resolveWithObject: true });
    // Pure white #FFFFFF outer pixel
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(255);
    expect(data[2]).toBe(255);
  });

  // 3. AI hero supports 1:1, 4:5, 9:16 correctly
  it('3. AI hero supports 1:1, 4:5, 9:16 correctly', async () => {
    const r11 = await generateWhiteProductImage(sampleNecklaceBuffer, `r11_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      outputRatio: '1:1',
      mockScoreForTests: 95,
    });
    expect(r11.width).toBe(2048);
    expect(r11.height).toBe(2048);

    const r45 = await generateWhiteProductImage(sampleNecklaceBuffer, `r45_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      outputRatio: '4:5',
      mockScoreForTests: 95,
    });
    expect(r45.width).toBe(1638);
    expect(r45.height).toBe(2048);

    const r916 = await generateWhiteProductImage(sampleNecklaceBuffer, `r916_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      outputRatio: '9:16',
      mockScoreForTests: 95,
    });
    expect(r916.width).toBe(1152);
    expect(r916.height).toBe(2048);
  });

  // 4. Underexposed/dark source results in non-black, visually recoverable stone appearance
  it('4. Underexposed/dark source results in non-black, visually recoverable stone appearance', async () => {
    const darkSource = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 45, g: 42, b: 40 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <polygon points="400,430 450,510 400,590 350,510" fill="#0f172a" stroke="#475569" stroke-width="4" />
              <circle cx="400" cy="510" r="26" fill="#1e293b" />
              <circle cx="250" cy="240" r="16" fill="#1e293b" />
              <circle cx="550" cy="240" r="16" fill="#1e293b" />
              <path d="M 250 240 Q 400 380 400 430 Q 400 380 550 240" fill="none" stroke="#64748b" stroke-width="5" />
            </svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    const res = await generateWhiteProductImage(darkSource, `dark_recov_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 92,
    });

    const diskPath = path.join(DERIVATIVES_DIR, path.basename(res.url));
    const heroBuf = fs.readFileSync(diskPath);
    const val = await validateAiHeroPresentation(heroBuf, { matchScore: 92 });
    expect(val.stonesTooDark).toBe(false);
    expect(val.hasWhiteBackground).toBe(true);
  });

  // 5. Chain alignment is centered/balanced within tolerance
  it('5. Chain alignment is centered/balanced within tolerance', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, `chain_align_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 95,
    });
    const diskPath = path.join(DERIVATIVES_DIR, path.basename(res.url));
    const heroBuf = fs.readFileSync(diskPath);
    const val = await validateAiHeroPresentation(heroBuf, { matchScore: 95 });
    expect(val.chainMisaligned).toBe(false);
    expect(val.pendantMisaligned).toBe(false);
  });

  // 6. Earrings are evenly positioned in hero layout
  it('6. Earrings are evenly positioned in hero layout', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, `earrings_pos_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 95,
    });
    const diskPath = path.join(DERIVATIVES_DIR, path.basename(res.url));
    const heroBuf = fs.readFileSync(diskPath);
    const val = await validateAiHeroPresentation(heroBuf, { matchScore: 95 });
    expect(val.earringsUneven).toBe(false);
  });

  // 7. Existing isolated master is reused with no extra PhotoRoom call
  it('7. Existing isolated master is reused with no extra PhotoRoom call', async () => {
    const uniqueSource = await sharp(sampleNecklaceBuffer)
      .composite([{
        input: Buffer.from(`<svg width="800" height="800"><text x="10" y="770">pr-reuse-${Date.now()}</text></svg>`),
        top: 0,
        left: 0,
      }])
      .jpeg({ quality: 90 })
      .toBuffer();

    await generateWhiteProductImage(uniqueSource, `pr_first_${Date.now()}`, {
      whiteProductMode: 'exact_cutout',
    });

    resetBackgroundRemovalCreditMetricsForTests();
    const countBefore = getBackgroundRemovalCreditMetrics().sourceIsolationCreateCount;

    const aiHero = await generateWhiteProductImage(uniqueSource, `pr_second_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 95,
    });

    const countAfter = getBackgroundRemovalCreditMetrics().sourceIsolationCreateCount;
    expect(countAfter).toBe(countBefore);
    expect(aiHero.cacheHit).toBe(true);
    expect(aiHero.inputReferenceUsed).toBe('ISOLATED_MASTER');
  });

  // 8. Failed AI hero below threshold is marked NEEDS REVIEW
  it('8. Failed AI hero below threshold is marked NEEDS REVIEW', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, `needs_rev_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 76,
    });
    expect(res.productMatchScore).toBe(76);
    expect(res.matchVerdict).toBe('NEEDS_REVIEW');
    expect(res.url).toBe(res.exactCutoutUrl);
    expect(res.mode).toBe('exact_cutout');
    expect(res.aiPresentationUrl).toBeDefined();
  });

  // 9. Exact Cutout remains available as fallback
  it('9. Exact Cutout remains available as fallback', async () => {
    const res = await generateWhiteProductImage(sampleNecklaceBuffer, `fallback_avail_${Date.now()}`, {
      whiteProductMode: 'ai_presentation',
      mockScoreForTests: 95,
    });
    expect(res.exactCutoutUrl).toBeDefined();
    expect(res.exactCutoutUrl).toContain('.jpg');
    expect(res.url).not.toBe(res.exactCutoutUrl);
  });

  // DETAIL CLOSE-UP ACCEPTANCE TESTS (10 to 15)

  // 10. Detail close-up never returns black output
  it('10. Detail close-up never returns black output', async () => {
    const detail = await createDetailCraftsmanshipCrop(
      sampleNecklaceBuffer,
      `no_black_${Date.now()}.jpg`,
      'pendant'
    );
    expect(detail.buffer).toBeDefined();
    expect(detail.buffer.length).toBeGreaterThan(0);
    const val = await validateDetailCloseup(detail.buffer);
    expect(val.isMostlyBlack).toBe(false);
  });

  // 11. Detail close-up never returns empty/near-empty output
  it('11. Detail close-up never returns empty/near-empty output', async () => {
    const detail = await createDetailCraftsmanshipCrop(
      sampleNecklaceBuffer,
      `no_empty_${Date.now()}.jpg`,
      'pendant'
    );
    const val = await validateDetailCloseup(detail.buffer);
    expect(val.isMostlyBlank).toBe(false);
    expect(val.foregroundAreaRatio).toBeGreaterThanOrEqual(0.02);
    expect(val.entropy).toBeGreaterThanOrEqual(8);
  });

  // 12. Detail close-up generates valid pendant-focused crop
  it('12. Detail close-up generates valid pendant-focused crop', async () => {
    const detail = await createDetailCraftsmanshipCrop(
      sampleNecklaceBuffer,
      `pendant_crop_${Date.now()}.jpg`,
      'pendant'
    );
    const val = await validateDetailCloseup(detail.buffer);
    expect(val.valid).toBe(true);
    expect(val.subjectExcluded).toBe(false);

    const meta = await sharp(detail.buffer).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(2048);
  });

  // 13. Detail close-up can generate valid earrings-focused crop
  it('13. Detail close-up can generate valid earrings-focused crop', async () => {
    const detail = await createDetailCraftsmanshipCrop(
      sampleNecklaceBuffer,
      `earrings_crop_${Date.now()}.jpg`,
      'earrings'
    );
    const val = await validateDetailCloseup(detail.buffer);
    expect(val.valid).toBe(true);

    const meta = await sharp(detail.buffer).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(2048);
  });

  // 14. If first closeup attempt fails, fallback crop succeeds
  it('14. If first closeup attempt fails, fallback crop succeeds', async () => {
    const detail = await createDetailCraftsmanshipCrop(
      sampleNecklaceBuffer,
      `fallback_crop_${Date.now()}.jpg`,
      'pendant',
      { x: 0, y: 0, width: 0, height: 0 }
    );
    expect(detail.buffer).toBeDefined();
    const val = await validateDetailCloseup(detail.buffer);
    expect(val.isMostlyBlack).toBe(false);
    expect(val.isMostlyBlank).toBe(false);
    expect(val.valid).toBe(true);
  });

  // 15. Slot 3 is always populated with a visible jewellery crop when generation succeeds
  it('15. Slot 3 is always populated with a visible jewellery crop when generation succeeds', async () => {
    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Craftsmanship Royal Necklace Set',
      clusteredItems: [
        {
          id: 'item_slot3_pop',
          originalFilename: 'slot3_source.jpg',
          buffer: sampleNecklaceBuffer,
          analysis: {
            isBlurry: false,
            qualityScore: 92,
            sharpness: 90,
            lighting: 88,
            roleSuggestion: 'HERO',
            category: 'necklace',
          },
        } as any,
      ],
      whiteProductMode: 'ai_presentation',
      enableModelGeneration: false,
      enableStyledSlot2: false,
    });

    const slot3 = pack.slots.find((s) => s.slotNumber === 3);
    expect(slot3).toBeDefined();
    expect(slot3?.url).toBeDefined();
    expect(slot3?.url).not.toBe('');
    expect(slot3?.url).toContain('/api/photos/derivatives/detail_closeup_');
    expect(slot3?.generationFailed).toBe(false);

    const diskPath = path.join(DERIVATIVES_DIR, path.basename(slot3!.url));
    expect(fs.existsSync(diskPath)).toBe(true);
    const val = await validateDetailCloseup(fs.readFileSync(diskPath));
    expect(val.isMostlyBlack).toBe(false);
    expect(val.isMostlyBlank).toBe(false);
  });
});
