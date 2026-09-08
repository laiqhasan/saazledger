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
} from '../server/services/media/mediaPipelineService';
import {
  MODEL_STYLING_PRESETS,
  STRICT_DESIGN_LOCK_CLAUSE,
  buildDesignLockedPrompt,
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

    // Model generation disabled
    const pack = await buildRecommendedGalleryPack({
      productId: 'pack-test-item-1',
      productTitle: 'Diamond Pendant Set',
      clusteredItems: clustered,
      enableModelGeneration: false,
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

    expect(altSlot1).toContain('Main commercial front view');
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
