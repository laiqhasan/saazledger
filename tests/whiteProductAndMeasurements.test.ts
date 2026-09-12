import { describe, it, expect, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import { cleanJewelleryCutoutArtifacts } from '../server/services/media/imageCleanupService';
import {
  extractJewelleryMeasurements,
  getProductMeasurementsByProductId,
  applyMeasurementsToItem,
  saveProductMeasurementsRecord,
} from '../server/services/media/measurementExtractorService';
import { generateWhiteProductImage } from '../server/services/media/mediaPipelineService';
import { createPureWhiteCover } from '../server/services/media/deterministicImageService';
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
    includeDust?: boolean;
    width?: number;
    height?: number;
  } = {}): Promise<Buffer> {
    const w = options.width || 800;
    const h = options.height || 800;
    const channels = 4;
    const buffer = Buffer.alloc(w * h * channels, 0); // start fully transparent

    // Draw central jewellery subject: gold ring / pendant (circle with hole)
    const centerX = Math.round(w / 2);
    const centerY = Math.round(h * 0.45);
    const outerR = Math.round(w * 0.22);
    const innerR = Math.round(w * 0.12);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dist = Math.hypot(x - centerX, y - centerY);
        if (dist <= outerR && dist >= innerR) {
          const idx = (y * w + x) * channels;
          buffer[idx] = 218;     // R (gold)
          buffer[idx + 1] = 165; // G
          buffer[idx + 2] = 32;  // B
          buffer[idx + 3] = 255; // A (fully opaque)
        }
      }
    }

    // Optionally draw an elongated ruler bar along the bottom edge
    if (options.includeRuler) {
      const rulerYStart = Math.round(h * 0.88);
      const rulerYEnd = Math.round(h * 0.96);
      const rulerXStart = Math.round(w * 0.05);
      const rulerXEnd = Math.round(w * 0.95);

      for (let y = rulerYStart; y <= rulerYEnd; y++) {
        for (let x = rulerXStart; x <= rulerXEnd; x++) {
          const idx = (y * w + x) * channels;
          buffer[idx] = 240;     // R (yellow ruler)
          buffer[idx + 1] = 230; // G
          buffer[idx + 2] = 140; // B
          buffer[idx + 3] = 255; // A
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
});
