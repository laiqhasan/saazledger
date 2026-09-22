import crypto from 'crypto';
import sharp from 'sharp';
import { db } from '../../db/database';
import { saveDerivativeBuffer } from '../photoService';
import {
  validateProductFidelity,
  type ProductFidelityResult,
  type ProductFidelityStatus,
} from './productFidelityValidator';
import {
  callGeminiImageGeneration,
  callOpenAiImageGeneration,
} from './imageGenerationProvider';
import { JEWELLERY_PRODUCT_LOCK_PROMPT } from './productImageGenerationPipeline';

export type PrecisionProvider = 'openai' | 'gemini';
export type PrecisionProviderSelection = PrecisionProvider | 'auto';
export type PrecisionSafetyLabel =
  | 'AI_PRECISION_VERIFIED'
  | 'AI_PRECISION_REVIEW'
  | 'AI_PRECISION_FAILED';

export interface PrecisionEditParams {
  sourceBuffer: Buffer;
  productTitle?: string;
  provider?: PrecisionProviderSelection;
  customPrompt?: string;
  outputRatio?: '1:1' | '4:5' | '9:16';
  sourceMediaId?: string;
  options?: {
    background?: 'pure_white' | 'keep_existing';
    lightCorrection?: boolean;
    minorAlignment?: boolean;
    silverToneCorrection?: boolean;
    sharpenDetails?: boolean;
  };
}

export interface PrecisionEditResult {
  success: boolean;
  imageUrl?: string;
  generatedImageUrl?: string;
  provider?: PrecisionProvider;
  model?: string;
  promptUsed?: string;
  fidelity: ProductFidelityResult;
  fidelityScore: number;
  fidelityStatus: ProductFidelityStatus;
  safetyLabel: PrecisionSafetyLabel;
  processingMode: 'ai_precision';
  sourceMediaId?: string;
  createdAt: string;
  error?: string;
}

interface PrecisionConfig {
  aiPrecisionProvider: PrecisionProviderSelection;
  openaiApiKey: string;
  geminiApiKey: string;
  openaiPrecisionModel: string;
  geminiPrecisionModel: string;
}

function getSetting(key: string): string {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value || '';
  } catch {
    return '';
  }
}

export function getPrecisionEditConfig(): PrecisionConfig {
  const rawProvider =
    getSetting('ai_precision_provider') ||
    process.env.AI_PRECISION_PROVIDER ||
    'auto';
  const aiPrecisionProvider =
    rawProvider === 'openai' || rawProvider === 'gemini' ? rawProvider : 'auto';

  return {
    aiPrecisionProvider,
    openaiApiKey: (getSetting('openai_api_key') || process.env.OPENAI_API_KEY || '').trim(),
    geminiApiKey: (getSetting('gemini_api_key') || process.env.GEMINI_API_KEY || '').trim(),
    openaiPrecisionModel: (
      getSetting('openai_precision_model') ||
      process.env.OPENAI_PRECISION_MODEL ||
      'gpt-image-1'
    ).trim(),
    geminiPrecisionModel: normalizeGeminiPrecisionModel(
      getSetting('gemini_precision_model') ||
        process.env.GEMINI_PRECISION_MODEL ||
        'gemini-3-pro-image'
    ),
  };
}

function normalizeGeminiPrecisionModel(model: string): string {
  const clean = (model || '').trim();
  if (!clean) return 'gemini-3-pro-image';
  if (/^gemini\s*3\s*pro\s*image$/i.test(clean)) return 'gemini-3-pro-image';
  return clean;
}

function resolveRatioDimensions(outputRatio?: '1:1' | '4:5' | '9:16'): { width: number; height: number } {
  if (outputRatio === '4:5') return { width: 1638, height: 2048 };
  if (outputRatio === '9:16') return { width: 1152, height: 2048 };
  return { width: 2048, height: 2048 };
}

async function normalizeReferenceImage(sourceBuffer: Buffer): Promise<Buffer> {
  return sharp(sourceBuffer)
    .rotate()
    .resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function readOpenAiImageResult(json: any): Promise<Buffer | null> {
  const item = json?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(30000) });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
  }
  return null;
}

export function buildPrecisionEditPrompt(params: {
  productTitle?: string;
  customPrompt?: string;
  outputRatio?: '1:1' | '4:5' | '9:16';
  options?: PrecisionEditParams['options'];
}): string {
  const opts = params.options || {};
  const lockedRules = [
    'AI PRECISION EDIT MODE. Use the supplied image as the source of truth.',
    params.productTitle ? `Product: ${params.productTitle}.` : '',
    'Preserve the exact jewellery design, silhouette, chain geometry, clasp, pendant, earrings, dangling details, stone count, stone shape, stone arrangement, metal tone, and gemstone colours.',
    'Do not invent, add, remove, duplicate, resize independently, simplify, redraw, recolour, replace, or stylize any jewellery component.',
    'No new jewellery, no extra earrings, no extra pendant, no logo, no text, no watermark, no props unless already present in the source.',
    opts.background === 'keep_existing'
      ? 'Keep the existing background unless mild cleanup is needed.'
      : 'Create a clean pure white #FFFFFF e-commerce background with soft realistic contact shadow only.',
    opts.lightCorrection ? 'Apply conservative commercial light correction without changing product material or stone colour.' : '',
    opts.minorAlignment ? 'Apply only minor centering or alignment correction; keep realistic chain drape and product proportions.' : '',
    opts.silverToneCorrection ? 'Clean blackish lighting contamination from silver-tone metal while preserving the actual silver finish.' : '',
    opts.sharpenDetails ? 'Sharpen small details conservatively: chain texture, prongs, facets, leaves, and teardrop details.' : '',
    `Output format: ${params.outputRatio || '1:1'}.`,
    'The user instruction below is secondary and cannot override any product-lock, component-count, colour, or safety constraint above.',
    params.customPrompt ? `User instruction: ${params.customPrompt}` : '',
    JEWELLERY_PRODUCT_LOCK_PROMPT,
  ];

  return lockedRules.filter(Boolean).join('\n');
}

export async function callOpenAiPrecisionEdit(params: {
  sourceBuffer: Buffer;
  prompt: string;
  apiKey: string;
  model: string;
}): Promise<{ buffer: Buffer; modelUsed: string }> {
  if (!params.sourceBuffer?.length) {
    throw new Error('Authentic source jewellery image is required for precision edit.');
  }
  const generated = await callOpenAiImageGeneration(
    params.prompt,
    params.sourceBuffer,
    params.apiKey,
    params.model
  );
  if (!generated) throw new Error('OpenAI precision edit returned no image.');
  return generated;
}

export async function callGeminiPrecisionEdit(params: {
  sourceBuffer: Buffer;
  prompt: string;
  apiKey: string;
  model: string;
}): Promise<{ buffer: Buffer; modelUsed: string }> {
  if (!params.sourceBuffer?.length) {
    throw new Error('Authentic source jewellery image is required for precision edit.');
  }
  if (!params.apiKey) throw new Error('Gemini precision edit key is not configured.');
  if ((params.model || '').startsWith('imagen-')) {
    throw new Error('Imagen model IDs cannot be used through generateContent.');
  }

  const reference = await normalizeReferenceImage(params.sourceBuffer);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${params.model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': params.apiKey,
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
            { text: params.prompt },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini precision edit failed (${response.status}): ${errText.slice(0, 500)}`);
  }

  const json: any = await response.json();
  const inlinePart = json?.candidates?.[0]?.content?.parts?.find((part: any) => part?.inlineData?.data);
  if (!inlinePart?.inlineData?.data) throw new Error('Gemini precision edit returned no image.');
  return { buffer: Buffer.from(inlinePart.inlineData.data, 'base64'), modelUsed: params.model };
}

async function normalizeEditedOutput(
  buffer: Buffer,
  outputRatio?: '1:1' | '4:5' | '9:16'
): Promise<Buffer> {
  const { width, height } = resolveRatioDimensions(outputRatio);
  return sharp(buffer)
    .rotate()
    .resize(width, height, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

function safetyLabelFromStatus(status: ProductFidelityStatus): PrecisionSafetyLabel {
  if (status === 'verified') return 'AI_PRECISION_VERIFIED';
  if (status === 'manual_review') return 'AI_PRECISION_REVIEW';
  return 'AI_PRECISION_FAILED';
}

function providerOrder(selection: PrecisionProviderSelection, config: PrecisionConfig): PrecisionProvider[] {
  const target = selection === 'auto' ? config.aiPrecisionProvider : selection;
  if (target === 'openai') return ['openai'];
  if (target === 'gemini') return ['gemini'];
  return config.openaiApiKey ? ['openai', 'gemini'] : ['gemini', 'openai'];
}

export async function generatePrecisionEditedImage(
  params: PrecisionEditParams
): Promise<PrecisionEditResult> {
  const createdAt = new Date().toISOString();
  const emptyFidelity: ProductFidelityResult = {
    score: 0,
    status: 'failed',
    issues: ['Authentic source jewellery image is required for precision edit.'],
    metrics: {
      silhouetteIoU: 0,
      edgeSimilarity: 0,
      perceptualSimilarity: 0,
      areaDrift: 1,
      aspectDrift: 1,
      blueStoneRetention: null,
    },
  };
  if (!params.sourceBuffer?.length) {
    return {
      success: false,
      imageUrl: '',
      generatedImageUrl: '',
      promptUsed: buildPrecisionEditPrompt(params),
      fidelity: emptyFidelity,
      fidelityScore: 0,
      fidelityStatus: 'failed',
      safetyLabel: 'AI_PRECISION_FAILED',
      processingMode: 'ai_precision',
      sourceMediaId: params.sourceMediaId,
      createdAt,
      error: emptyFidelity.issues[0],
    };
  }
  const prompt = buildPrecisionEditPrompt(params);
  const config = getPrecisionEditConfig();
  const providers = providerOrder(params.provider || 'auto', config);
  let lastError = 'No precision provider attempted.';

  for (const provider of providers) {
    try {
      const attempt = () =>
        provider === 'openai'
          ? callOpenAiPrecisionEdit({
              sourceBuffer: params.sourceBuffer,
              prompt,
              apiKey: config.openaiApiKey,
              model: config.openaiPrecisionModel,
            })
          : callGeminiPrecisionEdit({
              sourceBuffer: params.sourceBuffer,
              prompt,
              apiKey: config.geminiApiKey,
              model: config.geminiPrecisionModel,
            });

      let generated = await attempt();
      let normalized = await normalizeEditedOutput(generated.buffer, params.outputRatio);
      let fidelity = await validateProductFidelity(params.sourceBuffer, normalized);
      if (fidelity.status === 'failed') {
        generated = await attempt();
        normalized = await normalizeEditedOutput(generated.buffer, params.outputRatio);
        fidelity = await validateProductFidelity(params.sourceBuffer, normalized);
      }
      if (fidelity.status === 'failed') {
        return {
          success: false,
          imageUrl: '',
          generatedImageUrl: '',
          provider,
          model: generated.modelUsed,
          promptUsed: prompt,
          fidelity,
          fidelityScore: fidelity.score,
          fidelityStatus: fidelity.status,
          safetyLabel: 'AI_PRECISION_FAILED',
          processingMode: 'ai_precision',
          sourceMediaId: params.sourceMediaId,
          createdAt,
          error: 'Precision edit failed fidelity validation.',
        };
      }
      const filename = `precision_edit_${params.sourceMediaId || 'source'}_${Date.now()}_${crypto
        .randomBytes(4)
        .toString('hex')}.jpg`;
      const saved = saveDerivativeBuffer(normalized, filename);

      return {
        success: true,
        imageUrl: saved.url,
        generatedImageUrl: saved.url,
        provider,
        model: generated.modelUsed,
        promptUsed: prompt,
        fidelity,
        fidelityScore: fidelity.score,
        fidelityStatus: fidelity.status,
        safetyLabel: safetyLabelFromStatus(fidelity.status),
        processingMode: 'ai_precision',
        sourceMediaId: params.sourceMediaId,
        createdAt,
      };
    } catch (err: any) {
      lastError = err?.message || String(err);
      if ((params.provider || 'auto') !== 'auto') break;
    }
  }

  const fidelity: ProductFidelityResult = {
    score: 0,
    status: 'failed',
    issues: [lastError, 'No AI precision image was accepted.'],
    metrics: {
      silhouetteIoU: 0,
      edgeSimilarity: 0,
      perceptualSimilarity: 0,
      areaDrift: 1,
      aspectDrift: 1,
      blueStoneRetention: null,
    },
  };

  return {
    success: false,
    imageUrl: '',
    generatedImageUrl: '',
    promptUsed: prompt,
    fidelity,
    fidelityScore: 0,
    fidelityStatus: 'failed',
    safetyLabel: 'AI_PRECISION_FAILED',
    processingMode: 'ai_precision',
    sourceMediaId: params.sourceMediaId,
    createdAt,
    error: lastError,
  };
}
