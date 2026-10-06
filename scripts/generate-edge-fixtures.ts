/**
 * Generates SYNTHETIC edge-case photos (drawn diagrams, not real photos) for exercising
 * scripts/verify-real-photo.ts:   npx tsx scripts/generate-edge-fixtures.ts <outDir>
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { paperPhoto, PHOTO_W, PHOTO_H, ticks } from '../tests/helpers/jewelleryFixtures';

const outDir = path.resolve(process.argv[2] || './photo-verification-output/fixtures');
fs.mkdirSync(outDir, { recursive: true });

const clean = await paperPhoto();
fs.writeFileSync(path.join(outDir, 'synthetic_clean.jpg'), clean);

// Chain and earrings cut off by the photo frame (top and bottom of the set are outside the picture).
fs.writeFileSync(
  path.join(outDir, 'synthetic_clipped_chain.jpg'),
  await sharp(clean).extract({ left: 0, top: 900, width: PHOTO_W, height: 2500 }).jpeg({ quality: 92 }).toBuffer()
);

// A vertical ruler lying next to the jewellery.
const ruler = `
  <rect x="2020" y="250" width="190" height="3500" fill="#f3ead0" stroke="#555" stroke-width="4"/>
  ${ticks(58, (i) => `<rect x="2020" y="${270 + i * 60}" width="${i % 5 === 0 ? 110 : 60}" height="8" fill="#1a1a1a"/>`)}`;
fs.writeFileSync(path.join(outDir, 'synthetic_with_ruler.jpg'), await paperPhoto(ruler));

// Plain paper, no jewellery at all.
fs.writeFileSync(
  path.join(outDir, 'synthetic_blank_paper.jpg'),
  await sharp({ create: { width: PHOTO_W, height: PHOTO_H, channels: 3, background: { r: 238, g: 233, b: 224 } } }).jpeg().toBuffer()
);
console.log(`wrote 4 synthetic fixtures to ${outDir}`);
