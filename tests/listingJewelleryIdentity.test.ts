import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { scoreListingJewelleryIdentity } from '../server/services/media/productFidelityValidator';
import { createListingSetCloseup } from '../server/services/media/deterministicImageService';

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

  it('Slot 3 listing close-up includes earring tops (never starts 12–16% down)', async () => {
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

    const crop = await createListingSetCloseup(src, `listing_tops_${Date.now()}.jpg`);
    const { data, info } = await sharp(crop.buffer).raw().toBuffer({ resolveWithObject: true });
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
    expect(hoopPixels).toBeGreaterThan(80);
  });
});
