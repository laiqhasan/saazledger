import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import {
  detectRulerStructure,
  analyzeOutputIntegrity,
  analyzeSourceSubject,
  combineEvaluation,
  describeOriginalAsset,
  isDerivativeReference,
  verifyAgainstOriginal,
  getOrientedDimensions,
  sha256Hex,
} from '../server/services/media/outputIntegrityService';
import {
  validateGalleryAsset,
  createPureWhiteCover,
  applyNonDestructiveCrop,
} from '../server/services/media/deterministicImageService';

/**
 * Fixtures are generated with sharp - no network, no AI/provider calls.
 * The reproduction photo from the bug report is a 2276x4048 portrait photo of a blue pear-halo
 * pendant set (long chain, pendant, two earrings) lying on plain paper, with NO ruler.
 */
const PHOTO_W = 2276;
const PHOTO_H = 4048;

function jewellerySvg(w: number, h: number, bg: string | null): string {
  const cx = w / 2;
  const halo = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2;
    return `<circle cx="${cx + Math.cos(a) * 150}" cy="${2550 + Math.sin(a) * 190}" r="26" fill="#cfe3ff" stroke="#8a8f99" stroke-width="6"/>`;
  }).join('');
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    ${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}
    <!-- long chain with clasp near the top -->
    <circle cx="${cx - 40}" cy="260" r="34" fill="none" stroke="#7d828c" stroke-width="12"/>
    <path d="M ${cx - 40} 294 C ${cx - 700} 1100 ${cx - 520} 1900 ${cx} 2320 C ${cx + 520} 1900 ${cx + 700} 1100 ${cx + 40} 294"
          stroke="#8b909a" stroke-width="16" stroke-dasharray="26 8" fill="none"/>
    <!-- spare chain length laid straight down the left side (links produce regular light/dark
         transitions along any scan line through it - the old "tick mark" heuristic read that as a ruler) -->
    <line x1="182" y1="700" x2="182" y2="3500" stroke="#8b909a" stroke-width="16" stroke-dasharray="26 8"/>
    <line x1="560" y1="3643" x2="${w - 560}" y2="3643" stroke="#8b909a" stroke-width="14" stroke-dasharray="24 9"/>
    <!-- pear halo pendant -->
    ${halo}
    <path d="M ${cx} 2330 C ${cx + 210} 2480 ${cx + 190} 2800 ${cx} 2960 C ${cx - 190} 2800 ${cx - 210} 2480 ${cx} 2330 Z" fill="#1d4fa8" stroke="#c9ccd3" stroke-width="22"/>
    <!-- matching earrings: hook + pear drop -->
    <path d="M ${cx - 520} 3250 q 40 -90 90 0" stroke="#8b909a" stroke-width="12" fill="none"/>
    <path d="M ${cx - 475} 3270 C ${cx - 410} 3350 ${cx - 410} 3560 ${cx - 475} 3640 C ${cx - 540} 3560 ${cx - 540} 3350 ${cx - 475} 3270 Z" fill="#1d4fa8" stroke="#c9ccd3" stroke-width="16"/>
    <path d="M ${cx + 430} 3250 q 40 -90 90 0" stroke="#8b909a" stroke-width="12" fill="none"/>
    <path d="M ${cx + 475} 3270 C ${cx + 540} 3350 ${cx + 540} 3560 ${cx + 475} 3640 C ${cx + 410} 3560 ${cx + 410} 3350 ${cx + 475} 3270 Z" fill="#1d4fa8" stroke="#c9ccd3" stroke-width="16"/>
  </svg>`;
}

async function paperPhoto(extraSvg = ''): Promise<Buffer> {
  const paper = await sharp({
    create: { width: PHOTO_W, height: PHOTO_H, channels: 3, background: { r: 238, g: 233, b: 224 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${PHOTO_W}" height="${PHOTO_H}" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="0.04"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
            <rect width="${PHOTO_W}" height="${PHOTO_H}" fill="url(#g)"/>
          </svg>`
        ),
      },
      { input: Buffer.from(jewellerySvg(PHOTO_W, PHOTO_H, null)) },
      ...(extraSvg ? [{ input: Buffer.from(`<svg width="${PHOTO_W}" height="${PHOTO_H}" xmlns="http://www.w3.org/2000/svg">${extraSvg}</svg>`) }] : []),
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
  return paper;
}

function ticks(count: number, makeTick: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => makeTick(i)).join('');
}

// Vertical steel/plastic ruler along the right edge with a tick every 60px.
const VERTICAL_RULER = `
  <rect x="2020" y="250" width="190" height="3500" fill="#f3ead0" stroke="#555" stroke-width="4"/>
  ${ticks(58, (i) => `<rect x="2020" y="${270 + i * 60}" width="${i % 5 === 0 ? 110 : 60}" height="8" fill="#1a1a1a"/>`)}`;
// Horizontal ruler across the bottom.
const HORIZONTAL_RULER = `
  <rect x="150" y="3820" width="1976" height="170" fill="#f3ead0" stroke="#555" stroke-width="4"/>
  ${ticks(32, (i) => `<rect x="${170 + i * 60}" y="3820" width="8" height="${i % 5 === 0 ? 110 : 60}" fill="#1a1a1a"/>`)}`;
// Yellow measuring tape lying along the bottom.
const MEASURING_TAPE = `
  <rect x="100" y="3780" width="2076" height="130" fill="#f2c800"/>
  ${ticks(34, (i) => `<rect x="${130 + i * 60}" y="3780" width="7" height="${i % 5 === 0 ? 90 : 50}" fill="#222"/>`)}`;

async function whiteSquareWithSubject(): Promise<Buffer> {
  // The same jewellery layout contained (not cropped) in a white 2048 square.
  const subject = await sharp(Buffer.from(jewellerySvg(PHOTO_W, PHOTO_H, '#ffffff'))).png().toBuffer();
  const fitted = await sharp(subject).resize(1800, 1800, { fit: 'inside' }).png().toBuffer();
  return sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#ffffff' } })
    .composite([{ input: fitted, gravity: 'center' }])
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('Forbidden-object (ruler) detection', () => {
  let photo: Buffer;

  beforeAll(async () => {
    photo = await paperPhoto();
  });

  it('fixture is the reproduction geometry: 2276x4048 portrait, no ruler', async () => {
    const dims = await getOrientedDimensions(photo);
    expect(dims).toEqual({ width: PHOTO_W, height: PHOTO_H });
  });

  it('does NOT flag a tall paper photo of a pendant set (long chain + earrings) as a ruler', async () => {
    const detection = await detectRulerStructure(photo);
    expect(detection.detected).toBe(false);
    const realPhoto = await validateGalleryAsset(photo, 'REAL_PHOTO');
    expect(realPhoto.forbiddenObjects).not.toContain('ruler');
    const hero = await validateGalleryAsset(photo, 'HERO_COVER');
    expect(hero.forbiddenObjects).not.toContain('ruler');
  });

  it('does NOT flag the white-background output of the same pendant set', async () => {
    const white = await whiteSquareWithSubject();
    const v = await validateGalleryAsset(white, 'WHITE_PRODUCT');
    expect(v.forbiddenObjects).not.toContain('ruler');
    expect(v.valid).toBe(true);
    expect((await detectRulerStructure(white)).detected).toBe(false);
  });

  it('still detects a real vertical ruler lying next to the jewellery', async () => {
    const withRuler = await paperPhoto(VERTICAL_RULER);
    const detection = await detectRulerStructure(withRuler);
    expect(detection.detected).toBe(true);
    expect(detection.orientation).toBe('vertical');
    const v = await validateGalleryAsset(withRuler, 'REAL_PHOTO');
    expect(v.valid).toBe(false);
    expect(v.forbiddenObjects).toContain('ruler');
    expect(v.reason).toMatch(/Forbidden object\(s\) detected: ruler/);
  });

  it('still detects a horizontal ruler and a yellow measuring tape', async () => {
    const withRuler = await paperPhoto(HORIZONTAL_RULER);
    expect((await detectRulerStructure(withRuler)).detected).toBe(true);
    const withTape = await paperPhoto(MEASURING_TAPE);
    const tape = await detectRulerStructure(withTape);
    expect(tape.detected).toBe(true);
    expect((await validateGalleryAsset(withTape, 'WHITE_PRODUCT')).forbiddenObjects).toContain('ruler');
  });

  it('still detects a ruler on a white-background output', async () => {
    const white = await whiteSquareWithSubject();
    const ruler = await sharp(white)
      .composite([
        {
          input: Buffer.from(
            `<svg width="2048" height="2048" xmlns="http://www.w3.org/2000/svg"><rect x="80" y="1930" width="1888" height="90" fill="#f3ead0"/>${ticks(
              30,
              (i) => `<rect x="${100 + i * 62}" y="1930" width="7" height="${i % 5 === 0 ? 60 : 36}" fill="#1a1a1a"/>`
            )}</svg>`
          ),
        },
      ])
      .jpeg()
      .toBuffer();
    expect((await validateGalleryAsset(ruler, 'WHITE_PRODUCT')).forbiddenObjects).toContain('ruler');
  });
});

describe('Blank / clipped output detection (never ready, never a match label)', () => {
  it('flags an all-white canvas as blank and failed', async () => {
    const blank = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const integrity = await analyzeOutputIntegrity(blank);
    expect(integrity.isBlank).toBe(true);
    expect(integrity.status).toBe('failed');
    expect(integrity.ok).toBe(false);
    const evaluation = combineEvaluation(integrity, []);
    expect(evaluation.status).toBe('failed');
    expect(evaluation.matchLabelAllowed).toBe(false);
  });

  it('flags near-all-white output (a few specks) as blank', async () => {
    const speck = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="30" height="30"><rect width="30" height="30" fill="#777"/></svg>'), left: 900, top: 900 }])
      .jpeg()
      .toBuffer();
    expect((await analyzeOutputIntegrity(speck)).isBlank).toBe(true);
  });

  it('flags a subject touching the canvas border as clipped / needs review', async () => {
    const clipped = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="400" height="1900"><rect width="400" height="1900" fill="#1d4fa8"/></svg>'), left: 824, top: 0 }])
      .jpeg({ quality: 95 })
      .toBuffer();
    const integrity = await analyzeOutputIntegrity(clipped);
    expect(integrity.isClipped).toBe(true);
    expect(integrity.touchedEdges).toContain('top');
    expect(integrity.status).toBe('needs_review');
    expect(combineEvaluation(integrity, []).matchLabelAllowed).toBe(false);
  });

  it('flags a tall chain cropped into a block (aspect far from the source subject)', async () => {
    const photo = await paperPhoto();
    const source = await analyzeSourceSubject(photo);
    expect(source).not.toBeNull();
    expect(source!.aspect).toBeLessThan(0.9); // tall subject
    // Output where the subject was cut into a wide block with safe padding but missing parts.
    const cut = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="1500" height="900"><rect width="1500" height="900" fill="#1d4fa8"/></svg>'), left: 274, top: 574 }])
      .jpeg({ quality: 95 })
      .toBuffer();
    const integrity = await analyzeOutputIntegrity(cut, { source });
    expect(integrity.isClipped).toBe(true);
    expect(integrity.issues.join(' ')).toMatch(/proportions changed|missing/i);
  });

  it('passes a complete subject with padding', async () => {
    const white = await whiteSquareWithSubject();
    const photo = await paperPhoto();
    const source = await analyzeSourceSubject(photo);
    const integrity = await analyzeOutputIntegrity(white, { source });
    expect(integrity.issues).toEqual([]);
    expect(integrity.ok).toBe(true);
    expect(Math.min(...Object.values(integrity.padding!))).toBeGreaterThan(0.02);
    expect(combineEvaluation(integrity, []).matchLabelAllowed).toBe(true);
  });

  it('a forbidden object overrides an otherwise perfect output', async () => {
    const white = await whiteSquareWithSubject();
    const evaluation = combineEvaluation(await analyzeOutputIntegrity(white), ['ruler']);
    expect(evaluation.status).toBe('needs_review');
    expect(evaluation.matchLabelAllowed).toBe(false);
    expect(evaluation.issues.join(' ')).toMatch(/ruler/);
  });
});

describe('White-background framing: contain/fit with padding, never auto-crop', () => {
  async function tallTransparentSet(width: number, height: number): Promise<Buffer> {
    return sharp(Buffer.from(jewellerySvg(PHOTO_W, PHOTO_H, null)))
      .resize(width, height, { fit: 'inside' })
      .png()
      .toBuffer();
  }

  for (const [ratio, w, h] of [
    ['1:1', 2048, 2048],
    ['4:5', 1638, 2048],
    ['9:16', 1152, 2048],
  ] as const) {
    it(`keeps the complete tall subject inside the ${ratio} canvas with padding`, async () => {
      const master = await tallTransparentSet(900, 1600);
      const result = await createPureWhiteCover(master, `integrity_framing_${ratio.replace(':', 'x')}.jpg`, {
        targetWidth: w,
        targetHeight: h,
        backgroundMode: 'pure_white',
        isIsolatedMaster: true,
      });
      expect(result.width).toBe(w);
      expect(result.height).toBe(h);
      const integrity = await analyzeOutputIntegrity(result.buffer);
      expect(integrity.issues).toEqual([]);
      expect(integrity.touchedEdges).toEqual([]);
      const pad = integrity.padding!;
      for (const side of [pad.left, pad.right, pad.top, pad.bottom]) {
        expect(side).toBeGreaterThanOrEqual(0.02);
      }
      // Complete subject: proportions equal the source master's (no clipping, no stretching).
      const masterBox = await analyzeSourceSubject(await sharp(master).flatten({ background: '#ffffff' }).jpeg().toBuffer());
      const outBox = integrity.subjectBox!;
      const outAspect = (outBox.width * w) / (outBox.height * h);
      expect(outAspect / masterBox!.aspect).toBeGreaterThan(0.9);
      expect(outAspect / masterBox!.aspect).toBeLessThan(1.1);
    });
  }
});

describe('Immutable true original + crop recovery', () => {
  it('references the true original (id/url/dimensions/hash) and detects derivatives', async () => {
    const photo = await paperPhoto();
    const ref = await describeOriginalAsset(photo, { mediaId: 'IMG_20261001_120958', url: '/api/photos/abc123.jpg', filename: 'IMG_20261001_120958.jpg' });
    expect(ref.width).toBe(PHOTO_W);
    expect(ref.height).toBe(PHOTO_H);
    expect(ref.sha256).toBe(sha256Hex(photo));
    expect(ref.byteSize).toBe(photo.length);
    expect(isDerivativeReference('/api/photos/derivatives/x_shopify_2048.jpg')).toBe(true);
    expect(isDerivativeReference('/api/photos/derivatives/crop_123.jpg')).toBe(true);
    expect(isDerivativeReference('/api/photos/abc123def4567890.jpg')).toBe(false);
  });

  it('rejects the 2048x2048 derivative as a stand-in for the original', async () => {
    const photo = await paperPhoto();
    const ref = await describeOriginalAsset(photo, { url: '/api/photos/abc.jpg' });
    const derivative = await sharp(photo).resize(2048, 2048, { fit: 'contain', background: '#fff' }).jpeg().toBuffer();
    expect(await verifyAgainstOriginal(photo, ref)).toBeNull();
    const err = await verifyAgainstOriginal(derivative, ref);
    expect(err).toMatch(/2048x2048/);
    expect(err).toMatch(/2276x4048/);
  });

  it('crop recovery from the true original works after a bad (clipped) generation', async () => {
    const photo = await paperPhoto();
    const before = sha256Hex(photo);
    // A previous bad generation: a clipped 2048x2048 derivative of the same photo.
    const bad = await sharp(photo).resize(2048, 2048, { fit: 'cover', position: 'centre' }).jpeg().toBuffer();
    expect((await getOrientedDimensions(bad)).height).toBe(2048);

    // Recovery: crop the TRUE original (full chain top to earring bottom) - not the derivative.
    const crop = await applyNonDestructiveCrop(photo, { x: 0, y: 0, width: PHOTO_W, height: PHOTO_H, aspectRatio: 'free', filename: 'integrity_recovery_crop.jpg' } as any, 2048);
    const out = await getOrientedDimensions(crop.buffer);
    // Free ratio of 2276x4048 -> 1152x2048: the whole portrait frame, proportions preserved.
    expect(out.height).toBe(2048);
    expect(Math.abs(out.width / out.height - PHOTO_W / PHOTO_H)).toBeLessThan(0.01);
    const integrity = await analyzeOutputIntegrity(crop.buffer, { background: 'auto' });
    expect(integrity.isBlank).toBe(false);
    // Original bytes are untouched by cropping.
    expect(sha256Hex(photo)).toBe(before);
  });
});
