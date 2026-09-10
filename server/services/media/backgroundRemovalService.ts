import sharp from 'sharp';
import { db } from '../../db/database';

export interface BackgroundRemovalOptions {
  apiKey?: string;
  provider?: 'auto' | 'remove_bg' | 'clipdrop' | 'photoroom' | 'local';
  targetWidth?: number;
  targetHeight?: number;
  backgroundColor?: { r: number; g: number; b: number };
  addContactShadow?: boolean;
  returnTransparentPng?: boolean;
}

export interface BackgroundRemovalResult {
  buffer: Buffer; // Resulting clean RGBA / JPEG image buffer
  providerUsed: 'remove_bg' | 'clipdrop' | 'photoroom' | 'local_studio_vision';
  success: boolean;
  notes?: string;
}

/**
 * Retrieves configured Background Removal API keys from database or environment
 */
export function getBackgroundRemovalConfig(): {
  removeBgApiKey: string;
  clipdropApiKey: string;
  photoroomApiKey: string;
  provider: string;
} {
  const getSetting = (k: string) => {
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(k) as
        | { value: string }
        | undefined;
      return row?.value || '';
    } catch {
      return '';
    }
  };

  const removeBgApiKey =
    getSetting('remove_bg_api_key') ||
    process.env.REMOVE_BG_API_KEY ||
    process.env.REMOVEBG_API_KEY ||
    '';

  const clipdropApiKey =
    getSetting('clipdrop_api_key') ||
    process.env.CLIPDROP_API_KEY ||
    '';

  const photoroomApiKey =
    getSetting('photoroom_api_key') ||
    process.env.PHOTOROOM_API_KEY ||
    process.env.PHOTO_ROOM_API_KEY ||
    process.env.PHOTOROOM_KEY ||
    process.env.PHOTOROOM_TOKEN ||
    process.env.VITE_PHOTOROOM_API_KEY ||
    '';

  const provider = getSetting('bg_removal_provider') || process.env.BG_REMOVAL_PROVIDER || 'auto';

  return {
    removeBgApiKey,
    clipdropApiKey,
    photoroomApiKey,
    provider,
  };
}

/**
 * Remove background using Remove.bg official API
 */
async function callRemoveBgApi(inputBuffer: Buffer, apiKey: string): Promise<Buffer | null> {
  try {
    const base64Image = inputBuffer.toString('base64');
    const formData = new URLSearchParams();
    formData.append('image_file_b64', base64Image);
    formData.append('size', 'auto');
    formData.append('type', 'product');
    formData.append('format', 'png');

    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } else {
      const errText = await res.text();
      console.warn('[BackgroundRemoval] Remove.bg API rejected request:', res.status, errText);
      return null;
    }
  } catch (err: any) {
    console.warn('[BackgroundRemoval] Remove.bg request failed:', err.message);
    return null;
  }
}

/**
 * Remove background using ClipDrop API
 */
async function callClipdropApi(inputBuffer: Buffer, apiKey: string): Promise<Buffer | null> {
  try {
    const blob = new Blob([new Uint8Array(inputBuffer)], { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('image_file', blob, 'jewelry.jpg');

    const res = await fetch('https://clipdrop-api.co/remove-background/v1', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
      },
      body: formData,
    });

    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } else {
      const errText = await res.text();
      console.warn('[BackgroundRemoval] Clipdrop API rejected request:', res.status, errText);
      return null;
    }
  } catch (err: any) {
    console.warn('[BackgroundRemoval] Clipdrop request failed:', err.message);
    return null;
  }
}

/**
 * Remove background using PhotoRoom API
 */
async function callPhotoRoomApi(
  inputBuffer: Buffer,
  apiKey: string,
  options: { returnTransparent?: boolean } = {}
): Promise<Buffer | null> {
  try {
    const cleanKey = apiKey.trim();
    const blob = new Blob([new Uint8Array(inputBuffer)], { type: 'image/jpeg' });
    const formData = new FormData();
    formData.append('image_file', blob, 'jewelry.jpg');
    if (!options.returnTransparent) {
      formData.append('bg_color', 'ffffff');
    }

    const res = await fetch('https://sdk.photoroom.com/v1/segment', {
      method: 'POST',
      headers: {
        'x-api-key': cleanKey,
      },
      body: formData,
    });

    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      console.log(`[BackgroundRemoval] PhotoRoom API succeeded (${buf.length} bytes returned)`);
      return buf;
    } else {
      const errText = await res.text();
      console.warn('[BackgroundRemoval] PhotoRoom API response:', res.status, errText);
      if (!options.returnTransparent) {
        return callPhotoRoomApi(inputBuffer, apiKey, { returnTransparent: true });
      }
      return null;
    }
  } catch (err: any) {
    console.warn('[BackgroundRemoval] PhotoRoom request failed:', err.message);
    return null;
  }
}

/**
 * High-Precision Local Computer Vision Background Matting Engine.
 * 
 * Works for ALL metals (Silver-tone, Rhodium, Platinum, Yellow Gold, Rose Gold, Brass, Antique)
 * and ALL stones (American Diamonds/CZ, Rubies, Emeralds, Pearls, Polki, Kundan).
 * 
 * Never hardcodes gold-only heuristics!
 */
export async function cleanJewelryBackgroundLocally(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<Buffer> {
  const targetW = options.targetWidth || 2048;
  const targetH = options.targetHeight || 2048;

  // Auto-orient EXIF
  const baseImg = sharp(inputBuffer).rotate();
  const meta = await baseImg.metadata();
  const origW = meta.width || 2048;
  const origH = meta.height || 2048;

  // Process at optimal resolution (max 1400px) for speed & edge precision
  const maxDim = 1400;
  let workW = origW;
  let workH = origH;
  let procPipeline = sharp(inputBuffer).rotate();

  if (origW > maxDim || origH > maxDim) {
    procPipeline = procPipeline.resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true });
  }

  const { data: rawRgb, info } = await procPipeline
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  workW = info.width;
  workH = info.height;
  const channels = info.channels; // 3 (R, G, B)

  // 1. Analyze border pixels to profile ambient background color & variance
  const borderPixels: Array<{ r: number; g: number; b: number }> = [];
  const borderThickness = Math.max(3, Math.floor(Math.min(workW, workH) * 0.05));

  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      if (
        x < borderThickness ||
        x >= workW - borderThickness ||
        y < borderThickness ||
        y >= workH - borderThickness
      ) {
        const idx = (y * workW + x) * channels;
        borderPixels.push({
          r: rawRgb[idx],
          g: rawRgb[idx + 1],
          b: rawRgb[idx + 2],
        });
      }
    }
  }

  // Calculate median & variance of background
  let sumR = 0, sumG = 0, sumB = 0;
  for (const p of borderPixels) {
    sumR += p.r;
    sumG += p.g;
    sumB += p.b;
  }
  const bgMeanR = sumR / borderPixels.length;
  const bgMeanG = sumG / borderPixels.length;
  const bgMeanB = sumB / borderPixels.length;

  // Calculate standard deviation / dispersion
  let varDistSum = 0;
  for (const p of borderPixels) {
    const d = Math.hypot(p.r - bgMeanR, p.g - bgMeanG, p.b - bgMeanB);
    varDistSum += d;
  }
  const bgStdDev = Math.max(8, varDistSum / borderPixels.length);
  const distanceThreshold = Math.min(48, Math.max(18, bgStdDev * 2.2));

  // 2. Build alpha mask buffer (1 channel, 0 = background, 255 = jewelry foreground)
  const mask = new Uint8Array(workW * workH);

  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      const idx = (y * workW + x) * channels;
      const r = rawRgb[idx];
      const g = rawRgb[idx + 1];
      const b = rawRgb[idx + 2];

      const dist = Math.hypot(r - bgMeanR, g - bgMeanG, bgMeanB ? b - bgMeanB : 0);

      // Contrast from background
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC - minC;

      // Detect foreground jewelry:
      // A: Significant chromatic or luminance distance from background
      // B: High saturation (colored gemstones, enamel, yellow/rose gold)
      // C: Specular reflections, facet glints, or shadow contours of metal
      const isForeground =
        dist > distanceThreshold ||
        (sat > 22 && dist > 14) ||
        (maxC > 240 && dist > 12 && (bgMeanR < 235 || bgMeanG < 235 || bgMeanB < 235));

      if (isForeground) {
        // Discard outer 2px boundary noise
        if (x >= 2 && x < workW - 2 && y >= 2 && y < workH - 2) {
          mask[y * workW + x] = 255;
        }
      }
    }
  }

  // 3. Morphological closing to fill American diamond stone interiors & prongs
  const closedMask = new Uint8Array(workW * workH);
  const rClose = 2;

  // Dilation
  const dilated = new Uint8Array(workW * workH);
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      if (mask[y * workW + x] === 255) {
        for (let dy = -rClose; dy <= rClose; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= workH) continue;
          for (let dx = -rClose; dx <= rClose; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= workW) continue;
            dilated[ny * workW + nx] = 255;
          }
        }
      }
    }
  }

  // Erosion back
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      if (dilated[y * workW + x] === 255) {
        let allOn = true;
        for (let dy = -rClose; dy <= rClose && allOn; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= workH) { allOn = false; break; }
          for (let dx = -rClose; dx <= rClose; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= workW || dilated[ny * workW + nx] === 0) {
              allOn = false;
              break;
            }
          }
        }
        if (allOn) {
          closedMask[y * workW + x] = 255;
        }
      }
    }
  }

  // 4. Soft edge feathering using Sharp Gaussian blur on mask
  const softMask = await sharp(Buffer.from(closedMask), {
    raw: { width: workW, height: workH, channels: 1 },
  })
    .blur(1.5)
    .raw()
    .toBuffer();

  // 5. Combine original RGB with the refined alpha mask into 4-channel RGBA
  const rgba = Buffer.alloc(workW * workH * 4);
  for (let i = 0; i < workW * workH; i++) {
    const srcRgb = i * 3;
    const dstRgba = i * 4;
    rgba[dstRgba] = rawRgb[srcRgb];
    rgba[dstRgba + 1] = rawRgb[srcRgb + 1];
    rgba[dstRgba + 2] = rawRgb[srcRgb + 2];
    rgba[dstRgba + 3] = softMask[i];
  }

  const isolatedCutout = await sharp(rgba, {
    raw: { width: workW, height: workH, channels: 4 },
  })
    .png()
    .toBuffer();

  // 6. Composite onto pristine commercial white canvas (targetW x targetH)
  // with safe margins so pendant, chain, and earrings fit perfectly without clipping.
  const paddedDim = Math.round(targetW * 0.88); // 88% scale leaves 6% breathing room around all sides
  const resizedCutout = await sharp(isolatedCutout)
    .resize(paddedDim, paddedDim, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .toBuffer();

  if (options.returnTransparentPng) {
    return resizedCutout;
  }

  const finalCanvas = await sharp({
    create: {
      width: targetW,
      height: targetH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: resizedCutout,
        gravity: 'center',
      },
    ])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return finalCanvas;
}

/**
 * Universal Background Removal Controller:
 * 1. Checks if Remove.bg, Clipdrop, or PhotoRoom API key is configured.
 * 2. If an API key is available, calls the API for studio-grade isolation and composites onto 2048x2048 white canvas.
 * 3. If no external key or if the API call fails, seamlessly falls back to the high-precision local computer vision matting engine!
 */
export async function executeBackgroundRemoval(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<BackgroundRemovalResult> {
  const config = getBackgroundRemovalConfig();
  const providerChoice = options.provider || config.provider || 'auto';
  const targetW = options.targetWidth || 2048;
  const targetH = options.targetHeight || 2048;

  // 1. Try PhotoRoom API if key provided (premier for jewelry isolation & stand removal)
  const photoroomKey = options.apiKey || config.photoroomApiKey;
  if ((providerChoice === 'auto' || providerChoice === 'photoroom') && photoroomKey) {
    console.log('[BackgroundRemoval] Invoking PhotoRoom API for studio isolation...');
    const apiResult = await callPhotoRoomApi(inputBuffer, photoroomKey, {
      returnTransparent: Boolean(options.returnTransparentPng),
    });
    if (apiResult && apiResult.length > 100) {
      try {
        const paddedDim = Math.round(targetW * 0.88);
        const resized = await sharp(apiResult)
          .resize(paddedDim, paddedDim, { fit: 'inside', withoutEnlargement: false })
          .toBuffer();

        if (options.returnTransparentPng) {
          return {
            buffer: resized,
            providerUsed: 'photoroom',
            success: true,
            notes: 'Transparent PNG cutout via PhotoRoom API',
          };
        }

        const composited = await sharp({
          create: {
            width: targetW,
            height: targetH,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          },
        })
          .composite([{ input: resized, gravity: 'center' }])
          .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          .toBuffer();

        return {
          buffer: composited,
          providerUsed: 'photoroom',
          success: true,
          notes: 'Studio-quality background removal via PhotoRoom API',
        };
      } catch (err: any) {
        console.warn('[BackgroundRemoval] Error compositing PhotoRoom result:', err.message);
      }
    }
  }

  // 2. Try Remove.bg API if key provided
  const removeBgKey = options.apiKey || config.removeBgApiKey;
  if ((providerChoice === 'auto' || providerChoice === 'remove_bg') && removeBgKey) {
    console.log('[BackgroundRemoval] Invoking Remove.bg API for studio-quality isolation...');
    const apiResult = await callRemoveBgApi(inputBuffer, removeBgKey);
    if (apiResult && apiResult.length > 100) {
      try {
        const paddedDim = Math.round(targetW * 0.88);
        const resized = await sharp(apiResult)
          .resize(paddedDim, paddedDim, { fit: 'inside', withoutEnlargement: false })
          .toBuffer();

        const composited = await sharp({
          create: {
            width: targetW,
            height: targetH,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          },
        })
          .composite([{ input: resized, gravity: 'center' }])
          .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          .toBuffer();

        return {
          buffer: composited,
          providerUsed: 'remove_bg',
          success: true,
          notes: 'Studio-quality background removal via Remove.bg API',
        };
      } catch (err: any) {
        console.warn('[BackgroundRemoval] Error compositing Remove.bg result:', err.message);
      }
    }
  }

  // 3. Try ClipDrop API if key provided
  const clipdropKey = options.apiKey || config.clipdropApiKey;
  if ((providerChoice === 'auto' || providerChoice === 'clipdrop') && clipdropKey) {
    console.log('[BackgroundRemoval] Invoking ClipDrop API...');
    const apiResult = await callClipdropApi(inputBuffer, clipdropKey);
    if (apiResult && apiResult.length > 100) {
      try {
        const paddedDim = Math.round(targetW * 0.88);
        const resized = await sharp(apiResult)
          .resize(paddedDim, paddedDim, { fit: 'inside', withoutEnlargement: false })
          .toBuffer();

        const composited = await sharp({
          create: {
            width: targetW,
            height: targetH,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          },
        })
          .composite([{ input: resized, gravity: 'center' }])
          .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          .toBuffer();

        return {
          buffer: composited,
          providerUsed: 'clipdrop',
          success: true,
          notes: 'High-precision background removal via ClipDrop API',
        };
      } catch (err: any) {
        console.warn('[BackgroundRemoval] Error compositing ClipDrop result:', err.message);
      }
    }
  }

  // 4. Fallback to High-Precision Local Computer Vision Matting Engine
  console.log('[BackgroundRemoval] Using enhanced local studio vision matting engine (all-metal safe)...');
  const localResult = await cleanJewelryBackgroundLocally(inputBuffer, options);
  return {
    buffer: localResult,
    providerUsed: 'local_studio_vision',
    success: true,
    notes: 'Cleaned via enhanced all-metal computer vision matting engine',
  };
}
