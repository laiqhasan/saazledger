/**
 * Output integrity + forbidden-object detection for generated media.
 *
 * Why this exists
 * ---------------
 * 1. Ruler detection used to be "count contrast transitions along one 1px scan line at 8% from
 *    the left / 90% from the bottom of a 256x256 *stretched* thumbnail". A tall photo squashed to a
 *    square, with a pendant/chain/earring crossing that line a handful of times, produced >= 6
 *    transitions and was reported as a ruler. A real ruler is a long, straight, thin band (with
 *    regular tick marks) - so we now look for that structure explicitly instead of counting edges.
 * 2. Generated outputs were never checked for being blank or clipped, and exact-cutout results
 *    always claimed "100% / HIGH MATCH". `analyzeOutputIntegrity` gives callers a hard
 *    blank/clipped/too-small verdict so they can mark the slot failed/needs-review.
 * 3. The true uploaded original needs a stable, hashable reference that every derivative can carry
 *    (`OriginalAssetRef`) so regeneration/crop can always go back to it.
 */
import crypto from 'crypto';
import sharp from 'sharp';
import type { JewelleryCompleteness } from './jewelleryForegroundService';

// ─────────────────────────────────────────────────────────────────────────────
// True-original references
// ─────────────────────────────────────────────────────────────────────────────

export interface OriginalAssetRef {
  /** media/upload id of the immutable upload */
  mediaId?: string;
  /** URL of the immutable full-resolution upload (never a derivative) */
  url: string;
  filename?: string;
  /** EXIF-oriented pixel dimensions (what the crop editor works in) */
  width: number;
  height: number;
  /** sha256 of the exact uploaded bytes */
  sha256: string;
  byteSize: number;
}

export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** EXIF-oriented dimensions of an image buffer (portrait phone photos report swapped raw dims). */
export async function getOrientedDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  const swap = typeof meta.orientation === 'number' && meta.orientation >= 5 && meta.orientation <= 8;
  return swap ? { width: h, height: w } : { width: w, height: h };
}

export async function describeOriginalAsset(
  buffer: Buffer,
  info: { mediaId?: string; url: string; filename?: string }
): Promise<OriginalAssetRef> {
  const dims = await getOrientedDimensions(buffer);
  return {
    mediaId: info.mediaId,
    url: info.url,
    filename: info.filename,
    width: dims.width,
    height: dims.height,
    sha256: sha256Hex(buffer),
    byteSize: buffer.length,
  };
}

/**
 * True when a URL/filename points at something *generated* from an upload (square master, clean
 * cover, cutout, crop, detail, thumbnail, styled/AI output...) rather than the upload itself.
 * Uploads are stored by content hash directly under /api/photos/, derivatives live under
 * /derivatives/ and carry a role suffix.
 */
export function isDerivativeReference(ref?: string | null): boolean {
  if (!ref || typeof ref !== 'string') return false;
  if (ref.startsWith('data:')) return false; // caller-supplied bytes; judged by hash instead
  const clean = ref.split('?')[0];
  if (/\/derivatives\//i.test(clean) || /^derivatives\//i.test(clean)) return true;
  const base = clean.split('/').pop() || '';
  return /(_shopify_2048|_clean_cover|_exact_cutout|_isolated|_cutout|_detail|_white_product|_original_photo|_thumb|_social|_styled|_ai_|_master|_square|_whitebg|_white_bg)/i.test(base) || /^crop_/i.test(base);
}

/**
 * Returns an error string when the candidate buffer is NOT the recorded true original
 * (wrong bytes, or a derivative such as the 2048x2048 square), otherwise null.
 */
export async function verifyAgainstOriginal(buffer: Buffer, original?: OriginalAssetRef | null): Promise<string | null> {
  if (!original) return null;
  if (original.sha256 && sha256Hex(buffer) === original.sha256) return null;
  const dims = await getOrientedDimensions(buffer);
  if (original.width && original.height && (dims.width !== original.width || dims.height !== original.height)) {
    return `Source is ${dims.width}x${dims.height}, not the true original ${original.width}x${original.height}`;
  }
  return 'Source bytes do not match the recorded true original (hash mismatch)';
}

// ─────────────────────────────────────────────────────────────────────────────
// Raster helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

async function loadRaster(buffer: Buffer, maxDim: number): Promise<Raster> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function estimateBackground(r: Raster): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const bx = Math.max(2, Math.round(r.width * 0.03));
  const by = Math.max(2, Math.round(r.height * 0.03));
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (x < bx || x >= r.width - bx || y < by || y >= r.height - by) {
        const i = (y * r.width + x) * 3;
        rs.push(r.data[i]);
        gs.push(r.data[i + 1]);
        bs.push(r.data[i + 2]);
      }
    }
  }
  const med = (a: number[]) => {
    a.sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)] ?? 255;
  };
  return [med(rs), med(gs), med(bs)];
}

function foregroundMask(r: Raster, bg: [number, number, number], threshold: number): Uint8Array {
  const mask = new Uint8Array(r.width * r.height);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 3;
    const d = Math.hypot(r.data[i] - bg[0], r.data[i + 1] - bg[1], r.data[i + 2] - bg[2]);
    if (d > threshold) mask[p] = 1;
  }
  return mask;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ruler / measuring-scale detection
// ─────────────────────────────────────────────────────────────────────────────

export interface RulerDetection {
  detected: boolean;
  kind?: 'ticked_scale' | 'solid_bar';
  orientation?: 'horizontal' | 'vertical';
  /** Normalised 0..1 band box */
  box?: { x: number; y: number; width: number; height: number };
  tickCount?: number;
  reasons: string[];
}

interface Band {
  start: number; // first row (or column) of the band
  end: number; // last row (or column) of the band
  runStart: number; // median start of long run along the axis
  runEnd: number;
}

/**
 * Finds thin, long, straight bands in a foreground mask (rows when `horizontal`, else columns).
 * `lineLen` is the length along the band axis, `lines` the number of rows/cols.
 */
function findStraightBands(
  mask: Uint8Array,
  width: number,
  height: number,
  horizontal: boolean,
  minRunFraction: number
): Band[] {
  const lineLen = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const longest: { len: number; start: number }[] = [];
  for (let l = 0; l < lines; l++) {
    let best = 0;
    let bestStart = 0;
    let cur = 0;
    let curStart = 0;
    let gap = 0;
    for (let k = 0; k < lineLen; k++) {
      const v = horizontal ? mask[l * width + k] : mask[k * width + l];
      if (v) {
        if (cur === 0) curStart = k;
        cur += 1 + gap;
        gap = 0;
        if (cur > best) {
          best = cur;
          bestStart = curStart;
        }
      } else if (cur > 0 && gap < 2) {
        gap++; // tolerate 1-2 px gaps (tick marks on a pale ruler body)
      } else {
        cur = 0;
        gap = 0;
      }
    }
    longest.push({ len: best, start: bestStart });
  }

  const minRun = lineLen * minRunFraction;
  const bands: Band[] = [];
  let l = 0;
  while (l < lines) {
    if (longest[l].len >= minRun) {
      let e = l;
      let miss = 0;
      for (let n = l + 1; n < lines; n++) {
        if (longest[n].len >= minRun) {
          e = n;
          miss = 0;
        } else if (++miss > 1) break;
      }
      const starts: number[] = [];
      const ends: number[] = [];
      for (let n = l; n <= e; n++) {
        if (longest[n].len >= minRun) {
          starts.push(longest[n].start);
          ends.push(longest[n].start + longest[n].len);
        }
      }
      starts.sort((a, b) => a - b);
      ends.sort((a, b) => a - b);
      const medStart = starts[Math.floor(starts.length / 2)];
      const medEnd = ends[Math.floor(ends.length / 2)];
      // A real ruler is *straight*: every row of the band starts/ends at about the same place.
      const tol = lineLen * 0.04;
      const straight = starts.every((s) => Math.abs(s - medStart) <= tol) && ends.every((x) => Math.abs(x - medEnd) <= tol);
      if (straight) bands.push({ start: l, end: e, runStart: medStart, runEnd: medEnd });
      l = e + 1;
    } else {
      l++;
    }
  }
  return bands;
}

function analyseTicks(r: Raster, band: Band, horizontal: boolean): { ticks: number; regular: boolean } {
  const lineLen = horizontal ? r.width : r.height;
  const profile: number[] = [];
  for (let k = band.runStart; k < Math.min(lineLen, band.runEnd); k++) {
    let sum = 0;
    let n = 0;
    for (let l = band.start; l <= band.end; l++) {
      const x = horizontal ? k : l;
      const y = horizontal ? l : k;
      const i = (y * r.width + x) * 3;
      sum += 0.299 * r.data[i] + 0.587 * r.data[i + 1] + 0.114 * r.data[i + 2];
      n++;
    }
    profile.push(sum / Math.max(1, n));
  }
  if (profile.length < 24) return { ticks: 0, regular: false };

  // Detect local minima/maxima excursions (tick marks) with hysteresis.
  const sorted = [...profile].sort((a, b) => a - b);
  const range = sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)];
  if (range < 24) return { ticks: 0, regular: false };
  const hi = sorted[Math.floor(sorted.length * 0.05)] + range * 0.65;
  const lo = sorted[Math.floor(sorted.length * 0.05)] + range * 0.35;
  const positions: number[] = [];
  let state: 'hi' | 'lo' = profile[0] > (hi + lo) / 2 ? 'hi' : 'lo';
  for (let i = 1; i < profile.length; i++) {
    if (state === 'hi' && profile[i] < lo) {
      state = 'lo';
      positions.push(i);
    } else if (state === 'lo' && profile[i] > hi) {
      state = 'hi';
    }
  }
  if (positions.length < 8) return { ticks: positions.length, regular: false };
  const gaps: number[] = [];
  for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  return { ticks: positions.length, regular: cv < 0.3 };
}

/**
 * Detects a ruler / measuring scale / tape: a long straight thin band (>= 50% of the frame along
 * its axis) that either carries regularly spaced tick marks, or is a perfectly straight solid bar
 * with an extreme aspect ratio. Chains, earrings, pendants and ordinary paper texture/edges do not
 * form straight, ticked, full-length bands, so they are no longer misreported.
 */
export async function detectRulerStructure(buffer: Buffer): Promise<RulerDetection> {
  const reasons: string[] = [];
  let raster: Raster;
  try {
    raster = await loadRaster(buffer, 768);
  } catch {
    return { detected: false, reasons: ['unreadable image'] };
  }
  const bg = estimateBackground(raster);
  // Loose threshold: a ruler/tape body is often close to the paper colour (white/cream plastic on
  // white paper). Straightness + thickness + regular ticks keep this from over-triggering.
  const mask = foregroundMask(raster, bg, 14);

  for (const horizontal of [true, false]) {
    const lines = horizontal ? raster.height : raster.width;
    const bands = findStraightBands(mask, raster.width, raster.height, horizontal, 0.5);
    for (const band of bands) {
      const thickness = band.end - band.start + 1;
      const length = band.runEnd - band.runStart;
      // A ruler/tape has a real body: >= 2% and <= 22% of the cross dimension. Hairline strands
      // (a chain laid straight, a thin cord) are far thinner than any measuring scale, so a
      // regular link pattern along them is not a tick scale.
      if (thickness > lines * 0.22 || thickness < Math.max(4, lines * 0.02)) continue;
      const aspect = length / thickness;
      const ticks = analyseTicks(raster, band, horizontal);
      const box = horizontal
        ? { x: band.runStart / raster.width, y: band.start / raster.height, width: length / raster.width, height: thickness / raster.height }
        : { x: band.start / raster.width, y: band.runStart / raster.height, width: thickness / raster.width, height: length / raster.height };
      if (ticks.regular && aspect >= 4) {
        reasons.push(`${horizontal ? 'horizontal' : 'vertical'} band with ${ticks.ticks} regularly spaced tick marks`);
        return { detected: true, kind: 'ticked_scale', orientation: horizontal ? 'horizontal' : 'vertical', box, tickCount: ticks.ticks, reasons };
      }
      if (aspect >= 10 && length >= (horizontal ? raster.width : raster.height) * 0.6) {
        // Solid bar must also be colour-uniform and clearly distinct from the background
        // (a painted scale body), not paper texture, a shadow or a paper edge.
        let dist = 0;
        let sum = 0;
        let sumSq = 0;
        let n = 0;
        for (let l = band.start; l <= band.end; l++) {
          for (let k = band.runStart; k < band.runEnd; k += 2) {
            const x = horizontal ? k : l;
            const y = horizontal ? l : k;
            const i = (y * raster.width + x) * 3;
            const lum = 0.299 * raster.data[i] + 0.587 * raster.data[i + 1] + 0.114 * raster.data[i + 2];
            dist += Math.hypot(raster.data[i] - bg[0], raster.data[i + 1] - bg[1], raster.data[i + 2] - bg[2]);
            sum += lum;
            sumSq += lum * lum;
            n++;
          }
        }
        const mean = sum / Math.max(1, n);
        const sd = Math.sqrt(Math.max(0, sumSq / Math.max(1, n) - mean * mean));
        if (sd < 28 && dist / Math.max(1, n) > 40) {
          reasons.push(`${horizontal ? 'horizontal' : 'vertical'} straight uniform bar (aspect ${aspect.toFixed(0)}:1)`);
          return { detected: true, kind: 'solid_bar', orientation: horizontal ? 'horizontal' : 'vertical', box, reasons };
        }
      }
    }
  }
  return { detected: false, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Blank / clipped / framing analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface SubjectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceSubjectInfo {
  /** subject bbox aspect ratio (w/h) measured on the true source */
  aspect: number;
  /** fraction of the source frame the subject bbox covers */
  frameFraction: number;
  bbox: SubjectBox;
}

export interface OutputIntegrity {
  ok: boolean;
  status: 'ok' | 'needs_review' | 'failed';
  isBlank: boolean;
  isFilled: boolean;
  isClipped: boolean;
  isTooSmall: boolean;
  touchedEdges: Array<'left' | 'right' | 'top' | 'bottom'>;
  subjectBox: SubjectBox | null;
  canvas: { width: number; height: number };
  /** padding between subject bbox and each canvas edge, as a fraction of that canvas dimension */
  padding: { left: number; right: number; top: number; bottom: number } | null;
  subjectFrameFraction: number;
  issues: string[];
}

export interface IntegrityOptions {
  /** minimum padding (fraction of canvas dimension) required around the subject */
  minPadding?: number;
  /** subject measured on the true source; used to detect lost chain/earrings */
  source?: SourceSubjectInfo | null;
  /** background of the output. 'white' (default) or 'auto' (estimated from the border) */
  background?: 'white' | 'auto';
}

function measureSubject(r: Raster, mask: Uint8Array): { box: SubjectBox | null; count: number; touched: Array<'left' | 'right' | 'top' | 'bottom'> } {
  // Ignore speckle: require a pixel to have at least one foreground neighbour.
  let minX = r.width;
  let maxX = -1;
  let minY = r.height;
  let maxY = -1;
  let count = 0;
  for (let y = 1; y < r.height - 1; y++) {
    for (let x = 1; x < r.width - 1; x++) {
      const p = y * r.width + x;
      if (!mask[p]) continue;
      if (!(mask[p - 1] || mask[p + 1] || mask[p - r.width] || mask[p + r.width])) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // Pixels in the 1px outer ring are skipped above; count them explicitly for edge contact.
  const touched: Array<'left' | 'right' | 'top' | 'bottom'> = [];
  const band = Math.max(1, Math.round(Math.min(r.width, r.height) * 0.004));
  let l = 0;
  let rt = 0;
  let t = 0;
  let b = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (!mask[y * r.width + x]) continue;
      if (x < band) l++;
      if (x >= r.width - band) rt++;
      if (y < band) t++;
      if (y >= r.height - band) b++;
    }
  }
  const minContact = 3;
  if (l >= minContact) touched.push('left');
  if (rt >= minContact) touched.push('right');
  if (t >= minContact) touched.push('top');
  if (b >= minContact) touched.push('bottom');
  if (maxX < 0) return { box: null, count, touched };
  for (const e of touched) {
    if (e === 'left') minX = 0;
    if (e === 'right') maxX = r.width - 1;
    if (e === 'top') minY = 0;
    if (e === 'bottom') maxY = r.height - 1;
  }
  return { box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, count, touched };
}

/** Measures the subject on the true source so outputs can be compared against it. */
export async function analyzeSourceSubject(buffer: Buffer): Promise<SourceSubjectInfo | null> {
  try {
    const raster = await loadRaster(buffer, 512);
    const bg = estimateBackground(raster);
    const mask = foregroundMask(raster, bg, 48);
    const { box } = measureSubject(raster, mask);
    if (!box || box.width < 4 || box.height < 4) return null;
    return {
      aspect: box.width / box.height,
      frameFraction: (box.width * box.height) / (raster.width * raster.height),
      bbox: {
        x: box.x / raster.width,
        y: box.y / raster.height,
        width: box.width / raster.width,
        height: box.height / raster.height,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Hard verdict on a generated white-background output.
 * - blank: (almost) nothing but background, or the canvas is entirely filled
 * - clipped: the subject touches/crosses the canvas border, has less than `minPadding`, or its
 *   aspect ratio is far from the source subject (a long chain/earring was cut off)
 * - too small: the subject is an unusably tiny fraction of the frame
 */
export async function analyzeOutputIntegrity(buffer: Buffer, options: IntegrityOptions = {}): Promise<OutputIntegrity> {
  const minPadding = options.minPadding ?? 0.01;
  const issues: string[] = [];
  const raster = await loadRaster(buffer, 1024);
  const bg: [number, number, number] = options.background === 'auto' ? estimateBackground(raster) : [255, 255, 255];
  const mask = foregroundMask(raster, bg, 18);
  const total = raster.width * raster.height;
  const { box, count, touched } = measureSubject(raster, mask);
  const fgRatio = count / total;

  const isBlank = !box || fgRatio < 0.0005;
  const isFilled = fgRatio > 0.97;
  if (isBlank) issues.push('Generated image is blank (no subject visible on the canvas).');
  if (isFilled) issues.push('Generated image is completely filled - no background/subject separation.');

  let padding: OutputIntegrity['padding'] = null;
  let isClipped = false;
  let isTooSmall = false;
  let frameFraction = 0;

  if (box && !isBlank) {
    padding = {
      left: box.x / raster.width,
      right: (raster.width - (box.x + box.width)) / raster.width,
      top: box.y / raster.height,
      bottom: (raster.height - (box.y + box.height)) / raster.height,
    };
    frameFraction = (box.width * box.height) / total;
    if (touched.length > 0) {
      isClipped = true;
      issues.push(`Subject touches the canvas edge (${touched.join(', ')}) - jewellery is clipped.`);
    } else if (Math.min(padding.left, padding.right, padding.top, padding.bottom) < minPadding) {
      isClipped = true;
      issues.push('Subject has no safe padding to the canvas edge - jewellery may be clipped.');
    }
    if (options.source && options.source.aspect > 0 && options.source.frameFraction < 0.85) {
      const outAspect = box.width / box.height;
      const ratio = outAspect / options.source.aspect;
      // A tall necklace set (aspect ~0.4) turning into a near-square block means the chain top /
      // earrings were cut. Allow generous tolerance: stray segmentation noise shouldn't fail it.
      if (ratio > 1.45 || ratio < 0.69) {
        isClipped = true;
        issues.push(
          `Subject proportions changed vs the source (aspect ${outAspect.toFixed(2)} vs ${options.source.aspect.toFixed(2)}) - parts of the jewellery are missing or cut off.`
        );
      }
    }
    if (box.width / raster.width < 0.12 && box.height / raster.height < 0.12) {
      isTooSmall = true;
      issues.push('Subject occupies an unusably small part of the frame.');
    }
  }

  const failed = isBlank || isFilled;
  const needsReview = isClipped || isTooSmall;
  return {
    ok: !failed && !needsReview,
    status: failed ? 'failed' : needsReview ? 'needs_review' : 'ok',
    isBlank,
    isFilled,
    isClipped,
    isTooSmall,
    touchedEdges: touched,
    subjectBox: box
      ? { x: box.x / raster.width, y: box.y / raster.height, width: box.width / raster.width, height: box.height / raster.height }
      : null,
    canvas: { width: raster.width, height: raster.height },
    padding,
    subjectFrameFraction: frameFraction,
    issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output status (ready / needs review / failed) - single source of truth for labels
// ─────────────────────────────────────────────────────────────────────────────

export type OutputStatus = 'ready' | 'needs_review' | 'failed';

export interface WhiteProductEvaluation {
  status: OutputStatus;
  issues: string[];
  integrity: OutputIntegrity;
  forbiddenObjects: string[];
  /** true when the output may carry an exact-match / HIGH MATCH label */
  matchLabelAllowed: boolean;
  /** jewellery completeness gate (output vs original-photo jewellery foreground); see jewelleryForegroundService */
  completeness?: JewelleryCompleteness;
}

/**
 * Evaluates a generated white-product output. A validator error (blank, clipped, forbidden object)
 * always overrides any similarity score - callers must not show "HIGH MATCH" unless
 * `matchLabelAllowed` is true.
 */
export function combineEvaluation(
  integrity: OutputIntegrity,
  forbiddenObjects: string[],
  completeness?: JewelleryCompleteness | null
): WhiteProductEvaluation {
  const issues = [...integrity.issues];
  if (forbiddenObjects.length > 0) issues.push(`Forbidden object(s) detected: ${forbiddenObjects.join(', ')}`);
  // Completeness gate: a lost chain segment / pendant / earring (or < strict retention) means the
  // output is NOT an exact product match, whatever the similarity score says.
  const gate = completeness && completeness.applicable ? completeness : null;
  if (gate && !gate.pass) issues.push(...gate.issues);
  let status: OutputStatus =
    integrity.status === 'failed' ? 'failed' : integrity.status === 'needs_review' || forbiddenObjects.length > 0 ? 'needs_review' : 'ready';
  // The image exists and the operator must be able to inspect it next to the reason, so a failed
  // gate is reported as needs_review at slot level (gate.status keeps the severity).
  if (gate && !gate.pass && status !== 'failed') status = 'needs_review';
  return {
    status, issues, integrity, forbiddenObjects, matchLabelAllowed: status === 'ready',
    ...(completeness ? { completeness } : {}),
  };
}
