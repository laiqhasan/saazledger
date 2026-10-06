import sharp from 'sharp';

/**
 * Shared sharp-generated fixtures (no network, no AI/provider calls).
 * The reproduction photo from the bug report is a 2276x4048 portrait photo of a blue pear-halo
 * pendant set (long chain, pendant, two earrings) lying on plain paper, with NO ruler.
 */
export const PHOTO_W = 2276;
export const PHOTO_H = 4048;

export function jewellerySvg(w: number, h: number, bg: string | null): string {
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

export async function paperPhoto(extraSvg = ''): Promise<Buffer> {
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

export function ticks(count: number, makeTick: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => makeTick(i)).join('');
}

// Vertical steel/plastic ruler along the right edge with a tick every 60px.
export const VERTICAL_RULER = `
  <rect x="2020" y="250" width="190" height="3500" fill="#f3ead0" stroke="#555" stroke-width="4"/>
  ${ticks(58, (i) => `<rect x="2020" y="${270 + i * 60}" width="${i % 5 === 0 ? 110 : 60}" height="8" fill="#1a1a1a"/>`)}`;
// Horizontal ruler across the bottom.
export const HORIZONTAL_RULER = `
  <rect x="150" y="3820" width="1976" height="170" fill="#f3ead0" stroke="#555" stroke-width="4"/>
  ${ticks(32, (i) => `<rect x="${170 + i * 60}" y="3820" width="8" height="${i % 5 === 0 ? 110 : 60}" fill="#1a1a1a"/>`)}`;
// Yellow measuring tape lying along the bottom.
export const MEASURING_TAPE = `
  <rect x="100" y="3780" width="2076" height="130" fill="#f2c800"/>
  ${ticks(34, (i) => `<rect x="${130 + i * 60}" y="3780" width="7" height="${i % 5 === 0 ? 90 : 50}" fill="#222"/>`)}`;

export async function whiteSquareWithSubject(): Promise<Buffer> {
  // The same jewellery layout contained (not cropped) in a white 2048 square.
  const subject = await sharp(Buffer.from(jewellerySvg(PHOTO_W, PHOTO_H, '#ffffff'))).png().toBuffer();
  const fitted = await sharp(subject).resize(1800, 1800, { fit: 'inside' }).png().toBuffer();
  return sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#ffffff' } })
    .composite([{ input: fitted, gravity: 'center' }])
    .jpeg({ quality: 95 })
    .toBuffer();
}

