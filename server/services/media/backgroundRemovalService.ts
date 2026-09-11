import sharp from 'sharp';
import { db } from '../../db/database';

export interface BackgroundRemovalOptions {
  apiKey?: string;
  provider?: 'auto' | 'gemini' | 'remove_bg' | 'clipdrop' | 'photoroom' | 'local';
  targetWidth?: number;
  targetHeight?: number;
  backgroundColor?: { r: number; g: number; b: number };
  addContactShadow?: boolean;
  returnTransparentPng?: boolean;
}

export interface BackgroundRemovalResult {
  buffer: Buffer;
  providerUsed: 'photoroom';
  success: boolean;
  notes?: string;
}

/**
 * White-background production policy:
 *
 * PhotoRoom is the only runtime background-removal provider for Saaz Ledger.
 * We intentionally do not fall back to local thresholding or generative image
 * editing for the catalog hero because jewellery photographed on white paper
 * contains thin silver chains/prongs that are easy to damage with heuristic
 * segmentation and easy to redraw with generative models.
 */
export function getBackgroundRemovalConfig(): {
  removeBgApiKey: string;
  clipdropApiKey: string;
  photoroomApiKey: string;
  geminiApiKey: string;
  geminiImageModel: string;
  provider: string;
} {
  const getSetting = (key: string) => {
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value || '';
    } catch {
      return '';
    }
  };

  return {
    // Keep the legacy fields in the returned shape so existing settings screens
    // and callers do not break, but executeBackgroundRemoval no longer uses them.
    removeBgApiKey:
      getSetting('remove_bg_api_key') ||
      process.env.REMOVE_BG_API_KEY ||
      process.env.REMOVEBG_API_KEY ||
      '',
    clipdropApiKey: getSetting('clipdrop_api_key') || process.env.CLIPDROP_API_KEY || '',
    photoroomApiKey:
      getSetting('photoroom_api_key') ||
      process.env.PHOTOROOM_API_KEY ||
      process.env.PHOTO_ROOM_API_KEY ||
      process.env.PHOTOROOM_KEY ||
      process.env.PHOTOROOM_TOKEN ||
      '',
    geminiApiKey:
      getSetting('gemini_api_key') ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_GEMINI_API_KEY ||
      '',
    geminiImageModel:
      getSetting('gemini_white_bg_model') ||
      getSetting('gemini_image_model') ||
      process.env.GEMINI_WHITE_BG_MODEL ||
      process.env.GEMINI_IMAGE_MODEL ||
      'gemini-3.1-flash-image',
    provider: 'photoroom',
  };
}

async function preparePhotoRoomInput(inputBuffer: Buffer): Promise<Buffer> {
  // Normalize EXIF orientation and upload a predictable PNG to PhotoRoom.
  // This prevents a JPEG MIME declaration from being wrong for PNG/HEIC inputs.
  return sharp(inputBuffer)
    .rotate()
    .png({ compressionLevel: 6 })
    .toBuffer();
}

async function callPhotoRoomApi(inputBuffer: Buffer, apiKey: string): Promise<Buffer> {
  if (!apiKey.trim()) {
    throw new Error(
      'PhotoRoom API key is not configured. Set PHOTOROOM_API_KEY in the server environment.'
    );
  }

  const prepared = await preparePhotoRoomInput(inputBuffer);
  const formData = new FormData();
  formData.append(
    'image_file',
    new Blob([new Uint8Array(prepared)], { type: 'image/png' }),
    'jewellery-source.png'
  );

  // Explicitly request the full-resolution RGBA PNG cutout. Background colour is
  // intentionally omitted because we want a true transparent subject first; the
  // Shopify #FFFFFF master is composited deterministically afterwards with Sharp.
  formData.append('format', 'png');
  formData.append('channels', 'rgba');
  formData.append('size', 'full');

  console.log('[BackgroundRemoval] Sending original jewellery photo to PhotoRoom...');

  const response = await fetch('https://sdk.photoroom.com/v1/segment', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey.trim(),
    },
    body: formData,
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `PhotoRoom background removal failed (${response.status}): ${body.slice(0, 800)}`
    );
  }

  const result = Buffer.from(await response.arrayBuffer());
  if (result.length < 1000) {
    throw new Error('PhotoRoom returned an empty or invalid background-removal image.');
  }

  return result;
}

async function normalizeTransparentResult(buffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('PhotoRoom returned an image with invalid dimensions.');
  }

  if (!metadata.hasAlpha) {
    throw new Error(
      'PhotoRoom did not return a transparent RGBA cutout. White BG was not generated.'
    );
  }

  // Verify that the alpha channel contains at least some transparent pixels. This
  // stops an opaque original photograph from ever being accepted as a cutout.
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaIndex = info.channels - 1;
  let transparentPixels = 0;
  let opaquePixels = 0;
  const pixelCount = info.width * info.height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 250000));

  for (let p = 0; p < pixelCount; p += sampleStep) {
    const alpha = data[p * info.channels + alphaIndex];
    if (alpha < 245) transparentPixels++;
    if (alpha > 10) opaquePixels++;
  }

  if (transparentPixels === 0) {
    throw new Error(
      'PhotoRoom result is fully opaque, so the original background was not removed.'
    );
  }

  if (opaquePixels === 0) {
    throw new Error('PhotoRoom result contains no visible jewellery subject.');
  }

  return sharp(buffer)
    .rotate()
    .png({ compressionLevel: 6 })
    .toBuffer();
}

async function compositeToWhite(
  transparentBuffer: Buffer,
  targetWidth: number,
  targetHeight: number,
  backgroundColor: { r: number; g: number; b: number }
): Promise<Buffer> {
  let trimmedBuffer: Buffer;

  try {
    // Trim only transparent pixels from the PhotoRoom result. We never trim based
    // on white colour because silver jewellery itself can be close to white.
    trimmedBuffer = (
      await sharp(transparentBuffer)
        .trim({
          background: { r: 0, g: 0, b: 0, alpha: 0 },
          threshold: 2,
        })
        .png()
        .toBuffer({ resolveWithObject: true })
    ).data;
  } catch {
    trimmedBuffer = transparentBuffer;
  }

  // Keep comfortable marketplace margins. For long necklaces, fit:'inside'
  // preserves the complete clasp -> chain -> pendant geometry without distortion.
  const maxW = Math.max(1, Math.round(targetWidth * 0.88));
  const maxH = Math.max(1, Math.round(targetHeight * 0.88));

  const subject = await sharp(trimmedBuffer)
    .resize(maxW, maxH, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  return sharp({
    create: {
      width: targetWidth,
      height: targetHeight,
      channels: 3,
      background: backgroundColor,
    },
  })
    .composite([{ input: subject, gravity: 'center' }])
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/**
 * Retained only for source compatibility with older imports/tests.
 * Production white-background creation is PhotoRoom-only. Failing loudly is
 * safer than silently producing the paper/board artefacts seen in the old local
 * thresholding implementation.
 */
export async function cleanJewelryBackgroundLocally(
  _inputBuffer: Buffer,
  _options: BackgroundRemovalOptions = {}
): Promise<Buffer> {
  throw new Error(
    'Local jewellery background removal is disabled. Use executeBackgroundRemoval(), which is PhotoRoom-only.'
  );
}

/**
 * PhotoRoom-only background removal.
 *
 * - Always sends the authentic uploaded image to PhotoRoom Basic Background Removal.
 * - Never uses Gemini, remove.bg, ClipDrop, or local thresholding as a fallback.
 * - Returns the transparent PhotoRoom PNG when returnTransparentPng=true.
 * - Otherwise composites the extracted subject onto an exact 2048x2048 (default)
 *   #FFFFFF master while preserving aspect ratio.
 */
export async function executeBackgroundRemoval(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<BackgroundRemovalResult> {
  const config = getBackgroundRemovalConfig();
  const targetWidth = options.targetWidth || 2048;
  const targetHeight = options.targetHeight || 2048;
  const backgroundColor = options.backgroundColor || { r: 255, g: 255, b: 255 };
  const apiKey = options.apiKey?.trim() || config.photoroomApiKey.trim();

  if (options.provider && options.provider !== 'auto' && options.provider !== 'photoroom') {
    console.warn(
      `[BackgroundRemoval] Ignoring requested provider "${options.provider}". PhotoRoom is the only enabled background-removal provider.`
    );
  }

  const rawPhotoRoomResult = await callPhotoRoomApi(inputBuffer, apiKey);
  const transparent = await normalizeTransparentResult(rawPhotoRoomResult);

  if (options.returnTransparentPng) {
    return {
      buffer: transparent,
      providerUsed: 'photoroom',
      success: true,
      notes: 'Transparent jewellery cutout created by PhotoRoom Background Removal API',
    };
  }

  const whiteMaster = await compositeToWhite(
    transparent,
    targetWidth,
    targetHeight,
    backgroundColor
  );

  return {
    buffer: whiteMaster,
    providerUsed: 'photoroom',
    success: true,
    notes: `Jewellery isolated by PhotoRoom and composited onto ${targetWidth}x${targetHeight} pure white e-commerce canvas`,
  };
}
