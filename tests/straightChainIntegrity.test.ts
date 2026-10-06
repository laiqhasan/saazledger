/**
 * Straight jewellery (chains, posts) must never be removed; the completeness gate must catch any loss.
 * ALL fixtures here are SYNTHETIC drawings (sharp/SVG) - they are not the user's real photo.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import {
  PHOTO_W, PHOTO_H, RIGHT_EARRING_MAX_X, chainPhoto, chainCutout, eraseFromCutout, whiteSquareFromCutout, type ChainFixtureOptions,
} from './helpers/chainFixtures';
import { cleanJewelleryCutoutArtifacts } from '../server/services/media/imageCleanupService';
import { analyzeJewelleryForeground, evaluateJewelleryCompleteness } from '../server/services/media/jewelleryForegroundService';
import { evaluateWhiteProductOutput } from '../server/services/media/mediaPipelineService';
import { combineEvaluation, analyzeOutputIntegrity } from '../server/services/media/outputIntegrityService';
import { getSlotOutputStatus, getMatchLabel, getSlotProblemReason } from '../src/utils/mediaPackStatus';
import { applyNonDestructiveCrop } from '../server/services/media/deterministicImageService';

const CX = PHOTO_W / 2;

async function alphaOf(png: Buffer): Promise<{ data: Buffer; w: number; h: number }> {
  const { data, info } = await sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
async function opaqueCount(png: Buffer): Promise<number> {
  const { data } = await alphaOf(png);
  let n = 0;
  for (const v of data) if (v > 25) n++;
  return n;
}
/** opaque pixels in a source-pixel rectangle */
async function opaqueIn(png: Buffer, x0: number, y0: number, x1: number, y1: number): Promise<number> {
  const { data, w } = await alphaOf(png);
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (data[y * w + x] > 25) n++;
  return n;
}

const FULL: ChainFixtureOptions = { hangingChain: true, laidChain: true, earrings: true };

describe('straight chains / posts are never removed by cleanup (SYNTHETIC fixtures)', () => {
  it('(a) a perfectly straight chain hanging from the pendant is kept', async () => {
    const cut = await chainCutout(FULL);
    const before = await opaqueIn(cut, CX - 30, 420, CX + 30, 1700);
    expect(before).toBeGreaterThan(3000);
    const res = await cleanJewelleryCutoutArtifacts(cut, { removeRuler: true });
    expect(await opaqueIn(res.fullCleanedBuffer, CX - 30, 420, CX + 30, 1700)).toBe(before);
    expect(res.hasRuler).toBe(false);
    expect(res.removedArtifactsCount).toBe(0);
  });

  it('(a2) a straight chain NOT connected to anything and hugging the left frame edge is kept (old heuristic called it a ruler)', async () => {
    const cut = await chainCutout({ ...FULL, spareLeftChain: true });
    const before = await opaqueIn(cut, 60, 600, 140, 3300);
    expect(before).toBeGreaterThan(3000);
    const res = await cleanJewelleryCutoutArtifacts(cut, { removeRuler: true });
    expect(await opaqueIn(res.fullCleanedBuffer, 60, 600, 140, 3300)).toBe(before);
    expect(res.hasRuler).toBe(false);
    expect(res.keptStraightStructures).toBeGreaterThan(0);
    expect(res.warnings!.join(' ')).toMatch(/kept/i);
  });

  it('(b) a straight horizontal chain laid beside the pendant (separate, bottom of frame) is kept', async () => {
    const cut = await chainCutout(FULL);
    const before = await opaqueIn(cut, 880, 3600, 1520, 3680);
    expect(before).toBeGreaterThan(2000);
    const res = await cleanJewelleryCutoutArtifacts(cut, { removeRuler: true });
    expect(await opaqueIn(res.fullCleanedBuffer, 880, 3600, 1520, 3680)).toBe(before);
    expect(res.removedArtifactsCount).toBe(0);
    // and it is a jewellery component of the source photo, not a ruler
    const analysis = await analyzeJewelleryForeground(await chainPhoto(FULL));
    expect(analysis!.rulers).toHaveLength(0);
    expect(analysis!.components.length).toBeGreaterThanOrEqual(4); // pendant+chain, laid chain, two earrings
  });

  it('(c) straight earring posts are kept, and a long straight uniform thin bar is never a ruler', async () => {
    const cut = await chainCutout({ ...FULL, extraSvg: `<rect x="300" y="3000" width="14" height="900" fill="#8b909a"/>` });
    const before = await opaqueIn(cut, CX - 520, 2900, CX - 480, 3280);
    expect(before).toBeGreaterThan(3000);
    const res = await cleanJewelleryCutoutArtifacts(cut, { removeRuler: true });
    expect(await opaqueIn(res.fullCleanedBuffer, CX - 520, 2900, CX - 480, 3280)).toBe(before);
    expect(await opaqueIn(res.fullCleanedBuffer, 290, 3000, 330, 3900)).toBeGreaterThan(10000);
    expect(res.hasRuler).toBe(false);
    const analysis = await analyzeJewelleryForeground(
      await chainPhoto({ ...FULL, extraSvg: `<rect x="300" y="300" width="14" height="3500" fill="#8b909a"/>` })
    );
    expect(analysis!.rulers).toHaveLength(0);
  });
});

describe('real rulers are still identified (SYNTHETIC fixtures)', () => {
  it('(d) a ticked ruler near but disconnected from the jewellery is flagged, excluded from jewellery and removed by cleanup', async () => {
    const rulerX = RIGHT_EARRING_MAX_X + 115;
    const withRuler = await analyzeJewelleryForeground(await chainPhoto({ ...FULL, rulerX }));
    const without = await analyzeJewelleryForeground(await chainPhoto(FULL));
    expect(withRuler!.rulers).toHaveLength(1);
    expect(withRuler!.rulers[0].kind).toBe('ticked_scale');
    expect(withRuler!.rulers[0].nearJewellery).toBe(false);
    expect(withRuler!.rulers[0].gapToJewelleryPx).toBeGreaterThan(20);
    // not counted as jewellery: same components and (almost) same foreground area
    expect(withRuler!.components.length).toBe(without!.components.length);
    expect(Math.abs(withRuler!.jewelleryAreaPx - without!.jewelleryAreaPx) / without!.jewelleryAreaPx).toBeLessThan(0.02);

    const cut = await chainCutout({ ...FULL, rulerX });
    const chainBefore = await opaqueIn(cut, CX - 30, 420, CX + 30, 1700);
    const res = await cleanJewelleryCutoutArtifacts(cut, { removeRuler: true });
    expect(res.hasRuler).toBe(true);
    expect(await opaqueIn(res.fullCleanedBuffer, rulerX, 250, rulerX + 190, 3750)).toBe(0);
    expect(await opaqueIn(res.fullCleanedBuffer, CX - 30, 420, CX + 30, 1700)).toBe(chainBefore);
  });

  it('(e) a ruler touching the jewellery is flagged needs_review and the jewellery is retained', async () => {
    const rulerX = RIGHT_EARRING_MAX_X - 4;
    const photo = await chainPhoto({ ...FULL, rulerX });
    const analysis = await analyzeJewelleryForeground(photo);
    expect(analysis!.rulers).toHaveLength(1);
    expect(analysis!.rulers[0].nearJewellery).toBe(true);

    // jewellery-only output still passes retention, but the gate asks for review because of the ruler
    const white = await whiteSquareFromCutout(await chainCutout(FULL));
    const gate = await evaluateJewelleryCompleteness(photo, white);
    expect(gate.retainedPercent).toBeGreaterThanOrEqual(97);
    expect(gate.status).toBe('needs_review');
    expect(gate.pass).toBe(false);
    expect(gate.issues.join(' ')).toMatch(/ruler/i);

    // cleanup of the cutout (ruler touching the right earring): nothing is deleted, review requested
    const cut = await chainCutout({ ...FULL, rulerX });
    const before = await opaqueCount(cut);
    const res = await cleanJewelleryCutoutArtifacts(cut, { removeRuler: true });
    expect(res.needsReview).toBe(true);
    expect(res.hasRuler).toBe(false);
    expect(await opaqueCount(res.fullCleanedBuffer)).toBe(before);
    expect(res.warnings!.join(' ')).toMatch(/needs_review/);
  });
});

describe('completeness gate (SYNTHETIC fixtures)', () => {
  let photo: Buffer;
  let cut: Buffer;
  beforeAll(async () => {
    photo = await chainPhoto(FULL);
    cut = await chainCutout(FULL);
  });

  it('(g) passes on a complete cutout and reports per-region retention', async () => {
    const white = await whiteSquareFromCutout(cut);
    const gate = await evaluateJewelleryCompleteness(photo, white);
    expect(gate.applicable).toBe(true);
    expect(gate.pass).toBe(true);
    expect(gate.status).toBe('ok');
    expect(gate.retainedPercent).toBeGreaterThanOrEqual(99);
    expect(gate.missingComponentCount).toBe(0);
    expect(gate.issues).toEqual([]);
    const kinds = new Set(gate.regions.map((r) => r.kind));
    expect(kinds.has('pendant')).toBe(true);
    expect(kinds.has('earring')).toBe(true);
    expect(kinds.has('chain')).toBe(true);
    // end to end through the status logic used for blank/clipped checks
    const evaluation = await evaluateWhiteProductOutput(white, photo);
    expect(evaluation!.status).toBe('ready');
    expect(evaluation!.matchLabelAllowed).toBe(true);
  });

  it('(f) FAILS Product Accuracy when a chain segment is deliberately erased from the cutout', async () => {
    const damaged = await eraseFromCutout(cut, { x: CX - 80, y: 600, width: 160, height: 700 });
    const white = await whiteSquareFromCutout(damaged);
    const gate = await evaluateJewelleryCompleteness(photo, white, { includeLostMask: true });
    expect(gate.pass).toBe(false);
    expect(['needs_review', 'failed']).toContain(gate.status);
    expect(gate.retainedPercent).toBeLessThan(97);
    expect(gate.issues.join(' ')).toMatch(/Chain segment missing: \d+\.\d% of jewellery foreground not present/);
    expect(gate.lostRegions.length).toBeGreaterThan(0);
    expect(gate.lostMask!.data.some((v) => v === 1)).toBe(true);

    const evaluation = await evaluateWhiteProductOutput(white, photo);
    expect(evaluation!.status).not.toBe('ready');
    expect(evaluation!.matchLabelAllowed).toBe(false);
    expect(evaluation!.issues.join(' ')).toMatch(/Chain segment missing/);

    // the UI status logic (src/utils/mediaPackStatus.ts) shows it: never ready, no exact-match label
    const slot = { url: '/x.jpg', outputStatus: 'ready' as const, productMatchScore: 100, jewelleryCompleteness: gate };
    expect(getSlotOutputStatus(slot)).toBe('needs_review');
    expect(getMatchLabel(slot).text).toBeNull();
    expect(getSlotProblemReason(slot)).toMatch(/Chain segment missing/);
  });

  it('(f2) also fails when the END of the chain (and a whole earring) is erased, shrinking the subject box', async () => {
    const noTop = await eraseFromCutout(cut, { x: CX - 80, y: 300, width: 160, height: 500 });
    const g1 = await evaluateJewelleryCompleteness(photo, await whiteSquareFromCutout(noTop));
    expect(g1.pass).toBe(false);
    const noEarring = await eraseFromCutout(cut, { x: CX + 380, y: 2850, width: 240, height: 850 });
    const g2 = await evaluateJewelleryCompleteness(photo, await whiteSquareFromCutout(noEarring));
    expect(g2.pass).toBe(false);
    expect(g2.status).toBe('failed');
    expect(g2.missingComponentCount).toBeGreaterThan(0);
    expect(g2.issues.join(' ')).toMatch(/Earring missing/);
  });

  it('combineEvaluation lets the gate override an otherwise clean integrity verdict', async () => {
    const white = await whiteSquareFromCutout(await eraseFromCutout(cut, { x: CX - 80, y: 600, width: 160, height: 700 }));
    const integrity = await analyzeOutputIntegrity(white);
    const gate = await evaluateJewelleryCompleteness(photo, white);
    const ev = combineEvaluation(integrity, [], gate);
    expect(integrity.status).toBe('ok');
    expect(ev.status).toBe('needs_review');
    expect(ev.matchLabelAllowed).toBe(false);
  });
});

describe('1:1 crop path uses contain WITH padding (SYNTHETIC fixture)', () => {
  it('a tall full-height crop fitted into a square keeps a white margin on every side; a matching-aspect crop stays edge to edge', async () => {
    const photo = await chainPhoto(FULL);
    const tall = await applyNonDestructiveCrop(photo, { x: 0, y: 0, width: PHOTO_W, height: PHOTO_H, aspectRatio: '1:1', filename: `crop_padding_test_${Date.now()}.jpg` }, 1024);
    const raw = await sharp(tall.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = raw.info;
    expect([width, height]).toEqual([1024, 1024]);
    const nonWhiteIn = (x0: number, y0: number, x1: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 3;
        if (raw.data[o] < 245 || raw.data[o + 1] < 245 || raw.data[o + 2] < 245) n++;
      }
      return n;
    };
    // paper (beige) fills the crop; it must start inside a ~3% margin => outer 2% rows/cols are white
    expect(nonWhiteIn(0, 0, width, 20)).toBe(0);
    expect(nonWhiteIn(0, height - 20, width, height)).toBe(0);
    expect(nonWhiteIn(0, 0, 20, height)).toBe(0);
    expect(nonWhiteIn(width - 20, 0, width, height)).toBe(0);
    expect(nonWhiteIn(0, 40, width, height - 40)).toBeGreaterThan(1000);

    const squareCrop = await applyNonDestructiveCrop(photo, { x: 0, y: 0, width: PHOTO_W, height: PHOTO_W, aspectRatio: '1:1', filename: `crop_padding_sq_${Date.now()}.jpg` }, 1024);
    const sq = await sharp(squareCrop.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const o = (3 * sq.info.width + 3) * 3;
    expect(sq.data[o]).toBeLessThan(245); // paper reaches the corner: no padding added to an exact-aspect crop
    void PHOTO_H;
  });
});
