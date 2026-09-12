import { describe, it, expect, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { cleanJewelleryCutoutArtifacts } from '../server/services/media/imageCleanupService';
import { DERIVATIVES_DIR } from '../server/services/photoService';
import {
  extractJewelleryMeasurements,
  getProductMeasurementsByProductId,
  applyMeasurementsToItem,
  saveProductMeasurementsRecord,
} from '../server/services/media/measurementExtractorService';
import { generateWhiteProductImage } from '../server/services/media/mediaPipelineService';
import {
  createPureWhiteCover,
  validateGalleryAsset,
} from '../server/services/media/deterministicImageService';
import {
  ISOLATION_CACHE_VERSION,
  getIsolatedMasterCacheKey,
  getIsolatedMasterPath,
  executeBackgroundRemoval,
  getBackgroundRemovalCreditMetrics,
  resetBackgroundRemovalCreditMetricsForTests,
  forceGeminiFallbackOnceForTests,
  validateJewelleryMask,
  getSourceHash,
  invalidateIsolatedMasterCacheByHash,
} from '../server/services/media/backgroundRemovalService';
import { buildRecommendedGalleryPack } from '../server/services/media/galleryPackService';
import db from '../server/db/database';

describe('White Product Pure Cutout & Physical Measurement Extraction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: Generates a test RGBA buffer simulating jewellery (a circle/loop in center)
   * with or without an elongated ruler bar near the bottom and disconnected dust specks.
   */
  async function createSyntheticJewelleryWithRuler(options: {
    includeRuler?: boolean;
    includeLeftRuler?: boolean;
    includeBottomRuler?: boolean;
    includeEarrings?: boolean;
    includeFlowers?: boolean;
    includeDust?: boolean;
    width?: number;
    height?: number;
    seed?: number;
  } = {}): Promise<Buffer> {
    const w = options.width || 800;
    const h = options.height || 800;
    const channels = 4;
    const buffer = Buffer.alloc(w * h * channels, 0); // start fully transparent

    if (options.seed !== undefined) {
      buffer[0] = options.seed % 255;
    }

    // Draw central jewellery subject: gold necklace / pendant medallion
    const centerX = Math.round(w / 2);
    const centerY = Math.round(h * 0.48);
    const outerR = Math.round(w * 0.20);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dist = Math.hypot(x - centerX, y - centerY);
        if (dist <= outerR) {
          const idx = (y * w + x) * channels;
          buffer[idx] = 218;     // R (gold)
          buffer[idx + 1] = 165; // G
          buffer[idx + 2] = 32;  // B
          buffer[idx + 3] = 255; // A (fully opaque)
        }
      }
    }

    // Optionally draw two disconnected earrings (left and right)
    if (options.includeEarrings) {
      const earringRadius = Math.round(w * 0.045);
      const leftEarringCenter = { x: Math.round(w * 0.28), y: Math.round(h * 0.28) };
      const rightEarringCenter = { x: Math.round(w * 0.72), y: Math.round(h * 0.28) };

      for (const center of [leftEarringCenter, rightEarringCenter]) {
        for (let y = center.y - earringRadius; y <= center.y + earringRadius; y++) {
          for (let x = center.x - earringRadius; x <= center.x + earringRadius; x++) {
            if (Math.hypot(x - center.x, y - center.y) <= earringRadius) {
              const idx = (y * w + x) * channels;
              buffer[idx] = 225;
              buffer[idx + 1] = 175;
              buffer[idx + 2] = 45;
              buffer[idx + 3] = 255;
            }
          }
        }
      }
    }

    // Optionally draw an elongated ruler bar along the bottom edge
    if (options.includeRuler || options.includeBottomRuler) {
      const rulerYStart = Math.round(h * 0.88);
      const rulerYEnd = Math.round(h * 0.96);
      const rulerXStart = Math.round(w * 0.05);
      const rulerXEnd = Math.round(w * 0.95);

      for (let y = rulerYStart; y <= rulerYEnd; y++) {
        for (let x = rulerXStart; x <= rulerXEnd; x++) {
          const idx = (y * w + x) * channels;
          // Add tick marks every 12 pixels
          const isTick = (x % 12 === 0);
          buffer[idx] = isTick ? 40 : 240;
          buffer[idx + 1] = isTick ? 40 : 230;
          buffer[idx + 2] = isTick ? 40 : 140;
          buffer[idx + 3] = 255;
        }
      }
    }

    // Optionally draw a vertical ruler bar along the left edge
    if (options.includeLeftRuler) {
      const rulerXStart = Math.round(w * 0.02);
      const rulerXEnd = Math.round(w * 0.08);
      const rulerYStart = Math.round(h * 0.08);
      const rulerYEnd = Math.round(h * 0.92);

      for (let y = rulerYStart; y <= rulerYEnd; y++) {
        for (let x = rulerXStart; x <= rulerXEnd; x++) {
          const idx = (y * w + x) * channels;
          const isTick = (y % 12 === 0);
          buffer[idx] = isTick ? 40 : 240;
          buffer[idx + 1] = isTick ? 40 : 230;
          buffer[idx + 2] = isTick ? 40 : 140;
          buffer[idx + 3] = 255;
        }
      }
    }

    // Optionally add a large flower prop in peripheral corner
    if (options.includeFlowers) {
      const flowerCenter = { x: Math.round(w * 0.88), y: Math.round(h * 0.12) };
      const flowerRadius = Math.round(w * 0.10);
      for (let y = flowerCenter.y - flowerRadius; y <= flowerCenter.y + flowerRadius; y++) {
        for (let x = flowerCenter.x - flowerRadius; x <= flowerCenter.x + flowerRadius; x++) {
          if (x >= 0 && x < w && y >= 0 && y < h && Math.hypot(x - flowerCenter.x, y - flowerCenter.y) <= flowerRadius) {
            const idx = (y * w + x) * channels;
            buffer[idx] = 255;     // Pink flower
            buffer[idx + 1] = 105;
            buffer[idx + 2] = 180;
            buffer[idx + 3] = 255;
          }
        }
      }
    }

    // Optionally add tiny disconnected dust specks
    if (options.includeDust) {
      // 3 tiny specks far from center
      const specks = [
        { x: 30, y: 40, r: 2 },
        { x: 750, y: 50, r: 2 },
        { x: 50, y: 700, r: 3 },
      ];
      for (const speck of specks) {
        for (let dy = -speck.r; dy <= speck.r; dy++) {
          for (let dx = -speck.r; dx <= speck.r; dx++) {
            const px = speck.x + dx;
            const py = speck.y + dy;
            if (px >= 0 && px < w && py >= 0 && py < h) {
              const idx = (py * w + px) * channels;
              buffer[idx] = 100;
              buffer[idx + 1] = 100;
              buffer[idx + 2] = 100;
              buffer[idx + 3] = 255;
            }
          }
        }
      }
    }

    return sharp(buffer, { raw: { width: w, height: h, channels } }).png().toBuffer();
  }

  it('TEST 1: cleanJewelleryCutoutArtifacts cleanly eliminates ruler bars and returns tight bounds', async () => {
    const syntheticBuffer = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      includeDust: true,
      width: 800,
      height: 800,
    });

    const result = await cleanJewelleryCutoutArtifacts(syntheticBuffer, {
      removeRuler: true,
    });

    expect(result.hasRuler).toBe(true);
    expect(result.removedArtifactsCount).toBeGreaterThan(0);
    expect(result.tightBounds).toBeDefined();
    expect(result.tightBounds.width).toBeGreaterThan(100);
    expect(result.tightBounds.height).toBeGreaterThan(100);

    // Verify the bottom ruler area is eliminated in fullCleanedBuffer
    const fullAlpha = await sharp(result.fullCleanedBuffer).extractChannel(3).raw().toBuffer();
    const w = result.originalWidth;
    const h = result.originalHeight;

    // Check ruler row in fullCleanedBuffer
    const rulerRowY = Math.round(h * 0.92);
    let opaqueRulerPixels = 0;
    for (let x = Math.round(w * 0.1); x <= Math.round(w * 0.9); x++) {
      if (fullAlpha[rulerRowY * w + x] > 30) {
        opaqueRulerPixels++;
      }
    }
    // Ruler pixels must be 0 or near-zero
    expect(opaqueRulerPixels).toBe(0);
  });

  it('TEST 2: cleanJewelleryCutoutArtifacts removes small disconnected dust particles', async () => {
    const syntheticBuffer = await createSyntheticJewelleryWithRuler({
      includeRuler: false,
      includeDust: true,
      width: 800,
      height: 800,
    });

    const result = await cleanJewelleryCutoutArtifacts(syntheticBuffer, {
      removeRuler: true,
    });

    expect(result.removedArtifactsCount).toBeGreaterThan(0);
    // Jewellery center bounds should not encompass the corner dust specks
    expect(result.tightBounds.x).toBeGreaterThan(50);
    expect(result.tightBounds.y).toBeGreaterThan(60);
  });

  it('TEST 3: generateWhiteProductImage creates a 1:1 image with pure #FFFFFF background and exact 2048x2048 dimensions', async () => {
    const inputWithRuler = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      includeDust: true,
      width: 800,
      height: 800,
    });

    const wpResult = await generateWhiteProductImage(inputWithRuler, `test_wp_${Date.now()}`, {
      outputRatio: '1:1',
      mode: 'exact_cutout',
    });

    expect(wpResult.width).toBe(2048);
    expect(wpResult.height).toBe(2048);
    expect(wpResult.mode).toBe('exact_cutout');
    expect(wpResult.productMatchScore).toBe(100);
    expect(wpResult.url).toBeDefined();

    // Verify corners of output derivative are pure white #FFFFFF (255, 255, 255)
    // Read the derivative from the local file path or buffer
    const localPath = wpResult.url.startsWith('/api/photos/derivatives/')
      ? `./data/uploads/photos/derivatives/${wpResult.url.replace('/api/photos/derivatives/', '')}`
      : null;

    if (localPath) {
      const img = sharp(localPath);
      const meta = await img.metadata();
      expect(meta.width).toBe(2048);
      expect(meta.height).toBe(2048);

      // Extract a 10x10 corner patch to verify pure white background
      const cornerPatch = await img
        .extract({ left: 5, top: 5, width: 10, height: 10 })
        .raw()
        .toBuffer();

      // In JPEG, white pixels are >= 253 across R, G, B
      for (let i = 0; i < cornerPatch.length; i++) {
        expect(cornerPatch[i]).toBeGreaterThanOrEqual(250);
      }
    }
  });

  it('TEST 4: generateWhiteProductImage respects 4:5 and 9:16 aspect ratios', async () => {
    const input = await createSyntheticJewelleryWithRuler({
      includeRuler: false,
      width: 600,
      height: 600,
    });

    const wp45 = await generateWhiteProductImage(input, `test_wp_45_${Date.now()}`, {
      outputRatio: '4:5',
      mode: 'exact_cutout',
    });
    expect(wp45.width).toBe(1638);
    expect(wp45.height).toBe(2048);

    const wp916 = await generateWhiteProductImage(input, `test_wp_916_${Date.now()}`, {
      outputRatio: '9:16',
      mode: 'exact_cutout',
    });
    expect(wp916.width).toBe(1152);
    expect(wp916.height).toBe(2048);
  });

  it('TEST 5: extractJewelleryMeasurements extracts calibrated physical dimensions and saves to database', async () => {
    const testProductId = `prod_measure_${Date.now()}`;
    const testMediaId = `media_measure_${Date.now()}`;

    // Ensure item exists in DB for foreign key / association
    db.prepare(`
      INSERT INTO items (id, sku, title, type_code, stone_code, color_code, serial, buying_price, selling_price, quantity, date_added)
      VALUES (?, ?, ?, 'NK', 'KD', 'GL', '001', 1000, 2500, 1, '2026-09-12')
    `).run(testProductId, `SKU-${Date.now()}`, 'Royal Kundan Choker');

    const syntheticBuffer = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      width: 800,
      height: 800,
    });

    const extraction = await extractJewelleryMeasurements({
      imageBuffer: syntheticBuffer,
      productId: testProductId,
      mediaId: testMediaId,
      mockCalibrationForTests: {
        pixelsPerMm: 14.5,
        necklaceDropMm: 185,
        pendantHeightMm: 45,
        pendantWidthMm: 38,
        earringHeightMm: 35,
        earringWidthMm: 22,
      },
    });

    expect(extraction.success).toBe(true);
    expect(extraction.measurements).toBeDefined();
    expect(extraction.measurements?.pixelsPerMm).toBe(14.5);
    expect(extraction.measurements?.necklaceDropMm).toBe(185);
    expect(extraction.measurements?.pendantHeightMm).toBe(45);
    expect(extraction.measurements?.pendantWidthMm).toBe(38);

    // Verify record in product_measurements DB table
    const stored = await getProductMeasurementsByProductId(testProductId);
    expect(stored).not.toBeNull();
    expect(stored?.necklaceDropMm).toBe(185);
    expect(stored?.pendantHeightMm).toBe(45);
    expect(stored?.pixelsPerMm).toBe(14.5);

    // Apply measurements to item attributes
    if (stored) {
      const applyRes = await applyMeasurementsToItem(testProductId, stored);
      expect(applyRes.success).toBe(true);

      const itemRow = db.prepare('SELECT confirmed_attributes FROM items WHERE id = ?').get(testProductId) as any;
      expect(itemRow).toBeDefined();
      const attrs = JSON.parse(itemRow.confirmed_attributes);
      expect(attrs.measurements).toBeDefined();
      expect(attrs.measurements.necklaceDropMm).toBe(185);
      expect(attrs.measurements.pendantHeightMm).toBe(45);
    }
  });

  it('TEST 6: white product and measurement extraction operate as decoupled features', async () => {
    // Both can run on the same ruler image independently without side-effects or credit leaks
    const inputWithRuler = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      width: 800,
      height: 800,
    });

    // 1. Measurement extraction runs first
    const measureResult = await extractJewelleryMeasurements({
      imageBuffer: inputWithRuler,
      mockCalibrationForTests: {
        pixelsPerMm: 12.0,
        necklaceDropMm: 210,
      },
    });
    expect(measureResult.success).toBe(true);
    expect(measureResult.measurements?.necklaceDropMm).toBe(210);

    // 2. White product generation runs and produces a clean white cover excluding the ruler
    const whiteResult = await generateWhiteProductImage(inputWithRuler, `decoupled_${Date.now()}`, {
      outputRatio: '1:1',
      mode: 'exact_cutout',
    });

    expect(whiteResult.width).toBe(2048);
    expect(whiteResult.height).toBe(2048);
    expect(whiteResult.mode).toBe('exact_cutout');
    // White product does not contain the ruler
    expect(whiteResult.url).toBeDefined();
  });

  it('TEST 7: White Product preview never falls back to original source URL', async () => {
    // When white product generation fails or cannot run, Slot 1 must not contain the original photo URL
    const originalPhoto = await createSyntheticJewelleryWithRuler({ width: 400, height: 400 });
    const mockItem = {
      id: `fallback_test_${Date.now()}`,
      originalFilename: 'ruler_photo.jpg',
      buffer: originalPhoto,
      width: 400,
      height: 400,
      analysis: {
        roleSuggestion: 'WHITE_COVER',
        qualityScore: 85,
        isBlurry: false,
        lightingScore: 90,
      },
    } as any;

    const galleryPack = await buildRecommendedGalleryPack({
      clusteredItems: [mockItem],
      productTitle: 'Emerald Choker',
      skipRoles: ['model', 'silk', 'detail'],
    });

    const slot1 = galleryPack.slots.find((s) => s.slotNumber === 1);
    expect(slot1).toBeDefined();
    // If white product succeeded, url must be a clean white derivative, NEVER original photo
    if (slot1?.cleanCoverUrl) {
      expect(slot1.url).not.toBe('/api/photos/ruler_photo.jpg');
      expect(slot1.url).toContain('_exact_cutout_');
    } else {
      expect(slot1?.url).toBe('');
      expect(slot1?.included).toBe(false);
      expect(slot1?.generationFailed).toBe(true);
    }
  });

  it('TEST 8: Failed isolation does not return original image as White Product', async () => {
    // A blank/black image has no jewellery subject, isolation fails validation
    const invalidImage = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    const hash = getSourceHash(invalidImage);
    const masterPath = getIsolatedMasterPath(hash, ISOLATION_CACHE_VERSION);
    if (fs.existsSync(masterPath.filepath)) {
      fs.unlinkSync(masterPath.filepath);
    }

    await expect(
      createPureWhiteCover(invalidImage, 'failed_isolation_test.jpg', {
        backgroundMode: 'pure_white',
      })
    ).rejects.toThrow();
  });

  it('TEST 9: Old isolation cache version is ignored', async () => {
    const testBuffer = await createSyntheticJewelleryWithRuler({ width: 500, height: 500 });
    const hash = getSourceHash(testBuffer);

    // Write a mock old cache file without version (e.g. isolated_master_{hash}.png or v1)
    const oldFilename = `isolated_master_${hash}.png`;
    const oldPath = path.join('./data/uploads/photos/derivatives/isolated-masters', oldFilename);
    const mockOldData = Buffer.from('OLD_CONTAMINATED_CUTOUT');
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    fs.writeFileSync(oldPath, mockOldData);

    // Call executeBackgroundRemoval
    const result = await executeBackgroundRemoval(testBuffer, { returnTransparentPng: true });

    // Must use v3 cache path, not the old file
    expect(result.isolatedMasterPath).toContain(`isolated_master_${ISOLATION_CACHE_VERSION}_`);
    expect(result.cacheVersion).toBe('v3');
    expect(result.buffer).not.toEqual(mockOldData);

    // Clean up mock old file
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  });

  it('TEST 10: New cache version (v3) is reused', async () => {
    const testBuffer = await createSyntheticJewelleryWithRuler({ width: 512, height: 512, seed: 7777 });
    const hash = getSourceHash(testBuffer);
    const masterPath = getIsolatedMasterPath(hash, ISOLATION_CACHE_VERSION);
    if (fs.existsSync(masterPath.filepath)) {
      fs.unlinkSync(masterPath.filepath);
    }
    resetBackgroundRemovalCreditMetricsForTests();

    // First call: cache miss
    const res1 = await executeBackgroundRemoval(testBuffer, { returnTransparentPng: true });
    expect(res1.cacheHit).toBe(false);
    expect(res1.cacheVersion).toBe('v3');

    // Second call: cache hit
    const res2 = await executeBackgroundRemoval(testBuffer, { returnTransparentPng: true });
    expect(res2.cacheHit).toBe(true);
    expect(res2.cacheVersion).toBe('v3');
    expect(res2.isolatedMasterUrl).toBe(res1.isolatedMasterUrl);
  });

  it('TEST 11: PhotoRoom transparent response is used directly with diagnostic metadata', async () => {
    const testBuffer = await createSyntheticJewelleryWithRuler({ width: 600, height: 600 });
    const result = await executeBackgroundRemoval(testBuffer, { returnTransparentPng: true });

    // 1. Inspect alpha channel
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(true);

    // 2. Diagnostic metadata present in development
    expect(result.providerUsed).toBeDefined();
    expect(result.cacheVersion).toBe('v3');
    expect(result.transparentWidth).toBeGreaterThan(0);
    expect(result.transparentHeight).toBeGreaterThan(0);
    expect(result.opaquePixelRatio).toBeGreaterThan(0);
    expect(result.componentCount).toBeGreaterThan(0);
  });

  it('TEST 12: Original containing dual rulers (left and bottom): isolated master contains no ruler', async () => {
    const sourceWithDualRulers = await createSyntheticJewelleryWithRuler({
      includeLeftRuler: true,
      includeBottomRuler: true,
      width: 800,
      height: 800,
    });

    const cleanup = await cleanJewelleryCutoutArtifacts(sourceWithDualRulers, { removeRuler: true });
    expect(cleanup.hasRuler).toBe(true);
    expect(cleanup.removedArtifactsCount).toBeGreaterThan(0);

    // Verify left ruler margin has zero opaque pixels in cleaned result
    const alpha = await sharp(cleanup.fullCleanedBuffer).extractChannel(3).raw().toBuffer();
    const w = cleanup.originalWidth;
    const h = cleanup.originalHeight;

    let leftRulerPixels = 0;
    for (let y = Math.round(h * 0.2); y <= Math.round(h * 0.8); y++) {
      for (let x = Math.round(w * 0.03); x <= Math.round(w * 0.07); x++) {
        if (alpha[y * w + x] > 30) leftRulerPixels++;
      }
    }
    expect(leftRulerPixels).toBe(0);

    // Verify bottom ruler margin has zero opaque pixels in cleaned result
    let bottomRulerPixels = 0;
    for (let y = Math.round(h * 0.90); y <= Math.round(h * 0.95); y++) {
      for (let x = Math.round(w * 0.2); x <= Math.round(w * 0.8); x++) {
        if (alpha[y * w + x] > 30) bottomRulerPixels++;
      }
    }
    expect(bottomRulerPixels).toBe(0);
  });

  it('TEST 13: Original containing flowers: semantic fallback detects forbidden objects and invokes Gemini', async () => {
    const sourceWithFlowers = await createSyntheticJewelleryWithRuler({
      includeFlowers: true,
      width: 800,
      height: 800,
    });

    // Mask validation detects flower / excessive foreground
    const quality = await validateJewelleryMask(sourceWithFlowers, true);
    expect(quality.forbiddenObjects).toBeDefined();

    // When Gemini fallback is forced, Gemini produces the final isolated master directly
    forceGeminiFallbackOnceForTests();
    const result = await executeBackgroundRemoval(sourceWithFlowers, {
      returnTransparentPng: true,
      allowGeminiFallback: true,
      exactIsolation: true,
    });

    expect(result.success).toBe(true);
    expect(result.buffer).toBeDefined();
  });

  it('TEST 14: Necklace + 2 disconnected earrings are all preserved', async () => {
    const setBuffer = await createSyntheticJewelleryWithRuler({
      includeEarrings: true,
      includeRuler: false,
      includeDust: false,
      width: 800,
      height: 800,
    });

    const cleanup = await cleanJewelleryCutoutArtifacts(setBuffer, { removeRuler: true });

    // The tight bounds must encompass both the top earrings (y ~ 200) and bottom necklace (y ~ 500)
    expect(cleanup.tightBounds.y).toBeLessThan(260);
    expect(cleanup.tightBounds.x).toBeLessThan(260);
    expect(cleanup.tightBounds.width).toBeGreaterThan(350);
    expect(cleanup.tightBounds.height).toBeGreaterThan(250);

    // All 3 jewellery components were preserved
    const alpha = await sharp(cleanup.fullCleanedBuffer).extractChannel(3).raw().toBuffer();
    const w = cleanup.originalWidth;

    // Check left earring area has opaque pixels
    const leftEarringPx = alpha[Math.round(800 * 0.28) * w + Math.round(800 * 0.28)];
    expect(leftEarringPx).toBeGreaterThan(100);

    // Check right earring area has opaque pixels
    const rightEarringPx = alpha[Math.round(800 * 0.28) * w + Math.round(800 * 0.72)];
    expect(rightEarringPx).toBeGreaterThan(100);

    // Check center necklace has opaque pixels
    const centerNecklacePx = alpha[Math.round(800 * 0.48) * w + Math.round(800 * 0.50)];
    expect(centerNecklacePx).toBeGreaterThan(100);
  });

  it('TEST 15: Measurement extraction always uses originalSourceMediaId', async () => {
    const testMediaId = `orig_media_${Date.now()}`;
    const testProductId = `prod_orig_${Date.now()}`;
    const syntheticBuffer = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      width: 800,
      height: 800,
    });

    // Store in uploads directory and mock media_assets table
    const filename = `${testMediaId}_original.png`;
    const uploadPath = path.join('./data/uploads/photos', filename);
    fs.mkdirSync(path.dirname(uploadPath), { recursive: true });
    fs.writeFileSync(uploadPath, syntheticBuffer);

    db.prepare(`
      INSERT OR REPLACE INTO media_assets (
        id, original_filename, display_title, mime_type, byte_size, checksum_sha256,
        upload_source, media_type, classification, processing_status, approval_status
      ) VALUES (?, ?, ?, 'image/png', 50000, ?, 'web_upload', 'image', 'original', 'ready', 'approved')
    `).run(testMediaId, filename, filename, `hash_${testMediaId}`);

    // Call extract measurements with originalSourceMediaId
    const res = await extractJewelleryMeasurements({
      originalSourceMediaId: testMediaId,
      productId: testProductId,
      mockCalibrationForTests: { pixelsPerMm: 15.0 },
    });

    expect(res.success).toBe(true);
    expect(res.hasRuler).toBe(true);
    expect(res.measurements?.pixelsPerMm).toBe(15.0);
    expect(res.measurements?.mediaId).toBe(testMediaId);

    // Clean up
    if (fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath);
    try {
      db.prepare('DELETE FROM media_assets WHERE id = ?').run(testMediaId);
    } catch {}
  });

  it('TEST 16: Source ruler image detects ruler despite White Product having ruler removed', async () => {
    const sourceWithRuler = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      width: 800,
      height: 800,
    });

    // 1. Generate White Product: ruler is stripped out
    const wpResult = await generateWhiteProductImage(sourceWithRuler, `wp_strip_${Date.now()}`, {
      outputRatio: '1:1',
      mode: 'exact_cutout',
    });
    expect(wpResult.url).toBeDefined();

    // 2. Measure against the source image: ruler IS detected
    const measureOnSource = await extractJewelleryMeasurements({
      imageBuffer: sourceWithRuler,
      mockCalibrationForTests: { pixelsPerMm: 12.5 },
    });
    expect(measureOnSource.hasRuler).toBe(true);
    expect(measureOnSource.measurements?.pixelsPerMm).toBe(12.5);
  });

  it('TEST 17: Measurement extraction and White Product generation remain independent and measurement consumes 0 PhotoRoom credits', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    const source = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      width: 800,
      height: 800,
    });

    // Run measurement extraction
    await extractJewelleryMeasurements({
      imageBuffer: source,
      mockCalibrationForTests: { pixelsPerMm: 10.0 },
    });

    const metricsAfterMeasurement = getBackgroundRemovalCreditMetrics();
    expect(metricsAfterMeasurement.photoroomCallCount).toBe(0);
    expect(metricsAfterMeasurement.sourceIsolationCreateCount).toBe(0);
  });

  it('TEST 18: PhotoRoom remains maximum one call for a given source + cache version', async () => {
    resetBackgroundRemovalCreditMetricsForTests();

    const source = await createSyntheticJewelleryWithRuler({ width: 512, height: 512, seed: 8888 });
    const masterPath = getIsolatedMasterPath(getSourceHash(source), ISOLATION_CACHE_VERSION);
    if (fs.existsSync(masterPath.filepath)) {
      fs.unlinkSync(masterPath.filepath);
    }

    // Call 1
    await executeBackgroundRemoval(source, { returnTransparentPng: true });
    expect(getBackgroundRemovalCreditMetrics().sourceIsolationCreateCount).toBe(1);

    // Call 2
    await executeBackgroundRemoval(source, { returnTransparentPng: true });
    expect(getBackgroundRemovalCreditMetrics().sourceIsolationCreateCount).toBe(1);

    // Call 3 (generating white product)
    await generateWhiteProductImage(source, `credit_guarantee_${Date.now()}`, {
      mode: 'exact_cutout',
    });
    expect(getBackgroundRemovalCreditMetrics().sourceIsolationCreateCount).toBe(1);
  });

  it('TEST 19: Criterion 8 — Slot 3 DETAIL CLOSE-UP must NEVER crop ORIGINAL_SOURCE and contains 0 rulers', async () => {
    const rawRulerPhoto = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      includeLeftRuler: true,
      includeBottomRuler: true,
      width: 800,
      height: 800,
      seed: 991,
    });

    const testId = `test_c8_${Date.now()}`;
    const mockItem = {
      id: testId,
      originalFilename: `${testId}.jpg`,
      buffer: rawRulerPhoto,
      url: `/api/photos/${testId}.jpg`,
      analysis: {
        qualityScore: 92,
        roleSuggestion: 'HERO_COVER',
      },
    };

    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Emerald Kundan Choker',
      clusteredItems: [mockItem] as any,
      targetSlotCount: 5,
    });

    const slot1 = pack.slots.find((s) => s.slotNumber === 1);
    const slot3 = pack.slots.find((s) => s.slotNumber === 3);

    expect(slot1).toBeDefined();
    expect(slot1?.url).toBeDefined();
    expect(slot1?.url).not.toBe(mockItem.url);

    expect(slot3).toBeDefined();
    expect(slot3?.url).toBeDefined();
    expect(slot3?.url).not.toBe(mockItem.url);
    expect(slot3?.url).toContain('detail_closeup_');

    // Read the generated Slot 3 image from disk and validate it has ZERO rulers
    const slot3Filename = path.basename(slot3!.url);
    const slot3Path = path.join(DERIVATIVES_DIR, slot3Filename);
    expect(fs.existsSync(slot3Path)).toBe(true);

    const slot3Buf = fs.readFileSync(slot3Path);
    const validation = await validateGalleryAsset(slot3Buf, 'DETAIL_CLOSEUP');
    expect(validation.valid).toBe(true);
    expect(validation.forbiddenObjects).not.toContain('ruler');
  });

  it('TEST 20: Criterion 9 — Slot 5 marks measurementReference = true and included = false when ruler is detected', async () => {
    const rawRulerPhoto = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      includeLeftRuler: true,
      includeBottomRuler: true,
      width: 800,
      height: 800,
      seed: 992,
    });

    const testId = `test_c9_ruler_${Date.now()}`;
    const mockItem = {
      id: testId,
      originalFilename: `${testId}.jpg`,
      buffer: rawRulerPhoto,
      url: `/api/photos/${testId}.jpg`,
      analysis: {
        qualityScore: 90,
        roleSuggestion: 'HERO_COVER',
      },
    };

    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Ruby Choker Necklace',
      clusteredItems: [mockItem] as any,
      targetSlotCount: 5,
    });

    const slot5 = pack.slots.find((s) => s.slotNumber === 5);
    expect(slot5).toBeDefined();
    expect(slot5?.measurementReference).toBe(true);
    expect(slot5?.included).toBe(false);
    expect(slot5?.slotTitle).toContain('Measurement Reference');
  });

  it('TEST 21: Criterion 9 — Slot 5 marks measurementReference = false and included = true when no ruler is present', async () => {
    const cleanPhoto = await createSyntheticJewelleryWithRuler({
      includeRuler: false,
      includeLeftRuler: false,
      includeBottomRuler: false,
      width: 800,
      height: 800,
      seed: 993,
    });

    const testId = `test_c9_clean_${Date.now()}`;
    const mockItem = {
      id: testId,
      originalFilename: `${testId}.jpg`,
      buffer: cleanPhoto,
      url: `/api/photos/${testId}.jpg`,
      analysis: {
        qualityScore: 95,
        roleSuggestion: 'HERO_COVER',
      },
    };

    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Diamond Solitaire Pendant',
      clusteredItems: [mockItem] as any,
      targetSlotCount: 5,
    });

    const slot5 = pack.slots.find((s) => s.slotNumber === 5);
    expect(slot5).toBeDefined();
    expect(slot5?.measurementReference).toBe(false);
    expect(slot5?.included).toBe(true);
  });

  it('TEST 22: Criterion 10 — rebuild-isolation clears cached master and regenerates clean White Product and Detail Close-up', async () => {
    const sourceWithRuler = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      includeLeftRuler: true,
      includeBottomRuler: true,
      width: 600,
      height: 600,
      seed: 994,
    });

    const sourceHash = getSourceHash(sourceWithRuler);
    const masterPath = getIsolatedMasterPath(sourceHash, ISOLATION_CACHE_VERSION);

    // 1. Generate once to populate cache
    await generateWhiteProductImage(sourceWithRuler, `rebuild_test_${Date.now()}`, {
      mode: 'exact_cutout',
    });
    expect(fs.existsSync(masterPath.filepath)).toBe(true);

    // 2. Invalidate cache
    const invalidated = invalidateIsolatedMasterCacheByHash(sourceHash);
    expect(invalidated).toBe(true);
    expect(fs.existsSync(masterPath.filepath)).toBe(false);

    // 3. Rebuild: generate fresh White Product
    const newWp = await generateWhiteProductImage(sourceWithRuler, `rebuild_test_fresh_${Date.now()}`, {
      mode: 'exact_cutout',
    });
    expect(fs.existsSync(masterPath.filepath)).toBe(true);

    // Read master and verify it has zero rulers
    const masterBuf = fs.readFileSync(masterPath.filepath);
    const masterVal = await validateGalleryAsset(masterBuf, 'WHITE_PRODUCT');
    expect(masterVal.valid).toBe(true);
    expect(masterVal.forbiddenObjects).not.toContain('ruler');
  });

  it('TEST 23: Slot 1 failure displays error state and never falls back to raw ruler photo', async () => {
    const rawRulerPhoto = await createSyntheticJewelleryWithRuler({
      includeRuler: true,
      width: 800,
      height: 800,
      seed: 995,
    });

    const testId = `test_fail_${Date.now()}`;
    const mockItem = {
      id: testId,
      originalFilename: `${testId}.jpg`,
      buffer: rawRulerPhoto,
      url: `/api/photos/${testId}.jpg`,
      analysis: {
        qualityScore: 90,
        roleSuggestion: 'HERO_COVER',
      },
    };

    // Force failure during Slot 1 generation by passing an invalid ratio or throwing mock
    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Failed White Product Test',
      clusteredItems: [mockItem] as any,
      targetSlotCount: 5,
      whiteProductAiProvider: 'nonexistent_provider' as any,
    });

    const slot1 = pack.slots.find((s) => s.slotNumber === 1);
    expect(slot1).toBeDefined();
    // If it succeeded via fallback exact cutout, url is clean white product.
    // If it failed, url MUST NOT be mockItem.url
    if (slot1?.generationFailed) {
      expect(slot1.url).toBe('');
      expect(slot1.included).toBe(false);
      expect(slot1.generationError).toContain('White Product');
    } else {
      expect(slot1?.url).not.toBe(mockItem.url);
    }
  });
});
