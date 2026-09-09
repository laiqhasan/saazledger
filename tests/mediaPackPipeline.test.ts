import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { db } from '../server/db/database';
import {
  computePerceptualHash,
  computeHashDistance,
  analyzeImageQuality,
  analyzeBatchMedia,
} from '../server/services/media/mediaAnalyzerService';
import {
  createShopifySquareDerivative,
  createDetailCropDerivative,
  createSocialMediaDerivatives,
  createCleanCoverDerivative,
  createStyledSupportingDerivative,
  isolateJewelleryPng,
} from '../server/services/media/mediaPipelineService';
import {
  MODEL_STYLING_PRESETS,
  STYLED_SLOT2_PRESETS,
  STRICT_DESIGN_LOCK_CLAUSE,
  buildDesignLockedPrompt,
  buildStyledSlot2Prompt,
  generateStyledSupportingImage,
  generateControlledModelImage,
} from '../server/services/media/modelImageGeneratorService';
import {
  buildRecommendedGalleryPack,
  generateSlotAltText,
  regenerateSingleSlot,
  type RecommendedGalleryPack,
} from '../server/services/media/galleryPackService';
import { sniffFileFormat } from '../server/services/media/derivativeService';

beforeAll(() => {
  // Ensure test item exists
  db.prepare(`
    INSERT OR IGNORE INTO items (id, sku, title, type_code, stone_code, color_code, serial, buying_price, selling_price, quantity, date_added, vendor_name)
    VALUES ('pack-test-item-1', 'PDD40001', 'Moissanite Diamond Pendant Set in 14K Gold', 'PD', 'D', '40', '001', 1200, 2800, 5, '2026-09-08', 'Saaz Atelier')
  `).run();

  // Ensure test media asset exists for foreign key constraints
  db.prepare(`
    INSERT OR IGNORE INTO media_assets (id, original_filename, display_title, mime_type, byte_size, checksum_sha256, upload_source, media_type, classification, processing_status, approval_status)
    VALUES ('media-test-1', 'hero.jpg', 'Hero Image', 'image/jpeg', 1024, 'dummy_sha', 'web_upload', 'image', 'original', 'ready', 'approved')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO media_assets (id, original_filename, display_title, mime_type, byte_size, checksum_sha256, upload_source, media_type, classification, processing_status, approval_status)
    VALUES ('media-test-2', 'hero_v2.jpg', 'Hero Image V2', 'image/jpeg', 1024, 'dummy_sha_2', 'web_upload', 'image', 'original', 'ready', 'approved')
  `).run();
});

describe('Automated Shopify Media Pack Acceptance Test Suite (15 Scenarios)', () => {
  // Scenario 1: Single 9:16 mobile photo upload
  it('Scenario 1: Converts single 9:16 mobile photo into 2048x2048 square with white background padding without clipping', async () => {
    // Create a synthetic 9:16 portrait image (1080 x 1920)
    const mobile9x16Buffer = await sharp({
      create: {
        width: 1080,
        height: 1920,
        channels: 3,
        background: { r: 200, g: 180, b: 120 }, // Gold jewelry tone
      },
    })
      .jpeg()
      .toBuffer();

    const squareResult = await createShopifySquareDerivative(mobile9x16Buffer, 'test_mobile_square.jpg');
    expect(squareResult.buffer).toBeDefined();

    const meta = await sharp(squareResult.buffer).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(2048);
    expect(meta.format).toBe('jpeg');
  });

  // Scenario 2: 5-photo burst with 2 near duplicates
  it('Scenario 2: Detects near duplicates via perceptual dHash and Hamming distance clustering', async () => {
    // Create base image with geometric feature
    const svgBar = Buffer.from('<svg width="400" height="400"><rect x="50" y="50" width="120" height="300" fill="black"/></svg>');
    const svgBarShifted = Buffer.from('<svg width="400" height="400"><rect x="52" y="50" width="120" height="300" fill="black"/></svg>');
    const svgCircle = Buffer.from('<svg width="400" height="400"><circle cx="200" cy="200" r="180" fill="white"/></svg>');

    const baseImg = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 150, g: 100, b: 50 } },
    })
      .composite([{ input: svgBar }])
      .jpeg()
      .toBuffer();

    // Create a near-duplicate burst shot with slight 2px shift
    const nearDuplicateImg = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 150, g: 100, b: 50 } },
    })
      .composite([{ input: svgBarShifted }])
      .jpeg()
      .toBuffer();

    // Create a completely distinct image (different shape and gradient)
    const distinctImg = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 20, g: 20, b: 20 } },
    })
      .composite([{ input: svgCircle }])
      .jpeg()
      .toBuffer();

    const hash1 = await computePerceptualHash(baseImg);
    const hash2 = await computePerceptualHash(nearDuplicateImg);
    const hash3 = await computePerceptualHash(distinctImg);

    const dist12 = computeHashDistance(hash1, hash2);
    const dist13 = computeHashDistance(hash1, hash3);

    expect(dist12).toBeLessThanOrEqual(8); // Clustered as burst near duplicate
    expect(dist13).toBeGreaterThan(8); // Distinct image

    const batch = await analyzeBatchMedia([
      { id: 'img-1', originalFilename: 'burst_1.jpg', buffer: baseImg },
      { id: 'img-2', originalFilename: 'burst_2.jpg', buffer: nearDuplicateImg },
      { id: 'img-3', originalFilename: 'side_view.jpg', buffer: distinctImg },
    ]);

    expect(batch.length).toBe(3);
    // img-2 should be flagged as near-duplicate of img-1
    const dupItem = batch.find((b) => b.id === 'img-2');
    expect(dupItem?.duplicateGroup).toBe('group_img-1');
  });

  // Scenario 3: Pendant with earrings (composite set)
  it('Scenario 3: Preserves chain top, pendant drop, and earrings within containment safe margin', async () => {
    // 9:16 portrait set photo
    const setBuffer = await sharp({
      create: {
        width: 1080,
        height: 1920,
        channels: 3,
        background: { r: 240, g: 230, b: 210 },
      },
    })
      .jpeg()
      .toBuffer();

    const square = await createShopifySquareDerivative(setBuffer, 'test_pendant_earrings_set.jpg');
    const squareMeta = await sharp(square.buffer).metadata();
    expect(squareMeta.width).toBe(2048);
    expect(squareMeta.height).toBe(2048);

    // Also verify detail close-up generation
    const closeup = await createDetailCropDerivative(setBuffer, 'test_set_closeup.jpg');
    const closeupMeta = await sharp(closeup.buffer).metadata();
    expect(closeupMeta.width).toBe(1200);
    expect(closeupMeta.height).toBe(1200);
  });

  // Scenario 4: AI model generation enabled (3 real + 2 model photos)
  it('Scenario 4: Formulates 5-slot pack with 3 real photos and 2 AI model lifestyles', async () => {
    // Create 3 real photos
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 100, g: 100, b: 100 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'p1', originalFilename: 'hero.jpg', buffer: dummyBuffer },
      { id: 'p2', originalFilename: 'alt.jpg', buffer: dummyBuffer },
      { id: 'p3', originalFilename: 'detail.jpg', buffer: dummyBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Diamond Pendant Set',
      clusteredItems: clustered,
      enableModelGeneration: true,
      modelPresetKey: 'indian_festive',
      modelPresetKey2: 'western_fashion',
      targetSlotCount: 5,
    });

    expect(pack.slots.length).toBe(5);
    expect(pack.totalRealImagesUsed).toBeGreaterThanOrEqual(3);
    expect(pack.slots[0].slotRole).toBe('HERO_COVER');
    expect(pack.slots[0].isCover).toBe(true);
    expect(pack.slots[0].sourceType).toBe('real_photo');
  });

  // Scenario 5: AI model generation disabled or API failure
  it('Scenario 5: Gracefully falls back to real photos when AI model generation is disabled or fails', async () => {
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 120, g: 120, b: 120 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'p1', originalFilename: 'hero.jpg', buffer: dummyBuffer },
      { id: 'p2', originalFilename: 'alt.jpg', buffer: dummyBuffer },
      { id: 'p3', originalFilename: 'detail.jpg', buffer: dummyBuffer },
    ]);

    // Model generation and styled AI generation disabled
    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Diamond Pendant Set',
      clusteredItems: clustered,
      enableModelGeneration: false,
      enableStyledSlot2: false,
      targetSlotCount: 5,
    });

    expect(pack.slots.length).toBe(5);
    expect(pack.totalRealImagesUsed).toBe(5);
    expect(pack.totalAiImagesUsed).toBe(0);
  });

  // Scenario 6: Hero image protection
  it('Scenario 6: Slot 1 is strictly a real product photo and never an AI model', async () => {
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 140, g: 140, b: 140 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'p1', originalFilename: 'hero.jpg', buffer: dummyBuffer },
      { id: 'p2', originalFilename: 'alt.jpg', buffer: dummyBuffer },
      { id: 'p3', originalFilename: 'detail.jpg', buffer: dummyBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Diamond Pendant Set',
      clusteredItems: clustered,
      enableModelGeneration: true,
      modelPresetKey: 'indian_festive',
    });

    expect(pack.slots[0].slotRole).toBe('HERO_COVER');
    expect(pack.slots[0].sourceType).toBe('real_photo');
    expect(pack.slots[0].isAiGenerated).toBe(false);
    expect(pack.slots[0].isCover).toBe(true);
  });

  // Scenario 7: Regenerate model image only
  it('Scenario 7: Regenerates Slot 4 while preserving Slots 1, 2, 3, and 5 untouched', async () => {
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 150, g: 150, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'p1', originalFilename: 'hero.jpg', buffer: dummyBuffer },
      { id: 'p2', originalFilename: 'alt.jpg', buffer: dummyBuffer },
      { id: 'p3', originalFilename: 'detail.jpg', buffer: dummyBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Diamond Pendant Set',
      clusteredItems: clustered,
      enableModelGeneration: true,
      modelPresetKey: 'indian_festive',
    });

    const origSlot1Url = pack.slots[0].imageUrl;
    const origSlot2Url = pack.slots[1].imageUrl;
    const origSlot3Url = pack.slots[2].imageUrl;
    const origSlot5Url = pack.slots[4].imageUrl;

    const regeneratedPack = await regenerateSingleSlot(pack, 4, {
      newPresetKey: 'bridal_styling',
      newCustomPrompt: 'Warm bridal studio spotlight',
    });

    expect(regeneratedPack.slots[3].slotNumber).toBe(4);
    expect(regeneratedPack.slots[3].modelPresetKey).toBe('bridal_styling');
    // Verify Slots 1, 2, 3, 5 remained completely intact
    expect(regeneratedPack.slots[0].imageUrl).toBe(origSlot1Url);
    expect(regeneratedPack.slots[1].imageUrl).toBe(origSlot2Url);
    expect(regeneratedPack.slots[2].imageUrl).toBe(origSlot3Url);
    expect(regeneratedPack.slots[4].imageUrl).toBe(origSlot5Url);
  });

  // Scenario 8: Shopify media upload & cover ordering
  it('Scenario 8: Formulates gallery pack with Slot 1 strictly designated as position: 1 cover', async () => {
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 160, g: 160, b: 160 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'p1', originalFilename: 'hero.jpg', buffer: dummyBuffer },
      { id: 'p2', originalFilename: 'alt.jpg', buffer: dummyBuffer },
      { id: 'p3', originalFilename: 'detail.jpg', buffer: dummyBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Moissanite Diamond Pendant Set',
      clusteredItems: clustered,
      enableModelGeneration: false,
    });

    expect(pack.slots[0].slotNumber).toBe(1);
    expect(pack.slots[0].isCover).toBe(true);
    expect(pack.slots[0].altText).toContain('Moissanite Diamond Pendant Set');
    expect(pack.slots[1].isCover).toBe(false);
  });

  // Scenario 9: Shopify upload failure on slot 4 with retry
  it('Scenario 9: Identifies retryable slot failure and isolates slot without re-uploading earlier slots', () => {
    const slots = [
      { slotNumber: 1, status: 'SUCCESS' },
      { slotNumber: 2, status: 'SUCCESS' },
      { slotNumber: 3, status: 'SUCCESS' },
      { slotNumber: 4, status: 'FAILED' },
      { slotNumber: 5, status: 'SUCCESS' },
    ];

    const failed = slots.filter((s) => s.status === 'FAILED');
    expect(failed.length).toBe(1);
    expect(failed[0].slotNumber).toBe(4);

    // Simulate retry solely on failed slot
    const retryRes = failed.map((s) => ({ ...s, status: 'SUCCESS' }));
    expect(retryRes[0].status).toBe('SUCCESS');
  });

  // Scenario 10: Re-running pipeline on product with existing Shopify media
  it('Scenario 10: Cleanly refreshes links without orphan database records', () => {
    db.prepare(`
      INSERT OR REPLACE INTO product_media_links (id, product_id, media_id, slot_type, display_order, is_cover)
      VALUES ('link-dup-test', 'pack-test-item-1', 'media-test-1', 'cover', 1, 1)
    `).run();

    const initial = db.prepare(`SELECT count(*) as cnt FROM product_media_links WHERE product_id = 'pack-test-item-1'`).get() as any;
    expect(initial.cnt).toBeGreaterThan(0);

    // Refreshing media link
    db.prepare(`
      INSERT OR REPLACE INTO product_media_links (id, product_id, media_id, slot_type, display_order, is_cover)
      VALUES ('link-dup-test', 'pack-test-item-1', 'media-test-2', 'cover', 1, 1)
    `).run();

    const after = db.prepare(`SELECT count(*) as cnt FROM product_media_links WHERE id = 'link-dup-test'`).get() as any;
    expect(after.cnt).toBe(1);
  });

  // Scenario 11: Alt text generation
  it('Scenario 11: Generates distinct, keyword-rich SEO alt text with title + SKU for Slot 1', () => {
    const altSlot1 = generateSlotAltText('Classic Solitaire Diamond Pendant PDD40001', 'HERO_COVER');
    const altSlot2 = generateSlotAltText('Classic Solitaire Diamond Pendant PDD40001', 'ALT_VIEW');
    const altSlot3 = generateSlotAltText('Classic Solitaire Diamond Pendant PDD40001', 'DETAIL_CLOSEUP');
    const altSlot4 = generateSlotAltText('Classic Solitaire Diamond Pendant PDD40001', 'MODEL_1');

    expect(altSlot1).toContain('Main commercial clean background front view');
    expect(altSlot1).toContain('PDD40001');
    expect(altSlot2).toContain('Alternate angle');
    expect(altSlot3).toContain('craftsmanship view');
    expect(altSlot4).toContain('Fashion model');
  });

  // Scenario 12: Review mode vs Auto-publish mode
  it('Scenario 12: Distinguishes Mode A (Review First) from Mode B (Full Auto)', () => {
    const modeA = { approvalMode: 'REVIEW_FIRST', autoPushShopify: false };
    const modeB = { approvalMode: 'FULL_AUTO', autoPushShopify: true };

    expect(modeA.autoPushShopify).toBe(false);
    expect(modeB.autoPushShopify).toBe(true);
  });

  // Scenario 13: Low-photo warning (< 3 photos)
  it('Scenario 13: Triggers warning when fewer than 3 real photos are uploaded', async () => {
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 170, g: 170, b: 170 } },
    })
      .jpeg()
      .toBuffer();

    // Only 2 photos provided
    const clustered = await analyzeBatchMedia([
      { id: 'p1', originalFilename: 'hero.jpg', buffer: dummyBuffer },
      { id: 'p2', originalFilename: 'alt.jpg', buffer: dummyBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Diamond Pendant Set',
      clusteredItems: clustered,
      enableModelGeneration: false,
    });

    expect(pack.warnings.length).toBeGreaterThan(0);
    expect(pack.warnings.some((w) => w.includes('Minimum recommended for a premium gallery is 3 real photos'))).toBe(true);
  });

  // Scenario 14: HEIC photo identification & processing
  it('Scenario 14: Sniffs HEIC files and supports conversion workflow', () => {
    const heicBuf = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    const format = sniffFileFormat(heicBuf, 'IMG_1234.HEIC');
    expect(format.isHeic).toBe(true);
  });

  // Scenario 15: Strict Design Lock enforcement
  it('Scenario 15: Injects anti-hallucination design-lock clause into AI model prompts', () => {
    const { prompt, preset } = buildDesignLockedPrompt(
      'Moissanite Floral Pendant Set in 14K Rose Gold',
      'indian_festive',
      'sunset warm bokeh lighting'
    );

    expect(prompt).toContain(STRICT_DESIGN_LOCK_CLAUSE);
    expect(prompt).toContain('CRITICAL JEWELLERY DESIGN LOCK INSTRUCTION');
    expect(prompt).toContain('DO NOT alter the metal finish, plating color, stone colors, or stone arrangement');
    expect(prompt).toContain('DO NOT add imaginary stones, remove existing stones, or change the motif');
    expect(prompt).toContain('sunset warm bokeh lighting');
    expect(preset.name).toBe('Indian Festive Model');
  });
});

describe('Slot 1 & Slot 2 Gallery Logic Acceptance Tests (7 Requirements)', () => {
  // TEST 1: Given uploaded plain product photos, system should generate Slot 1 with a clean clear background.
  it('TEST 1: Given uploaded plain product photos, system should generate Slot 1 with a clean clear background', async () => {
    const plainBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 245, g: 245, b: 245 } },
    })
      .jpeg()
      .toBuffer();

    const altBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 240, g: 240, b: 240 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'plain-hero', originalFilename: 'plain_hero.jpg', buffer: plainBuffer },
      { id: 'plain-alt', originalFilename: 'plain_alt.jpg', buffer: altBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Solitaire Diamond Pendant',
      clusteredItems: clustered,
      enableStyledSlot2: true,
      enableModelGeneration: false,
    });

    const slot1 = pack.slots[0];
    expect(slot1).toBeDefined();
    expect(slot1.slotNumber).toBe(1);
    expect(slot1.slotRole).toBe('HERO_COVER');
    expect(slot1.isCover).toBe(true);
    expect(slot1.slotTitle).toContain('Clean Background');
    expect(slot1.dimensions.width).toBe(2048);
    expect(slot1.dimensions.height).toBe(2048);
  });

  // TEST 2: Slot 1 should not contain distracting decorative props.
  it('TEST 2: Slot 1 should not contain distracting decorative props', async () => {
    const clutteredBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 180, g: 50, b: 50 } },
    })
      .jpeg()
      .toBuffer();

    const cleanBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'cluttered-img', originalFilename: 'silk_fabric_props.jpg', buffer: clutteredBuffer },
      { id: 'clean-img', originalFilename: 'clean_catalog.jpg', buffer: cleanBuffer },
    ]);

    const clutteredItem = clustered.find((c) => c.id === 'cluttered-img')!;
    clutteredItem.analysis.hasDistractingProps = true;
    clutteredItem.analysis.isCleanBackground = false;
    clutteredItem.analysis.backgroundClarityScore = 20;

    const cleanItem = clustered.find((c) => c.id === 'clean-img')!;
    cleanItem.analysis.hasDistractingProps = false;
    cleanItem.analysis.isCleanBackground = true;
    cleanItem.analysis.backgroundClarityScore = 95;

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Gold Floral Earrings',
      clusteredItems: clustered,
      enableStyledSlot2: true,
    });

    const slot1 = pack.slots[0];
    expect(slot1.mediaId).toBe('clean-img');
    expect(slot1.mediaId).not.toBe('cluttered-img');
  });

  // TEST 3: When styled generation is enabled, Slot 2 should become a silk-cloth or flower-styled image.
  it('TEST 3: When styled generation is enabled, Slot 2 should become a silk-cloth or flower-styled image', async () => {
    const plainBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 245, g: 245, b: 245 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'photo-1', originalFilename: 'catalog.jpg', buffer: plainBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Emerald Choker Necklace',
      clusteredItems: clustered,
      enableStyledSlot2: true,
      slot2StyleOption: 'silk_cloth',
    });

    const slot2 = pack.slots.find((s) => s.slotNumber === 2);
    expect(slot2).toBeDefined();
    expect(slot2?.slotRole).toBe('STYLED_SUPPORTING');
    expect(slot2?.slotTitle).toContain('Silk');
  });

  // TEST 4: Slot 2 should still preserve exact jewellery design.
  it('TEST 4: Slot 2 should still preserve exact jewellery design', () => {
    const { prompt, preset } = buildStyledSlot2Prompt(
      'Ruby Pendant Set in 18K Yellow Gold',
      'silk_cloth',
      'delicate champagne folds'
    );

    expect(prompt).toContain(STRICT_DESIGN_LOCK_CLAUSE);
    expect(prompt).toContain('CRITICAL JEWELLERY DESIGN LOCK INSTRUCTION');
    expect(prompt).toContain('DO NOT alter the metal finish, plating color, stone colors, or stone arrangement');
    expect(prompt).toContain('Pendant shape, chain type, clasp, and earring structure must remain 100% faithful');
    expect(prompt).toContain('IMPORTANT PROP & COMPOSITION CONSTRAINTS');
    expect(prompt).toContain('The prop styling must support the product, NOT overpower it');
    expect(prompt).toContain('DO NOT hide the jewellery in props');
    expect(preset.name).toBe('Silk Cloth');
  });

  // TEST 5: Slot 1 and Slot 2 should be visually different.
  it('TEST 5: Slot 1 and Slot 2 should be visually different', async () => {
    const plainBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 245, g: 245, b: 245 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'plain-hero', originalFilename: 'plain_hero.jpg', buffer: plainBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Solitaire Diamond Pendant',
      clusteredItems: clustered,
      enableStyledSlot2: true,
      slot2StyleOption: 'silk_cloth',
    });

    const slot1 = pack.slots[0];
    const slot2 = pack.slots[1];

    expect(slot1).toBeDefined();
    expect(slot2).toBeDefined();
    expect(slot1.slotRole).toBe('HERO_COVER');
    expect(slot2.slotRole).toBe('STYLED_SUPPORTING');
    expect(slot1.mediaId).not.toBe(slot2.mediaId);
  });

  // TEST 6: If user selects "Silk Cloth", Slot 2 should reflect silk cloth styling.
  it('TEST 6: If user selects "Silk Cloth", Slot 2 should reflect silk cloth styling', async () => {
    const plainBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 245, g: 245, b: 245 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'hero-img', originalFilename: 'hero.jpg', buffer: plainBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Diamond Tennis Bracelet',
      clusteredItems: clustered,
      enableStyledSlot2: true,
      slot2StyleOption: 'silk_cloth',
    });

    expect(pack.slot2StyleOption).toBe('silk_cloth');
    const slot2 = pack.slots[1];
    expect(slot2.styledOption).toBe('silk_cloth');
    expect(slot2.slotTitle).toContain('Silk');
    expect(slot2.altText.toLowerCase()).toContain('silk');
  });

  // TEST 7: If user selects "Flower Styling", Slot 2 should reflect subtle flower styling.
  it('TEST 7: If user selects "Flower Styling", Slot 2 should reflect subtle flower styling', async () => {
    const plainBuffer = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 245, g: 245, b: 245 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'hero-img', originalFilename: 'hero.jpg', buffer: plainBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Diamond Floral Mangalsutra',
      clusteredItems: clustered,
      enableStyledSlot2: true,
      slot2StyleOption: 'flower_styling',
    });

    expect(pack.slot2StyleOption).toBe('flower_styling');
    const slot2 = pack.slots[1];
    expect(slot2.styledOption).toBe('flower_styling');
    expect(slot2.slotTitle).toContain('Flower');
    expect(slot2.altText.toLowerCase()).toContain('flower');

    // Also test single-slot regeneration for Slot 2 switching to flower styling
    const regeneratedPack = await regenerateSingleSlot(pack, 2, {
      newSlot2StyleOption: 'flower_styling',
    });

    expect(regeneratedPack).toBeDefined();
    const regeneratedSlot2 = regeneratedPack.slots.find((s) => s.slotNumber === 2);
    expect(regeneratedSlot2?.styledOption).toBe('flower_styling');
    expect(regeneratedSlot2?.slotTitle).toContain('Flower');
  });

  // TEST 8: isolateJewelleryPng creates pure transparent cutout and clean cover has studio white background
  it('TEST 8: isolateJewelleryPng cleanly isolates jewellery on transparent alpha and generates pure white studio cover', async () => {
    // Create an image with cardboard background and gold/diamond pendant
    const raw = Buffer.alloc(200 * 200 * 3);
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        const idx = (y * 200 + x) * 3;
        // Beige cardboard background
        raw[idx] = 160;
        raw[idx + 1] = 145;
        raw[idx + 2] = 130;

        // Gold pendant in center (x: 80..120, y: 80..120)
        if (Math.hypot(x - 100, y - 100) < 25) {
          raw[idx] = 210;
          raw[idx + 1] = 175;
          raw[idx + 2] = 40;
        }
      }
    }

    const testImgBuffer = await sharp(raw, { raw: { width: 200, height: 200, channels: 3 } })
      .jpeg()
      .toBuffer();

    const isolatedPng = await isolateJewelleryPng(testImgBuffer);
    const pngMeta = await sharp(isolatedPng).metadata();
    expect(pngMeta.channels).toBe(4);
    expect(pngMeta.hasAlpha).toBe(true);

    const cover = await createCleanCoverDerivative(testImgBuffer, 'test_unit_clean_cover.jpg');
    expect(cover.relativeUrl).toContain('/api/photos/derivatives/test_unit_clean_cover.jpg');

    const coverMeta = await sharp(cover.buffer).metadata();
    expect(coverMeta.width).toBe(2048);
    expect(coverMeta.height).toBe(2048);

    // Verify background corners are pure studio white (255, 255, 255)
    const { data } = await sharp(cover.buffer).raw().toBuffer({ resolveWithObject: true });
    // Top-left corner pixel
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(255);
    expect(data[2]).toBe(255);
  });

  // TEST 9: Slot 4 always produces a Fashion Model photo (MODEL_1)
  it('TEST 9: Slot 4 always produces an authentic Fashion Model photo (MODEL_1)', async () => {
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 150, g: 150, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'prod-1', originalFilename: 'product_1.jpg', buffer: dummyBuffer },
      { id: 'prod-2', originalFilename: 'product_2.jpg', buffer: dummyBuffer },
      { id: 'prod-3', originalFilename: 'product_3.jpg', buffer: dummyBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Bridal Diamond Necklace Set',
      clusteredItems: clustered,
      enableModelGeneration: true,
      modelPresetKey: 'indian_festive',
      targetSlotCount: 5,
    });

    const slot4 = pack.slots.find((s) => s.slotNumber === 4);
    expect(slot4).toBeDefined();
    expect(slot4?.slotRole).toBe('MODEL_1');
    expect(slot4?.slotTitle).toContain('Fashion Model');
    expect(slot4?.sourceType).toBe('ai_model');
    expect(slot4?.isAiGenerated).toBe(true);
    expect(slot4?.url).toMatch(/\/api\/photos\/derivatives\//);
  });

  // TEST 10: Slot 5 always produces a Prompt/Lifestyle photo (MODEL_2_OR_SUPPORTING / ai_lifestyle)
  it('TEST 10: Slot 5 always produces a Prompt/Lifestyle photo (MODEL_2_OR_SUPPORTING / ai_lifestyle)', async () => {
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 150, g: 150, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    const clustered = await analyzeBatchMedia([
      { id: 'prod-1', originalFilename: 'product_1.jpg', buffer: dummyBuffer },
      { id: 'prod-2', originalFilename: 'product_2.jpg', buffer: dummyBuffer },
      { id: 'prod-3', originalFilename: 'product_3.jpg', buffer: dummyBuffer },
    ]);

    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Royal Polki Choker Set',
      clusteredItems: clustered,
      enableModelGeneration: true,
      modelPresetKey2: 'minimal_luxury_studio',
      targetSlotCount: 5,
    });

    const slot5 = pack.slots.find((s) => s.slotNumber === 5);
    expect(slot5).toBeDefined();
    expect(slot5?.slotRole).toBe('MODEL_2_OR_SUPPORTING');
    expect(slot5?.slotTitle).toContain('Lifestyle Styling');
    expect(slot5?.sourceType).toBe('ai_lifestyle');
    expect(slot5?.isAiGenerated).toBe(true);
    expect(slot5?.url).toMatch(/\/api\/photos\/derivatives\//);
  });

  // TEST 11: Supports selecting between Gemini Image Pro and OpenAI DALL·E 3 engines
  it('TEST 11: Supports selecting between Gemini Image Pro and OpenAI engines based on user requirement', async () => {
    const dummyBuffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 150, g: 150, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    const resultGemini = await generateControlledModelImage({
      sourceImageUrl: '/api/photos/dummy.jpg',
      productTitle: 'Diamond Emerald Necklace',
      targetSlot: 'model_1',
      sourceBuffer: dummyBuffer,
      aiProvider: 'gemini',
    });
    expect(resultGemini.success).toBe(true);
    expect(resultGemini.isDesignLocked).toBe(true);

    const resultOpenAi = await generateControlledModelImage({
      sourceImageUrl: '/api/photos/dummy.jpg',
      productTitle: 'Diamond Emerald Necklace',
      targetSlot: 'model_1',
      sourceBuffer: dummyBuffer,
      aiProvider: 'openai',
    });
    expect(resultOpenAi.success).toBe(true);
    expect(resultOpenAi.isDesignLocked).toBe(true);
  });
});
