import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  detectBackgroundType,
  validateJewelleryMask,
} from '../server/services/media/backgroundRemovalService';

describe('hybrid jewellery background isolation', () => {
  it('classifies a simple white/cream source as plain', async () => {
    const source = await sharp({
      create: {
        width: 600,
        height: 900,
        channels: 3,
        background: { r: 246, g: 244, b: 241 },
      },
    })
      .png()
      .toBuffer();

    await expect(detectBackgroundType(source)).resolves.toBe('plain');
  });

  it('classifies a colourful prop-like source as styled', async () => {
    const source = await sharp({
      create: {
        width: 600,
        height: 900,
        channels: 3,
        background: { r: 95, g: 35, b: 115 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 260,
              height: 260,
              channels: 3,
              background: { r: 235, g: 95, b: 135 },
            },
          }).png().toBuffer(),
          left: 0,
          top: 0,
        },
        {
          input: await sharp({
            create: {
              width: 240,
              height: 300,
              channels: 3,
              background: { r: 25, g: 145, b: 95 },
            },
          }).png().toBuffer(),
          left: 360,
          top: 600,
        },
      ])
      .png()
      .toBuffer();

    await expect(detectBackgroundType(source)).resolves.toBe('styled');
  });

  it('accepts a sparse jewellery-like transparent mask', async () => {
    const transparent = await sharp({
      create: {
        width: 500,
        height: 500,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 8,
              height: 360,
              channels: 4,
              background: { r: 180, g: 180, b: 180, alpha: 1 },
            },
          }).png().toBuffer(),
          left: 170,
          top: 50,
        },
        {
          input: await sharp({
            create: {
              width: 8,
              height: 360,
              channels: 4,
              background: { r: 180, g: 180, b: 180, alpha: 1 },
            },
          }).png().toBuffer(),
          left: 320,
          top: 50,
        },
        {
          input: await sharp({
            create: {
              width: 90,
              height: 110,
              channels: 4,
              background: { r: 35, g: 55, b: 130, alpha: 1 },
            },
          }).png().toBuffer(),
          left: 205,
          top: 330,
        },
      ])
      .png()
      .toBuffer();

    const quality = await validateJewelleryMask(transparent, true);
    expect(quality.foregroundRatio).toBeGreaterThan(0);
    expect(quality.foregroundRatio).toBeLessThan(0.34);
  });

  it('rejects a broad prop/background alpha mask in styled mode', async () => {
    const broad = await sharp({
      create: {
        width: 500,
        height: 500,
        channels: 4,
        background: { r: 235, g: 220, b: 210, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const quality = await validateJewelleryMask(broad, true);
    expect(quality.acceptable).toBe(false);
    expect(quality.issues.length).toBeGreaterThan(0);
  });
});
