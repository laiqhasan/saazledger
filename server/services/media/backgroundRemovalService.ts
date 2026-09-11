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
  providerUsed:
    | 'gemini_image_edit'
    | 'remove_bg'
    | 'clipdrop'
    | 'photoroom'
    | 'local_studio_vision';
  success: boolean;
  notes?: string;
}

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
      'gemini-3-pro-image-preview',
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

    const response = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey.trim(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      console.warn(
        '[BackgroundRemoval] remove.bg rejected request:',
        response.status,
        (await response.text()).slice(0, 600)
      );
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error: any) {
    console.warn('[BackgroundRemoval] remove.bg request failed:', error.message);
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

    const response = await fetch('https://clipdrop-api.co/remove-background/v1', {
      method: 'POST',
      headers: { 'x-api-key': apiKey.trim() },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      console.warn(
        '[BackgroundRemoval] ClipDrop rejected request:',
        response.status,
        (await response.text()).slice(0, 600)
      );
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error: any) {
    console.warn('[BackgroundRemoval] ClipDrop request failed:', error.message);
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

    const response = await fetch('https://sdk.photoroom.com/v1/segment', {
      method: 'POST',
      headers: { 'x-api-key': apiKey.trim() },
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      console.warn(
        '[BackgroundRemoval] PhotoRoom rejected request:',
        response.status,
        (await response.text()).slice(0, 600)
      );
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error: any) {
    console.warn('[BackgroundRemoval] PhotoRoom request failed:', error.message);
    return null;
  }
}

const GEMINI_WHITE_BG_PROMPT = `
Using the provided jewellery product photo, isolate only the jewellery item(s), including the complete necklace chain, clasp, pendant and matching earrings.

Remove the current background entirely. Remove the white paper sheet/board, paper edges, paper shadows, grey areas, texture, wrinkles, marks, dust and every other non-jewellery object.

Replace the removed background with a clean, solid, pure white background (#FFFFFF).

STRICT PRODUCT PRESERVATION:
- Do not redesign, retouch or reinterpret the jewellery.
- Do not change the stone colour, stone count, stone position or stone shape.
- Do not change the metal colour or finish.
- Do not change the chain, clasp, pendant, earrings, proportions, orientation or geometry.
- Do not remove thin chain sections, prongs, hooks or dangling details.
- Do not add any jewellery, props, shadows, text, logo or watermark.
- Keep the complete sellable set fully visible and centered with comfortable e-commerce margins.
- Preserve the original photographic appearance of the jewellery as closely as possible.

Only change the background. The result must look like a clean e-commerce product photograph on pure #FFFFFF, not an illustration or a newly designed product.
`.trim();

function extractGeminiImageBuffer(payload: any): Buffer | null {
  // Gemini Interactions API shape.
  for (const step of payload?.steps || []) {
    if (step?.type !== 'model_output') continue;
    for (const block of step?.content || []) {
      if (block?.type === 'image' && block?.data) {
        const buffer = Buffer.from(block.data, 'base64');
        if (buffer.length > 1000) return buffer;
      }
    }
  }

  // Also accept generateContent-compatible shapes for defensive compatibility.
  for (const candidate of payload?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      const base64 = part?.inlineData?.data || part?.inline_data?.data;
      if (base64) {
        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length > 1000) return buffer;
      }
    }
  }

  return null;
}

async function callGeminiWhiteBackgroundEdit(
  inputBuffer: Buffer,
  apiKey: string,
  configuredModel: string
): Promise<{ buffer: Buffer; modelUsed: string } | null> {
  if (!apiKey.trim()) return null;

  try {
    // Normalize the authentic source only for transport. Do not crop or redraw it here.
    const reference = await sharp(inputBuffer)
      .rotate()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    // Prefer the configured/Pro model, then fall back to the current Gemini image model.
    const models = Array.from(
      new Set([
        configuredModel || 'gemini-3-pro-image-preview',
        'gemini-3-pro-image-preview',
        'gemini-3.1-flash-image',
      ])
    );

    for (const model of models) {
      console.log(`[BackgroundRemoval] Trying Gemini image edit (${model})...`);

      try {
        const response = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/interactions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey.trim(),
            },
            body: JSON.stringify({
              model,
              input: [
                {
                  type: 'image',
                  mime_type: 'image/png',
                  data: reference.toString('base64'),
                },
                {
                  type: 'text',
                  text: GEMINI_WHITE_BG_PROMPT,
                },
              ],
            }),
            signal: AbortSignal.timeout(120000),
          }
        );

        if (!response.ok) {
          const text = await response.text();
          console.warn(
            `[BackgroundRemoval] Gemini ${model} rejected request ${response.status}:`,
            text.slice(0, 1000)
          );
          continue;
        }

        const payload: any = await response.json();
        const generated = extractGeminiImageBuffer(payload);
        if (!generated) {
          console.warn(`[BackgroundRemoval] Gemini ${model} returned no image block.`);
          continue;
        }

        return { buffer: generated, modelUsed: model };
      } catch (error: any) {
        console.warn(`[BackgroundRemoval] Gemini ${model} request failed:`, error.message);
      }
    }
  } catch (error: any) {
    console.warn('[BackgroundRemoval] Could not prepare Gemini reference image:', error.message);
  }

  return null;
}

async function normalizeGeminiWhiteResult(
  generatedBuffer: Buffer,
  targetWidth: number,
  targetHeight: number
): Promise<Buffer> {
  // Gemini is responsible for the semantic background replacement. Sharp only makes the
  // result a predictable Shopify master while preserving its aspect ratio.
  return sharp(generatedBuffer)
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(targetWidth, targetHeight, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255 },
      withoutEnlargement: false,
    })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Local object extractor for jewellery photographed on white / pale paper or boards.
 *
 * This remains as an offline fallback. When GEMINI_API_KEY is available, normal white
 * e-commerce cover creation prefers Gemini semantic image editing because pale paper and
 * thin silver chains are intrinsically difficult to separate with thresholding alone.
 */
export async function cleanJewelryBackgroundLocally(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<Buffer> {
  void options;

  const maxWorkingDim = 2200;
  const workingBuffer = await sharp(inputBuffer)
    .rotate()
    .resize(maxWorkingDim, maxWorkingDim, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  const { data: rgb, info } = await sharp(workingBuffer)
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const pixelCount = width * height;

  const sigma = Math.max(10, Math.min(24, Math.min(width, height) / 55));
  const localBackground = await sharp(workingBuffer)
    .blur(sigma)
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer();

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

  const luma = new Uint8Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    const i = p * channels;
    luma[p] = Math.round(0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]);
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

  const seed = new Uint8Array(pixelCount);
  const chromaThreshold = Math.max(20, bgChroma + 10);
  const darkThreshold = bgLuma - 34;

  for (let p = 0; p < pixelCount; p++) {
    const i = p * channels;
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    const localR = localBackground[i];
    const localG = localBackground[i + 1];
    const localB = localBackground[i + 2];

    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const localDistance = Math.hypot(r - localR, g - localG, b - localB);
    const edge = gradient[p];

    const isForeground =
      chroma > chromaThreshold ||
      luma[p] < darkThreshold ||
      edge >= 15 ||
      (localDistance >= 13 && edge >= 7) ||
      (localDistance >= 20 && luma[p] < bgLuma - 12);

    seed[p] = isForeground ? 255 : 0;
  }

  const bridged = new Uint8Array(seed);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      if (seed[p] !== 255) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          bridged[(y + dy) * width + (x + dx)] = 255;
        }
      }
    }
  }

  const visited = new Uint8Array(pixelCount);
  const filtered = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const minArea = Math.max(48, Math.round(pixelCount * 0.000025));
  const thinMinArea = Math.max(20, Math.round(pixelCount * 0.00001));

  for (let start = 0; start < pixelCount; start++) {
    if (bridged[start] === 0 || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    while (head < tail) {
      const p = queue[head++];
      const y = Math.floor(p / width);
      const x = p - y * width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const np = ny * width + nx;
          if (bridged[np] === 255 && !visited[np]) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
      }
    }

    const spanW = maxX - minX + 1;
    const spanH = maxY - minY + 1;
    const boxArea = Math.max(1, spanW * spanH);
    const density = tail / boxArea;

    const sheetLike =
      tail > pixelCount * 0.08 ||
      (spanW > width * 0.86 && spanH > height * 0.86 && density > 0.14);

    const elongated = Math.max(spanW, spanH) >= 42;
    const keep = !sheetLike && (tail >= minArea || (tail >= thinMinArea && elongated));

    if (keep) {
      for (let i = 0; i < tail; i++) filtered[queue[i]] = 255;
    }
  }

  const protectedMask = new Uint8Array(filtered);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      if (filtered[p] !== 255) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          protectedMask[(y + dy) * width + (x + dx)] = 255;
        }
      }
    }
  }

  const feather = await sharp(Buffer.from(protectedMask), {
    raw: { width, height, channels: 1 },
  })
    .blur(0.4)
    .raw()
    .toBuffer();

  const rgba = Buffer.alloc(pixelCount * 4);
  let foregroundPixels = 0;
  for (let p = 0; p < pixelCount; p++) {
    const source = p * channels;
    const target = p * 4;
    rgba[target] = rgb[source];
    rgba[target + 1] = rgb[source + 1];
    rgba[target + 2] = rgb[source + 2];
    rgba[target + 3] = protectedMask[p] === 255 ? 255 : feather[p];
    if (protectedMask[p] === 255) foregroundPixels++;
  }

  const occupancy = foregroundPixels / Math.max(1, pixelCount);
  console.log(
    `[BackgroundRemoval] Local white-paper isolation kept ${(occupancy * 100).toFixed(2)}% of pixels as jewellery.`
  );

  return sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function normalizeTransparentResult(buffer: Buffer): Promise<Buffer | null> {
  try {
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height || !metadata.hasAlpha) return null;
    return sharp(buffer).rotate().png().toBuffer();
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
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 3 })
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
  const providerChoice =
    options.provider || (config.provider as BackgroundRemovalOptions['provider']) || 'auto';
  const targetWidth = options.targetWidth || 2048;
  const targetHeight = options.targetHeight || 2048;

  const explicitKey = options.apiKey?.trim() || '';

  // For the actual e-commerce white cover, prefer semantic Gemini image editing whenever
  // the existing GEMINI_API_KEY is available. This handles white paper / white chain cases
  // that deterministic thresholding cannot reliably separate. Transparent cutouts still use
  // true segmentation providers/local CV because Gemini white-background output is opaque.
  if (!options.returnTransparentPng && (providerChoice === 'auto' || providerChoice === 'gemini')) {
    const geminiKey = providerChoice === 'gemini' && explicitKey ? explicitKey : config.geminiApiKey;
    if (geminiKey) {
      const geminiResult = await callGeminiWhiteBackgroundEdit(
        inputBuffer,
        geminiKey,
        config.geminiImageModel
      );

      if (geminiResult) {
        return {
          buffer: await normalizeGeminiWhiteResult(geminiResult.buffer, targetWidth, targetHeight),
          providerUsed: 'gemini_image_edit',
          success: true,
          notes: `White e-commerce background generated by Gemini image editing (${geminiResult.modelUsed}); subject-preservation review recommended before Shopify publish`,
        };
      }

      console.warn('[BackgroundRemoval] Gemini image edit failed; continuing to segmentation fallbacks.');
    }
  }

  const providers: Array<{
    name: 'photoroom' | 'remove_bg' | 'clipdrop';
    key: string;
    run: (key: string) => Promise<Buffer | null>;
  }> = [
    {
      name: 'photoroom',
      key: config.photoroomApiKey,
      run: (key) => callPhotoRoomApi(inputBuffer, key),
    },
    {
      name: 'remove_bg',
      key: config.removeBgApiKey,
      run: (key) => callRemoveBgApi(inputBuffer, key),
    },
    {
      name: 'clipdrop',
      key: config.clipdropApiKey,
      run: (key) => callClipdropApi(inputBuffer, key),
    },
  ];

  if (providerChoice !== 'local' && providerChoice !== 'gemini') {
    for (const provider of providers) {
      if (providerChoice !== 'auto' && providerChoice !== provider.name) continue;
      const key = explicitKey || provider.key;
      if (!key) continue;

      console.log(`[BackgroundRemoval] Trying ${provider.name}...`);
      const result = await provider.run(key);
      if (!result || result.length < 100) continue;

      const transparent = await normalizeTransparentResult(result);
      if (!transparent) {
        console.warn(
          `[BackgroundRemoval] ${provider.name} did not return a transparent cutout; trying next provider.`
        );
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
        notes: `Jewellery isolated via ${provider.name} and composited onto pure #FFFFFF`,
      };
    }
  }

  console.log('[BackgroundRemoval] Using local white-paper jewellery isolation engine...');
  const localTransparent = await cleanJewelryBackgroundLocally(inputBuffer, options);

  if (options.returnTransparentPng) {
    return {
      buffer: localTransparent,
      providerUsed: 'local_studio_vision',
      success: true,
      notes: 'Transparent jewellery-only cutout via local white-paper isolation engine',
    };
  }

  return {
    buffer: await compositeToWhite(localTransparent, targetWidth, targetHeight),
    providerUsed: 'local_studio_vision',
    success: true,
    notes: 'Jewellery extracted from paper/board and composited onto pure #FFFFFF',
  };
}
