import type {
  MediaAsset,
  MediaStorageSettings,
  ConnectionTestResult,
  MediaSlotType,
  ProductMeasurements,
  MeasurementExtractionResult,
} from '../types/media';
import { getStoredAiConfig } from './aiVisionService';

const BASE_URL = ''; // Relative path leverages Vite dev proxy & prod origin

/**
 * Safely executes a fetch request and parses JSON response,
 * gracefully handling HTML error pages (502, 504, 413, 404, etc.) without throwing SyntaxError.
 */
async function safeFetchJson<T = any>(
  url: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const res = await fetch(url, init);
    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      try {
        const json = await res.json();
        if (!res.ok) {
          return {
            ok: false,
            status: res.status,
            data: json,
            error: json.error || json.message || `Server error (${res.status} ${res.statusText})`,
          };
        }
        return { ok: true, status: res.status, data: json };
      } catch (jsonErr: any) {
        return {
          ok: false,
          status: res.status,
          error: `Malformed JSON from server (${res.status}): ${jsonErr.message}`,
        };
      }
    }

    // Non-JSON response (e.g. HTML 502/504 Bad Gateway, 413 Payload Too Large, 404, etc.)
    const text = await res.text();
    let errorSummary = `Server returned status ${res.status}`;
    if (res.status === 413) {
      errorSummary = 'Uploaded images exceed server limit. Please upload fewer or smaller photos.';
    } else if (res.status === 502 || res.status === 503) {
      errorSummary = 'Server is currently restarting or busy on Railway. Please try again in a few moments.';
    } else if (res.status === 504) {
      errorSummary = 'Server gateway timed out while processing image generation. Please try again with fewer images.';
    } else if (res.status === 404) {
      errorSummary = `Endpoint not found (${url}). Please ensure backend is up to date.`;
    } else {
      const stripped = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (stripped) {
        errorSummary = `Server error (${res.status}): ${stripped}`;
      }
    }

    return {
      ok: false,
      status: res.status,
      error: errorSummary,
    };
  } catch (err: any) {
    const isTimeout =
      err.name === 'TimeoutError' ||
      err.message?.includes('timeout') ||
      err.message?.includes('aborted');
    return {
      ok: false,
      status: 0,
      error: isTimeout
        ? 'Request timed out. The server was busy or still processing; please try again.'
        : err.message || 'Network error communicating with server',
    };
  }
}

export interface FetchMediaParams {
  search?: string;
  mediaType?: 'image' | 'video' | 'document';
  provider?: string;
  approvalStatus?: string;
  isLinked?: boolean;
  limit?: number;
  offset?: number;
}

export async function fetchMediaAssets(params: FetchMediaParams = {}): Promise<{ assets: MediaAsset[]; totalCount: number }> {
  try {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.mediaType) query.set('mediaType', params.mediaType);
    if (params.provider) query.set('provider', params.provider);
    if (params.approvalStatus) query.set('approvalStatus', params.approvalStatus);
    if (params.isLinked !== undefined) query.set('isLinked', String(params.isLinked));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));

    const res = await fetch(`${BASE_URL}/api/media?${query.toString()}`);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed fetching media assets:', err);
  }
  return { assets: [], totalCount: 0 };
}

export async function uploadMediaDirect(params: {
  base64Data: string;
  filename: string;
  displayTitle?: string;
  productId?: string;
  slotType?: MediaSlotType;
  approvalStatus?: 'pending_review' | 'approved';
}): Promise<{ asset: MediaAsset; isDuplicate: boolean; duplicateAssetId?: string } | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/media/upload-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed uploading media file:', err);
  }
  return null;
}

export async function updateMediaAsset(id: string, updates: { displayTitle?: string; approvalStatus?: string }): Promise<MediaAsset | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/media/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      const data = await res.json();
      return data.asset;
    }
  } catch (err) {
    console.warn('Failed updating media asset:', err);
  }
  return null;
}

export async function deleteMediaAsset(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/media/${id}`, { method: 'DELETE' });
    return res.ok;
  } catch (err) {
    console.warn('Failed deleting media asset:', err);
    return false;
  }
}

export async function linkMediaToProduct(params: {
  productId: string;
  mediaId: string;
  slotType: MediaSlotType;
  displayOrder?: number;
  altText?: string;
}): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/products/${params.productId}/media/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed linking media to product:', err);
    return false;
  }
}

export async function unlinkMediaFromProduct(productId: string, mediaId: string, slotType?: string): Promise<boolean> {
  try {
    const url = slotType
      ? `${BASE_URL}/api/products/${productId}/media/${mediaId}?slotType=${encodeURIComponent(slotType)}`
      : `${BASE_URL}/api/products/${productId}/media/${mediaId}`;
    const res = await fetch(url, { method: 'DELETE' });
    return res.ok;
  } catch (err) {
    console.warn('Failed unlinking media:', err);
    return false;
  }
}

export async function fetchMediaStorageSettings(): Promise<MediaStorageSettings | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/media-settings`);
    if (res.ok) {
      const data = await res.json();
      return data.settings;
    }
  } catch (err) {
    console.warn('Failed fetching media storage settings:', err);
  }
  return null;
}

export async function saveMediaStorageSettings(settings: Partial<MediaStorageSettings>): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/media-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed saving media storage settings:', err);
    return false;
  }
}

export async function testS3Connection(): Promise<ConnectionTestResult> {
  try {
    const res = await fetch(`${BASE_URL}/api/media-settings/test-s3`, { method: 'POST' });
    if (res.ok) {
      return await res.json();
    }
  } catch (err: any) {
    return {
      success: false,
      provider: 's3',
      message: err.message,
      testedAt: new Date().toISOString(),
    };
  }
  return {
    success: false,
    provider: 's3',
    message: 'Server error during S3 probe',
    testedAt: new Date().toISOString(),
  };
}

export async function testGoogleDriveConnection(): Promise<ConnectionTestResult> {
  try {
    const res = await fetch(`${BASE_URL}/api/media-settings/test-drive`, { method: 'POST' });
    if (res.ok) {
      return await res.json();
    }
  } catch (err: any) {
    return {
      success: false,
      provider: 'google_drive',
      message: err.message,
      testedAt: new Date().toISOString(),
    };
  }
  return {
    success: false,
    provider: 'google_drive',
    message: 'Server error during Google Drive probe',
    testedAt: new Date().toISOString(),
  };
}

export async function syncAllPhotosToS3(): Promise<{ success: boolean; message: string; count?: number }> {
  try {
    const res = await fetch(`${BASE_URL}/api/media-settings/sync-all-to-s3`, { method: 'POST' });
    const data = await res.json();
    return { success: res.ok && data.success, message: data.message || data.error || 'Sync failed', count: data.count };
  } catch (err: any) {
    return { success: false, message: err.message || 'Network error syncing photos to S3.' };
  }
}

export async function backupDatabaseToS3(): Promise<{ success: boolean; message: string; url?: string }> {
  try {
    const res = await fetch(`${BASE_URL}/api/media-settings/backup-db-to-s3`, { method: 'POST' });
    const data = await res.json();
    return { success: res.ok && data.success, message: data.message || data.error || 'Backup failed', url: data.url };
  } catch (err: any) {
    return { success: false, message: err.message || 'Network error creating S3 backup.' };
  }
}

export async function fetchMediaPresets(): Promise<import('../types/media').StylingPreset[]> {
  try {
    const res = await fetch(`${BASE_URL}/api/media/presets`);
    if (res.ok) {
      const data = await res.json();
      return data.presets || [];
    }
  } catch (err) {
    console.warn('Failed fetching media presets:', err);
  }
  return [];
}

export async function generateMediaPack(params: {
  productId?: string;
  sku?: string;
  sourceMediaIds?: string[];
  newFiles?: { base64Data: string; filename: string; id?: string }[];
  stylingPreset?: string;
  slot2StyleOption?: string;
  enableStyledSlot2?: boolean;
  enableModelGeneration?: boolean;
  enableModelSlot4?: boolean;
  enableLifestyleSlot5?: boolean;
  customPrompt?: string;
  customPromptSlot2?: string;
  customPromptSlot4?: string;
  customPromptSlot5?: string;
  approvalMode?: 'REVIEW_FIRST' | 'FULL_AUTO';
  autoPushShopify?: boolean;
  aiReferenceFileId?: string;
  aiProvider?: 'gemini' | 'openai';
  sourceModes?: Partial<Record<'white' | 'model' | 'detail' | 'silk' | 'original', 'auto' | 'manual' | 'skip'>>;
  selectedOutputTypes?: Array<'white' | 'model' | 'detail' | 'silk' | 'original'>;
  whiteProductOutputRatio?: '1:1' | '4:5' | '9:16';
  whiteProductMode?: 'exact_cutout' | 'ai_presentation';
  whiteProductAiProvider?: 'auto' | 'gemini' | 'openai';
}): Promise<{
  success: boolean;
  jobId?: string;
  galleryPack?: import('../types/media').GalleryPack;
  warnings?: string[];
  message?: string;
}> {
  const aiConfig = getStoredAiConfig();
  const payload = {
    ...params,
    aiProvider: params.aiProvider || aiConfig.provider || 'gemini',
    geminiApiKey: aiConfig.geminiApiKey || undefined,
    openaiApiKey: aiConfig.openaiApiKey || undefined,
  };

  const res = await safeFetchJson(`${BASE_URL}/api/media/pack/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok || !res.data) {
    return {
      success: false,
      message: res.error || (res.data as any)?.error || 'Failed generating media pack',
    };
  }
  return res.data;
}

export async function regeneratePackSlot(params: {
  jobId?: string;
  galleryPack?: import('../types/media').GalleryPack;
  slotNumber: number;
  stylingPreset?: string;
  slot2StyleOption?: string;
  newSlot2StyleOption?: string;
  customPrompt?: string;
  sourceSlotNumber?: number;
  sourceMediaId?: string;
  sourceImageUrl?: string;
  sourceBase64?: string;
  targetRole?: 'AI_MODEL' | 'STYLED_SUPPORTING' | 'HERO_COVER' | 'white';
  aiProvider?: 'gemini' | 'openai';
  whiteProductOutputRatio?: '1:1' | '4:5' | '9:16';
  whiteProductMode?: 'exact_cutout' | 'ai_presentation';
  whiteProductAiProvider?: 'auto' | 'gemini' | 'openai';
}): Promise<{
  success: boolean;
  slot?: import('../types/media').GallerySlot;
  message?: string;
}> {
  const aiConfig = getStoredAiConfig();
  const payload = {
    ...params,
    aiProvider: params.aiProvider || aiConfig.provider || 'gemini',
    geminiApiKey: aiConfig.geminiApiKey || undefined,
    openaiApiKey: aiConfig.openaiApiKey || undefined,
  };

  const res = await safeFetchJson(`${BASE_URL}/api/media/pack/regenerate-slot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok || !res.data) {
    return {
      success: false,
      message: res.error || (res.data as any)?.error || 'Failed regenerating slot',
    };
  }
  return res.data;
}

export async function publishPackToShopify(params: {
  productId: string;
  shopifyProductId?: string;
  gallerySlots: import('../types/media').GallerySlot[];
  shopifyConfig?: any;
  productData?: any;
}): Promise<{
  success: boolean;
  uploadedCount?: number;
  results?: any[];
  error?: string;
  errors?: string[];
  shopifyProductId?: string;
  targetShopifyId?: string;
}> {
  const res = await safeFetchJson(`${BASE_URL}/api/media/pack/publish-shopify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok || !res.data) {
    return {
      success: false,
      error: res.error || (res.data as any)?.error || 'Failed publishing to Shopify',
    };
  }
  const data = res.data;
  if (!data.success && !data.error && Array.isArray(data.errors) && data.errors.length > 0) {
    data.error = data.errors.join('; ');
  }
  return data;
}

export async function fetchMediaJobStatus(jobId: string): Promise<import('../types/media').MediaPackJobStatus | null> {
  const res = await safeFetchJson(`${BASE_URL}/api/media/jobs/${jobId}`);
  if (res.ok && res.data) {
    return res.data.job;
  }
  return null;
}

export interface AiAccuracyAnalysis {
  accuracyScore: number;
  isDesignLocked: boolean;
  breakdown: {
    structureFidelity: number;
    stoneSettingFidelity: number;
    metalToneFidelity: number;
    proportionsFidelity: number;
  };
  verdict: 'EXCELLENT_MATCH' | 'GOOD_MATCH' | 'NEEDS_REFINEMENT';
  summary: string;
  matchHighlights: string[];
  observations?: string;
  analyzedAt: string;
}

export interface AnalyzeAccuracyParams {
  originalImageUrl?: string;
  generatedImageUrl?: string;
  originalBase64?: string;
  generatedBase64?: string;
  productTitle?: string;
}

export async function analyzeMediaAccuracy(
  params: AnalyzeAccuracyParams
): Promise<{ success: boolean; analysis?: AiAccuracyAnalysis; error?: string }> {
  const aiCfg = getStoredAiConfig();
  const res = await safeFetchJson<{ success: boolean; analysis: AiAccuracyAnalysis }>(
    `${BASE_URL}/api/media/accuracy/analyze`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        geminiApiKey: aiCfg.apiKey,
        openaiApiKey: aiCfg.openaiApiKey,
      }),
      signal: AbortSignal.timeout(35000),
    }
  );

  if (!res.ok || !res.data) {
    return {
      success: false,
      error: res.error || (res.data as any)?.error || 'Accuracy analysis failed',
    };
  }
  return {
    success: true,
    analysis: res.data.analysis,
  };
}

export interface CropParams {
  imageBase64?: string;
  url?: string;
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    zoom?: number;
    aspectRatio?: '1:1' | '4:5' | '9:16' | 'free';
  };
  targetOutputDim?: number;
}

export async function applyMediaCrop(params: CropParams): Promise<{
  success: boolean;
  url?: string;
  outputFilename?: string;
  base64?: string;
  error?: string;
}> {
  const res = await safeFetchJson(`${BASE_URL}/api/media/crop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || 'Crop failed' };
  }
  return res.data;
}

export interface WhiteCoverParams {
  imageBase64?: string;
  url?: string;
  backgroundMode?: 'pure_white' | 'original' | 'transparent';
  occupancyPercent?: number;
  customCrop?: any;
  outputRatio?: '1:1' | '4:5' | '9:16';
  mode?: 'exact_cutout' | 'ai_presentation';
  whiteProductMode?: 'exact_cutout' | 'ai_presentation';
  aiProvider?: 'auto' | 'gemini' | 'openai';
  productTitle?: string;
  customInstruction?: string;
}

export async function generatePureWhiteCover(params: WhiteCoverParams): Promise<{
  success: boolean;
  url?: string;
  exactCutoutUrl?: string;
  mode?: 'exact_cutout' | 'ai_presentation';
  productMatchScore?: number;
  matchVerdict?: 'HIGH_MATCH' | 'REVIEW_RECOMMENDED' | 'NEEDS_REVIEW';
  accuracyAnalysis?: any;
  quality?: any;
  backgroundMode?: string;
  base64?: string;
  isolatedMasterUrl?: string;
  sourceHash?: string;
  cacheHit?: boolean;
  outputRatio?: '1:1' | '4:5' | '9:16';
  width?: number;
  height?: number;
  error?: string;
}> {
  const res = await safeFetchJson(`${BASE_URL}/api/media/white-cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || 'White cover generation failed' };
  }
  return res.data;
}

export async function requestJewelryAutoCrop(params: { imageBase64?: string; url?: string; category?: string }): Promise<{
  success: boolean;
  crop?: any;
  error?: string;
}> {
  const res = await safeFetchJson(`${BASE_URL}/api/media/auto-crop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || 'Auto crop failed' };
  }
  return res.data;
}

export async function requestDetailCrop(params: {
  imageBase64?: string;
  url?: string;
  targetRegion?: 'pendant' | 'earrings' | 'stones' | 'custom';
  customCrop?: any;
}): Promise<{ success: boolean; url?: string; base64?: string; error?: string }> {
  const res = await safeFetchJson(`${BASE_URL}/api/media/detail-crop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || 'Detail crop failed' };
  }
  return res.data;
}

export async function extractMeasurements(params: {
  imageBase64?: string;
  imageUrl?: string;
  productId?: string;
  mediaId?: string;
  originalSourceMediaId?: string;
  originalMediaId?: string;
  geminiApiKey?: string;
  mockCalibrationForTests?: any;
}): Promise<MeasurementExtractionResult> {
  const config = getStoredAiConfig();
  const apiKey = params.geminiApiKey || config.geminiApiKey;
  const res = await safeFetchJson<MeasurementExtractionResult>(`${BASE_URL}/api/media/extract-measurements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, geminiApiKey: apiKey }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok || !res.data) {
    return { success: false, hasRuler: false, error: res.error || 'Failed to extract measurements' };
  }
  return res.data;
}

export async function fetchProductMeasurements(productId: string): Promise<{
  success: boolean;
  measurements?: ProductMeasurements | null;
  error?: string;
}> {
  const res = await safeFetchJson(`${BASE_URL}/api/media/measurements/${encodeURIComponent(productId)}`);
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || 'Failed to fetch measurements' };
  }
  return res.data;
}

export async function applyProductMeasurements(
  productId: string,
  measurements: ProductMeasurements
): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await safeFetchJson(`${BASE_URL}/api/media/measurements/${encodeURIComponent(productId)}/apply-to-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ measurements }),
  });
  if (!res.ok || !res.data) {
    return { success: false, error: res.error || 'Failed to apply measurements' };
  }
  return res.data;
}
