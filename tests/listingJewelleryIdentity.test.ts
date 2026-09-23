import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { scoreListingJewelleryIdentity } from '../server/services/media/productFidelityValidator';
import { createListingSetCloseup, createContainFitListingCloseup, createPendantFillCloseup, createBruteForceLowerPendantCrop, listingLooksLikeFullChainClaspLayout, measureListingCloseupPresentation, listingCloseupPresentationIsShipable, repairListingCloseupPresentation, createPureWhiteCover, cropSparseUpperChainForListing, composeCompactListingSet } from '../server/services/media/deterministicImageService';
import { generateModelImage } from '../server/services/media/imageGenerationProvider';
import { buildRecommendedGalleryPack } from '../server/services/media/galleryPackService';
import { generateWhiteProductImage } from '../server/services/media/mediaPipelineService';
import { DERIVATIVES_DIR } from '../server/services/photoService';

async function goldSetBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: Buffer.from(`<svg width="800" height="800">
          <circle cx="220" cy="90" r="42" fill="#d4a017" stroke="#c9a227" stroke-width="8"/>
          <circle cx="580" cy="90" r="42" fill="#d4a017" stroke="#c9a227" stroke-width="8"/>
          <path d="M180 140 C 200 380, 240 520, 400 640 C 560 520, 600 380, 620 140" fill="none" stroke="#c9a227" stroke-width="10"/>
          <ellipse cx="400" cy="680" rx="55" ry="70" fill="#1f8a4c"/>
        </svg>`),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
}

describe('Listing jewellery identity gate', () => {
  it('scores identical images at or above 90', async () => {
    const src = await goldSetBuffer();
    const score = await scoreListingJewelleryIdentity(src, src);
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('rejects a clearly different generated image below 90', async () => {
    const src = await goldSetBuffer();
    const other = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800"><rect x="80" y="80" width="640" height="640" fill="#2244cc"/><circle cx="400" cy="400" r="180" fill="#88ccff"/></svg>`
          ),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    const score = await scoreListingJewelleryIdentity(src, other);
    expect(score).toBeLessThan(90);
  });

  it('Slot 3 of a full-set source is a tighter pendant crop, not a shrink of the full listing', async () => {
    const hoopColor = { r: 40, g: 190, b: 70 };
    const src = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="1000" height="1000">
            <circle cx="280" cy="70" r="36" fill="rgb(40,190,70)"/>
            <circle cx="720" cy="70" r="36" fill="rgb(40,190,70)"/>
            <path d="M220 140 C 250 420, 300 620, 500 820 C 700 620, 750 420, 780 140" fill="none" stroke="#c9a227" stroke-width="12"/>
            <polygon points="500,760 560,880 440,880" fill="#d4a017"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const crop = await createListingSetCloseup(src, `listing_pendant_fill_${Date.now()}.jpg`);
    const contain = await createContainFitListingCloseup(src, `listing_contain_${Date.now()}.jpg`);
    const { data, info } = await sharp(crop.buffer).raw().toBuffer({ resolveWithObject: true });

    const goldBbox = (raw: Buffer, inf: { width: number; height: number; channels: number }) => {
      let minX = inf.width, maxX = -1, minY = inf.height, maxY = -1;
      for (let y = 0; y < inf.height; y++) {
        for (let x = 0; x < inf.width; x++) {
          const idx = (y * inf.width + x) * inf.channels;
          const r = raw[idx], g = raw[idx + 1], b = raw[idx + 2];
          const isGold = r > 160 && g > 100 && r > b + 20 && g > b;
          if (isGold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX) return 0;
      return Math.max((maxX - minX + 1) / inf.width, (maxY - minY + 1) / inf.height);
    };

    let hoopPixels = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (
        Math.abs(data[i] - hoopColor.r) < 40 &&
        Math.abs(data[i + 1] - hoopColor.g) < 40 &&
        Math.abs(data[i + 2] - hoopColor.b) < 40
      ) {
        hoopPixels++;
      }
    }
    expect(hoopPixels).toBeLessThan(40);
    expect(crop.buffer.equals(contain.buffer)).toBe(false);
    expect(goldBbox(data, info)).toBeGreaterThan(0.45);
  });

  it('Slot 3 listing close-up fills the frame with the pendant cluster, not a second earring row', async () => {
    const width = 2000;
    const height = 2000;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <path d="M 300,50 L 1000,500" stroke="#c9a227" stroke-width="10" fill="none" />
      <path d="M 1700,50 L 1000,500" stroke="#c9a227" stroke-width="10" fill="none" />
      <circle cx="820" cy="480" r="75" fill="#22aa44" />
      <circle cx="1180" cy="480" r="75" fill="#22aa44" />
      <path d="M 1000,500 L 990,1750 L 1010,1750 Z" stroke="#c9a227" stroke-width="8" fill="none" />
      <polygon points="1000,1650 1120,1780 1000,1910 880,1780" fill="#2266ee" stroke="#0033aa" stroke-width="6" />
    </svg>`;
    const src = await sharp({
      create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
    })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();

    const crop = await createListingSetCloseup(src, `listing_set_frame_${Date.now()}.jpg`);
    const { data, info } = await sharp(crop.buffer).raw().toBuffer({ resolveWithObject: true });

    let hasGreen = false;
    let hasBlue = false;
    let minX = info.width, maxX = -1, minY = info.height, maxY = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        if (r < 248 || g < 248 || b < 248) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        if (g > r + 30 && g > b + 30) hasGreen = true;
        if (b > r + 30 && b > g + 30) hasBlue = true;
      }
    }

    expect(hasBlue).toBe(true);
    expect(hasGreen).toBe(false);

    const occW = (maxX - minX + 1) / info.width;
    const occH = (maxY - minY + 1) / info.height;
    expect(Math.max(occW, occH)).toBeGreaterThanOrEqual(0.78);
    expect(Math.min(occW, occH)).toBeGreaterThanOrEqual(0.22);
    expect(Math.max(occW, occH)).toBeLessThanOrEqual(0.94);
  });

  it('Slot 3 listing close-up of a full necklace+earrings set is accepted as a pendant fill', async () => {
    const width = 2000;
    const height = 2000;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="220" cy="80" r="28" fill="#22aa44" />
      <circle cx="1780" cy="80" r="28" fill="#22aa44" />
      <path d="M 220,110 C 400,900 700,1500 1000,1750" stroke="#c9a227" stroke-width="4" fill="none" />
      <path d="M 1780,110 C 1600,900 1300,1500 1000,1750" stroke="#c9a227" stroke-width="4" fill="none" />
      <polygon points="1000,1680 1080,1860 920,1860" fill="#2266ee" />
    </svg>`;
    const src = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 95 })
      .toBuffer();

    const listing = await createListingSetCloseup(src, `listing_macro_mismatch_${Date.now()}.jpg`);
    expect(listing.buffer.length).toBeGreaterThan(1000);

    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Sparse Full Set Listing Closeup',
      clusteredItems: [
        {
          id: 'sparse_set_slot3',
          originalFilename: 'sparse_set_slot3.jpg',
          buffer: src,
          analysis: {
            isBlurry: false,
            qualityScore: 90,
            sharpness: 90,
            lighting: 90,
            roleSuggestion: 'HERO',
            category: 'necklace',
          },
        } as any,
      ],
      enableModelGeneration: false,
      enableStyledSlot2: false,
    });

    const slot3 = pack.slots.find((s) => s.slotNumber === 3);
    expect(slot3).toBeDefined();
    expect(slot3?.generationFailed).toBe(false);
    expect(slot3?.url).toBeTruthy();
    const diskPath = path.join(DERIVATIVES_DIR, path.basename(slot3!.url));
    expect(fs.existsSync(diskPath)).toBe(true);
  }, 30000);

  it('Slot 3 pendant fill is dominated by the lower pendant region; full-chain+clasp layout fails', async () => {
    const width = 1200;
    const height = 1200;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <path d="M 80,40 L 600,980" stroke="#c9a227" stroke-width="14" fill="none" />
      <path d="M 1120,40 L 600,980" stroke="#c9a227" stroke-width="14" fill="none" />
      <circle cx="600" cy="70" r="28" fill="#cc2244"/>
      <circle cx="180" cy="80" r="36" fill="#22aa44"/>
      <circle cx="1020" cy="80" r="36" fill="#22aa44"/>
      <polygon points="600,880 720,1040 480,1040" fill="#2266ee"/>
      <circle cx="600" cy="860" r="22" fill="#d4a017"/>
    </svg>`;
    const src = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();

    expect(await listingLooksLikeFullChainClaspLayout(src)).toBe(true);

    const crop = await createPendantFillCloseup(src, `pendant_fill_region_${Date.now()}.jpg`);
    expect(await listingLooksLikeFullChainClaspLayout(crop.buffer)).toBe(false);

    const { data, info } = await sharp(crop.buffer).raw().toBuffer({ resolveWithObject: true });
    let red = 0, green = 0, blue = 0;
    let minY = info.height, maxY = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        if (r < 248 || g < 248 || b < 248) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        if (r > 160 && g < 80 && b < 80) red++;
        if (g > r + 30 && g > b + 30) green++;
        if (b > r + 30 && b > g + 30) blue++;
      }
    }
    expect(blue).toBeGreaterThan(green);
    expect(blue).toBeGreaterThan(red);
    expect(green).toBeLessThan(40);
    expect(red).toBeLessThan(40);
    expect(maxY - minY).toBeGreaterThan(info.height * 0.3);
  });

  it('listingLooksLikeFullChainClaspLayout is true when matching earrings sit as two blobs in the top 40%', async () => {
    const src = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="1000" height="1000">
            <circle cx="180" cy="90" r="44" fill="#22aa44"/>
            <circle cx="820" cy="90" r="44" fill="#22aa44"/>
            <polygon points="500,780 620,960 380,960" fill="#2266ee"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    expect(await listingLooksLikeFullChainClaspLayout(src)).toBe(true);
  });

  it('Slot 3 drops top earrings via geometric lower crop and never ships a contain-fit of the full set', async () => {
    const width = 1400;
    const height = 1400;
    const src = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="${width}" height="${height}">
            <circle cx="260" cy="80" r="50" fill="#22aa44"/>
            <circle cx="1140" cy="80" r="50" fill="#22aa44"/>
            <path d="M 220 150 C 280 520, 380 900, 700 1220 C 1020 900, 1120 520, 1180 150" fill="none" stroke="#c9a227" stroke-width="16"/>
            <polygon points="700,1080 840,1320 560,1320" fill="#2266ee"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    expect(await listingLooksLikeFullChainClaspLayout(src)).toBe(true);

    const crop = await createPendantFillCloseup(src, `slot3_lower_geom_${Date.now()}.jpg`);
    const contain = await createContainFitListingCloseup(src, `slot3_contain_ref_${Date.now()}.jpg`);
    const brute = await createBruteForceLowerPendantCrop(src, `slot3_brute_ref_${Date.now()}.jpg`);
    expect(crop.buffer.equals(contain.buffer)).toBe(false);
    expect(await listingLooksLikeFullChainClaspLayout(crop.buffer)).toBe(false);

    const { data, info } = await sharp(crop.buffer).raw().toBuffer({ resolveWithObject: true });
    let totalJewellery = 0;
    let green = 0;
    let blue = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        if (r < 248 || g < 248 || b < 248) {
          totalJewellery++;
        }
        if (g > r + 30 && g > b + 30) green++;
        if (b > r + 30 && b > g + 30) blue++;
      }
    }
    expect(totalJewellery).toBeGreaterThan(1000);
    expect(green).toBeLessThan(40);
    expect(blue).toBeGreaterThan(green);
    expect(blue).toBeGreaterThan(totalJewellery * 0.08);
    const pres = await measureListingCloseupPresentation(crop.buffer);
    expect(Math.max(pres.occupancyWidth, pres.occupancyHeight)).toBeGreaterThanOrEqual(0.78);
    expect(Math.min(pres.occupancyWidth, pres.occupancyHeight)).toBeGreaterThanOrEqual(0.22);

    const wrapSrc = fs.readFileSync(
      path.join(__dirname, '../server/services/media/galleryPackService.ts'),
      'utf8'
    );
    const implSrc = fs.readFileSync(
      path.join(__dirname, '../server/services/media/galleryPackService.impl.ts'),
      'utf8'
    );
    expect(wrapSrc).not.toMatch(/createContainFitListingCloseup/);
    expect(implSrc).not.toMatch(/createContainFitListingCloseup/);
    expect(wrapSrc).not.toMatch(/listing_contain_fit_/);
    expect(implSrc).not.toMatch(/listing_contain_fit_/);
    expect(implSrc).not.toMatch(/listing-contain-fit/);

    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Top Earring Bottom Pendant Set',
      clusteredItems: [
        {
          id: 'top_ear_bottom_pendant',
          originalFilename: 'top_ear_bottom_pendant.jpg',
          buffer: src,
          analysis: {
            isBlurry: false,
            qualityScore: 92,
            sharpness: 90,
            lighting: 90,
            roleSuggestion: 'HERO',
            category: 'necklace',
          },
        } as any,
      ],
      enableModelGeneration: false,
      enableStyledSlot2: false,
    });
    const slot3 = pack.slots.find((s) => s.slotNumber === 3);
    expect(slot3).toBeDefined();
    expect(slot3?.generationFailed).toBe(false);
    expect(slot3?.url).toBeTruthy();
    expect(String(slot3?.generationProvider || '')).not.toBe('listing-contain-fit');
    const diskPath = path.join(DERIVATIVES_DIR, path.basename(slot3!.url));
    expect(fs.existsSync(diskPath)).toBe(true);
    const slotBuf = fs.readFileSync(diskPath);
    expect(slotBuf.equals(contain.buffer)).toBe(false);
    expect(await listingLooksLikeFullChainClaspLayout(slotBuf)).toBe(false);

    const slotRaw = await sharp(slotBuf).raw().toBuffer({ resolveWithObject: true });
    let slotGreen = 0, slotBlue = 0;
    for (let y = 0; y < slotRaw.info.height; y++) {
      for (let x = 0; x < slotRaw.info.width; x++) {
        const idx = (y * slotRaw.info.width + x) * slotRaw.info.channels;
        const r = slotRaw.data[idx], g = slotRaw.data[idx + 1], b = slotRaw.data[idx + 2];
        if (g > r + 30 && g > b + 30) slotGreen++;
        if (b > r + 30 && b > g + 30) slotBlue++;
      }
    }
    expect(slotGreen).toBeLessThan(40);
    expect(slotBlue).toBeGreaterThan(slotGreen);
    expect(brute.buffer.length).toBeGreaterThan(1000);
  }, 30000);

  it('model generation path does not apply the 90% still-life identity gate', async () => {
    const providerSrc = fs.readFileSync(
      path.join(__dirname, '../server/services/media/imageGenerationProvider.ts'),
      'utf8'
    );
    const modelFnStart = providerSrc.indexOf('export async function generateModelImage');
    const modelFnEnd = providerSrc.indexOf('export async function generateLifestyleImage');
    const modelFn = providerSrc.slice(modelFnStart, modelFnEnd);
    expect(providerSrc).toMatch(/hasListingJewelleryColorPixels/);
    expect(modelFn).not.toMatch(/scoreOrMockListingIdentity/);
    expect(modelFn).not.toMatch(/LISTING_IDENTITY_MIN/);
    expect(modelFn).toMatch(/TIGHT LISTING CROP/);
    expect(modelFn).not.toMatch(/wider upper-torso/);

    const src = await goldSetBuffer();
    const model = await generateModelImage({
      productTitle: 'Gold Pendant Set',
      sourceBuffer: src,
      presetKey: 'office_to_occasion',
    });
    expect(model.success).toBe(true);
    expect(model.generatedImageUrl).toBeTruthy();
  });

  it('Slot 3 output is 2048 square, near-white, pendant-dominant, no letterbox', async () => {
    const src = await sharp({
      create: { width: 1600, height: 1600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="1600" height="1600">
            <circle cx="280" cy="90" r="40" fill="#22aa44"/>
            <circle cx="1320" cy="90" r="40" fill="#22aa44"/>
            <path d="M 260 160 C 360 700, 520 1100, 800 1380 C 1080 1100, 1240 700, 1340 160" fill="none" stroke="#c9a227" stroke-width="14"/>
            <ellipse cx="800" cy="1180" rx="210" ry="210" fill="#d4a017"/>
            <polygon points="800,1320 880,1520 720,1520" fill="#1f8a4c"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const crop = await createPendantFillCloseup(src, `slot3_presentable_${Date.now()}.jpg`);
    const pres = await measureListingCloseupPresentation(crop.buffer);
    expect(pres.width).toBe(2048);
    expect(pres.height).toBe(2048);
    expect(pres.meanInnerBackgroundLuminance).toBeGreaterThanOrEqual(245);
    expect(Math.max(pres.occupancyWidth, pres.occupancyHeight)).toBeGreaterThanOrEqual(0.82);
    expect(pres.touchesFrameEdge).toBe(false);
    expect(await listingLooksLikeFullChainClaspLayout(crop.buffer)).toBe(false);
    const ship = await listingCloseupPresentationIsShipable(crop.buffer);
    expect(ship.ok).toBe(true);
  });

  it('rejects Slot 3 gray studio paper and white letterbox bars', async () => {
    const grayPaper = await sharp({
      create: { width: 2048, height: 1200, channels: 3, background: { r: 186, g: 184, b: 178 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="400" height="360">
            <ellipse cx="200" cy="160" rx="140" ry="140" fill="#d4a017"/>
            <polygon points="200,260 250,350 150,350" fill="#1f8a4c"/>
          </svg>`),
          top: 420,
          left: 824,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    const letterboxed = await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: grayPaper, gravity: 'center' }])
      .jpeg({ quality: 90 })
      .toBuffer();

    const ship = await listingCloseupPresentationIsShipable(letterboxed);
    expect(ship.ok).toBe(false);
    expect(ship.issues.join(' ')).toMatch(/gray|letterbox|occupancy|luminance/i);

    const repaired = await repairListingCloseupPresentation(
      letterboxed,
      `slot3_repaired_letterbox_${Date.now()}.jpg`
    );
    const repairedShip = await listingCloseupPresentationIsShipable(repaired.buffer);
    expect(repairedShip.issues.join('; ')).toBe('');
    expect(repairedShip.ok).toBe(true);
  });

  it('accepts a tall pendant close-up that cannot fill both 70% width and height', async () => {
    const src = await sharp({
      create: { width: 900, height: 1600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="900" height="1600">
            <ellipse cx="450" cy="720" rx="260" ry="260" fill="#d4a017"/>
            <polygon points="450,980 540,1480 360,1480" fill="#1f8a4c"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const crop = await createPendantFillCloseup(src, `slot3_tall_pendant_${Date.now()}.jpg`);
    const ship = await listingCloseupPresentationIsShipable(crop.buffer);
    expect(ship.issues.join('; ')).toBe('');
    expect(ship.ok).toBe(true);
  });

  it('Slot 3 keeps a wide crescent pendant intact instead of cropping through the bail', async () => {
    const src = await sharp({
      create: { width: 1000, height: 1400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="1000" height="1400">
            <circle cx="280" cy="70" r="32" fill="#d4a017"/>
            <circle cx="720" cy="70" r="32" fill="#d4a017"/>
            <path d="M240 140 C 260 520, 320 820, 500 1100 C 680 820, 740 520, 760 140" fill="none" stroke="#c9a227" stroke-width="10"/>
            <path d="M320 820 L320 1080 L380 1080 L380 900 L520 900 L520 1080 L720 1080 L720 820 Z" fill="#d4a017"/>
            <circle cx="620" cy="1000" r="90" fill="#e8c547"/>
            <ellipse cx="500" cy="1280" rx="40" ry="55" fill="#1f8a4c"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const crop = await createPendantFillCloseup(src, `slot3_crescent_full_${Date.now()}.jpg`);
    const pres = await measureListingCloseupPresentation(crop.buffer);
    expect(pres.touchesFrameEdge).toBe(false);
    const ship = await listingCloseupPresentationIsShipable(crop.buffer);
    expect(ship.issues.join('; ')).toBe('');
    expect(ship.ok).toBe(true);

    const { data, info } = await sharp(crop.buffer).raw().toBuffer({ resolveWithObject: true });
    let minY = info.height;
    let maxY = -1;
    let minX = info.width;
    let maxX = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        if (data[idx] < 248 || data[idx + 1] < 248 || data[idx + 2] < 248) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    expect(minY).toBeGreaterThan(16);
    expect(maxY).toBeLessThan(info.height - 16);
    expect(maxX - minX).toBeGreaterThan(info.width * 0.35);
  });

  it('rejects a Slot 3 crop that cuts jewellery at the frame edge', async () => {
    const clipped = await sharp({
      create: { width: 2048, height: 2048, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="2048" height="900">
            <rect x="200" y="0" width="1400" height="700" fill="#d4a017"/>
            <ellipse cx="1024" cy="820" rx="80" ry="70" fill="#1f8a4c"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();
    const ship = await listingCloseupPresentationIsShipable(clipped);
    expect(ship.ok).toBe(false);
    expect(ship.issues.join(' ')).toMatch(/edge|crop/i);
  });

  it('Slot 1 exact_cutout path does not call generative white presentation', async () => {
    const pipelineSrc = fs.readFileSync(
      path.join(__dirname, '../server/services/media/mediaPipelineService.ts'),
      'utf8'
    );
    const packSrc = fs.readFileSync(
      path.join(__dirname, '../server/services/media/galleryPackService.impl.ts'),
      'utf8'
    );
    const fnStart = pipelineSrc.indexOf('export async function generateWhiteProductImage');
    const fnEnd = pipelineSrc.indexOf('export async function generateDetailCloseup');
    const fn = pipelineSrc.slice(fnStart, fnEnd);
    const exactIdx = fn.indexOf("if (mode === 'exact_cutout')");
    const presIdx = fn.indexOf('generateWhiteProductPresentationImage');
    expect(exactIdx).toBeGreaterThan(-1);
    expect(presIdx).toBeGreaterThan(exactIdx);
    expect(fn).toMatch(/options\.whiteProductMode \|\| options\.mode \|\| 'exact_cutout'/);
    expect(packSrc).toMatch(/whiteProductMode:\s*'exact_cutout'/);
    expect(packSrc).toMatch(/mode:\s*'exact_cutout'/);
    expect(packSrc).toMatch(/repairListingCloseupPresentation/);
    expect(packSrc).toMatch(/Detail close-up validation failed/);

    const coverSrc = fs.readFileSync(
      path.join(__dirname, '../server/services/media/deterministicImageService.impl.ts'),
      'utf8'
    );
    const coverStart = coverSrc.indexOf('export async function createPureWhiteCover');
    const coverEnd = coverSrc.indexOf('\nexport async function', coverStart + 10);
    const coverFn = coverSrc.slice(coverStart, coverEnd);
    expect(coverFn).not.toMatch(/composeCompactListingSet/);
    const silkStart = pipelineSrc.indexOf('export async function createStyledSupportingDerivative');
    const silkEnd = pipelineSrc.indexOf('\nexport async function', silkStart + 10);
    const silkFn = pipelineSrc.slice(silkStart, silkEnd);
    expect(silkFn).not.toMatch(/composeCompactListingSet/);

    const src = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="800" height="800">
            <circle cx="400" cy="430" r="120" fill="#d4a017"/>
            <circle cx="400" cy="430" r="48" fill="#f5d77f"/>
            <circle cx="250" cy="160" r="36" fill="#d4a017"/>
            <circle cx="550" cy="160" r="36" fill="#d4a017"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 92 })
      .toBuffer();
    const wp = await generateWhiteProductImage(src, `exact_no_gen_${Date.now()}`, {
      whiteProductMode: 'exact_cutout',
    });
    expect(wp.mode).toBe('exact_cutout');
    expect(wp.url).toMatch(/_exact_cutout_/);
    expect(wp.url).not.toMatch(/white_ai_presentation_/);
    expect(wp.providerUsed).toBe('photoroom');

    const pack = await buildRecommendedGalleryPack({
      productTitle: 'Exact Cutout Forced Hero',
      clusteredItems: [
        {
          id: 'exact_cutout_forced_hero',
          originalFilename: 'exact_cutout_forced_hero.jpg',
          buffer: src,
          analysis: {
            isBlurry: false,
            qualityScore: 90,
            sharpness: 90,
            lighting: 90,
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
    expect(slot1?.whiteProductMode).toBe('exact_cutout');
    expect(slot1?.isAiGenerated).toBe(false);
    expect(slot1?.url).toMatch(/_exact_cutout_/);
    expect(slot1?.url).not.toMatch(/white_ai_presentation_/);
  }, 30000);

  it('Slot 1 hero crops empty clasp chain so pendant and earrings fill the frame', async () => {
    const src = await sharp({
      create: { width: 900, height: 1400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="900" height="1400">
            <path d="M200 50 C 240 50, 660 50, 700 50" fill="none" stroke="#c9a227" stroke-width="6"/>
            <circle cx="450" cy="50" r="12" fill="#c9a227"/>
            <path d="M200 50 C 250 480, 320 820, 450 1180 C 580 820, 650 480, 700 50" fill="none" stroke="#c9a227" stroke-width="8"/>
            <circle cx="320" cy="540" r="52" fill="#d4a017"/>
            <circle cx="580" cy="540" r="52" fill="#d4a017"/>
            <ellipse cx="450" cy="1160" rx="120" ry="120" fill="#d4a017"/>
            <ellipse cx="450" cy="1320" rx="40" ry="52" fill="#1f8a4c"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const cover = await createPureWhiteCover(src, `hero_dense_fill_${Date.now()}.jpg`, {
      targetWidth: 2048,
      targetHeight: 2048,
      occupancyPercent: 86,
      isIsolatedMaster: true,
      cleanArtifacts: false,
    });

    const { data, info } = await sharp(cover.buffer).raw().toBuffer({ resolveWithObject: true });
    let goldTop = 0;
    const topBand = Math.round(info.height * 0.28);
    for (let y = 0; y < topBand; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (r > 160 && g > 100 && r > b + 20) goldTop++;
      }
    }
    expect(goldTop).toBeGreaterThan(1500);
  });

  it('cropSparseUpperChainForListing trims the empty upper chain on a mostly-white CZ set (alpha mask)', async () => {
    // Full-necklace layout: pale/near-white CZ pave (which colour detection
    // mis-reads as background) with a thin gold chain-V. The alpha mask must
    // still find the dense earrings/pendant and drop the sparse upper chain.
    const src = await sharp({
      create: { width: 1000, height: 1600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="1000" height="1600">
            <circle cx="500" cy="40" r="14" fill="rgb(210,205,200)"/>
            <path d="M240 60 C 300 560, 360 900, 500 1300 C 640 900, 700 560, 760 60" fill="none" stroke="rgb(205,200,195)" stroke-width="10"/>
            <circle cx="360" cy="620" r="70" fill="rgb(245,244,242)"/>
            <circle cx="640" cy="620" r="70" fill="rgb(245,244,242)"/>
            <ellipse cx="500" cy="1300" rx="150" ry="160" fill="rgb(246,245,243)"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const cropped = await cropSparseUpperChainForListing(src);
    const meta = await sharp(cropped).metadata();
    // Original object spans roughly full height; a proper trim removes the
    // sparse upper third (clasp + thin chain), leaving a shorter frame.
    expect(meta.height ?? 1600).toBeLessThan(1300);
    // The dense earrings (top of retained content) must now sit near the top.
    const { data, info } = await sharp(cropped).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const band = Math.round(info.height * 0.25);
    let opaqueTop = 0;
    for (let y = 0; y < band; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * info.channels + 3] > 24) opaqueTop++;
      }
    }
    expect(opaqueTop).toBeGreaterThan(3000);
  });

  // Sparse full-set: chain-U + earrings at top, a big empty gap, pendant far
  // below. This is the "tiny pendant lost in empty chain" case the user hit.
  async function sparseSetBuffer(): Promise<Buffer> {
    return sharp({
      create: { width: 800, height: 800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="800" height="800">
            <path d="M250 150 C 300 300, 360 300, 400 305 C 440 300, 500 300, 550 150" fill="none" stroke="#c9a227" stroke-width="8"/>
            <circle cx="228" cy="215" r="22" fill="#f2d675"/>
            <circle cx="572" cy="215" r="22" fill="#f2d675"/>
            <path d="M400 430 L455 520 L400 610 L345 520 Z" fill="#f2d675"/>
            <circle cx="400" cy="520" r="34" fill="#12a05a"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
  }

  async function greenCoreOnWhite(layer: Buffer): Promise<number> {
    const meta = await sharp(layer).metadata();
    const scale = Math.min((2048 * 0.86) / (meta.width || 1), (2048 * 0.86) / (meta.height || 1));
    const rw = Math.max(1, Math.round((meta.width || 1) * scale));
    const rh = Math.max(1, Math.round((meta.height || 1) * scale));
    const scaled = await sharp(layer).resize(rw, rh, { fit: 'inside', kernel: sharp.kernel.lanczos3 }).png().toBuffer();
    const flat = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: scaled, gravity: 'center' }])
      .raw()
      .toBuffer({ resolveWithObject: true });
    let green = 0;
    for (let i = 0; i < flat.data.length; i += flat.info.channels) {
      if (flat.data[i] < 120 && flat.data[i + 1] > 120 && flat.data[i + 2] < 140) green++;
    }
    return green;
  }

  it('composeCompactListingSet enlarges the pendant + keeps earrings for a sparse set', async () => {
    const src = await sparseSetBuffer();
    const composed = await composeCompactListingSet(src);
    // It must actually recompose (not the pass-through path).
    expect(composed.length).not.toBe(src.length);

    const cm = await sharp(composed).metadata();
    // Earrings flank the pendant → the compact layout is wider than tall.
    expect((cm.width || 0) / (cm.height || 1)).toBeGreaterThan(1.1);

    // Earrings present in both the left and right thirds; pendant in the centre.
    const { data, info } = await sharp(composed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const third = Math.floor(info.width / 3);
    let leftGold = 0, rightGold = 0, centerGreen = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        if (data[idx + 3] <= 24) continue;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const isGold = r > 180 && g > 140 && b < 160 && r > b;
        const isGreen = r < 120 && g > 120 && b < 150;
        if (isGold && x < third) leftGold++;
        if (isGold && x >= 2 * third) rightGold++;
        if (isGreen && x >= third && x < 2 * third) centerGreen++;
      }
    }
    expect(leftGold).toBeGreaterThan(200);
    expect(rightGold).toBeGreaterThan(200);
    expect(centerGreen).toBeGreaterThan(200);

    // The pendant's emerald core is much larger on white than a plain contain.
    const compactGreen = await greenCoreOnWhite(composed);
    const plainGreen = await greenCoreOnWhite(src);
    expect(compactGreen).toBeGreaterThan(plainGreen * 1.5);
  }, 30000);

  it('composeCompactListingSet leaves a compact pendant-only piece unchanged (gating)', async () => {
    // No earrings + no big empty gap → must not recompose.
    const solo = await sharp({
      create: { width: 600, height: 700, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="600" height="700">
            <path d="M300 120 L440 350 L300 600 L160 350 Z" fill="#f2d675"/>
            <circle cx="300" cy="350" r="90" fill="#12a05a"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    const out = await composeCompactListingSet(solo);
    expect(out).toBe(solo);
  }, 30000);

  it('Slot 1 exact cover keeps pale earring tips that look like studio paper', async () => {
    const src = await sharp({
      create: { width: 900, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: Buffer.from(`<svg width="900" height="1200">
            <circle cx="260" cy="36" r="28" fill="rgb(220,210,200)"/>
            <circle cx="640" cy="36" r="28" fill="rgb(220,210,200)"/>
            <path d="M220 90 C 250 520, 300 780, 450 1080 C 600 780, 650 520, 680 90" fill="none" stroke="#c9a227" stroke-width="14"/>
            <ellipse cx="450" cy="1100" rx="70" ry="70" fill="#d4a017"/>
          </svg>`),
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();

    const cover = await createPureWhiteCover(src, `hero_pale_earrings_${Date.now()}.jpg`, {
      targetWidth: 2048,
      targetHeight: 2048,
      occupancyPercent: 86,
      isIsolatedMaster: true,
      cleanArtifacts: false,
    });

    const { data, info } = await sharp(cover.buffer).removeAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    const topBand = Math.round(info.height * 0.12);
    let nonWhite = 0;
    for (let y = 0; y < topBand; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        if (data[idx] < 248 || data[idx + 1] < 248 || data[idx + 2] < 248) nonWhite++;
      }
    }
    expect(nonWhite).toBeGreaterThan(80);
  });

  it('image generation defaults to gpt-image-1 and gemini-3-pro-image with lanczos master upscale', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../server/services/media/imageGenerationProvider.ts'),
      'utf8'
    );
    expect(src).toMatch(/DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1'/);
    expect(src).toMatch(/DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3-pro-image'/);
    expect(src).toMatch(/quality',\s*'high'/);
    expect(src).toMatch(/upscaleToMaster2048/);
    expect(src).toMatch(/kernel:\s*sharp\.kernel\.lanczos3/);
  });
});
