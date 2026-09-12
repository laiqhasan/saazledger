import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { db } from '../../db/database';
import {
  callShopifyAdminApi,
  getShopifyConfig,
  type ShopifyBackendConfig,
} from '../shopifyBackendService';
import { extractShopifyErrorMessage } from '../../../src/services/shopifyService';
import type { GallerySlot, RecommendedGalleryPack } from './galleryPackService';
import { UPLOADS_DIR, DERIVATIVES_DIR, getPhoto, getDerivative } from '../photoService';

export interface ShopifyMediaSyncResult {
  success: boolean;
  uploadedCount: number;
  reorderedCount: number;
  errors: string[];
  slotsSynced: Array<{
    slotNumber: number;
    shopifyImageId: string;
    position: number;
    altText: string;
  }>;
}

const SHOPIFY_ROLE_ORDER = ['white', 'model', 'detail', 'silk', 'original'] as const;
type ShopifyMediaRole = typeof SHOPIFY_ROLE_ORDER[number];

function inferShopifyMediaRole(slot: any): ShopifyMediaRole | undefined {
  const explicitRole = String(slot?.mediaPackRole || slot?.role || '').toLowerCase();
  if (SHOPIFY_ROLE_ORDER.includes(explicitRole as ShopifyMediaRole)) {
    return explicitRole as ShopifyMediaRole;
  }

  const semantic = String(slot?.slotRole || '').toUpperCase();
  if (semantic === 'HERO_COVER') return 'white';
  if (semantic === 'MODEL_1' || semantic.startsWith('AI_MODEL')) return 'model';
  if (semantic === 'DETAIL_CLOSEUP') return 'detail';
  if (semantic === 'STYLED_SUPPORTING') return 'silk';
  if (semantic === 'REAL_PHOTO_FALLBACK') return 'original';

  switch (Number(slot?.slotNumber)) {
    case 1:
      return 'white';
    case 2:
      return 'silk';
    case 3:
      return 'detail';
    case 4:
      return 'model';
    case 5:
      return 'original';
    default:
      return undefined;
  }
}

export function getShopifyReadyGallerySlots(slots: any[] = []): any[] {
  const readySlots = slots.filter((slot) => {
    const hasUrl = Boolean(String(slot?.imageUrl || slot?.url || slot?.src || '').trim());
    return hasUrl && slot?.included !== false;
  });

  const hasSemanticCardOrder = readySlots.some((slot) => slot?.mediaPackRole || slot?.role);
  if (hasSemanticCardOrder) {
    return readySlots;
  }

  return readySlots
    .map((slot, index) => ({ slot, index, role: inferShopifyMediaRole(slot) }))
    .sort((a, b) => {
      const rankA = a.role ? SHOPIFY_ROLE_ORDER.indexOf(a.role) : Number.MAX_SAFE_INTEGER;
      const rankB = b.role ? SHOPIFY_ROLE_ORDER.indexOf(b.role) : Number.MAX_SAFE_INTEGER;
      return rankA === rankB ? a.index - b.index : rankA - rankB;
    })
    .map((entry) => entry.slot);
}

/**
 * Universally resolves any image format (data URL, raw base64, local file path, derivative URL, or remote URL)
 * into a high-quality, Shopify-compliant JPEG base64 string.
 */
async function resolveSlotImageAttachment(
  slot: any,
  productId: string,
  position: number
): Promise<{ attachmentBase64?: string; filename: string }> {
  const filename = `product_${productId}_slot_${position}.jpg`;
  const rawUrl: string = String(slot.imageUrl || slot.url || slot.src || '').trim();

  if (!rawUrl) {
    return { filename };
  }

  // 1. Data URL (e.g. data:image/jpeg;base64,... or data:image/webp;base64,...)
  if (rawUrl.startsWith('data:')) {
    const comma = rawUrl.indexOf(',');
    const b64 = comma !== -1 ? rawUrl.slice(comma + 1) : rawUrl;
    try {
      const buf = Buffer.from(b64, 'base64');
      const jpegBuf = await sharp(buf)
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return { attachmentBase64: jpegBuf.toString('base64'), filename };
    } catch {
      return { attachmentBase64: b64, filename };
    }
  }

  // 2. Raw base64 string (no data: prefix, length > 100)
  if (/^[A-Za-z0-9+/=]{100,}$/.test(rawUrl)) {
    try {
      const buf = Buffer.from(rawUrl, 'base64');
      const jpegBuf = await sharp(buf)
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return { attachmentBase64: jpegBuf.toString('base64'), filename };
    } catch {
      return { attachmentBase64: rawUrl, filename };
    }
  }

  // 3. Local disk files, relative paths, or localhost URLs
  let cleanPath = rawUrl.replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/, '');
  if (cleanPath.startsWith('/api/photos/')) {
    cleanPath = cleanPath.replace('/api/photos/', '');
  }

  const candidatePaths = [
    path.resolve(DERIVATIVES_DIR, path.basename(cleanPath)),
    path.resolve(UPLOADS_DIR, cleanPath),
    path.resolve(UPLOADS_DIR, 'derivatives', path.basename(cleanPath)),
    path.resolve(process.cwd(), cleanPath.replace(/^\/+/, '')),
    path.resolve(cleanPath),
  ];

  for (const cPath of candidatePaths) {
    if (fs.existsSync(cPath)) {
      try {
        const stat = fs.statSync(cPath);
        if (stat.isFile()) {
          const fileBuf = fs.readFileSync(cPath);
          const jpegBuf = await sharp(fileBuf)
            .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
            .toBuffer();
          return { attachmentBase64: jpegBuf.toString('base64'), filename };
        }
      } catch (fileErr: any) {
        console.warn(`[Shopify Sync] Read local file notice for ${cPath}:`, fileErr.message);
      }
    }
  }

  // 3b. Check persistent database photo_blobs
  const blobPhoto = getDerivative(path.basename(cleanPath)) || getPhoto(cleanPath);
  if (blobPhoto) {
    try {
      const jpegBuf = await sharp(blobPhoto.buffer)
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return { attachmentBase64: jpegBuf.toString('base64'), filename };
    } catch {}
  }

  // 4. Remote HTTP/HTTPS URL (external hosting)
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    try {
      const fetchRes = await fetch(rawUrl, { signal: AbortSignal.timeout(20000) });
      if (fetchRes.ok) {
        const ab = await fetchRes.arrayBuffer();
        const buf = Buffer.from(ab);
        const jpegBuf = await sharp(buf)
          .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          .toBuffer();
        return { attachmentBase64: jpegBuf.toString('base64'), filename };
      }
    } catch (fetchErr: any) {
      console.warn(`[Shopify Sync] Could not pre-fetch remote image from ${rawUrl}:`, fetchErr.message);
    }
  }

  return { filename };
}

/**
 * Uploads, sets Alt Text, and strictly reorders a recommended gallery pack
 * so that Slot 1 is guaranteed to be position 1 (primary cover) on Shopify.
 */
export async function syncGalleryPackToShopify(params: {
  shopifyProductId: string;
  productId: string;
  galleryPack: RecommendedGalleryPack;
  mode?: 'review_approved' | 'full_auto';
  shopifyConfig?: ShopifyBackendConfig;
}): Promise<ShopifyMediaSyncResult> {
  const config = params.shopifyConfig || getShopifyConfig();
  if (!config.shopDomain || !config.adminAccessToken) {
    throw new Error('Shopify credentials not configured.');
  }

  const errors: string[] = [];
  const slotsSynced: ShopifyMediaSyncResult['slotsSynced'] = [];

  const slotsForPublish = getShopifyReadyGallerySlots(params.galleryPack.slots as any[]);

  // Iterate through ready media in semantic card order unless the UI supplied an explicit semantic reorder.
  for (let i = 0; i < slotsForPublish.length; i++) {
    const slot = slotsForPublish[i];
    const targetPosition = i + 1; // Slot 1 = Position 1 (Cover)
    const slotTitle = slot.slotTitle || `Slot ${targetPosition}`;
    const rawUrl: string = String(slot.imageUrl || (slot as any).url || (slot as any).src || '').trim();
    const mediaId: string = String(slot.mediaId || (slot as any).mediaAssetId || (slot as any).id || `slot_${slot.slotNumber || targetPosition}_${Date.now()}`);

    try {
      const { attachmentBase64, filename } = await resolveSlotImageAttachment(
        slot,
        params.productId,
        targetPosition
      );

      if (!attachmentBase64 && (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
        errors.push(`Slot ${slot.slotNumber || targetPosition} (${slotTitle}): Image source file or data could not be found.`);
        continue;
      }

      const altText = (slot.altText || `${params.galleryPack.productTitle || 'Jewelry piece'} - Photo ${targetPosition}`).trim();

      const uploadBody: any = {
        image: {
          position: targetPosition,
          alt: altText,
        },
      };

      if (attachmentBase64) {
        uploadBody.image.attachment = attachmentBase64;
        uploadBody.image.filename = filename;
      } else {
        uploadBody.image.src = rawUrl;
      }

      // Call Shopify Admin API to create / attach media
      const uploadRes = await callShopifyAdminApi(
        `/admin/api/${config.apiVersion}/products/${params.shopifyProductId}/images.json`,
        {
          method: 'POST',
          body: uploadBody,
          config,
        }
      );

      if (uploadRes.ok && uploadRes.data?.image?.id) {
        const shopifyImageId = String(uploadRes.data.image.id);

        // Record remote mapping in database safely
        try {
          db.prepare(`
            INSERT INTO shopify_media_mappings (
              id, media_id, product_id, shopify_product_id, shopify_media_id,
              shopify_image_url, source_checksum_sha256, published_status, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              shopify_media_id = excluded.shopify_media_id,
              shopify_image_url = excluded.shopify_image_url,
              published_at = CURRENT_TIMESTAMP
          `).run(
            `smm_${shopifyImageId}`,
            mediaId,
            params.productId || 'unknown',
            params.shopifyProductId,
            shopifyImageId,
            uploadRes.data.image.src || rawUrl || '',
            `chk_${mediaId}`
          );
        } catch (mapErr: any) {
          console.warn('[Shopify Sync] Mapping record notice:', mapErr.message);
        }

        // Update media_assets record status safely
        try {
          db.prepare(`
            UPDATE media_assets SET
              shopify_upload_status = 'ready',
              shopify_media_id = ?,
              shopify_position = ?,
              alt_text = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(shopifyImageId, targetPosition, altText, mediaId);
        } catch {
          // Ignored if not found in media_assets table
        }

        slotsSynced.push({
          slotNumber: slot.slotNumber || targetPosition,
          shopifyImageId,
          position: targetPosition,
          altText,
        });
      } else {
        const errMsg = extractShopifyErrorMessage(uploadRes);
        errors.push(`Slot ${slot.slotNumber || targetPosition} (${slotTitle}) upload failed: ${errMsg}`);
      }
    } catch (slotErr: any) {
      errors.push(`Slot ${slot.slotNumber || targetPosition} (${slotTitle}) error: ${slotErr.message}`);
    }

    // Rate-limit throttle for Shopify API stability
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  // Final step: Ensure primary cover (Slot 1) is strictly set as position 1
  if (slotsSynced.length > 0 && slotsSynced[0]) {
    try {
      await callShopifyAdminApi(
        `/admin/api/${config.apiVersion}/products/${params.shopifyProductId}/images/${slotsSynced[0].shopifyImageId}.json`,
        {
          method: 'PUT',
          body: {
            image: {
              id: Number(slotsSynced[0].shopifyImageId),
              position: 1,
            },
          },
          config,
        }
      );
    } catch (reorderErr: any) {
      console.warn('[Shopify Sync] Reorder cover image notice:', reorderErr.message);
    }
  }

  return {
    success: errors.length === 0,
    uploadedCount: slotsSynced.length,
    reorderedCount: slotsSynced.length,
    errors,
    slotsSynced,
  };
}
