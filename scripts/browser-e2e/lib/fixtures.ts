import sharp from 'sharp';
import { chainFixtureSvg } from '../../../tests/helpers/chainFixtures';
import { PHOTO_W, PHOTO_H } from '../../../tests/helpers/jewelleryFixtures';

/**
 * SYNTHETIC 2276x4048 portrait "phone photo" for DRY RUNS ONLY: a pendant, a hanging chain and two earrings on a
 * dark velvet-like background (so the deterministic test-mode cutout stub can key the background out).
 * It is NOT the user's genuine photo IMG_20261001_120958.jpg.
 */
export async function syntheticPhoto(): Promise<Buffer> {
  return sharp({ create: { width: PHOTO_W, height: PHOTO_H, channels: 3, background: { r: 10, g: 10, b: 12 } } })
    .composite([{ input: Buffer.from(chainFixtureSvg({ hangingChain: true, earrings: true })) }])
    .jpeg({ quality: 92 })
    .toBuffer();
}
export { PHOTO_W, PHOTO_H };
