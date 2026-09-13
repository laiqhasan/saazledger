import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import {
  validateChainSymmetry,
  detectChainWarpOrCollapse,
  validatePendantCentered,
  validateSilverToneCleanliness,
  detectBlackishMetalContamination,
  enhanceSilverTonePrompt,
  cleanSilverToneFinish,
  validateNoExtraJewelry,
  validateHeroPresentationQuality,
} from '../server/services/media/deterministicImageService';
import { generateHeroImage } from '../server/services/media/mediaPipelineService';

describe('Focused AI Jewellery Hero Quality Pipeline — Chain Symmetry & Silver-Tone Cleanup', () => {
  let symmetricSilverNecklaceBuffer: Buffer;
  let asymmetricSilverNecklaceBuffer: Buffer;
  let offCenterPendantBuffer: Buffer;
  let dirtySilverFinishBuffer: Buffer;
  let silverWithBlueStoneBuffer: Buffer;
  let fourEarringsBuffer: Buffer;

  beforeAll(async () => {
    // 1. Balanced, symmetric silver necklace with centered pendant and 2 earrings
    symmetricSilverNecklaceBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <!-- Symmetrical chain drape -->
              <path d="M 250,150 Q 400,450 550,150" stroke="#c0c0c0" stroke-width="8" fill="none" />
              <!-- Centered pendant on axis x=400 -->
              <polygon points="400,430 440,500 400,570 360,500" fill="#d0d0d0" stroke="#ffffff" stroke-width="2" />
              <!-- Exactly 1 pair of earrings: balanced left and right -->
              <circle cx="210" cy="300" r="22" fill="#c0c0c0" />
              <circle cx="590" cy="300" r="22" fill="#c0c0c0" />
            </svg>`
          ),
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();

    // 2. Asymmetric / warped chain (one side bows inward and has uneven pixel density)
    asymmetricSilverNecklaceBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <!-- Left side bows inward sharply with heavy stroke, right side curves outward wide with thin stroke -->
              <path d="M 330,150 Q 370,300 400,450" stroke="#c0c0c0" stroke-width="26" fill="none" />
              <path d="M 400,450 Q 560,280 620,150" stroke="#c0c0c0" stroke-width="4" fill="none" />
              <polygon points="400,440 440,510 400,580 360,510" fill="#d0d0d0" stroke="#ffffff" stroke-width="2" />
            </svg>`
          ),
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();

    // 3. Off-center pendant (shifted to x=520, >10% lateral drift)
    offCenterPendantBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <path d="M 250,150 Q 400,450 550,150" stroke="#b8b8b8" stroke-width="8" fill="none" />
              <!-- Pendant shifted far to the right -->
              <polygon points="520,430 560,500 520,570 480,500" fill="#c4c4c4" stroke="#ffffff" stroke-width="2" />
            </svg>`
          ),
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();

    // 4. Dirty silver finish with blackish/muddy shadow contamination
    dirtySilverFinishBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <!-- Chain with dark muddy blackish segments (luma < 50) -->
              <path d="M 250,150 Q 400,450 550,150" stroke="#222222" stroke-width="14" fill="none" />
              <!-- Pendant metal with heavy dark shadow contamination -->
              <polygon points="400,430 450,510 400,590 350,510" fill="#181818" stroke="#252525" stroke-width="4" />
            </svg>`
          ),
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();

    // 5. Silver jewellery with royal blue sapphire gemstone
    silverWithBlueStoneBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <path d="M 250,150 Q 400,450 550,150" stroke="#b0b0b0" stroke-width="8" fill="none" />
              <polygon points="400,430 440,500 400,570 360,500" fill="#222222" stroke="#ffffff" stroke-width="2" />
              <!-- Royal blue sapphire stone at x=400, y=500 -->
              <circle cx="400" cy="500" r="24" fill="#0f41d7" />
            </svg>`
          ),
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();

    // 6. Duplicate components (4 earrings total)
    fourEarringsBuffer = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="800" height="800">
              <path d="M 250,150 Q 400,450 550,150" stroke="#b8b8b8" stroke-width="8" fill="none" />
              <polygon points="400,430 440,500 400,570 360,500" fill="#c4c4c4" stroke="#ffffff" stroke-width="2" />
              <!-- Pair 1 -->
              <circle cx="210" cy="270" r="20" fill="#b8b8b8" />
              <circle cx="590" cy="270" r="20" fill="#b8b8b8" />
              <!-- Duplicate Pair 2 -->
              <circle cx="150" cy="380" r="20" fill="#b8b8b8" />
              <circle cx="650" cy="380" r="20" fill="#b8b8b8" />
            </svg>`
          ),
        },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();
  });

  it('1. chain symmetry validation returns pass on balanced layout', async () => {
    const symRes = await validateChainSymmetry(symmetricSilverNecklaceBuffer);
    expect(symRes.passed).toBe(true);
    expect(symRes.valid).toBe(true);
    expect(symRes.score).toBeGreaterThanOrEqual(70);
    expect(symRes.balanceRatio).toBeGreaterThanOrEqual(0.60);
    expect(symRes.balanceRatio).toBeLessThanOrEqual(1.40);
    expect(symRes.notes).toHaveLength(0);

    const warpRes = await detectChainWarpOrCollapse(symmetricSilverNecklaceBuffer);
    expect(warpRes.passed).toBe(true);
    expect(warpRes.score).toBeGreaterThanOrEqual(70);
  });

  it('2. chain symmetry validation rejects visibly distorted one-sided chain', async () => {
    const asymRes = await validateChainSymmetry(asymmetricSilverNecklaceBuffer);
    expect(asymRes.passed).toBe(false);
    expect(asymRes.valid).toBe(false);
    expect(asymRes.notes.length).toBeGreaterThan(0);

    const warpRes = await detectChainWarpOrCollapse(asymmetricSilverNecklaceBuffer);
    expect(warpRes.passed).toBe(false);
    expect(warpRes.notes.length).toBeGreaterThan(0);
  });

  it('3. pendant-centered validation detects offset pendant', async () => {
    const centeredRes = await validatePendantCentered(symmetricSilverNecklaceBuffer);
    expect(centeredRes.passed).toBe(true);
    expect(centeredRes.valid).toBe(true);
    expect(centeredRes.offsetPercent).toBeLessThanOrEqual(10);
    expect(centeredRes.score).toBeGreaterThanOrEqual(50);

    const offCenterRes = await validatePendantCentered(offCenterPendantBuffer);
    expect(offCenterRes.passed).toBe(false);
    expect(offCenterRes.valid).toBe(false);
    expect(offCenterRes.offsetPercent).toBeGreaterThan(10);
    expect(offCenterRes.score).toBeLessThan(50);
    expect(offCenterRes.notes.length).toBeGreaterThan(0);
  });

  it('4. silver-tone cleanliness validation rejects blackish/dull metal contamination', async () => {
    const cleanCheck = await validateSilverToneCleanliness(dirtySilverFinishBuffer);
    expect(cleanCheck.passed).toBe(false);
    expect(cleanCheck.darkMetalRatio).toBeGreaterThan(0.15);
    expect(cleanCheck.notes.length).toBeGreaterThan(0);

    const detectContam = await detectBlackishMetalContamination(dirtySilverFinishBuffer);
    expect(detectContam.passed).toBe(false);
    expect(detectContam.contaminated).toBe(true);
    expect(detectContam.darkMetalRatio).toBeGreaterThan(0.15);
  });

  it('5. silver-tone cleanup preserves blue stone color', async () => {
    const cleanResult = await cleanSilverToneFinish(silverWithBlueStoneBuffer);
    expect(cleanResult.cleaned).toBe(true);

    // Inspect pixel color in the center of the blue stone (x=400, y=500)
    const { data: rawRgb, info } = await sharp(cleanResult.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const idx = (500 * info.width + 400) * 3;
    const r = rawRgb[idx];
    const g = rawRgb[idx + 1];
    const b = rawRgb[idx + 2];

    expect(b).toBeGreaterThan(r + 35);
    expect(b).toBeGreaterThan(g + 25);

    const val = await validateSilverToneCleanliness(cleanResult.buffer);
    expect(val.blueStonePreserved).toBe(true);
  });

  it('6. retry occurs once when hero fails symmetry or silver cleanliness threshold', async () => {
    const res = await generateHeroImage(
      symmetricSilverNecklaceBuffer,
      `retry_test_${Date.now()}`,
      {
        mockFailSymmetryOnFirstTry: true, // Forces initial failure to trigger retry
        outputRatio: '1:1',
      }
    );

    expect(res).toBeDefined();
    expect(res.retried).toBe(true);
    expect(res.success).toBe(true);
    expect(res.mode).toBe('ai_presentation');
    expect(res.validationPassed).toBe(true);
    expect(res.fallbackUsed).toBe(false);
  });

  it('7. fallback / review path triggers if retry still fails', async () => {
    const res = await generateHeroImage(
      asymmetricSilverNecklaceBuffer,
      `fallback_test_${Date.now()}`,
      {
        mockScoreForTests: 60, // Consistently below threshold, forcing fallback
        outputRatio: '1:1',
      }
    );

    expect(res).toBeDefined();
    expect(res.mode).toBe('exact_cutout');
    expect(res.fallbackUsed).toBe(true);
    expect(res.matchVerdict).toBe('NEEDS_REVIEW');
    expect(res.url).toBe(res.exactCutoutUrl);
  });

  it('8. no extra jewellery components are introduced during hero enhancement', async () => {
    const validSet = await validateNoExtraJewelry(symmetricSilverNecklaceBuffer);
    expect(validSet.valid).toBe(true);
    expect(validSet.earringCount).toBe(2);
    expect(validSet.necklaceCount).toBe(1);
    expect(validSet.pendantCount).toBe(1);
    expect(validSet.extraComponentsCount).toBe(0);

    const invalidSet = await validateNoExtraJewelry(fourEarringsBuffer);
    expect(invalidSet.valid).toBe(false);
    expect(invalidSet.earringCount).toBeGreaterThan(2);

    const promptWithInstructions = enhanceSilverTonePrompt('Standard luxury jewellery photo prompt');
    expect(promptWithInstructions).toContain('SILVER-TONE FINISH & GEMSTONE RULES');
    expect(promptWithInstructions).toContain('STRICT PRODUCT-LOCK');
    expect(promptWithInstructions).toContain('Clean unwanted blackish');
  });
});
