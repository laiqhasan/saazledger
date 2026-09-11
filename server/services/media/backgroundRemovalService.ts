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
 * Local jewellery-aware background matting fallback.
 *
 * This is deliberately conservative around thin chains and pale/silver metal.
 * It preserves every pixel that the first-pass detector identified as product,
 * then only uses morphology/feathering to ADD continuity around those pixels.
 * The previous implementation eroded thin chains during closing and blurred the
 * remaining mask too heavily, which could make silver jewellery look ghosted on
 * white backgrounds.
 */
export async function cleanJewelryBackgroundLocally(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<Buffer> {
  const targetW = options.targetWidth || 2048;
  const targetH = options.targetHeight || 2048;

  const baseImg = sharp(inputBuffer).rotate();
  const meta = await baseImg.metadata();
  const origW = meta.width || 2048;
  const origH = meta.height || 2048;

  // Keep more source detail than before so 1-3 px necklace chains survive.
  const maxDim = 1800;
  let procPipeline = sharp(inputBuffer).rotate();
  if (origW > maxDim || origH > maxDim) {
    procPipeline = procPipeline.resize(maxDim, maxDim, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const { data: rawRgb, info } = await procPipeline
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const workW = info.width;
  const workH = info.height;
  const channels = info.channels;

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

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const p of borderPixels) {
    sumR += p.r;
    sumG += p.g;
    sumB += p.b;
  }
  const bgMeanR = sumR / borderPixels.length;
  const bgMeanG = sumG / borderPixels.length;
  const bgMeanB = sumB / borderPixels.length;

  let varDistSum = 0;
  for (const p of borderPixels) {
    varDistSum += Math.hypot(p.r - bgMeanR, p.g - bgMeanG, p.b - bgMeanB);
  }
  const bgStdDev = Math.max(6, varDistSum / Math.max(1, borderPixels.length));
  const distanceThreshold = Math.min(30, Math.max(12, bgStdDev * 1.45));

  const luma = new Uint8Array(workW * workH);
  for (let i = 0; i < workW * workH; i++) {
    const s = i * channels;
    luma[i] = Math.round(0.299 * rawRgb[s] + 0.587 * rawRgb[s + 1] + 0.114 * rawRgb[s + 2]);
  }

  const grad = new Uint8Array(workW * workH);
  for (let y = 1; y < workH - 1; y++) {
    for (let x = 1; x < workW - 1; x++) {
      const idx = y * workW + x;
      const gx = Math.abs(luma[idx + 1] - luma[idx - 1]);
      const gy = Math.abs(luma[idx + workW] - luma[idx - workW]);
      grad[idx] = Math.min(255, gx + gy);
    }
  }

  const mask = new Uint8Array(workW * workH);

  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      const idx = (y * workW + x) * channels;
      const r = rawRgb[idx];
      const g = rawRgb[idx + 1];
      const b = rawRgb[idx + 2];
      const dist = Math.hypot(r - bgMeanR, g - bgMeanG, b - bgMeanB);
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const sat = maxC - minC;
      const localDetail = grad[y * workW + x];

      const inProductZone =
        x >= workW * 0.04 &&
        x <= workW * 0.96 &&
        y >= workH * 0.035 &&
        y <= workH * 0.97;

      const isGold = r > b + 14 && g > b + 6 && sat > 14 && r > 75;
      const isGemstone = sat > 20 && dist > 8;
      const isFacetOrProng = inProductZone && localDetail >= 8 && dist >= 4;
      const isFineMetalEdge = inProductZone && localDetail >= 6 && dist >= 3 && sat < 45;
      const isSparkleOrGlint =
        inProductZone &&
        maxC > 225 &&
        dist > 8 &&
        (bgMeanR < 245 || bgMeanG < 245 || bgMeanB < 245);
      const isMetalShadow = inProductZone && dist > 11 && minC < 120;
      const isClearForeground = dist > distanceThreshold;

      const isForeground =
        isClearForeground ||
        isGold ||
        isGemstone ||
        isFacetOrProng ||
        isFineMetalEdge ||
        isSparkleOrGlint ||
        isMetalShadow;

      if (isForeground && x >= 2 && x < workW - 2 && y >= 2 && y < workH - 2) {
        mask[y * workW + x] = 255;
      }
    }
  }

  // Gentle closing fills tiny gaps but must never replace the original mask.
  const rClose = 2;
  const dilated = new Uint8Array(workW * workH);
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      if (mask[y * workW + x] !== 255) continue;
      for (let dy = -rClose; dy <= rClose; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= workH) continue;
        for (let dx = -rClose; dx <= rClose; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= workW) continue;
          if (dx * dx + dy * dy <= rClose * rClose) {
            dilated[ny * workW + nx] = 255;
          }
        }
      }
    }
  }

  const closedMask = new Uint8Array(workW * workH);
  for (let y = rClose; y < workH - rClose; y++) {
    for (let x = rClose; x < workW - rClose; x++) {
      if (dilated[y * workW + x] !== 255) continue;
      let allOn = true;
      for (let dy = -rClose; dy <= rClose && allOn; dy++) {
        for (let dx = -rClose; dx <= rClose; dx++) {
          if (dx * dx + dy * dy > rClose * rClose) continue;
          if (dilated[(y + dy) * workW + (x + dx)] === 0) {
            allOn = false;
            break;
          }
        }
      }
      if (allOn) closedMask[y * workW + x] = 255;
    }
  }

  // Preserve all first-pass jewellery pixels at full opacity. Closing may add pixels,
  // but it is never allowed to erase an already detected thin chain/prong.
  const preservedMask = new Uint8Array(workW * workH);
  for (let i = 0; i < preservedMask.length; i++) {
    preservedMask[i] = Math.max(mask[i], closedMask[i]);
  }

  // Very light feathering: previous 1.5px blur made fine silver chains translucent.
  const feathered = await sharp(Buffer.from(preservedMask), {
    raw: { width: workW, height: workH, channels: 1 },
  })
    .blur(0.65)
    .raw()
    .toBuffer();

  const rgba = Buffer.alloc(workW * workH * 4);
  for (let i = 0; i < workW * workH; i++) {
    const srcRgb = i * 3;
    const dstRgba = i * 4;
    rgba[dstRgba] = rawRgb[srcRgb];
    rgba[dstRgba + 1] = rawRgb[srcRgb + 1];
    rgba[dstRgba + 2] = rawRgb[srcRgb + 2];
    // Hard-preserve detected product pixels and only feather outside their edge.
    rgba[dstRgba + 3] = Math.max(preservedMask[i], feathered[i]);
  }

  const isolatedCutout = await sharp(rgba, {
    raw: { width: workW, height: workH, channels: 4 },
  })
    .png()
    .toBuffer();

  const paddedDim = Math.round(targetW * 0.88);
  const resizedCutout = await sharp(isolatedCutout)
    .resize(paddedDim, paddedDim, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  if (options.returnTransparentPng) {
    return resizedCutout;
  }

  return sharp({
    create: {
      width: targetW,
      height: targetH,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: resizedCutout, gravity: 'center' }])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/**
 * Universal Background Removal Controller:
 * 1. Checks if Remove.bg, Clipdrop, or PhotoRoom API key is configured.
 * 2. If an API key is available, calls the API for studio-grade isolation and composites onto 2048x2048 white canvas.
 * 3. If no external key or if the API call fails, falls back to local jewellery-aware matting.
 */
export async function executeBackgroundRemoval(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<BackgroundRemovalResult> {
  const config = getBackgroundRemovalConfig();
  const providerChoice = options.provider || config.provider || 'auto';
  const targetW = options.targetWidth || 2048;
  const targetH = options.targetHeight || 2048;

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
          .png()
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

  const removeBgKey = options.apiKey || config.removeBgApiKey;
  if ((providerChoice === 'auto' || providerChoice === 'remove_bg') && removeBgKey) {
    console.log('[BackgroundRemoval] Invoking Remove.bg API for studio-quality isolation...');
    const apiResult = await callRemoveBgApi(inputBuffer, removeBgKey);
    if (apiResult && apiResult.length > 100) {
      try {
        const paddedDim = Math.round(targetW * 0.88);
        const resized = await sharp(apiResult)
          .resize(paddedDim, paddedDim, { fit: 'inside', withoutEnlargement: false })
          .png()
          .toBuffer();

        if (options.returnTransparentPng) {
          return {
            buffer: resized,
            providerUsed: 'remove_bg',
            success: true,
            notes: 'Transparent PNG cutout via Remove.bg API',
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
          providerUsed: 'remove_bg',
          success: true,
          notes: 'Studio-quality background removal via Remove.bg API',
        };
      } catch (err: any) {
        console.warn('[BackgroundRemoval] Error compositing Remove.bg result:', err.message);
      }
    }
  }

  const clipdropKey = options.apiKey || config.clipdropApiKey;
  if ((providerChoice === 'auto' || providerChoice === 'clipdrop') && clipdropKey) {
    console.log('[BackgroundRemoval] Invoking ClipDrop API...');
    const apiResult = await callClipdropApi(inputBuffer, clipdropKey);
    if (apiResult && apiResult.length > 100) {
      try {
        const paddedDim = Math.round(targetW * 0.88);
        const resized = await sharp(apiResult)
          .resize(paddedDim, paddedDim, { fit: 'inside', withoutEnlargement: false })
          .png()
          .toBuffer();

        if (options.returnTransparentPng) {
          return {
            buffer: resized,
            providerUsed: 'clipdrop',
            success: true,
            notes: 'Transparent PNG cutout via ClipDrop API',
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
          providerUsed: 'clipdrop',
          success: true,
          notes: 'High-precision background removal via ClipDrop API',
        };
      } catch (err: any) {
        console.warn('[BackgroundRemoval] Error compositing ClipDrop result:', err.message);
      }
    }
  }

  console.log('[BackgroundRemoval] Using local jewellery-aware matting fallback...');
  const localResult = await cleanJewelryBackgroundLocally(inputBuffer, options);
  return {
    buffer: localResult,
    providerUsed: 'local_studio_vision',
    success: true,
    notes: 'Best-effort local jewellery-aware background isolation',
  };
}
