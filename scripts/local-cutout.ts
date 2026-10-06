/**
 * Local, offline, deterministic background-colour-key cutout used ONLY by scripts/verify-real-photo.ts.
 *
 * The production exact-cutout step needs PhotoRoom (or Gemini) to matte the jewellery, which an offline
 * tool must not call. This stand-in keys the plain paper/table colour (with a shading-aware local
 * background estimate) and returns an RGBA PNG. It is good enough to verify FRAMING (padding, clipping,
 * contain/fit) and original-file handling, but it is NOT PhotoRoom: edge quality, shadows and thin-chain
 * mattes will differ from what the app produces with a real provider.
 */
import sharp from 'sharp';

export interface LocalCutoutResult {
  png: Buffer;
  width: number;
  height: number;
  backgroundRgb: [number, number, number];
  foregroundRatio: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 255;
}

export async function localColourKeyCutout(input: Buffer): Promise<LocalCutoutResult> {
  const { data, info } = await sharp(input).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;

  // Global background colour: median of a thin ring along the photo border.
  const ring = Math.max(4, Math.round(Math.min(w, h) * 0.015));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const stride = Math.max(1, Math.round(Math.min(w, h) / 400));
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      if (x >= ring && x < w - ring && y >= ring && y < h - ring) {
        x = Math.max(x, w - ring - 1); // jump across the interior
        continue;
      }
      const o = (y * w + x) * 3;
      rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]);
    }
  }
  const bg: [number, number, number] = [median(rs), median(gs), median(bs)];

  const dist = (o: number, c: [number, number, number]) => {
    const dr = data[o] - c[0], dg = data[o + 1] - c[1], db = data[o + 2] - c[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  // Pass 1: coarse mask against the global colour, used to exclude the subject from the shading estimate.
  const shade = Buffer.alloc(n * 3);
  for (let p = 0; p < n; p++) {
    const o = p * 3;
    const isFg = dist(o, bg) > 36;
    shade[o] = isFg ? bg[0] : data[o];
    shade[o + 1] = isFg ? bg[1] : data[o + 1];
    shade[o + 2] = isFg ? bg[2] : data[o + 2];
  }
  const localBg = await sharp(shade, { raw: { width: w, height: h, channels: 3 } })
    .blur(Math.max(8, Math.min(w, h) / 40))
    .raw()
    .toBuffer();

  // Pass 2: distance from the LOCAL background -> soft alpha.
  const lo = 26;
  const hi = 52;
  const alpha = Buffer.alloc(n);
  for (let p = 0; p < n; p++) {
    const o = p * 3;
    const dr = data[o] - localBg[o], dg = data[o + 1] - localBg[o + 1], db = data[o + 2] - localBg[o + 2];
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    alpha[p] = d <= lo ? 0 : d >= hi ? 255 : Math.round(((d - lo) / (hi - lo)) * 255);
  }
  // Remove single-pixel speckle without eating thin chains.
  const cleanAlpha = await sharp(alpha, { raw: { width: w, height: h, channels: 1 } }).median(3).extractChannel(0).raw().toBuffer();

  const rgba = Buffer.alloc(n * 4);
  let fg = 0;
  for (let p = 0; p < n; p++) {
    rgba[p * 4] = data[p * 3];
    rgba[p * 4 + 1] = data[p * 3 + 1];
    rgba[p * 4 + 2] = data[p * 3 + 2];
    rgba[p * 4 + 3] = cleanAlpha[p];
    if (cleanAlpha[p] > 128) fg++;
  }
  const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer();
  return { png, width: w, height: h, backgroundRgb: bg, foregroundRatio: fg / n };
}
