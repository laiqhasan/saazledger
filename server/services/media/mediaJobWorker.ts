import crypto from 'crypto';
import { db } from '../../db/database';
import { analyzeBatchMedia } from './mediaAnalyzerService';
import { processListingMediaDerivatives } from './mediaPipelineService';
import { buildRecommendedGalleryPack, regenerateSingleSlot } from './galleryPackService';
import { syncGalleryPackToShopify } from './shopifyMediaSyncService';

export interface MediaJobRecord {
  id: string;
  job_type: string;
  media_id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  retry_count: number;
  max_retries: number;
  payload?: string | null;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
}

/**
 * Enqueues an asynchronous media processing job
 */
export function enqueueMediaJob(params: {
  jobType: 'process_media_pack' | 'shopify_publish' | 'regenerate_slot';
  mediaId: string;
  payload?: any;
}): string {
  const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  db.prepare(`
    INSERT INTO media_processing_jobs (
      id, job_type, media_id, status, retry_count, max_retries, payload
    ) VALUES (?, ?, ?, 'queued', 0, 3, ?)
  `).run(
    jobId,
    params.jobType,
    params.mediaId,
    params.payload ? JSON.stringify(params.payload) : null
  );
  return jobId;
}

/**
 * Queries job status for live progress polling from the frontend
 */
export function getMediaJobStatus(jobId: string): MediaJobRecord | null {
  const row = db.prepare('SELECT * FROM media_processing_jobs WHERE id = ?').get(jobId) as MediaJobRecord | undefined;
  return row || null;
}

/**
 * Executes a media pack job asynchronously
 */
export async function executeMediaPackPipeline(params: {
  productTitle: string;
  productId?: string;
  files: Array<{ id: string; originalFilename: string; buffer: Buffer; isHeic?: boolean }>;
  enableModelGeneration?: boolean;
  enableStyledSlot2?: boolean;
  slot2StyleOption?: any;
  modelPresetKey?: string;
  customPrompt?: string;
}): Promise<any> {
  // Step 1: Quality analysis, blur detection & duplicate clustering
  const clustered = await analyzeBatchMedia(params.files);

  // Step 2: Generate 2048x2048 square Shopify derivatives & detail crops
  for (const item of clustered) {
    try {
      const derivatives = await processListingMediaDerivatives(item.buffer, item.id, {
        generateSocial: true,
        isHeic: (item as any).isHeic,
      });
      (item as any).shopifySquareUrl = derivatives.shopifySquareUrl;
      (item as any).cleanCoverUrl = derivatives.cleanCoverUrl;
      (item as any).detailCropUrl = derivatives.detailCropUrl;
      (item as any).thumbnailUrl = derivatives.thumbnailUrl;
      (item as any).social1x1Url = derivatives.social1x1Url;
      (item as any).social4x5Url = derivatives.social4x5Url;
      (item as any).social9x16Url = derivatives.social9x16Url;
    } catch (e: any) {
      console.warn(`Derivative generation notice for ${item.id}:`, e.message);
    }
  }

  // Step 3: Recommend optimal 4–5 image Shopify gallery
  const galleryPack = await buildRecommendedGalleryPack({
    productTitle: params.productTitle,
    productId: params.productId,
    clusteredItems: clustered,
    enableModelGeneration: params.enableModelGeneration,
    enableStyledSlot2: params.enableStyledSlot2 !== false,
    slot2StyleOption: params.slot2StyleOption,
    modelPresetKey: params.modelPresetKey,
    customPrompt: params.customPrompt,
  });

  return {
    clusteredItems: clustered.map((c) => ({
      id: c.id,
      originalFilename: c.originalFilename,
      analysis: c.analysis,
      duplicateGroup: c.duplicateGroup,
      shopifySquareUrl: (c as any).shopifySquareUrl,
      cleanCoverUrl: (c as any).cleanCoverUrl,
      thumbnailUrl: (c as any).thumbnailUrl,
      detailCropUrl: (c as any).detailCropUrl,
      social1x1Url: (c as any).social1x1Url,
      social4x5Url: (c as any).social4x5Url,
      social9x16Url: (c as any).social9x16Url,
    })),
    galleryPack,
  };
}
