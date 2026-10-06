/**
 * Jewellery foreground analysis + COMPLETENESS GATE.
 *
 * Why this exists
 * ---------------
 * Straight jewellery (a chain laid straight, a straight chain hanging from a pendant/earring hook, a
 * straight earring post) used to be deleted from exact-cutout / white-background outputs because the
 * cleanup treated "long, straight, thin component near the frame border" as a ruler (see
 * docs/straight-chain-root-cause.md). Nothing then checked that the output still contained all the
 * jewellery that is in the photo, so the loss was silent.
 *
 * This module provides
 *  1. `findRulerBands`      - POSITIVE ruler/scale identification (thick band + regular tick marks, or a
 *                             long uniform solid bar). Thin straight strands (chains, posts) can never match.
 *  2. `analyzeJewelleryForeground` - segments the jewellery foreground of an ORIGINAL photo, excludes
 *                             positively identified rulers, splits it into connected components and
 *                             regions (pendant / earrings / chain segments).
 *  3. `evaluateJewelleryCompleteness` - compares an output (cutout / white background) against the source
 *                             jewellery foreground and reports per-region retention. If the output loses
 *                             a component or retains less than the strict threshold the verdict is
 *                             needs_review / failed so Product Accuracy cannot pass.
 *
 * Everything is deterministic, offline and uses sharp only.
 */
import sharp from 'sharp';

// ─────────────────────────────────────────────────────────────────────────────
// Raster + morphology helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface Raster {
  data: Buffer; // RGB, 3 channels
  width: number;
  height: number;
}

export async function loadAnalysisRaster(buffer: Buffer, maxDim: number): Promise<Raster> {
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

function integralImage(mask: Uint8Array, w: number, h: number): Int32Array {
  const W = w + 1;
  const I = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x] ? 1 : 0;
      I[(y + 1) * W + (x + 1)] = I[y * W + (x + 1)] + row;
    }
  }
  return I;
}

function windowCount(I: Int32Array, w: number, x0: number, y0: number, x1: number, y1: number): number {
  const W = w + 1;
  return I[(y1 + 1) * W + (x1 + 1)] - I[y0 * W + (x1 + 1)] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
}

/** Rectangular erosion with half sizes hx/hy. Pixels whose window leaves the frame are cleared. */
export function erodeRect(mask: Uint8Array, w: number, h: number, hx: number, hy: number): Uint8Array {
  const I = integralImage(mask, w, h);
  const out = new Uint8Array(w * h);
  const full = (2 * hx + 1) * (2 * hy + 1);
  for (let y = hy; y < h - hy; y++) {
    for (let x = hx; x < w - hx; x++) {
      if (mask[y * w + x] && windowCount(I, w, x - hx, y - hy, x + hx, y + hy) === full) out[y * w + x] = 1;
    }
  }
  return out;
}

export function dilateRect(mask: Uint8Array, w: number, h: number, hx: number, hy: number): Uint8Array {
  const I = integralImage(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - hy);
    const y1 = Math.min(h - 1, y + hy);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - hx);
      const x1 = Math.min(w - 1, x + hx);
      if (windowCount(I, w, x0, y0, x1, y1) > 0) out[y * w + x] = 1;
    }
  }
  return out;
}

export interface LabelStats {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 8-connected component labelling. labels[i] = 0 (background) or 1..n. stats[0] is unused. */
export function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; n: number; stats: LabelStats[] } {
  const labels = new Int32Array(w * h);
  const stats: LabelStats[] = [{ area: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 }];
  const queue = new Int32Array(w * h);
  let n = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    n++;
    const st: LabelStats = { area: 0, minX: w, minY: h, maxX: 0, maxY: 0 };
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = n;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w;
      const cy = (cur - cx) / w;
      st.area++;
      if (cx < st.minX) st.minX = cx;
      if (cx > st.maxX) st.maxX = cx;
      if (cy < st.minY) st.minY = cy;
      if (cy > st.maxY) st.maxY = cy;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (mask[ni] && !labels[ni]) {
            labels[ni] = n;
            queue[tail++] = ni;
          }
        }
      }
    }
    stats.push(st);
  }
  return { labels, n, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// Background model (paper) + distance map
// ─────────────────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (!values.length) return 255;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function solve3(A: number[][], b: number[]): number[] | null {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/**
 * Per-pixel distance from a paper model: border median colour plus a linear lighting gradient fitted
 * to paper-like grid cells (so a vignette/shadow across the sheet is not mistaken for foreground).
 * Returns distances clamped to 0..255.
 */
export function paperDistanceMap(r: Raster): { dist: Uint8Array; background: [number, number, number] } {
  const { width: w, height: h, data } = r;
  const bx = Math.max(2, Math.round(w * 0.03));
  const by = Math.max(2, Math.round(h * 0.03));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (x < bx || x >= w - bx || y < by || y >= h - by) {
        const i = (y * w + x) * 3;
        rs.push(data[i]);
        gs.push(data[i + 1]);
        bs.push(data[i + 2]);
      }
    }
  }
  const bg: [number, number, number] = [median(rs), median(gs), median(bs)];

  // Plane fit on paper-like cells.
  const cols = 12;
  const rows = 16;
  const cellsX: number[] = [];
  const cellsY: number[] = [];
  const cellCol: number[][] = [[], [], []];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * w) / cols);
      const x1 = Math.floor(((cx + 1) * w) / cols);
      const y0 = Math.floor((cy * h) / rows);
      const y1 = Math.floor(((cy + 1) * h) / rows);
      const cr: number[] = [];
      const cg: number[] = [];
      const cb: number[] = [];
      for (let y = y0; y < y1; y += 3) {
        for (let x = x0; x < x1; x += 3) {
          const i = (y * w + x) * 3;
          cr.push(data[i]);
          cg.push(data[i + 1]);
          cb.push(data[i + 2]);
        }
      }
      if (!cr.length) continue;
      const m: [number, number, number] = [median(cr), median(cg), median(cb)];
      if (Math.hypot(m[0] - bg[0], m[1] - bg[1], m[2] - bg[2]) < 30) {
        cellsX.push((x0 + x1) / 2 / w);
        cellsY.push((y0 + y1) / 2 / h);
        cellCol[0].push(m[0]);
        cellCol[1].push(m[1]);
        cellCol[2].push(m[2]);
      }
    }
  }
  const coef: Array<[number, number, number]> = [
    [bg[0], 0, 0],
    [bg[1], 0, 0],
    [bg[2], 0, 0],
  ];
  if (cellsX.length >= 8) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    const n = cellsX.length;
    for (let i = 0; i < n; i++) {
      sx += cellsX[i]; sy += cellsY[i];
      sxx += cellsX[i] * cellsX[i]; syy += cellsY[i] * cellsY[i]; sxy += cellsX[i] * cellsY[i];
    }
    const A = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
    for (let c = 0; c < 3; c++) {
      let t0 = 0, t1 = 0, t2 = 0;
      for (let i = 0; i < n; i++) {
        t0 += cellCol[c][i]; t1 += cellCol[c][i] * cellsX[i]; t2 += cellCol[c][i] * cellsY[i];
      }
      const sol = solve3(A, [t0, t1, t2]);
      // Ignore implausibly steep gradients (> 40 levels across the frame).
      if (sol && Math.abs(sol[1]) < 40 && Math.abs(sol[2]) < 40) coef[c] = [sol[0], sol[1], sol[2]];
    }
  }
  const dist = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / h;
    for (let x = 0; x < w; x++) {
      const fx = x / w;
      const i = (y * w + x) * 3;
      const dr = data[i] - (coef[0][0] + coef[0][1] * fx + coef[0][2] * fy);
      const dg = data[i + 1] - (coef[1][0] + coef[1][1] * fx + coef[1][2] * fy);
      const db = data[i + 2] - (coef[2][0] + coef[2][1] * fx + coef[2][2] * fy);
      dist[y * w + x] = Math.min(255, Math.round(Math.sqrt(dr * dr + dg * dg + db * db)));
    }
  }
  return { dist, background: bg };
}

function thresholdMask(dist: Uint8Array, thr: number): Uint8Array {
  const m = new Uint8Array(dist.length);
  for (let i = 0; i < dist.length; i++) if (dist[i] > thr) m[i] = 1;
  return m;
}

function grayOf(r: Raster): Uint8Array {
  const g = new Uint8Array(r.width * r.height);
  for (let p = 0; p < g.length; p++) {
    const i = p * 3;
    g[p] = Math.round(0.299 * r.data[i] + 0.587 * r.data[i + 1] + 0.114 * r.data[i + 2]);
  }
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// Positive ruler / scale identification
// ─────────────────────────────────────────────────────────────────────────────

export interface RulerBand {
  orientation: 'horizontal' | 'vertical';
  kind: 'ticked_scale' | 'solid_bar';
  /** pixel box (x1/y1 exclusive) of the band body in the analysed raster */
  box: { x0: number; y0: number; x1: number; y1: number };
  tickCount: number;
  thickness: number;
  length: number;
  reasons: string[];
}

/** Regular tick marks in a 1-D luminance profile (>= 8 evenly spaced dips). */
export function detectRegularTicks(profile: number[]): { ticks: number; regular: boolean } {
  if (profile.length < 24) return { ticks: 0, regular: false };
  const sorted = [...profile].sort((a, b) => a - b);
  const p05 = sorted[Math.floor(sorted.length * 0.05)];
  const range = sorted[Math.floor(sorted.length * 0.95)] - p05;
  if (range < 24) return { ticks: 0, regular: false };
  const hi = p05 + range * 0.65;
  const lo = p05 + range * 0.35;
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

export interface RulerSearchInput {
  width: number;
  height: number;
  /** generous foreground mask (a pale ruler body must be inside it) */
  looseMask: Uint8Array;
  gray: Uint8Array;
  /** distance from background (0..255); used for the uniform-bar test */
  dist: Uint8Array;
}

/**
 * Finds rulers / measuring scales. A band qualifies ONLY with positive evidence:
 *   - it survives a morphological opening with a rectangle that is >= 25% of the frame long and
 *     >= 1.2% of the short frame side thick (a chain, hook, post or hairline strand is far thinner
 *     than that and can never survive), AND
 *   - it carries regularly spaced tick marks (>= 8, spacing CV < 0.3), OR it is a perfectly uniform,
 *     clearly visible solid bar with aspect >= 10 spanning >= 50% of the frame.
 * Straightness alone is never enough.
 */
export function findRulerBands(input: RulerSearchInput): RulerBand[] {
  const { width: W, height: H, looseMask, gray, dist } = input;
  const bands: RulerBand[] = [];
  const minSide = Math.min(W, H);
  const thick = Math.max(5, Math.round(minSide * 0.012));
  const thickHalf = Math.floor(thick / 2);
  for (const horizontal of [true, false]) {
    const longLen = Math.round((horizontal ? W : H) * 0.25);
    const longHalf = Math.floor(longLen / 2);
    const hx = horizontal ? longHalf : thickHalf;
    const hy = horizontal ? thickHalf : longHalf;
    const eroded = erodeRect(looseMask, W, H, hx, hy);
    const opened = dilateRect(eroded, W, H, hx, hy);
    const { n, stats } = labelComponents(opened, W, H);
    for (let id = 1; id <= n; id++) {
      const s = stats[id];
      const bw = s.maxX - s.minX + 1;
      const bh = s.maxY - s.minY + 1;
      const length = horizontal ? bw : bh;
      const thickness = horizontal ? bh : bw;
      if (thickness < thick || length < longLen) continue;
      if (length / thickness < 4) continue;
      // Solid body (a ruler is a filled rectangle); merged lumps are not a band.
      if (s.area / (bw * bh) < 0.7) continue;
      const profile: number[] = [];
      const a0 = horizontal ? s.minX : s.minY;
      const a1 = horizontal ? s.maxX : s.maxY;
      for (let k = a0; k <= a1; k++) {
        let sum = 0;
        let cnt = 0;
        const c0 = horizontal ? s.minY : s.minX;
        const c1 = horizontal ? s.maxY : s.maxX;
        for (let c = c0; c <= c1; c++) {
          const x = horizontal ? k : c;
          const y = horizontal ? c : k;
          sum += gray[y * W + x];
          cnt++;
        }
        profile.push(sum / Math.max(1, cnt));
      }
      const ticks = detectRegularTicks(profile);
      const box = { x0: s.minX, y0: s.minY, x1: s.maxX + 1, y1: s.maxY + 1 };
      const orientation = horizontal ? 'horizontal' : 'vertical';
      if (ticks.regular) {
        bands.push({
          orientation, kind: 'ticked_scale', box, tickCount: ticks.ticks, thickness, length,
          reasons: [`${orientation} band ${thickness}px thick with ${ticks.ticks} regularly spaced tick marks`],
        });
        continue;
      }
      if (length / thickness >= 10 && length >= (horizontal ? W : H) * 0.5) {
        let sum = 0, sumSq = 0, dsum = 0, cnt = 0;
        for (let y = s.minY; y <= s.maxY; y++) {
          for (let x = s.minX; x <= s.maxX; x++) {
            const g = gray[y * W + x];
            sum += g; sumSq += g * g; dsum += dist[y * W + x]; cnt++;
          }
        }
        const mean = sum / cnt;
        const sd = Math.sqrt(Math.max(0, sumSq / cnt - mean * mean));
        if (sd < 28 && dsum / cnt > 40) {
          bands.push({
            orientation, kind: 'solid_bar', box, tickCount: 0, thickness, length,
            reasons: [`${orientation} straight uniform solid bar (aspect ${(length / thickness).toFixed(0)}:1, ${thickness}px thick)`],
          });
        }
      }
    }
  }
  return bands;
}

/** Shortest distance (px) from any set pixel of `mask` (outside `rect`) to the rectangle. */
export function minGapToRect(
  mask: Uint8Array,
  w: number,
  h: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  maxReport = Infinity
): number {
  let best = Infinity;
  for (let y = 0; y < h; y++) {
    const dy = y < rect.y0 ? rect.y0 - y : y >= rect.y1 ? y - rect.y1 + 1 : 0;
    if (dy >= best || dy > maxReport) continue;
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const dx = x < rect.x0 ? rect.x0 - x : x >= rect.x1 ? x - rect.x1 + 1 : 0;
      if (dx === 0 && dy === 0) continue; // inside the band
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
  }
  return best;
}

export function expandRect(rect: { x0: number; y0: number; x1: number; y1: number }, by: number, w: number, h: number) {
  return { x0: Math.max(0, rect.x0 - by), y0: Math.max(0, rect.y0 - by), x1: Math.min(w, rect.x1 + by), y1: Math.min(h, rect.y1 + by) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source foreground analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface RulerFinding {
  kind: 'ticked_scale' | 'solid_bar';
  orientation: 'horizontal' | 'vertical';
  /** normalised 0..1 box in the source frame */
  box: { x: number; y: number; width: number; height: number };
  tickCount: number;
  /** nearest jewellery distance in px of the analysed raster (Infinity when none) */
  gapToJewelleryPx: number;
  /** true when the ruler touches or is within ~1.5% of the frame of jewellery */
  nearJewellery: boolean;
  reasons: string[];
}

export type RegionKind = 'chain' | 'pendant' | 'earring' | 'detail';

export interface ForegroundRegion {
  id: number;
  kind: RegionKind;
  label: string;
  areaPx: number;
  /** share of the total jewellery foreground (0..1) */
  share: number;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface ForegroundComponent {
  id: number;
  areaPx: number;
  share: number;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface ForegroundAnalysis {
  width: number;
  height: number;
  /** jewellery pixel indices (rulers and speckle excluded) */
  pixels: Int32Array;
  regionOf: Int32Array; // per pixel in `pixels`
  componentOf: Int32Array;
  regions: ForegroundRegion[];
  components: ForegroundComponent[];
  rulers: RulerFinding[];
  rulerRects: Array<{ x0: number; y0: number; x1: number; y1: number }>;
  jewelleryAreaPx: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  warnings: string[];
}

const JEWELLERY_DIST = 30;
const RULER_DIST = 9;

function norm(b: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number) {
  return { x: b.x0 / w, y: b.y0 / h, width: (b.x1 - b.x0) / w, height: (b.y1 - b.y0) / h };
}

/** Segments the jewellery foreground of an original photo (see module header). */
export async function analyzeJewelleryForeground(photo: Buffer, maxDim = 1800): Promise<ForegroundAnalysis | null> {
  let raster: Raster;
  try {
    raster = await loadAnalysisRaster(photo, maxDim);
  } catch {
    return null;
  }
  const { width: W, height: H } = raster;
  const { dist } = paperDistanceMap(raster);
  const gray = grayOf(raster);
  const loose = thresholdMask(dist, RULER_DIST);
  const jew = thresholdMask(dist, JEWELLERY_DIST);
  const maxSide = Math.max(W, H);
  const nearPx = Math.max(3, Math.round(maxSide * 0.015));
  const warnings: string[] = [];

  // 1) positively identified rulers are excluded from the jewellery foreground
  const rulers: RulerFinding[] = [];
  const rulerRects: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const bands = findRulerBands({ width: W, height: H, looseMask: loose, gray, dist });
  for (const band of bands) {
    const rect = expandRect(band.box, Math.max(2, Math.round(band.thickness * 0.06)), W, H);
    rulerRects.push(rect);
    for (let y = rect.y0; y < rect.y1; y++) for (let x = rect.x0; x < rect.x1; x++) jew[y * W + x] = 0;
  }

  // 2) connected groups (links of a chain are joined by a small dilation); drop speckle
  const linkR = Math.max(2, Math.round(maxSide * 0.003));
  const linked = dilateRect(jew, W, H, linkR, linkR);
  const grouped = labelComponents(linked, W, H);
  const minArea = Math.max(30, Math.round(W * H * 0.00008));
  const keepGroup = new Uint8Array(grouped.n + 1);
  const groupArea = new Int32Array(grouped.n + 1);
  for (let i = 0; i < jew.length; i++) if (jew[i] && grouped.labels[i]) groupArea[grouped.labels[i]]++;
  for (let g = 1; g <= grouped.n; g++) keepGroup[g] = groupArea[g] >= minArea ? 1 : 0;
  const keptMask = new Uint8Array(jew.length);
  let total = 0;
  for (let i = 0; i < jew.length; i++) {
    if (jew[i] && keepGroup[grouped.labels[i]]) { keptMask[i] = 1; total++; }
  }
  // proximity of each ruler to the (speckle-free) jewellery
  bands.forEach((band, n) => {
    const gap = minGapToRect(keptMask, W, H, rulerRects[n]);
    const near = gap <= nearPx;
    rulers.push({
      kind: band.kind, orientation: band.orientation, box: norm(band.box, W, H), tickCount: band.tickCount,
      gapToJewelleryPx: gap, nearJewellery: near, reasons: band.reasons,
    });
    warnings.push(
      near
        ? `Ruler/scale (${band.reasons[0]}) touches or is near the jewellery - needs review; jewellery was kept.`
        : `Ruler/scale detected away from the jewellery (${band.reasons[0]}); excluded from the jewellery foreground.`
    );
  });
  if (total === 0) return null;

  // 3) regions: compact bodies (pendant / earrings) vs thin strands (chain, hooks, posts)
  const R = Math.max(3, Math.round(maxSide * 0.005));
  const opened = dilateRect(erodeRect(keptMask, W, H, R, R), W, H, R, R);
  const bodyCore = dilateRect(opened, W, H, R, R);
  const bodyMask = new Uint8Array(jew.length);
  const thinMask = new Uint8Array(jew.length);
  for (let i = 0; i < jew.length; i++) {
    if (!keptMask[i]) continue;
    if (bodyCore[i]) bodyMask[i] = 1; else thinMask[i] = 1;
  }
  const bodyLab = labelComponents(bodyMask, W, H);
  const thinLinked = dilateRect(thinMask, W, H, linkR, linkR);
  const thinLab = labelComponents(thinLinked, W, H);

  const bodyAreas = new Int32Array(bodyLab.n + 1);
  const thinAreas = new Int32Array(thinLab.n + 1);
  for (let i = 0; i < jew.length; i++) {
    if (bodyMask[i]) bodyAreas[bodyLab.labels[i]]++;
    else if (thinMask[i] && thinLab.labels[i]) thinAreas[thinLab.labels[i]]++;
  }
  const bodyIds = Array.from({ length: bodyLab.n }, (_, k) => k + 1).filter((id) => bodyAreas[id] >= minArea).sort((a, b) => bodyAreas[b] - bodyAreas[a]);
  const largestBody = bodyIds.length ? bodyAreas[bodyIds[0]] : 0;
  const regionDefs: Array<{ kind: RegionKind; label: string; bodyId?: number; thinId?: number }> = [];
  let earringNo = 0;
  bodyIds.forEach((id, idx) => {
    if (idx === 0) regionDefs.push({ kind: 'pendant', label: 'pendant / main body', bodyId: id });
    else if (bodyAreas[id] >= largestBody * 0.12) regionDefs.push({ kind: 'earring', label: `earring / drop ${++earringNo}`, bodyId: id });
    else regionDefs.push({ kind: 'detail', label: `small detail ${idx}`, bodyId: id });
  });
  const thinIds = Array.from({ length: thinLab.n }, (_, k) => k + 1).filter((id) => thinAreas[id] > 0).sort((a, b) => thinAreas[b] - thinAreas[a]);
  thinIds.forEach((id, idx) => regionDefs.push({ kind: 'chain', label: `thin strand (chain/hook/post) ${idx + 1}`, thinId: id }));

  const bodyToRegion = new Map<number, number>();
  const thinToRegion = new Map<number, number>();
  regionDefs.forEach((d, idx) => {
    if (d.bodyId) bodyToRegion.set(d.bodyId, idx);
    if (d.thinId) thinToRegion.set(d.thinId, idx);
  });
  const fallbackRegion = regionDefs.length; // small leftovers
  const needFallback = { used: false };

  const pixels: number[] = [];
  const regionOf: number[] = [];
  const componentOf: number[] = [];
  const compIndex = new Map<number, number>();
  const regionStats: LabelStats[] = regionDefs.map(() => ({ area: 0, minX: W, minY: H, maxX: 0, maxY: 0 }));
  const fbStats: LabelStats = { area: 0, minX: W, minY: H, maxX: 0, maxY: 0 };
  const compStats: LabelStats[] = [];
  let bx0 = W, by0 = H, bx1 = 0, by1 = 0;
  for (let i = 0; i < jew.length; i++) {
    if (!keptMask[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    let rg: number | undefined;
    if (bodyMask[i]) rg = bodyToRegion.get(bodyLab.labels[i]);
    else rg = thinToRegion.get(thinLab.labels[i]);
    let st: LabelStats;
    if (rg === undefined) { rg = fallbackRegion; needFallback.used = true; st = fbStats; } else st = regionStats[rg];
    st.area++;
    if (x < st.minX) st.minX = x; if (x > st.maxX) st.maxX = x;
    if (y < st.minY) st.minY = y; if (y > st.maxY) st.maxY = y;
    const g = grouped.labels[i];
    let ci = compIndex.get(g);
    if (ci === undefined) {
      ci = compStats.length;
      compIndex.set(g, ci);
      compStats.push({ area: 0, minX: W, minY: H, maxX: 0, maxY: 0 });
    }
    const cs = compStats[ci];
    cs.area++;
    if (x < cs.minX) cs.minX = x; if (x > cs.maxX) cs.maxX = x;
    if (y < cs.minY) cs.minY = y; if (y > cs.maxY) cs.maxY = y;
    if (x < bx0) bx0 = x; if (x >= bx1) bx1 = x + 1;
    if (y < by0) by0 = y; if (y >= by1) by1 = y + 1;
    pixels.push(i);
    regionOf.push(rg);
    componentOf.push(ci);
  }

  const toBox = (s: LabelStats) => norm({ x0: s.minX, y0: s.minY, x1: s.maxX + 1, y1: s.maxY + 1 }, W, H);
  const regions: ForegroundRegion[] = regionDefs.map((d, idx) => ({
    id: idx, kind: d.kind, label: d.label, areaPx: regionStats[idx].area, share: regionStats[idx].area / total, bbox: toBox(regionStats[idx]),
  }));
  if (needFallback.used) {
    regions.push({ id: fallbackRegion, kind: 'detail', label: 'small details', areaPx: fbStats.area, share: fbStats.area / total, bbox: toBox(fbStats) });
  }
  const components: ForegroundComponent[] = compStats.map((s, idx) => ({ id: idx, areaPx: s.area, share: s.area / total, bbox: toBox(s) }));

  return {
    width: W, height: H,
    pixels: Int32Array.from(pixels), regionOf: Int32Array.from(regionOf), componentOf: Int32Array.from(componentOf),
    regions, components, rulers, rulerRects, jewelleryAreaPx: total,
    bbox: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Completeness gate
// ─────────────────────────────────────────────────────────────────────────────

/** Strict default: the output must keep at least 97% of the source jewellery foreground. */
export const DEFAULT_MIN_RETENTION = 0.97;
/** A region (chain segment / pendant / earring) retained below this is reported as lost/incomplete. */
const REGION_RETENTION_FLOOR = 0.9;
/** A region/component retained below this counts as MISSING (the component is gone). */
const MISSING_RETENTION = 0.5;
/** Regions smaller than this share of the foreground are only judged through the overall figure. */
const MIN_REGION_SHARE = 0.003;

export interface RegionRetention {
  id: number;
  kind: RegionKind;
  label: string;
  areaPx: number;
  sharePercent: number;
  retainedPercent: number;
  lostPercentOfTotal: number;
  status: 'ok' | 'incomplete' | 'missing';
  bbox: { x: number; y: number; width: number; height: number };
}

export interface ComponentRetention {
  id: number;
  areaPx: number;
  sharePercent: number;
  retainedPercent: number;
  missing: boolean;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface JewelleryCompleteness {
  /** false when the source had no analysable jewellery (gate could not run) */
  applicable: boolean;
  /** true only when status === 'ok' */
  pass: boolean;
  status: 'ok' | 'needs_review' | 'failed';
  threshold: number;
  retainedPercent: number;
  lostPercent: number;
  sourceComponentCount: number;
  retainedComponentCount: number;
  missingComponentCount: number;
  regions: RegionRetention[];
  components: ComponentRetention[];
  rulers: RulerFinding[];
  /** reasons that block Product Accuracy / exact-match labels */
  issues: string[];
  /** non-blocking notes (ruler excluded etc.) */
  warnings: string[];
  alignment?: { scale: number; note: string };
  lostRegions: Array<{ label: string; kind: RegionKind; retainedPercent: number; bbox: { x: number; y: number; width: number; height: number } }>;
  /** (debug / contact sheet) source-frame mask of jewellery pixels that are NOT in the output */
  lostMask?: { width: number; height: number; data: Uint8Array };
}

export interface CompletenessOptions {
  minRetention?: number;
  /** 'white' (default): output is on a white canvas; 'auto': estimate the output background */
  outputBackground?: 'white' | 'auto';
  includeLostMask?: boolean;
  analysis?: ForegroundAnalysis | null;
}

const KIND_LABEL: Record<RegionKind, string> = {
  chain: 'Chain segment',
  pendant: 'Pendant',
  earring: 'Earring',
  detail: 'Jewellery detail',
};

const pct1 = (f: number) => Math.round(f * 1000) / 10;

function emptyResult(threshold: number, warnings: string[] = []): JewelleryCompleteness {
  return {
    applicable: false, pass: true, status: 'ok', threshold, retainedPercent: 100, lostPercent: 0,
    sourceComponentCount: 0, retainedComponentCount: 0, missingComponentCount: 0,
    regions: [], components: [], rulers: [], issues: [], warnings, lostRegions: [],
  };
}

/**
 * Compares an output (cutout / white background) against the jewellery foreground of the ORIGINAL
 * photo. The output is scaled/translated relative to the source, so the transform is recovered from
 * the subject bounding boxes (trying every anchor and both axis scales and keeping the best
 * alignment - a deliberately lost end of a chain therefore cannot hide behind a wrong alignment).
 */
export async function evaluateJewelleryCompleteness(
  sourcePhoto: Buffer,
  output: Buffer,
  options: CompletenessOptions = {}
): Promise<JewelleryCompleteness> {
  const threshold = options.minRetention ?? DEFAULT_MIN_RETENTION;
  const src = options.analysis ?? (await analyzeJewelleryForeground(sourcePhoto));
  if (!src) return emptyResult(threshold, ['Source jewellery foreground could not be analysed; completeness gate not applied.']);

  const out = await loadAnalysisRaster(output, 1800);
  const OW = out.width;
  const OH = out.height;
  let outMask: Uint8Array;
  if (options.outputBackground === 'auto') {
    outMask = thresholdMask(paperDistanceMap(out).dist, 18);
  } else {
    outMask = new Uint8Array(OW * OH);
    for (let p = 0; p < outMask.length; p++) {
      const i = p * 3;
      if (Math.hypot(255 - out.data[i], 255 - out.data[i + 1], 255 - out.data[i + 2]) > 18) outMask[p] = 1;
    }
  }
  const oLab = labelComponents(outMask, OW, OH);
  let ox0 = OW, oy0 = OH, ox1 = 0, oy1 = 0, outPx = 0;
  for (let id = 1; id <= oLab.n; id++) {
    const s = oLab.stats[id];
    if (s.area < 20) continue;
    outPx += s.area;
    if (s.minX < ox0) ox0 = s.minX; if (s.minY < oy0) oy0 = s.minY;
    if (s.maxX + 1 > ox1) ox1 = s.maxX + 1; if (s.maxY + 1 > oy1) oy1 = s.maxY + 1;
  }

  const total = src.pixels.length;
  const regionCount = Math.max(...src.regions.map((r) => r.id)) + 1;
  const compCount = src.components.length;
  const issues: string[] = [];
  const warnings = [...src.warnings];
  const needsReview = src.rulers.some((r) => r.nearJewellery);

  let best = { retained: -1, scale: 1, note: 'no output foreground' };
  let bestFlags: Uint8Array | null = null;
  if (outPx > 0) {
    const tol = Math.max(2, Math.round(Math.max(OW, OH) * 0.002));
    const outDil = dilateRect(outMask, OW, OH, tol, tol);
    const sBoxes: Array<{ x0: number; y0: number; x1: number; y1: number; name: string }> = [
      { ...src.bbox!, name: 'jewellery bbox' },
    ];
    if (src.rulerRects.length && src.rulers.some((r) => r.nearJewellery)) {
      let { x0, y0, x1, y1 } = src.bbox!;
      for (const r of src.rulerRects) { x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
      sBoxes.push({ x0, y0, x1, y1, name: 'jewellery+ruler bbox' });
    }
    const flags = new Uint8Array(total);
    for (const S of sBoxes) {
      const sw = S.x1 - S.x0;
      const sh = S.y1 - S.y0;
      const ow = ox1 - ox0;
      const oh = oy1 - oy0;
      for (const k of new Set([ow / sw, oh / sh])) {
        for (const ax of [0, 0.5, 1]) {
          for (const ay of [0, 0.5, 1]) {
            const sx = S.x0 + ax * sw;
            const sy = S.y0 + ay * sh;
            const tx = ox0 + ax * ow;
            const ty = oy0 + ay * oh;
            let kept = 0;
            for (let n = 0; n < total; n++) {
              const idx = src.pixels[n];
              const x = idx % src.width;
              const y = (idx - x) / src.width;
              const mx = Math.round(tx + (x - sx) * k);
              const my = Math.round(ty + (y - sy) * k);
              const ok = mx >= 0 && my >= 0 && mx < OW && my < OH && outDil[my * OW + mx] === 1;
              flags[n] = ok ? 1 : 0;
              if (ok) kept++;
            }
            if (kept > best.retained) {
              best = { retained: kept, scale: k, note: `aligned on ${S.name} (anchor ${ax},${ay})` };
              bestFlags = Uint8Array.from(flags);
            }
          }
        }
      }
    }
  }

  const retainedFlags = bestFlags ?? new Uint8Array(total);
  const regionTotal = new Int32Array(regionCount);
  const regionKept = new Int32Array(regionCount);
  const compTotal = new Int32Array(compCount);
  const compKept = new Int32Array(compCount);
  let keptTotal = 0;
  for (let n = 0; n < total; n++) {
    regionTotal[src.regionOf[n]]++;
    compTotal[src.componentOf[n]]++;
    if (retainedFlags[n]) {
      regionKept[src.regionOf[n]]++;
      compKept[src.componentOf[n]]++;
      keptTotal++;
    }
  }
  const retained = keptTotal / total;
  const lost = 1 - retained;

  const regions: RegionRetention[] = src.regions.map((r) => {
    const rt = regionTotal[r.id] ? regionKept[r.id] / regionTotal[r.id] : 1;
    const lostOfTotal = (regionTotal[r.id] - regionKept[r.id]) / total;
    const judged = r.share >= MIN_REGION_SHARE;
    const status = !judged ? 'ok' : rt < 0.1 ? 'missing' : rt < REGION_RETENTION_FLOOR ? 'incomplete' : 'ok';
    return {
      id: r.id, kind: r.kind, label: r.label, areaPx: r.areaPx, sharePercent: pct1(r.share),
      retainedPercent: pct1(rt), lostPercentOfTotal: pct1(lostOfTotal), status, bbox: r.bbox,
    };
  });
  const components: ComponentRetention[] = src.components.map((c) => {
    const rt = compTotal[c.id] ? compKept[c.id] / compTotal[c.id] : 1;
    return { id: c.id, areaPx: c.areaPx, sharePercent: pct1(c.share), retainedPercent: pct1(rt), missing: rt < MISSING_RETENTION, bbox: c.bbox };
  });
  const missingComponents = components.filter((c) => c.missing).length;

  for (const r of regions.filter((x) => x.status !== 'ok')) {
    issues.push(
      `${KIND_LABEL[r.kind]} ${r.status === 'missing' || r.kind === 'chain' ? 'missing' : 'incomplete'}: ${r.lostPercentOfTotal.toFixed(1)}% of jewellery foreground not present (${r.label}: ${r.retainedPercent.toFixed(1)}% retained).`
    );
  }
  if (missingComponents > 0 && !issues.length) {
    issues.push(`Jewellery component missing: ${missingComponents} of ${components.length} jewellery component(s) not present in the output.`);
  }
  if (retained < threshold && !issues.length) {
    issues.push(`Jewellery foreground incomplete: ${pct1(lost).toFixed(1)}% of jewellery foreground not present (retained ${pct1(retained).toFixed(1)}%, required ${(threshold * 100).toFixed(0)}%).`);
  }
  if (retained < threshold && issues.length) {
    issues.push(`Overall jewellery retention ${pct1(retained).toFixed(1)}% is below the required ${(threshold * 100).toFixed(0)}%.`);
  }
  if (needsReview) {
    issues.push('A ruler/scale touches or is near the jewellery - review the cutout (jewellery was kept, ruler may remain).');
  }

  const blocking = retained < threshold || missingComponents > 0 || regions.some((r) => r.status !== 'ok');
  const failed = blocking && (missingComponents > 0 || retained < 0.9 || regions.some((r) => r.status === 'missing'));
  const status: JewelleryCompleteness['status'] = failed ? 'failed' : blocking || needsReview ? 'needs_review' : 'ok';

  const result: JewelleryCompleteness = {
    applicable: true,
    pass: status === 'ok',
    status,
    threshold,
    retainedPercent: pct1(retained),
    lostPercent: pct1(lost),
    sourceComponentCount: components.length,
    retainedComponentCount: components.length - missingComponents,
    missingComponentCount: missingComponents,
    regions,
    components,
    rulers: src.rulers,
    issues,
    warnings,
    alignment: { scale: best.scale, note: best.note },
    lostRegions: regions.filter((r) => r.status !== 'ok').map((r) => ({ label: r.label, kind: r.kind, retainedPercent: r.retainedPercent, bbox: r.bbox })),
  };
  if (options.includeLostMask) {
    const data = new Uint8Array(src.width * src.height);
    for (let n = 0; n < total; n++) if (!retainedFlags[n]) data[src.pixels[n]] = 1;
    result.lostMask = { width: src.width, height: src.height, data };
  }
  return result;
}
