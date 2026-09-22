import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { scoreListingJewelleryIdentity } from '../server/services/media/productFidelityValidator';
import { createListingSetCloseup, createContainFitListingCloseup, validateDetailCloseup } from '../server/services/media/deterministicImageService';
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
    const containRaw = await sharp(contain.buffer).raw().toBuffer({ resolveWithObject: true });

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
    expect(goldBbox(data, info)).toBeGreaterThan(goldBbox(containRaw.data, containRaw.info));
    expect(goldBbox(data, info)).toBeGreaterThan(0.55);
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
    expect(Math.max(occW, occH)).toBeLessThanOrEqual(0.94);
  });

  it('Slot 3 listing close-up of a full necklace+earrings set is accepted even if macro validateDetailCloseup fails', async () => {
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
    const macro = await validateDetailCloseup(listing.buffer);
    expect(macro.valid).toBe(false);

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

  it('model generation path does not apply the 90% still-life identity gate', async () => {
    const providerSrc = fs.readFileSync(
      path.join(__dirname, '../server/services/media/imageGenerationProvider.ts'),
      'utf8'
    );
    const modelFnStart = providerSrc.indexOf('export async function generateModelImage');
    const modelFnEnd = providerSrc.indexOf('export async function generateLifestyleImage');
    const modelFn = providerSrc.slice(modelFnStart, modelFnEnd);
    expect(modelFn).not.toMatch(/scoreOrMockListingIdentity/);
    expect(modelFn).not.toMatch(/LISTING_IDENTITY_MIN/);
    expect(modelFn).toMatch(/hasListingJewelleryColorPixels/);

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
