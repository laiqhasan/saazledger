import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { scoreListingJewelleryIdentity } from '../server/services/media/productFidelityValidator';
import { createListingSetCloseup, createContainFitListingCloseup, createPendantFillCloseup, createBruteForceLowerPendantCrop, listingLooksLikeFullChainClaspLayout } from '../server/services/media/deterministicImageService';
import { generateModelImage } from '../server/services/media/imageGenerationProvider';
import { buildRecommendedGalleryPack } from '../server/services/media/galleryPackService';
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
    // Geometric lower-crop is a landscape slice letterboxed on 2048, not an 88% square pendant stamp.
    expect(Math.max(occW, occH)).toBeGreaterThanOrEqual(0.45);
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
    const topCut = Math.round(info.height * 0.25);
    let topJewellery = 0;
    let totalJewellery = 0;
    let green = 0;
    let blue = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * info.channels;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        if (r < 248 || g < 248 || b < 248) {
          totalJewellery++;
          if (y < topCut) topJewellery++;
        }
        if (g > r + 30 && g > b + 30) green++;
        if (b > r + 30 && b > g + 30) blue++;
      }
    }
    expect(totalJewellery).toBeGreaterThan(1000);
    expect(topJewellery / Math.max(totalJewellery, 1)).toBeLessThan(0.02);
    expect(green).toBeLessThan(40);
    expect(blue).toBeGreaterThan(green);
    expect(blue).toBeGreaterThan(totalJewellery * 0.08);

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
    let slotTop = 0, slotAll = 0, slotGreen = 0, slotBlue = 0;
    const slotTopCut = Math.round(slotRaw.info.height * 0.25);
    for (let y = 0; y < slotRaw.info.height; y++) {
      for (let x = 0; x < slotRaw.info.width; x++) {
        const idx = (y * slotRaw.info.width + x) * slotRaw.info.channels;
        const r = slotRaw.data[idx], g = slotRaw.data[idx + 1], b = slotRaw.data[idx + 2];
        if (r < 248 || g < 248 || b < 248) {
          slotAll++;
          if (y < slotTopCut) slotTop++;
        }
        if (g > r + 30 && g > b + 30) slotGreen++;
        if (b > r + 30 && b > g + 30) slotBlue++;
      }
    }
    expect(slotTop / Math.max(slotAll, 1)).toBeLessThan(0.02);
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

    const src = await goldSetBuffer();
    const model = await generateModelImage({
      productTitle: 'Gold Pendant Set',
      sourceBuffer: src,
      presetKey: 'office_to_occasion',
    });
    expect(model.success).toBe(true);
    expect(model.generatedImageUrl).toBeTruthy();
  });
});
