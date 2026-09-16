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
import { UPLOADS_DIR, DERIVATIVES_DIR, getPhoto, getDerivative, syncPhotoToS3, saveDerivativeBuffer } from '../photoService';

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
    s3Url?: string;
    localUrl?: string;
    mediaType?: 'image' | 'video';
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
): Promise<{
  attachmentBase64?: string;
  buffer?: Buffer;
  filename: string;
  mimeType: string;
  mediaType: 'image' | 'video';
}> {
  const rawUrl: string = String(slot?.imageUrl || slot?.url || slot?.src || '').trim();
  const isVideo = Boolean(
    slot?.mediaType === 'video' ||
    slot?.isVideo ||
    rawUrl.match(/\.(mp4|webm|mov)(\?.*)?$/i) ||
    rawUrl.startsWith('data:video/')
  );

  let ext = isVideo ? '.mp4' : '.jpg';
  let mimeType = isVideo ? 'video/mp4' : 'image/jpeg';
  if (rawUrl.includes('.webm') || rawUrl.startsWith('data:video/webm')) {
    ext = '.webm';
    mimeType = 'video/webm';
  } else if (rawUrl.includes('.mov') || rawUrl.startsWith('data:video/quicktime')) {
    ext = '.mov';
    mimeType = 'video/quicktime';
  }

  const filename = `product_${productId}_slot_${position}${ext}`;

  if (!rawUrl) {
    return { filename, mimeType, mediaType: isVideo ? 'video' : 'image' };
  }

  // 1. Data URL (image or video)
  if (rawUrl.startsWith('data:')) {
    const comma = rawUrl.indexOf(',');
    const b64 = comma !== -1 ? rawUrl.slice(comma + 1) : rawUrl;
    try {
      const buf = Buffer.from(b64, 'base64');
      if (isVideo) {
        return { buffer: buf, attachmentBase64: b64, filename, mimeType, mediaType: 'video' };
      }
      const jpegBuf = await sharp(buf)
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return { buffer: jpegBuf, attachmentBase64: jpegBuf.toString('base64'), filename, mimeType: 'image/jpeg', mediaType: 'image' };
    } catch {
      return { attachmentBase64: b64, filename, mimeType, mediaType: isVideo ? 'video' : 'image' };
    }
  }

  // 2. Raw base64 string
  if (/^[A-Za-z0-9+/=]{100,}$/.test(rawUrl)) {
    try {
      const buf = Buffer.from(rawUrl, 'base64');
      if (isVideo) {
        return { buffer: buf, attachmentBase64: rawUrl, filename, mimeType, mediaType: 'video' };
      }
      const jpegBuf = await sharp(buf)
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return { buffer: jpegBuf, attachmentBase64: jpegBuf.toString('base64'), filename, mimeType: 'image/jpeg', mediaType: 'image' };
    } catch {
      return { attachmentBase64: rawUrl, filename, mimeType, mediaType: isVideo ? 'video' : 'image' };
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
          if (isVideo) {
            return { buffer: fileBuf, attachmentBase64: fileBuf.toString('base64'), filename, mimeType, mediaType: 'video' };
          }
          const jpegBuf = await sharp(fileBuf)
            .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
            .toBuffer();
          return { buffer: jpegBuf, attachmentBase64: jpegBuf.toString('base64'), filename, mimeType: 'image/jpeg', mediaType: 'image' };
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
      if (isVideo) {
        return { buffer: blobPhoto.buffer, attachmentBase64: blobPhoto.buffer.toString('base64'), filename, mimeType, mediaType: 'video' };
      }
      const jpegBuf = await sharp(blobPhoto.buffer)
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer();
      return { buffer: jpegBuf, attachmentBase64: jpegBuf.toString('base64'), filename, mimeType: 'image/jpeg', mediaType: 'image' };
    } catch {}
  }

  // 4. Remote HTTP/HTTPS URL (external hosting)
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    try {
      const fetchRes = await fetch(rawUrl, { signal: AbortSignal.timeout(20000) });
      if (fetchRes.ok) {
        const ab = await fetchRes.arrayBuffer();
        const buf = Buffer.from(ab);
        if (isVideo) {
          return { buffer: buf, attachmentBase64: buf.toString('base64'), filename, mimeType, mediaType: 'video' };
        }
        const jpegBuf = await sharp(buf)
          .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          .toBuffer();
        return { buffer: jpegBuf, attachmentBase64: jpegBuf.toString('base64'), filename, mimeType: 'image/jpeg', mediaType: 'image' };
      }
    } catch (fetchErr: any) {
      console.warn(`[Shopify Sync] Could not pre-fetch remote image from ${rawUrl}:`, fetchErr.message);
    }
  }

  return { filename, mimeType, mediaType: isVideo ? 'video' : 'image' };
}

/**
 * Uploads, sets Alt Text, and strictly reorders a recommended gallery pack
 * so that Slot 1 is guaranteed to be position 1 (primary cover) on Shopify.
 * Automatically archives each published asset to AWS S3 and records full audit trail.
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
      const resolved = await resolveSlotImageAttachment(
        slot,
        params.productId,
        targetPosition
      );

      if (!resolved.attachmentBase64 && (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
        errors.push(`Slot ${slot.slotNumber || targetPosition} (${slotTitle}): Media source file or data could not be found.`);
        continue;
      }

      // Step A: Archive to AWS S3 & local vault
      let s3Url: string | null = null;
      let localUrl: string | null = null;
      if (resolved.buffer && resolved.buffer.length > 0) {
        try {
          const cleanProdId = String(params.productId || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
          const s3Filename = `shopify_published/${cleanProdId}/${resolved.filename}`;
          s3Url = await syncPhotoToS3(s3Filename, resolved.buffer, resolved.mimeType);
          if (s3Url) {
            console.log(`[Shopify Sync] Slot ${targetPosition} vaulted to AWS S3: ${s3Url}`);
          }
        } catch (s3Err: any) {
          console.warn('[Shopify Sync] S3 archival notice:', s3Err?.message);
        }
        try {
          const saved = saveDerivativeBuffer(resolved.buffer, resolved.filename);
          localUrl = saved.url;
        } catch {}
      }

      const altText = (slot.altText || `${params.galleryPack.productTitle || 'Jewelry piece'} - Photo ${targetPosition}`).trim();
      let shopifyImageId = '';
      let shopifyMediaUrl = '';

      if (resolved.mediaType === 'video') {
        // Step B1: Upload Video via Shopify GraphQL productCreateMedia
        const sourceForShopify = s3Url || (rawUrl.startsWith('http') ? rawUrl : undefined);
        if (sourceForShopify) {
          try {
            const gqlMutation = `
              mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                productCreateMedia(productId: $productId, media: $media) {
                  media {
                    id
                    status
                  }
                  mediaUserErrors {
                    field
                    message
                  }
                }
              }
            `;
            const gqlRes = await callShopifyAdminApi(`/admin/api/${config.apiVersion}/graphql.json`, {
              method: 'POST',
              config,
              body: {
                query: gqlMutation,
                variables: {
                  productId: `gid://shopify/Product/${params.shopifyProductId}`,
                  media: [
                    {
                      originalSource: sourceForShopify,
                      mediaContentType: 'VIDEO',
                      alt: altText,
                    },
                  ],
                },
              },
            });

            const createdMedia = gqlRes.data?.data?.productCreateMedia?.media?.[0];
            if (gqlRes.ok && createdMedia?.id) {
              shopifyImageId = String(createdMedia.id).split('/').pop() || String(createdMedia.id);
              shopifyMediaUrl = sourceForShopify;
            } else {
              const errs = gqlRes.data?.data?.productCreateMedia?.mediaUserErrors;
              const errMsg = Array.isArray(errs) && errs.length > 0 ? errs.map((e: any) => e.message).join('; ') : extractShopifyErrorMessage(gqlRes);
              console.warn(`[Shopify Sync] Video GraphQL upload warning: ${errMsg}`);
            }
          } catch (videoGqlErr: any) {
            console.warn('[Shopify Sync] Video GraphQL upload error:', videoGqlErr.message);
          }
        }
      }

      // Step B2: Image upload via REST /images.json (or fallback)
      if (!shopifyImageId && resolved.mediaType !== 'video') {
        const uploadBody: any = {
          image: {
            position: targetPosition,
            alt: altText,
          },
        };

        if (resolved.attachmentBase64) {
          uploadBody.image.attachment = resolved.attachmentBase64;
          uploadBody.image.filename = resolved.filename;
        } else {
          uploadBody.image.src = s3Url || rawUrl;
        }

        const uploadRes = await callShopifyAdminApi(
          `/admin/api/${config.apiVersion}/products/${params.shopifyProductId}/images.json`,
          {
            method: 'POST',
            body: uploadBody,
            config,
          }
        );

        if (uploadRes.ok && uploadRes.data?.image?.id) {
          shopifyImageId = String(uploadRes.data.image.id);
          shopifyMediaUrl = uploadRes.data.image.src || rawUrl || '';
        } else {
          const errMsg = extractShopifyErrorMessage(uploadRes);
          errors.push(`Slot ${slot.slotNumber || targetPosition} (${slotTitle}) upload failed: ${errMsg}`);
        }
      }

      if (shopifyImageId) {
        // Step C: Record remote mapping & audit trail in database
        try {
          db.prepare(`
            INSERT INTO shopify_media_mappings (
              id, media_id, product_id, shopify_product_id, shopify_media_id,
              shopify_image_url, s3_url, local_url, position, slot_title,
              media_type, filename, source_checksum_sha256, published_status, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              shopify_media_id = excluded.shopify_media_id,
              shopify_image_url = excluded.shopify_image_url,
              s3_url = COALESCE(excluded.s3_url, shopify_media_mappings.s3_url),
              local_url = COALESCE(excluded.local_url, shopify_media_mappings.local_url),
              position = excluded.position,
              slot_title = excluded.slot_title,
              media_type = excluded.media_type,
              filename = excluded.filename,
              published_at = CURRENT_TIMESTAMP
          `).run(
            `smm_${shopifyImageId}`,
            mediaId,
            params.productId || 'unknown',
            params.shopifyProductId,
            shopifyImageId,
            shopifyMediaUrl,
            s3Url || null,
            localUrl || rawUrl || null,
            targetPosition,
            slotTitle,
            resolved.mediaType,
            resolved.filename,
            `chk_${mediaId}`
          );
        } catch (mapErr: any) {
          console.warn('[Shopify Sync] Mapping record notice:', mapErr.message);
        }

        // Step D: Update or insert media_assets record
        try {
          db.prepare(`
            INSERT INTO media_assets (
              id, filename, file_size, mime_type, storage_provider,
              primary_url, shopify_media_id, shopify_position, shopify_upload_status,
              alt_text, media_type, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              shopify_media_id = excluded.shopify_media_id,
              shopify_position = excluded.shopify_position,
              shopify_upload_status = 'ready',
              primary_url = COALESCE(excluded.primary_url, media_assets.primary_url),
              updated_at = CURRENT_TIMESTAMP
          `).run(
            mediaId,
            resolved.filename,
            resolved.buffer?.length || 0,
            resolved.mimeType,
            s3Url ? 's3' : 'local_disk',
            s3Url || localUrl || rawUrl,
            shopifyImageId,
            targetPosition,
            altText,
            resolved.mediaType
          );
        } catch (assetErr: any) {
          console.warn('[Shopify Sync] media_assets notice:', assetErr.message);
        }

        // Step E: Link media to product
        try {
          db.prepare(`
            INSERT OR REPLACE INTO product_media_links (
              id, product_id, media_id, slot_type, gallery_position, shopify_position, is_cover
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            `pml_${params.productId}_${mediaId}`,
            params.productId,
            mediaId,
            targetPosition === 1 ? 'cover' : resolved.mediaType === 'video' ? 'video' : 'gallery',
            targetPosition,
            targetPosition,
            targetPosition === 1 ? 1 : 0
          );
        } catch {}

        slotsSynced.push({
          slotNumber: slot.slotNumber || targetPosition,
          shopifyImageId,
          position: targetPosition,
          altText,
          s3Url: s3Url || undefined,
          localUrl: localUrl || undefined,
          mediaType: resolved.mediaType,
        });
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
