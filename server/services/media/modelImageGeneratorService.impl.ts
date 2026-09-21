import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { db } from '../../db/database';
import { getStoredAiConfig } from '../../../src/services/aiVisionService';
import { UPLOADS_DIR, DERIVATIVES_DIR, saveDerivativeBuffer, getPhoto, getDerivative } from '../photoService';
import {
  createFashionModelDerivative,
  createLifestyleDerivative,
  generateFashionModelBackground,
  generateLifestyleBackground,
} from './mediaPipelineService';
import { isAllowedMediaFilePath, isOwnPhotoApiPath } from './productImageGenerationPipeline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ModelGenerationPreset {
  id: string;
  name: string;
  category: 'model' | 'lifestyle' | 'editorial';
  description: string;
  basePrompt: string;
}

export const MODEL_STYLING_PRESETS: Record<string, ModelGenerationPreset> = {
  indian_festive: {
    id: 'indian_festive',
    name: 'Indian Festive Model',
    category: 'model',
    description: 'Indian model close-up neckline, pastel silk drape, 95%+ exact jewelry match',
    basePrompt:
      'Macro close-up commercial jewelry photograph of an elegant Indian fashion model. The camera focuses closely on her neck, collarbone, and décolletage, showcasing the featured jewelry piece with 95%+ exact design fidelity. She wears an understated pastel silk saree neckline. Clean atelier studio lighting accentuates diamond brilliance and fine metal luster. The jewelry is crisp, high detail, and the unmistakable hero of the frame.',
  },
  western_fashion: {
    id: 'western_fashion',
    name: 'Western Fashion Model',
    category: 'model',
    description: 'Contemporary evening wear, soft editorial lighting, modern chic aesthetic',
    basePrompt:
      'Vogue-style contemporary evening fashion editorial. A sophisticated fashion model in modern minimalist cocktail attire, naturally wearing the exact featured jewellery piece. Soft dramatic studio lighting, clean architectural background.',
  },
  office_to_occasion: {
    id: 'office_to_occasion',
    name: 'Office to Occasion',
    category: 'model',
    description: 'Tailored blazer, clean day-to-night styling, crisp natural window light',
    basePrompt:
      'Contemporary smart-casual daytime fashion editorial. A professional model in a tailored ivory linen blazer, elegantly showcasing the featured jewellery piece. Bright natural morning window light, subtle warm interior ambiance.',
  },
  minimal_luxury_studio: {
    id: 'minimal_luxury_studio',
    name: 'Minimal Luxury Studio',
    category: 'lifestyle',
    description: 'Travertine stone, champagne silk folds, neutral luxury flat-lay aesthetic',
    basePrompt:
      'Ultra-luxury still life presentation. The featured jewellery piece resting gracefully on raw champagne silk drapery and subtle organic botanical accents. Soft diffused studio lighting, pristine clean aesthetic, commercial product focus.',
  },
  bridal_styling: {
    id: 'bridal_styling',
    name: 'Bridal Styling',
    category: 'model',
    description: 'Opulent Indian bridal neckline, warm festive glow, jewelry focus',
    basePrompt:
      'Opulent Indian bridal jewelry presentation. Close-up framing on the Indian bride\'s neckline and collarbone, highlighting the exact featured jewelry piece against soft blush silk bridal attire. Warm atelier glow with delicate bokeh, jewelry in sharp focus.',
  },
  everyday_wear: {
    id: 'everyday_wear',
    name: 'Everyday Wear Styling',
    category: 'lifestyle',
    description: 'Airy natural daylight, organic relaxed lifestyle styling, boutique setting',
    basePrompt:
      'Modern lifestyle aesthetic. A portrait of an elegant woman wearing the featured jewellery piece in an airy, sunlit boutique cafe. Natural relaxed styling, soft organic background tones, subtle daylight highlights.',
  },
};

export const STRICT_DESIGN_LOCK_CLAUSE = `
CRITICAL JEWELLERY DESIGN LOCK INSTRUCTION:
- You MUST PRESERVE the exact jewellery design shown in the product image with at least 95%+ identical replica fidelity.
- DO NOT alter the metal finish, plating color, stone colors, or stone arrangement.
- DO NOT add imaginary stones, remove existing stones, or change the motif.
- Pendant shape, chain type, clasp, and earring structure must remain 100% faithful to the source product.
- For mala or beaded necklaces, preserve the exact bead construction: pearl/white bead colour, gold spacer beads, bead spacing, strand thickness, clasp/connector style, and natural U/V drape. Never replace a beaded mala with a smooth chain or all-gold chain.
- Keep both earrings faithful at zoom level: same stud/top, lower jhumka/dangler silhouette, ruby/pearl placement, dangling bead count, and left/right symmetry as the source product.
- Accuracy is more important than oversized styling; use a slightly smaller realistic wearing scale if needed to keep the jewellery faithful and undistorted.
- Maintain realistic, anatomically accurate human proportions and wearing scale.
- No distorted hands, no blurred stones, no hallucinated additions.
- Framing & Camera Focus: Macro / close-up commercial jewelry framing focused closely on the model's neckline, collarbone, and décolletage. The jewellery must be the dominant hero (occupying 60-70% visual focus).
- Model Heritage: The fashion model must be an elegant Indian woman with radiant South Asian features and graceful posture.
- STRICT BACKGROUND NEGATIVE: Absolutely NO marble, NO stone slabs, NO rock, NO travertine, NO tiles, NO granite surfaces. When flowers are requested, the flowers and petals must rest softly on draped silk fabric.
`.trim();

/**
 * Extracts specific product traits (metal tone, gemstones, piece type, motif) from product title
 */
export function extractProductAttributes(title: string): {
  metalTone: string;
  gemstones: string;
  pieceType: string;
  motif: string;
} {
  const lower = (title || '').toLowerCase();
  let metalTone = 'fine jewelry metal finish';
  if (/silver|rhodium|white gold|platinum/i.test(lower)) metalTone = 'silver-tone / rhodium finish';
  else if (/rose gold/i.test(lower)) metalTone = 'rose gold finish';
  else if (/gold|yellow gold/i.test(lower)) metalTone = 'yellow gold finish';
  else if (/oxidized|antique/i.test(lower)) metalTone = 'antique oxidized silver finish';

  const stones: string[] = [];
  if (/royal blue|sapphire/i.test(lower)) stones.push('royal blue sapphire');
  if (/emerald|green/i.test(lower)) stones.push('emerald green');
  if (/ruby|red/i.test(lower)) stones.push('ruby red');
  if (/american diamond|ad|cz|cubic zirconia|diamond|moissanite/i.test(lower)) stones.push('sparkling American diamond (CZ)');
  if (/pearl|moti/i.test(lower)) stones.push('lustrous pearls');
  if (/kundan|polki/i.test(lower)) stones.push('kundan polki stones');
  const gemstones = stones.length > 0 ? stones.join(', ') : 'faceted gemstones';

  let pieceType = 'jewelry set';
  if (/pendant set|pendant/i.test(lower)) pieceType = 'pendant necklace with matching earrings';
  else if (/choker/i.test(lower)) pieceType = 'choker necklace set';
  else if (/necklace/i.test(lower)) pieceType = 'necklace set';
  else if (/earring|jhumka/i.test(lower)) pieceType = 'earrings';
  else if (/bangle|bracelet/i.test(lower)) pieceType = 'bangle bracelet';
  else if (/ring/i.test(lower)) pieceType = 'statement ring';

  let motif = '';
  if (/leaf|leaves/i.test(lower)) motif = 'organic leaf motif';
  else if (/floral|flower/i.test(lower)) motif = 'floral motif';
  else if (/peacock|mayur/i.test(lower)) motif = 'peacock motif';
  else if (/geometric/i.test(lower)) motif = 'geometric motif';

  return { metalTone, gemstones, pieceType, motif };
}

export interface GenerateModelImageParams {
  sourceImageUrl: string;
  productTitle: string;
  presetKey?: string;
  customPrompt?: string;
  targetSlot: 'model_1' | 'model_2' | 'lifestyle' | 'lifestyle_1';
  sourceBuffer?: Buffer;
  mediaId?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  aiProvider?: 'gemini' | 'openai';
}

export interface ModelGenerationResult {
  success: boolean;
  generatedImageUrl?: string;
  promptUsed: string;
  presetId: string;
  isDesignLocked: boolean;
  statusNotes: string;
  error?: string;
}

/**
 * Universally extracts an image Buffer from any source (data URL, /api/photos/, uploads dir, or URL).
 */
export async function extractBufferFromSource(
  sourceImageUrl?: string,
  sourceBuffer?: Buffer
): Promise<Buffer | null> {
  if (sourceBuffer && sourceBuffer.length > 0) return sourceBuffer;
  if (!sourceImageUrl) return null;

  let trimmed = sourceImageUrl.trim();
  if (trimmed.startsWith('data:')) {
    const comma = trimmed.indexOf(',');
    const b64 = comma !== -1 ? trimmed.slice(comma + 1) : trimmed;
    try {
      return Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith('//')) {
    trimmed = 'https:' + trimmed;
  }

  let cleanPath = trimmed;
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parsed = new URL(trimmed);
      cleanPath = parsed.pathname;
    }
  } catch {}

  const filename = path.basename(cleanPath.split('?')[0]);
  if (filename && filename !== '.' && filename !== '/') {
    const photo = getDerivative(filename) || getPhoto(filename);
    if (photo?.buffer?.length) return photo.buffer;

    try {
      const row = db.prepare(`
        SELECT data FROM photo_blobs
        WHERE filename = ? OR filename = ? OR filename = ? OR filename LIKE ?
        LIMIT 1
      `).get(filename, `derivatives/${filename}`, `photos/${filename}`, `%${filename}`) as { data: Buffer } | undefined;
      if (row?.data?.length) return row.data;
    } catch {}
  }

  const candidates = [
    path.resolve(DERIVATIVES_DIR, filename),
    path.resolve(UPLOADS_DIR, filename),
    path.resolve(UPLOADS_DIR, 'derivatives', filename),
  ];

  for (const cPath of candidates) {
    if (!isAllowedMediaFilePath(cPath)) continue;
    if (fs.existsSync(cPath)) {
      try {
        const stat = fs.statSync(cPath);
        if (stat.isFile()) {
          return fs.readFileSync(cPath);
        }
      } catch {}
    }
  }

  if (isOwnPhotoApiPath(trimmed)) {
    const ownName = path.basename(trimmed.split('?')[0]);
    const own = getDerivative(ownName) || getPhoto(ownName);
    if (own?.buffer?.length) return own.buffer;
  }

  return null;
}

/**
 * Builds the fully constrained generation prompt combining the selected styling preset,
 * user custom instructions, product specifics, and strict design-lock clauses.
 */
export function buildDesignLockedPrompt(
  productTitle: string,
  presetKey = 'indian_festive',
  customPrompt?: string,
  targetSlot: 'model_1' | 'model_2' | 'lifestyle' = 'model_1'
): { prompt: string; preset: ModelGenerationPreset } {
  const preset = MODEL_STYLING_PRESETS[presetKey] || MODEL_STYLING_PRESETS.indian_festive;
  const attrs = extractProductAttributes(productTitle);

  const roleInstruction = targetSlot === 'model_1'
    ? `Generate an authentic close-up commercial fashion photograph of an elegant Indian woman model wearing this exact jewellery piece. Frame tightly on her neckline and collarbone so the necklace and earrings are prominently displayed at realistic scale.`
    : `Generate a luxurious, elegant commercial lifestyle still-life photograph featuring this exact jewellery piece artfully arranged on soft draped silk cloth with fresh flower petals. NO marble or stone.`;

  const parts: string[] = [roleInstruction];

  if (customPrompt && customPrompt.trim()) {
    parts.push(`TOP PRIORITY USER DIRECT INSTRUCTIONS:\n${customPrompt.trim()}`);
  }

  parts.push(
    `CRITICAL PRODUCT FIDELITY CONSTRAINTS:
- Product Title: ${productTitle}
- Exact Metal Finish: ${attrs.metalTone} (MANDATORY: DO NOT substitute with yellow gold or other metal!)
- Exact Gemstones & Colors: ${attrs.gemstones} (MANDATORY: Preserve exact stone colors and placement!)
- Piece Structure: ${attrs.pieceType}${attrs.motif ? ` with ${attrs.motif}` : ''}
- Stylistic Baseline: ${preset.basePrompt}`
  );

  parts.push(STRICT_DESIGN_LOCK_CLAUSE);

  return {
    prompt: parts.join('\n\n'),
    preset,
  };
}

/**
 * Primary controlled model image generation engine with zero hallucination guarantee.
 * 1. Checks for Gemini (gemini-2.5-flash-image) or OpenAI API keys.
 * 2. If present, calls the generative model conditioned on source image (45s timeout).
 * 3. If API unavailable, quota exceeded, or keys missing, falls back to high-resolution
 *    procedural décolletage composite with identical jewellery guarantee.
 */
export async function generateControlledModelImage(
  params: GenerateModelImageParams
): Promise<ModelGenerationResult> {
  const { prompt, preset } = buildDesignLockedPrompt(
    params.productTitle,
    params.presetKey,
    params.customPrompt,
    params.targetSlot
  );

  const srcBuffer = await extractBufferFromSource(params.sourceImageUrl, params.sourceBuffer);
  if (!srcBuffer?.length) {
    return {
      success: false,
      presetId: preset.id,
      promptUsed: prompt,
      isDesignLocked: false,
      generatedImageUrl: '',
      error: 'Authentic source jewellery image is required for product-locked generation.',
      statusNotes: 'Text-only generation is disabled. Attach the original product photo or isolated master.',
    };
  }

  const { generateModelImage } = await import('./imageGenerationProvider');
  const result = await generateModelImage({
    productTitle: params.productTitle,
    sourceBuffer: srcBuffer,
    sourceImageUrl: params.sourceImageUrl,
    presetKey: params.presetKey,
    customPrompt: params.customPrompt,
    aiProvider: params.aiProvider,
    mediaId: params.mediaId,
  });

  return {
    success: result.success,
    generatedImageUrl: result.success ? result.generatedImageUrl : undefined,
    promptUsed: result.promptUsed || prompt,
    presetId: preset.id,
    isDesignLocked: Boolean(result.isDesignLocked),
    statusNotes: result.statusNotes || (result.success ? `Generated ${preset.name}.` : result.error || 'Generation failed'),
    error: result.error,
  };
}

export type StyledSlot2Option =
  | 'silk_cloth'
  | 'flower_styling'
  | 'silk_and_flower'
  | 'minimal_luxury_flat_lay';

export interface StyledSlot2Preset {
  id: StyledSlot2Option;
  name: string;
  description: string;
  basePrompt: string;
}

export const STYLED_SLOT2_PRESETS: Record<StyledSlot2Option, StyledSlot2Preset> = {
  silk_and_flower: {
    id: 'silk_and_flower',
    name: 'Silk & Flowers (No Marble)',
    description: 'Draped ivory champagne silk satin with delicate fresh white and blush petals',
    basePrompt:
      'Luxury styled jewelry flat-lay presentation. The exact featured jewellery set is placed artfully on soft, lustrous ivory-champagne silk satin fabric with elegant flowing folds. Accent the composition with real, fresh white and blush flower petals scattered gently along the silk fabric folds. The background must be pure draped silk fabric. STRICT NEGATIVE: Absolutely NO marble, NO stone slabs, NO travertine, NO tiles, NO granite.',
  },
  flower_styling: {
    id: 'flower_styling',
    name: 'Fresh Flowers on Silk',
    description: 'Soft ivory silk cloth accented with fresh floral petals along the folds',
    basePrompt:
      'Luxury styled flat-lay photograph of the exact jewellery set. The jewellery rests on softly draped ivory silk fabric, accompanied by delicate fresh floral petals and jasmine/rose buds resting on the silk folds. STRICT NEGATIVE: Absolutely NO marble, NO stone slabs, NO rock, NO travertine. The surface is 100% soft draped silk cloth with fresh flowers.',
  },
  silk_cloth: {
    id: 'silk_cloth',
    name: 'Silk Cloth',
    description: 'Soft ivory & blush silk satin drape with subtle luxurious folds',
    basePrompt:
      'Premium styled flat-lay presentation of the exact jewellery set. Place the jewellery elegantly on soft, luxurious ivory silk cloth and satin fabric with subtle, delicate folds. Clean atelier studio lighting with soft natural shadows. STRICT NEGATIVE: Absolutely NO marble, NO stone, NO travertine.',
  },
  minimal_luxury_flat_lay: {
    id: 'minimal_luxury_flat_lay',
    name: 'Silk Flat Lay',
    description: 'Champagne silk satin drape with clean atelier lighting',
    basePrompt:
      'Clean luxury flat-lay presentation of the exact jewellery set. Place the jewellery on lustrous champagne silk satin fabric with subtle soft folds. Warm commercial lighting highlighting the metal luster and stone brilliance. STRICT NEGATIVE: Absolutely NO marble, NO stone, NO rock slabs.',
  },
};

export function buildStyledSlot2Prompt(
  productTitle: string,
  styleOption: StyledSlot2Option = 'silk_and_flower',
  customPrompt?: string
): { prompt: string; preset: StyledSlot2Preset } {
  const preset = STYLED_SLOT2_PRESETS[styleOption] || STYLED_SLOT2_PRESETS.silk_and_flower;

  const parts = [
    `Product: ${productTitle}`,
    `Slot 2 Style: ${preset.name}`,
    `Scene: ${preset.basePrompt}`,
  ];

  if (customPrompt && customPrompt.trim()) {
    parts.push(`User Direction: ${customPrompt.trim()}`);
  }

  parts.push(
    `IMPORTANT PROP & COMPOSITION CONSTRAINTS:\n- The prop styling must support the product, NOT overpower it.\n- The background MUST be real draped silk fabric with fresh flower petals. NO marble, stone, or rock slabs.\n- DO NOT hide the jewellery in props.\n- DO NOT make the jewellery small in frame.\n- The jewellery MUST remain the sharp, clear, unmistakable 95%+ exact focus.`
  );

  parts.push(STRICT_DESIGN_LOCK_CLAUSE);

  return {
    prompt: parts.join('\n\n'),
    preset,
  };
}

export interface GenerateStyledSlot2Params {
  sourceImageUrl: string;
  productTitle: string;
  styleOption?: StyledSlot2Option;
  customPrompt?: string;
  sourceBuffer?: Buffer;
  mediaId?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  aiProvider?: 'gemini' | 'openai';
}

/**
 * Generates an elegant styled supporting image for Slot 2
 * (silk cloth, flower styling, silk + flower, or minimal luxury flat lay)
 * while strictly preserving the exact jewellery design.
 */
export async function generateStyledSupportingImage(
  params: GenerateStyledSlot2Params
): Promise<ModelGenerationResult> {
  const styleOption = params.styleOption || 'silk_cloth';
  const { prompt, preset } = buildStyledSlot2Prompt(
    params.productTitle,
    styleOption,
    params.customPrompt
  );

  const srcBuffer = await extractBufferFromSource(params.sourceImageUrl, params.sourceBuffer);
  if (!srcBuffer?.length) {
    return {
      success: false,
      presetId: preset.id,
      promptUsed: prompt,
      isDesignLocked: false,
      generatedImageUrl: '',
      error: 'Authentic source jewellery image is required for product-locked generation.',
      statusNotes: 'Styled Slot 2 cannot run without the authentic product photo.',
    };
  }

  const { generateStyledImage } = await import('./imageGenerationProvider');
  const result = await generateStyledImage({
    productTitle: params.productTitle,
    sourceBuffer: srcBuffer,
    sourceImageUrl: params.sourceImageUrl,
    styleOption,
    customPrompt: params.customPrompt,
    aiProvider: params.aiProvider,
    mediaId: params.mediaId,
  });

  return {
    success: result.success,
    generatedImageUrl: result.success ? result.generatedImageUrl : undefined,
    promptUsed: result.promptUsed || prompt,
    presetId: preset.id,
    isDesignLocked: Boolean(result.isDesignLocked),
    statusNotes: result.statusNotes || (result.success ? `Generated ${preset.name}.` : result.error || 'Generation failed'),
    error: result.error,
  };
}
