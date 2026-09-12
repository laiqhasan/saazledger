import sharp from 'sharp';
import { db } from '../../db/database';

export type BackgroundType = 'auto' | 'plain' | 'styled' | 'model';

export interface BackgroundRemovalOptions {
  apiKey?: string;
  provider?: 'auto' | 'gemini' | 'remove_bg' | 'clipdrop' | 'photoroom' | 'local';
  targetWidth?: number;
  targetHeight?: number;
  backgroundColor?: { r: number; g: number; b: number };
  addContactShadow?: boolean;
  returnTransparentPng?: boolean;
  backgroundType?: BackgroundType;
  exactIsolation?: boolean;
}

export interface BackgroundRemovalResult {
  buffer: Buffer;
  providerUsed: 'photoroom' | 'photoroom+gemini';
  success: boolean;
  notes?: string;
  detectedBackgroundType?: Exclude<BackgroundType, 'auto'>;
  maskQuality?: MaskQualityResult;
}

export interface MaskQualityResult {
  acceptable: boolean;
  score: number;
  foregroundRatio: number;
  significantComponents: number;
  largestComponentShare: number;
  borderTouchRatio: number;
  issues: string[];
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
      'gemini-3.1-flash-image',
    // Re-use the existing persisted bg_removal_provider setting as an isolation
    // strategy selector. Legacy values such as "photoroom" are treated as auto.
    provider:
      getSetting('bg_removal_provider') ||
      process.env.BG_REMOVAL_PROVIDER ||
      'auto',
  };
}

async function preparePhotoRoomInput(inputBuffer: Buffer): Promise<Buffer> {
  return sharp(inputBuffer).rotate().png({ compressionLevel: 6 }).toBuffer();
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
  formData.append('format', 'png');
  formData.append('channels', 'rgba');
  formData.append('size', 'full');

  console.log('[BackgroundRemoval] Sending jewellery photo to PhotoRoom...');

  const response = await fetch('https://sdk.photoroom.com/v1/segment', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.trim() },
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
    throw new Error('Background-removal provider returned invalid image dimensions.');
  }
  if (!metadata.hasAlpha) {
    throw new Error('Background-removal provider did not return a transparent RGBA cutout.');
  }

  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaIndex = info.channels - 1;
  let transparentPixels = 0;
  let visiblePixels = 0;
  const pixelCount = info.width * info.height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 250000));

  for (let p = 0; p < pixelCount; p += sampleStep) {
    const alpha = data[p * info.channels + alphaIndex];
    if (alpha < 245) transparentPixels++;
    if (alpha > 10) visiblePixels++;
  }

  if (transparentPixels === 0) {
    throw new Error('Background-removal result is fully opaque; the background was not removed.');
  }
  if (visiblePixels === 0) {
    throw new Error('Background-removal result contains no visible jewellery subject.');
  }

  return sharp(buffer).rotate().png({ compressionLevel: 6 }).toBuffer();
}

export async function detectBackgroundType(
  inputBuffer: Buffer
): Promise<'plain' | 'styled'> {
  const { data, info } = await sharp(inputBuffer)
    .rotate()
    .resize(192, 192, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const w = info.width;
  const h = info.height;
  const border = Math.max(8, Math.round(Math.min(w, h) * 0.16));

  let n = 0;
  let sumL = 0;
  let sumL2 = 0;
  let sumChroma = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= border && x < w - border && y >= border && y < h - border) continue;
      const i = (y * w + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      sumL += l;
      sumL2 += l * l;
      sumChroma += chroma;
      n++;
    }
  }

  const meanL = sumL / Math.max(1, n);
  const stdL = Math.sqrt(Math.max(0, sumL2 / Math.max(1, n) - meanL * meanL));
  const meanChroma = sumChroma / Math.max(1, n);

  if ((meanL >= 155 && stdL <= 38 && meanChroma <= 28) || (stdL <= 24 && meanChroma <= 20)) {
    return 'plain';
  }
  return 'styled';
}

export async function validateJewelleryMask(
  transparentBuffer: Buffer,
  strictForStyled = false
): Promise<MaskQualityResult> {
  const size = 224;
  const { data, info } = await sharp(transparentBuffer)
    .ensureAlpha()
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaChannel = info.channels - 1;
  const mask = new Uint8Array(size * size);
  let foreground = 0;
  let borderForeground = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      const a = data[p * info.channels + alphaChannel];
      if (a >= 80) {
        mask[p] = 1;
        foreground++;
        if (x < 3 || y < 3 || x >= size - 3 || y >= size - 3) borderForeground++;
      }
    }
  }

  if (foreground === 0) {
    return {
      acceptable: false,
      score: 0,
      foregroundRatio: 0,
      significantComponents: 0,
      largestComponentShare: 0,
      borderTouchRatio: 0,
      issues: ['No visible jewellery foreground was detected.'],
    };
  }

  const visited = new Uint8Array(mask.length);
  const componentAreas: number[] = [];
  const stack: number[] = [];

  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || visited[seed]) continue;
    let area = 0;
    visited[seed] = 1;
    stack.push(seed);

    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const x = p % size;
      const y = Math.floor(p / size);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const np = ny * size + nx;
          if (mask[np] && !visited[np]) {
            visited[np] = 1;
            stack.push(np);
          }
        }
      }
    }
    componentAreas.push(area);
  }

  componentAreas.sort((a, b) => b - a);
  const significantThreshold = Math.max(3, Math.round(foreground * 0.008));
  const significant = componentAreas.filter((a) => a >= significantThreshold);
  const largestShare = (componentAreas[0] || 0) / foreground;
  const foregroundRatio = foreground / (size * size);
  const borderTouchRatio = borderForeground / foreground;
  const issues: string[] = [];

  if (foregroundRatio < 0.0015) issues.push('Foreground is extremely small; jewellery may have been erased.');
  if (foregroundRatio > (strictForStyled ? 0.34 : 0.48)) {
    issues.push('Too much foreground remains; cloth, flowers, stand or other props may still be present.');
  }
  if (borderTouchRatio > (strictForStyled ? 0.08 : 0.18)) {
    issues.push('Foreground touches too much of the frame border; a prop/background region may have survived.');
  }
  if (significant.length > (strictForStyled ? 10 : 16)) {
    issues.push('Too many disconnected foreground regions remain for a clean jewellery set.');
  }
  if (strictForStyled && largestShare > 0.94 && foregroundRatio > 0.18) {
    issues.push('A broad dominant foreground region remains; styled background isolation is uncertain.');
  }

  let score = 100 - issues.length * 24;
  if (strictForStyled && significant.length >= 7) score -= 8;
  score = Math.max(0, Math.min(100, score));

  return {
    acceptable: score >= 60 && issues.length <= 1,
    score,
    foregroundRatio,
    significantComponents: significant.length,
    largestComponentShare: largestShare,
    borderTouchRatio,
    issues,
  };
}

async function callGeminiIsolationEdit(
  inputBuffer: Buffer,
  apiKey: string,
  configuredModel: string
): Promise<{ buffer: Buffer; modelUsed: string }> {
  if (!apiKey.trim()) {
    throw new Error('Gemini fallback is required for this styled background, but GEMINI_API_KEY is not configured.');
  }

  const reference = await sharp(inputBuffer)
    .rotate()
    .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();

  const prompt = [
    'Edit this product photo for strict jewellery e-commerce isolation.',
    'Keep ONLY the exact jewellery set: the complete necklace chain and clasp, pendant, matching earrings, stones, prongs and all metal components.',
    'Remove every non-jewellery element completely, including silk or fabric, flowers, marble, wood, trays, stands, display cards, hands, shadows, decorative props and background texture.',
    'Replace the removed scene with a clean solid pure white background (#FFFFFF).',
    'PRODUCT LOCK: do not redesign, redraw, recolour, beautify, repair, simplify, add or remove any jewellery component. Preserve exact stone colours, metal tone, stone count, chain type, proportions and arrangement.',
    'Do not crop any jewellery component. Keep the complete sellable set visible.',
    'Return a realistic catalogue product photograph, not an illustration.',
  ].join('\n\n');

  const models = Array.from(
    new Set([
      configuredModel.startsWith('imagen-') ? 'gemini-3.1-flash-image' : configuredModel,
      'gemini-3.1-flash-image',
      'gemini-2.5-flash-image',
    ])
  );

  for (const model of models) {
    console.log(`[BackgroundRemoval] Styled mask needs help; trying Gemini isolation (${model})...`);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey.trim(),
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: reference.toString('base64'),
                    },
                  },
                  { text: prompt },
                ],
              },
            ],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
          }),
          signal: AbortSignal.timeout(120000),
        }
      );

      if (!response.ok) {
        const body = await response.text();
        console.warn(`[BackgroundRemoval] Gemini ${model} returned ${response.status}: ${body.slice(0, 500)}`);
        continue;
      }

      const json: any = await response.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p: any) => p?.inlineData?.data);
      if (imagePart?.inlineData?.data) {
        const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
        if (buffer.length > 1000) return { buffer, modelUsed: model };
      }
    } catch (err: any) {
      console.warn(`[BackgroundRemoval] Gemini isolation error (${model}):`, err.message);
    }
  }

  throw new Error('Gemini could not produce a usable jewellery-isolation image.');
}

async function compositeToWhite(
  transparentBuffer: Buffer,
  targetWidth: number,
  targetHeight: number,
  backgroundColor: { r: number; g: number; b: number }
): Promise<Buffer> {
  let trimmedBuffer: Buffer;
  try {
    trimmedBuffer = (
      await sharp(transparentBuffer)
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 2 })
        .png()
        .toBuffer({ resolveWithObject: true })
    ).data;
  } catch {
    trimmedBuffer = transparentBuffer;
  }

  const maxW = Math.max(1, Math.round(targetWidth * 0.88));
  const maxH = Math.max(1, Math.round(targetHeight * 0.88));
  const subject = await sharp(trimmedBuffer)
    .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: false })
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

export async function cleanJewelryBackgroundLocally(
  _inputBuffer: Buffer,
  _options: BackgroundRemovalOptions = {}
): Promise<Buffer> {
  throw new Error(
    'Local heuristic jewellery background removal is disabled. Use the hybrid PhotoRoom/Gemini isolation pipeline.'
  );
}

export async function executeBackgroundRemoval(
  inputBuffer: Buffer,
  options: BackgroundRemovalOptions = {}
): Promise<BackgroundRemovalResult> {
  const config = getBackgroundRemovalConfig();
  const targetWidth = options.targetWidth || 2048;
  const targetHeight = options.targetHeight || 2048;
  const backgroundColor = options.backgroundColor || { r: 255, g: 255, b: 255 };
  const photoRoomKey = options.apiKey?.trim() || config.photoroomApiKey.trim();

  if (options.provider && options.provider !== 'auto' && options.provider !== 'photoroom') {
    console.warn(
      `[BackgroundRemoval] Provider "${options.provider}" requested. The production pipeline still starts with PhotoRoom and only uses Gemini as a validated styled-background fallback.`
    );
  }

  const configuredType: BackgroundType =
    config.provider === 'plain' ||
    config.provider === 'styled' ||
    config.provider === 'model' ||
    config.provider === 'auto'
      ? (config.provider as BackgroundType)
      : 'auto';

  const requestedType: BackgroundType = options.backgroundType || configuredType;
  if (requestedType === 'model') {
    throw new Error(
      'Exact white-background extraction from a model-worn photo is disabled because hidden chain/product geometry cannot be recovered without redesign. Use an unworn product photo for the exact catalogue image.'
    );
  }

  const detectedType: 'plain' | 'styled' =
    requestedType === 'plain' || requestedType === 'styled'
      ? requestedType
      : await detectBackgroundType(inputBuffer);
  const strict = Boolean(options.exactIsolation) || detectedType === 'styled';

  console.log(`[BackgroundRemoval] Isolation mode: ${requestedType} -> ${detectedType}; exactIsolation=${strict}`);

  const firstRaw = await callPhotoRoomApi(inputBuffer, photoRoomKey);
  const firstTransparent = await normalizeTransparentResult(firstRaw);
  const firstQuality = await validateJewelleryMask(firstTransparent, strict);

  let finalTransparent = firstTransparent;
  let providerUsed: BackgroundRemovalResult['providerUsed'] = 'photoroom';
  let finalQuality = firstQuality;
  let notes = `PhotoRoom mask score ${firstQuality.score}/100.`;

  const shouldFallback = !firstQuality.acceptable && strict;
  if (shouldFallback) {
    console.warn(
      '[BackgroundRemoval] PhotoRoom mask failed styled/exact isolation checks:',
      firstQuality.issues.join(' ')
    );

    const edited = await callGeminiIsolationEdit(
      inputBuffer,
      config.geminiApiKey,
      config.geminiImageModel
    );
    const secondRaw = await callPhotoRoomApi(edited.buffer, photoRoomKey);
    const secondTransparent = await normalizeTransparentResult(secondRaw);
    const secondQuality = await validateJewelleryMask(secondTransparent, true);

    if (!secondQuality.acceptable) {
      throw new Error(
        `Background isolation needs review. PhotoRoom issues: ${firstQuality.issues.join(' ') || 'mask uncertain'}. ` +
          `Gemini-assisted retry issues: ${secondQuality.issues.join(' ') || 'mask uncertain'}. ` +
          'Try a tighter crop around the jewellery or use a cleaner source photo.'
      );
    }

    finalTransparent = secondTransparent;
    finalQuality = secondQuality;
    providerUsed = 'photoroom+gemini';
    notes = `Styled/prop background required Gemini semantic isolation (${edited.modelUsed}) followed by PhotoRoom re-segmentation. Mask score ${secondQuality.score}/100.`;
  } else if (!firstQuality.acceptable) {
    throw new Error(
      `PhotoRoom background removal needs review. ${firstQuality.issues.join(' ') || 'Mask quality was below threshold.'}`
    );
  }

  if (options.returnTransparentPng) {
    return {
      buffer: finalTransparent,
      providerUsed,
      success: true,
      notes,
      detectedBackgroundType: detectedType,
      maskQuality: finalQuality,
    };
  }

  const whiteMaster = await compositeToWhite(
    finalTransparent,
    targetWidth,
    targetHeight,
    backgroundColor
  );

  return {
    buffer: whiteMaster,
    providerUsed,
    success: true,
    notes: `${notes} Jewellery composited onto ${targetWidth}x${targetHeight} pure white e-commerce canvas.`,
    detectedBackgroundType: detectedType,
    maskQuality: finalQuality,
  };
}
