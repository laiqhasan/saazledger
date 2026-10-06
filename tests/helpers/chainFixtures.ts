import sharp from 'sharp';
import { PHOTO_W, PHOTO_H } from './jewelleryFixtures';

/**
 * SYNTHETIC fixtures for straight-chain / completeness-gate tests. They are drawn with sharp/SVG,
 * they are NOT the user's real photo (IMG_20261001_120958.jpg is not available in this repo).
 * Portrait 2276x4048 on plain paper: pendant, chain(s) made of overlapping links, earrings with posts,
 * optional ruler.
 */
export { PHOTO_W, PHOTO_H };

const CX = PHOTO_W / 2;
const CHAIN = '#8b909a';

/** A straight chain: overlapping link ellipses laid along a line (links, not a solid bar). */
export function chainLine(x1: number, y1: number, x2: number, y2: number, spacing = 15): string {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(2, Math.round(len / spacing));
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  return Array.from({ length: n + 1 }, (_, i) => {
    const x = x1 + ((x2 - x1) * i) / n;
    const y = y1 + ((y2 - y1) * i) / n;
    return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="13" ry="7" transform="rotate(${ang.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="none" stroke="${CHAIN}" stroke-width="5"/>`;
  }).join('');
}

export interface ChainFixtureOptions {
  /** perfectly straight chain hanging from the pendant bail up to the top (connected to the pendant) */
  hangingChain?: boolean;
  /** straight chain laid horizontally near the bottom, separate from the pendant/earrings */
  laidChain?: boolean;
  /** straight spare chain length near the left frame edge, separate */
  spareLeftChain?: boolean;
  /** two earrings with straight posts */
  earrings?: boolean;
  /** ticked vertical ruler whose left edge is at this x (width 190, y 250..3750) */
  rulerX?: number;
  /** ticked horizontal ruler across the bottom */
  horizontalRuler?: boolean;
  /** raw extra SVG drawn on top (tests add odd shapes here) */
  extraSvg?: string;
}

export const RIGHT_EARRING_MAX_X = CX + 500 + 62;

export function rulerSvg(x: number): string {
  const ticks = Array.from({ length: 58 }, (_, i) => `<rect x="${x}" y="${270 + i * 60}" width="${i % 5 === 0 ? 110 : 60}" height="8" fill="#1a1a1a"/>`).join('');
  return `<rect x="${x}" y="250" width="190" height="3500" fill="#f3ead0" stroke="#555" stroke-width="4"/>${ticks}`;
}

export function horizontalRulerSvg(): string {
  const ticks = Array.from({ length: 32 }, (_, i) => `<rect x="${170 + i * 60}" y="3820" width="8" height="${i % 5 === 0 ? 110 : 60}" fill="#1a1a1a"/>`).join('');
  return `<rect x="150" y="3820" width="1976" height="170" fill="#f3ead0" stroke="#555" stroke-width="4"/>${ticks}`;
}

export function chainFixtureSvg(opts: ChainFixtureOptions = {}): string {
  const parts: string[] = [];
  // pear pendant with halo beads and a bail ring
  const halo = Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2;
    return `<circle cx="${CX + Math.cos(a) * 150}" cy="${2150 + Math.sin(a) * 200}" r="26" fill="#cfe3ff" stroke="#8a8f99" stroke-width="6"/>`;
  }).join('');
  parts.push(halo);
  parts.push(`<path d="M ${CX} 1960 C ${CX + 210} 2110 ${CX + 190} 2400 ${CX} 2560 C ${CX - 190} 2400 ${CX - 210} 2110 ${CX} 1960 Z" fill="#1d4fa8" stroke="#c9ccd3" stroke-width="22"/>`);
  parts.push(`<circle cx="${CX}" cy="1880" r="34" fill="none" stroke="#7d828c" stroke-width="12"/>`);
  if (opts.hangingChain) parts.push(chainLine(CX, 1846, CX, 420));
  if (opts.laidChain) parts.push(chainLine(900, 3640, 1500, 3640));
  if (opts.spareLeftChain) parts.push(chainLine(100, 600, 100, 3300));
  if (opts.earrings) {
    for (const ex of [CX - 500, CX + 500]) {
      // straight post (bar) + ball + pear drop
      parts.push(`<rect x="${ex - 6}" y="2900" width="12" height="380" fill="#8b909a"/>`);
      parts.push(`<circle cx="${ex}" cy="2890" r="18" fill="#c9ccd3" stroke="#8b909a" stroke-width="4"/>`);
      parts.push(`<path d="M ${ex} 3280 C ${ex + 62} 3360 ${ex + 62} 3540 ${ex} 3620 C ${ex - 62} 3540 ${ex - 62} 3360 ${ex} 3280 Z" fill="#1d4fa8" stroke="#c9ccd3" stroke-width="14"/>`);
    }
  }
  if (opts.rulerX !== undefined) parts.push(rulerSvg(opts.rulerX));
  if (opts.horizontalRuler) parts.push(horizontalRulerSvg());
  if (opts.extraSvg) parts.push(opts.extraSvg);
  return `<svg width="${PHOTO_W}" height="${PHOTO_H}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

/** Jewellery (and optional ruler) drawn on plain paper, as a JPEG like a phone photo. */
export async function chainPhoto(opts: ChainFixtureOptions = {}): Promise<Buffer> {
  return sharp({ create: { width: PHOTO_W, height: PHOTO_H, channels: 3, background: { r: 238, g: 233, b: 224 } } })
    .composite([{ input: Buffer.from(chainFixtureSvg(opts)) }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** The same drawing as a transparent PNG cutout (what a perfect matte would look like). */
export async function chainCutout(opts: ChainFixtureOptions = {}): Promise<Buffer> {
  return sharp({ create: { width: PHOTO_W, height: PHOTO_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(chainFixtureSvg(opts)) }])
    .png()
    .toBuffer();
}

/** Erases a rectangle (source-pixel coordinates) from a cutout: simulates a lost chain segment. */
export async function eraseFromCutout(cutout: Buffer, rect: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const hole = await sharp({ create: { width: rect.width, height: rect.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  return sharp(cutout).composite([{ input: hole, left: rect.x, top: rect.y, blend: 'dest-out' }]).png().toBuffer();
}

/** Contain a cutout into a white 2048 square with padding (what Product Accuracy outputs). */
export async function whiteSquareFromCutout(cutout: Buffer, size = 2048, occupancy = 0.86): Promise<Buffer> {
  const inner = Math.round(size * occupancy);
  const fitted = await sharp(cutout).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 }).resize(inner, inner, { fit: 'inside' }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: '#ffffff' } })
    .composite([{ input: fitted, gravity: 'center' }])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
}
