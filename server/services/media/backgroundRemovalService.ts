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
  buffer: Buffer;
  providerUsed: 'remove_bg' | 'clipdrop' | 'photoroom' | 'local_studio_vision';
  success: boolean;
  notes?: string;
}

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

  return {
    removeBgApiKey:
      getSetting('remove_bg_api_key') ||
      process.env.REMOVE_BG_API_KEY ||
      process.env.REMOVEBG_API_KEY ||
      '',
    clipdropApiKey:
      getSetting('clipdrop_api_key') || process.env.CLIPDROP_API_KEY || '',
    photoroomApiKey:
      getSetting('photoroom_api_key') ||
      process.env.PHOTOROOM_API_KEY ||
      process.env.PHOTO_ROOM_API_KEY ||
      process.env.PHOTOROOM_KEY ||
      process.env.PHOTOROOM_TOKEN ||
      '',
    provider: getSetting('bg_removal_provider') || process.env.BG_REMOVAL_PROVIDER || 'auto',
  };
}

async function callRemoveBgApi(inputBuffer: Buffer, apiKey: string): Promise<Buffer | null> {
  try {
    const formData = new URLSearchParams();
    formData.append('image_file_b64', inputBuffer.toString('base64'));
    formData.append('size', 'auto');
    formData.append('type', 'product');
    formData.append('format', 'png');

    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey.trim(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.warn('[BackgroundRemoval] remove.bg rejected request:', res.status, (await res.text()).slice(0, 600));
      return null;
    }

    return Buffer.from(await res.arrayBuffer());
  } catch (err: any) {
    console.warn('[BackgroundRemoval] remove.bg request failed:', err.message);
    return null;
  }
}

async function callClipdropApi(inputBuffer: Buffer, apiKey: string): Promise<Buffer | null> {
  try {
    const formData = new FormData();
    formData.append(
      'image_file',
      new Blob([new Uint8Array(inputBuffer)], { type: 'image/jpeg' }),
      'jewelry.jpg'
    );

    const res = await fetch('https://clipdrop-api.co/remove-background/v1', {
      method: 'POST',
      headers: { 'x-api-key': apiKey.trim() },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.warn('[BackgroundRemoval] ClipDrop rejected request:', res.status, (await res.text()).slice(0, 600));
      return null;
    }

    return Buffer.from(await res.arrayBuffer());
  } catch (err: any) {
    console.warn('[BackgroundRemoval] ClipDrop request failed:', err.message);
    return null;
  }
}

async function callPhotoRoomApi(inputBuffer: Buffer, apiKey: string): Promise<Buffer | null> {
  try {
    const formData = new FormData();
    formData.append(
      'image_file',
      new Blob([new Uint8Array(inputBuffer)], { type: 'image/jpeg' }),
      'jewelry.jpg'
    );

    const res = await fetch('https://sdk.photoroom.com/v1/segment', {
      method: 'POST',
      headers: { 'x-api-key': apiKey.trim() },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.warn('[BackgroundRemoval] PhotoRoom rejected request:', res.status, (await res.text()).slice(0, 600));
      return null;
    }

    return Buffer.from(await res.arrayBuffer());
  } catch (err: any) {
    console.warn('[BackgroundRemoval] PhotoRoom request failed:', err.message);
    return null;
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Local deterministic studio isolation for bright supplier boards / light cloth.
 *
 * The previous implementation tried to classify jewellery foreground directly and
 * frequently made thin silver chains semi-transparent. This implementation does the
 * opposite: it identifies only pixels that are very likely to be smooth background.
 * Everything else is preserved as opaque product detail.
 */
export async function cleanJewelryBackgroundLocally(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<Buffer> {
  const maxWorkingDim = 1800;

  const oriented = sharp(inputBuffer).rotate();
  const meta = await oriented.metadata();
  const srcW = meta.width || 1;
  const srcH = meta.height || 1;

  let pipeline = sharp(inputBuffer).rotate();
  if (Math.max(srcW, srcH) > maxWorkingDim) {
    pipeline = pipeline.resize(maxWorkingDim, maxWorkingDim, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const { data: rgb, info } = await pipeline
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const pixelCount = width * height;

  const sampleR: number[] = [];
  const sampleG: number[] = [];
  const sampleB: number[] = [];
  const border = Math.max(4, Math.round(Math.min(width, height) * 0.035));

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x < border || x >= width - border || y < border || y >= height - border) {
        const i = (y * width + x) * channels;
        sampleR.push(rgb[i]);
        sampleG.push(rgb[i + 1]);
        sampleB.push(rgb[i + 2]);
      }
    }
  }

  const bgR = median(sampleR);
  const bgG = median(sampleG);
  const bgB = median(sampleB);
  const bgLuma = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  const bgChroma = Math.max(bgR, bgG, bgB) - Math.min(bgR, bgG, bgB);

  // Estimate normal board/cloth variation from border samples.
  const borderDistances: number[] = [];
  for (let i = 0; i < sampleR.length; i++) {
    borderDistances.push(
      Math.hypot(sampleR[i] - bgR, sampleG[i] - bgG, sampleB[i] - bgB)
    );
  }
  const borderSpread = median(borderDistances);
  const backgroundDistanceThreshold = Math.max(22, Math.min(48, 20 + borderSpread * 2.2));

  const luma = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const s = i * channels;
    luma[i] = Math.round(0.299 * rgb[s] + 0.587 * rgb[s + 1] + 0.114 * rgb[s + 2]);
  }

  const gradient = new Uint8Array(pixelCount);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const gx = Math.abs(luma[p + 1] - luma[p - 1]);
      const gy = Math.abs(luma[p + width] - luma[p - width]);
      gradient[p] = Math.min(255, gx + gy);
    }
  }

  const foreground = new Uint8Array(pixelCount);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * channels;
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const chroma = maxC - minC;
      const lum = luma[p];
      const grad = gradient[p];
      const dist = Math.hypot(r - bgR, g - bgG, b - bgB);

      // Background must be both visually close to the sampled board AND smooth.
      // This deliberately preserves thin chain/prong edges even when they are light silver.
      const smoothBackground =
        dist <= backgroundDistanceThreshold &&
        grad < 11 &&
        chroma <= Math.max(24, bgChroma + 12) &&
        lum >= bgLuma - 42;

      const obviousJewellery =
        dist > backgroundDistanceThreshold ||
        grad >= 11 ||
        chroma > Math.max(24, bgChroma + 12) ||
        lum < bgLuma - 42;

      foreground[p] = smoothBackground && !obviousJewellery ? 0 : 255;
    }
  }

  // Protect thin jewellery by expanding foreground by one pixel. This is intentionally
  // small: enough for chains/prongs, but not enough to reintroduce large background areas.
  const protectedMask = new Uint8Array(foreground);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      if (foreground[p] !== 255) continue;
      protectedMask[p - 1] = 255;
      protectedMask[p + 1] = 255;
      protectedMask[p - width] = 255;
      protectedMask[p + width] = 255;
    }
  }

  // Very light feathering avoids jagged cutout edges but keeps the chain opaque.
  const alpha = await sharp(Buffer.from(protectedMask), {
    raw: { width, height, channels: 1 },
  })
    .blur(0.45)
    .raw()
    .toBuffer();

  // Snap confident foreground back to full opacity so silver chains do not look faded.
  const rgba = Buffer.alloc(pixelCount * 4);
  for (let p = 0; p < pixelCount; p++) {
    const src = p * channels;
    const dst = p * 4;
    rgba[dst] = rgb[src];
    rgba[dst + 1] = rgb[src + 1];
    rgba[dst + 2] = rgb[src + 2];
    rgba[dst + 3] = protectedMask[p] === 255 ? 255 : alpha[p];
  }

  return sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function normalizeTransparentResult(buffer: Buffer): Promise<Buffer | null> {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return null;

    if (meta.hasAlpha) {
      return sharp(buffer).rotate().png().toBuffer();
    }

    // Some providers may return a white-background image instead of alpha. Do not
    // misrepresent it as transparent; let the next provider/local fallback handle it.
    return null;
  } catch {
    return null;
  }
}

async function compositeToWhite(
  transparentBuffer: Buffer,
  targetWidth: number,
  targetHeight: number
): Promise<Buffer> {
  const trimmed = await sharp(transparentBuffer)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 })
    .toBuffer({ resolveWithObject: true });

  const maxW = Math.round(targetWidth * 0.86);
  const maxH = Math.round(targetHeight * 0.86);
  const resized = await sharp(trimmed.data)
    .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: targetWidth,
      height: targetHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([{ input: resized, gravity: 'center' }])
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

export async function executeBackgroundRemoval(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<BackgroundRemovalResult> {
  const config = getBackgroundRemovalConfig();
  const providerChoice = options.provider || (config.provider as BackgroundRemovalOptions['provider']) || 'auto';
  const targetWidth = options.targetWidth || 2048;
  const targetHeight = options.targetHeight || 2048;

  const providers: Array<{
    name: 'photoroom' | 'remove_bg' | 'clipdrop';
    enabled: boolean;
    run: () => Promise<Buffer | null>;
  }> = [
    {
      name: 'photoroom',
      enabled: Boolean(config.photoroomApiKey) && (providerChoice === 'auto' || providerChoice === 'photoroom'),
      run: () => callPhotoRoomApi(inputBuffer, options.apiKey || config.photoroomApiKey),
    },
    {
      name: 'remove_bg',
      enabled: Boolean(config.removeBgApiKey) && (providerChoice === 'auto' || providerChoice === 'remove_bg'),
      run: () => callRemoveBgApi(inputBuffer, options.apiKey || config.removeBgApiKey),
    },
    {
      name: 'clipdrop',
      enabled: Boolean(config.clipdropApiKey) && (providerChoice === 'auto' || providerChoice === 'clipdrop'),
      run: () => callClipdropApi(inputBuffer, options.apiKey || config.clipdropApiKey),
    },
  ];

  for (const provider of providers) {
    if (!provider.enabled) continue;
    console.log(`[BackgroundRemoval] Trying ${provider.name}...`);
    const result = await provider.run();
    if (!result || result.length < 100) continue;

    const transparent = await normalizeTransparentResult(result);
    if (!transparent) {
      console.warn(`[BackgroundRemoval] ${provider.name} did not return a transparent cutout; trying next provider.`);
      continue;
    }

    if (options.returnTransparentPng) {
      return {
        buffer: transparent,
        providerUsed: provider.name,
        success: true,
        notes: `Transparent jewellery cutout via ${provider.name}`,
      };
    }

    return {
      buffer: await compositeToWhite(transparent, targetWidth, targetHeight),
      providerUsed: provider.name,
      success: true,
      notes: `Studio-white background via ${provider.name}`,
    };
  }

  console.log('[BackgroundRemoval] Using local bright-background isolation fallback...');
  const localTransparent = await cleanJewelryBackgroundLocally(inputBuffer, {
    ...options,
    returnTransparentPng: true,
  });

  if (options.returnTransparentPng) {
    return {
      buffer: localTransparent,
      providerUsed: 'local_studio_vision',
      success: true,
      notes: 'Local bright-background isolation with thin-chain preservation',
    };
  }

  return {
    buffer: await compositeToWhite(localTransparent, targetWidth, targetHeight),
    providerUsed: 'local_studio_vision',
    success: true,
    notes: 'Local bright-background isolation composited onto pure #FFFFFF',
  };
}
