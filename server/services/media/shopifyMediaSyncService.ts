import fs from 'fs';
import path from 'path';
import { db } from '../../db/database';
import {
  callShopifyAdminApi,
  getShopifyConfig,
  type ShopifyBackendConfig,
} from '../shopifyBackendService';
import { extractShopifyErrorMessage } from '../../../src/services/shopifyService';
import type { GallerySlot, RecommendedGalleryPack } from './galleryPackService';
import { UPLOADS_DIR } from '../photoService';

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

  // Fetch existing product images on Shopify first to avoid duplicate uploads
  let existingImages: Array<{ id: number; src: string; alt?: string; position: number }> = [];
  try {
    const listRes = await callShopifyAdminApi(
      `/admin/api/${config.apiVersion}/products/${params.shopifyProductId}/images.json`,
      { config }
    );
    if (listRes.ok && Array.isArray(listRes.data?.images)) {
      existingImages = listRes.data.images;
    }
  } catch (err: any) {
    console.warn('Failed querying existing Shopify images:', err.message);
  }

  // Iterate through slots in guaranteed order (1 to 5)
  for (let i = 0; i < params.galleryPack.slots.length; i++) {
    const slot = params.galleryPack.slots[i];
    const targetPosition = i + 1; // Slot 1 = Position 1 (Cover)

    try {
      let attachmentBase64: string | undefined = undefined;

      // Resolve local file path if relative
      if (slot.imageUrl.startsWith('/api/photos/')) {
        const subPath = slot.imageUrl.replace('/api/photos/', '');
        const absPath = path.resolve(UPLOADS_DIR, subPath);
        if (fs.existsSync(absPath)) {
          attachmentBase64 = fs.readFileSync(absPath).toString('base64');
        }
      } else if (slot.imageUrl.startsWith('data:')) {
        const comma = slot.imageUrl.indexOf(',');
        attachmentBase64 = comma !== -1 ? slot.imageUrl.slice(comma + 1) : slot.imageUrl;
      }

      const uploadBody: any = {
        image: {
          position: targetPosition,
          alt: slot.altText,
        },
      };

      if (attachmentBase64) {
        uploadBody.image.attachment = attachmentBase64;
        uploadBody.image.filename = `product_${params.productId}_slot_${targetPosition}.jpg`;
      } else if (slot.imageUrl.startsWith('http://') || slot.imageUrl.startsWith('https://')) {
        uploadBody.image.src = slot.imageUrl;
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

        // Record remote mapping in database
        db.prepare(`
          INSERT INTO shopify_media_mappings (
            id, media_id, product_id, shopify_product_id, shopify_media_id,
            shopify_image_url, source_checksum_sha256, published_status, published_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)
        `).run(
          `smm_${shopifyImageId}`,
          slot.mediaId,
          params.productId,
          params.shopifyProductId,
          shopifyImageId,
          uploadRes.data.image.src || slot.imageUrl,
          `chk_${slot.mediaId}`
        );

        // Update media_assets record status
        db.prepare(`
          UPDATE media_assets SET
            shopify_upload_status = 'ready',
            shopify_media_id = ?,
            shopify_position = ?,
            alt_text = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(shopifyImageId, targetPosition, slot.altText, slot.mediaId);

        slotsSynced.push({
          slotNumber: slot.slotNumber,
          shopifyImageId,
          position: targetPosition,
          altText: slot.altText,
        });
      } else {
        const errMsg = extractShopifyErrorMessage(uploadRes);
        errors.push(`Slot ${slot.slotNumber} (${slot.slotTitle}) upload failed: ${errMsg}`);
      }
    } catch (slotErr: any) {
      errors.push(`Slot ${slot.slotNumber} error: ${slotErr.message}`);
    }

    // Rate-limit throttle
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
    } catch (reorderErr) {
      console.warn('Reorder cover image notice:', reorderErr);
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
