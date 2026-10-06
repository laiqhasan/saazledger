import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WHITE_PROCESSING_MODE,
  DEFAULT_WHITE_PRODUCT_MODE,
  computeStudioCounts,
  countDistinctOriginals,
  getMatchLabel,
  getSlotOutputStatus,
  getSlotProblemReason,
  looksLikeDerivativeUrl,
  resolveTrueOriginal,
  describeImageKind,
} from '../src/utils/mediaPackStatus';

const readySlot = {
  slotNumber: 1,
  slotRole: 'HERO_COVER',
  url: '/api/photos/derivatives/a_exact_cutout_1x1_2048x2048.jpg',
  outputStatus: 'ready' as const,
  productMatchScore: 100,
  matchVerdict: 'HIGH_MATCH' as const,
  included: true,
};

describe('Product Accuracy is the default for the Exact white-product slot', () => {
  it('defaults to Product Accuracy / exact cutout', () => {
    expect(DEFAULT_WHITE_PROCESSING_MODE).toBe('product_accuracy');
    expect(DEFAULT_WHITE_PRODUCT_MODE).toBe('exact_cutout');
  });
});

describe('Failed / blank / clipped outputs are never ready and never get a match label', () => {
  it('ready slot keeps its label', () => {
    expect(getSlotOutputStatus(readySlot)).toBe('ready');
    expect(getMatchLabel(readySlot).text).toBe('HIGH MATCH - 100%');
  });

  it('a failed slot shows no label even if a stale 100% score is attached (validator overrides score)', () => {
    const failed = { ...readySlot, generationFailed: true, generationError: 'blank' };
    expect(getSlotOutputStatus(failed)).toBe('failed');
    expect(getMatchLabel(failed).text).toBeNull();
    expect(getSlotProblemReason(failed)).toBe('blank');
  });

  it('a blank output (no url) is failed', () => {
    expect(getSlotOutputStatus({ ...readySlot, url: '', imageUrl: '' })).toBe('failed');
  });

  it('a clipped / needs-review slot shows the reason and no HIGH MATCH label', () => {
    const clipped = { ...readySlot, outputStatus: 'needs_review' as const, outputIssues: ['Subject touches the canvas edge (top) - jewellery is clipped.'], included: false };
    expect(getSlotOutputStatus(clipped)).toBe('needs_review');
    expect(getMatchLabel(clipped).text).toBeNull();
    expect(getSlotProblemReason(clipped)).toMatch(/clipped/);
  });

  it('a forbidden object detected by the validator overrides a high score', () => {
    const ruler = { ...readySlot, forbiddenObjects: ['ruler'] };
    expect(getSlotOutputStatus(ruler)).toBe('needs_review');
    expect(getMatchLabel(ruler).text).toBeNull();
    expect(getSlotProblemReason(ruler)).toMatch(/ruler/);
  });
});

describe('Studio counts: originals vs derivatives, failed outputs are not ready', () => {
  const upload = { id: 'IMG_20261001_120958', dataUrl: 'data:image/jpeg;base64,AAAA' };

  it('counts distinct source uploads once, even if the same piece photo is added twice', () => {
    expect(countDistinctOriginals([upload, { ...upload, id: 'copy' }, { id: 'other', dataUrl: 'data:image/jpeg;base64,BBBB' }])).toBe(2);
  });

  it('does not count failed/blank/clipped derivatives as ready; original-photo slot is not a derivative', () => {
    const counts = computeStudioCounts({
      rawFiles: [upload, { ...upload, id: 'dup' }],
      slots: [
        readySlot,
        { slotNumber: 2, slotRole: 'STYLED_SUPPORTING', url: '', generationFailed: true },
        { slotNumber: 3, slotRole: 'DETAIL_CLOSEUP', url: '/x.jpg', outputStatus: 'needs_review', included: false },
        { slotNumber: 5, slotRole: 'REAL_PHOTO_FALLBACK', url: '/api/photos/abc.jpg', included: true },
      ],
    });
    expect(counts.sourceOriginals).toBe(1);
    expect(counts.pieces).toBe(1);
    expect(counts.derivativesReady).toBe(1);
    expect(counts.derivativesNeedingReview).toBe(1);
    expect(counts.derivativesFailed).toBe(1);
    // ready to publish: the ready white product + the real original photo slot
    expect(counts.readyToPublish).toBe(2);
  });
});

describe('Original vs derivative labelling and resolution', () => {
  it('recognises derivative urls', () => {
    expect(looksLikeDerivativeUrl('/api/photos/derivatives/IMG_x_shopify_2048.jpg')).toBe(true);
    expect(looksLikeDerivativeUrl('/api/photos/derivatives/crop_1.jpg')).toBe(true);
    expect(looksLikeDerivativeUrl('/api/photos/0123456789abcdef.jpg')).toBe(false);
    expect(describeImageKind(true)).toBe('Original');
    expect(describeImageKind(false)).toBe('Derivative');
  });

  it('prefers the browser upload, then the recorded true original; never the derived slot image', () => {
    const slot = {
      ...readySlot,
      mediaId: 'IMG_20261001_120958',
      originalUrl: '/api/photos/derivatives/IMG_x_shopify_2048.jpg', // legacy derivative-as-original
      sourceOriginal: { mediaId: 'IMG_20261001_120958', url: '/api/photos/0123456789abcdef.jpg', width: 2276, height: 4048, sha256: 'abc' },
    };
    const fromBrowser = resolveTrueOriginal(slot, [{ id: 'IMG_20261001_120958', dataUrl: 'data:image/jpeg;base64,AAAA' }]);
    expect(fromBrowser?.origin).toBe('browser_upload');
    expect(fromBrowser?.url).toBe('data:image/jpeg;base64,AAAA');

    const fromServer = resolveTrueOriginal(slot, []);
    expect(fromServer?.origin).toBe('server_record');
    expect(fromServer?.url).toBe('/api/photos/0123456789abcdef.jpg');
    expect(fromServer?.width).toBe(2276);
    expect(fromServer?.height).toBe(4048);
    expect(fromServer?.url).not.toBe(slot.url);
  });

  it('returns null when only derivatives are known (the editor then labels it a derivative)', () => {
    const slot = { ...readySlot, originalUrl: '/api/photos/derivatives/IMG_x_shopify_2048.jpg' };
    expect(resolveTrueOriginal(slot, [])).toBeNull();
  });
});
