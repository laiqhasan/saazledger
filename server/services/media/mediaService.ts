import crypto from 'crypto';
import path from 'path';
import { db } from '../../db/database';
import {
  getMediaStorageSettings,
  type StorageProviderAdapter,
  type StorageProviderType,
} from './storageProvider';
import { LocalDiskStorageAdapter } from './localDiskAdapter';
import { S3StorageAdapter } from './s3Adapter';
import { GoogleDriveStorageAdapter } from './googleDriveAdapter';
import { sniffFileFormat, generateDerivatives } from './derivativeService';

export function getStorageAdapter(provider: StorageProviderType): StorageProviderAdapter {
  const settings = getMediaStorageSettings();
  switch (provider) {
    case 's3':
      return new S3StorageAdapter(settings.s3);
    case 'google_drive':
      return new GoogleDriveStorageAdapter(settings.googleDrive);
    case 'local_disk':
    default:
      return new LocalDiskStorageAdapter();
  }
}

export function getPrimaryStorageAdapter(): StorageProviderAdapter {
  const settings = getMediaStorageSettings();
  return getStorageAdapter(settings.primaryProvider);
}

export function getBackupStorageAdapter(): StorageProviderAdapter {
  const settings = getMediaStorageSettings();
  return getStorageAdapter(settings.backupProvider);
}

// -------------------------------------------------------------
// Media Assets Queries & Management
// -------------------------------------------------------------

export interface MediaAssetRecord {
  id: string;
  original_filename: string;
  display_title: string;
  mime_type: string;
  byte_size: number;
  checksum_sha256: string;
  perceptual_hash?: string | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  upload_source: string;
  uploader_id?: string | null;
  media_type: 'image' | 'video' | 'document';
  classification: 'original' | 'edited' | 'ai_generated' | 'derivative';
  processing_status: 'pending' | 'uploading' | 'verifying' | 'processing' | 'ready' | 'failed';
  approval_status: 'pending_review' | 'approved' | 'rejected';
  is_deleted: number;
  deleted_at?: string | null;
  deleted_by?: string | null;
  parent_media_id?: string | null;
  processing_notes?: string | null;
  created_at: string;
  updated_at: string;
  // Joined details
  primary_url?: string;
  thumbnail_url?: string;
  provider?: StorageProviderType;
  linked_product_count?: number;
  linked_products?: Array<{
    productId: string;
    productTitle: string;
    productSku: string;
    slotType: string;
    displayOrder: number;
  }>;
}

export interface GetMediaFilter {
  search?: string;
  mediaType?: 'image' | 'video' | 'document';
  provider?: StorageProviderType;
  approvalStatus?: 'pending_review' | 'approved' | 'rejected';
  processingStatus?: string;
  isLinked?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export function getAllMediaAssets(filter: GetMediaFilter = {}): { assets: MediaAssetRecord[]; totalCount: number } {
  let whereClauses: string[] = [];
  let params: any[] = [];

  if (!filter.includeDeleted) {
    whereClauses.push('m.is_deleted = 0');
  }

  if (filter.search) {
    const q = `%${filter.search.trim()}%`;
    whereClauses.push('(m.display_title LIKE ? OR m.original_filename LIKE ? OR EXISTS (SELECT 1 FROM product_media_links pml JOIN items it ON pml.product_id = it.id WHERE pml.media_id = m.id AND (it.sku LIKE ? OR it.title LIKE ?)))');
    params.push(q, q, q, q);
  }

  if (filter.mediaType) {
    whereClauses.push('m.media_type = ?');
    params.push(filter.mediaType);
  }

  if (filter.approvalStatus) {
    whereClauses.push('m.approval_status = ?');
    params.push(filter.approvalStatus);
  }

  if (filter.processingStatus) {
    whereClauses.push('m.processing_status = ?');
    params.push(filter.processingStatus);
  }

  if (filter.provider) {
    whereClauses.push('EXISTS (SELECT 1 FROM media_storage_locations loc WHERE loc.media_id = m.id AND loc.provider = ?)');
    params.push(filter.provider);
  }

  if (filter.isLinked !== undefined) {
    if (filter.isLinked) {
      whereClauses.push('EXISTS (SELECT 1 FROM product_media_links pml WHERE pml.media_id = m.id)');
    } else {
      whereClauses.push('NOT EXISTS (SELECT 1 FROM product_media_links pml WHERE pml.media_id = m.id)');
    }
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM media_assets m ${whereSql}`).get(...params) as { cnt: number };
  const totalCount = totalRow ? totalRow.cnt : 0;

  const limit = Math.min(100, Math.max(1, filter.limit || 50));
  const offset = Math.max(0, filter.offset || 0);

  const rows = db.prepare(`
    SELECT
      m.*,
      (SELECT public_delivery_url FROM media_storage_locations WHERE media_id = m.id AND storage_role = 'primary' LIMIT 1) as primary_url,
      (SELECT public_delivery_url FROM media_storage_locations WHERE media_id = m.id AND storage_role = 'derivative_thumb' LIMIT 1) as thumbnail_url,
      (SELECT provider FROM media_storage_locations WHERE media_id = m.id AND storage_role = 'primary' LIMIT 1) as provider,
      (SELECT COUNT(*) FROM product_media_links WHERE media_id = m.id) as linked_product_count
    FROM media_assets m
    ${whereSql}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as MediaAssetRecord[];

  // Fetch product linkages for each row
  const getLinks = db.prepare(`
    SELECT pml.product_id as productId, it.title as productTitle, it.sku as productSku, pml.slot_type as slotType, pml.display_order as displayOrder
    FROM product_media_links pml
    JOIN items it ON pml.product_id = it.id
    WHERE pml.media_id = ?
    ORDER BY pml.display_order ASC
  `);

  for (const r of rows) {
    r.linked_products = getLinks.all(r.id) as any[];
  }

  return { assets: rows, totalCount };
}

export function getMediaAssetById(id: string): MediaAssetRecord | null {
  const asset = db.prepare(`
    SELECT
      m.*,
      (SELECT public_delivery_url FROM media_storage_locations WHERE media_id = m.id AND storage_role = 'primary' LIMIT 1) as primary_url,
      (SELECT public_delivery_url FROM media_storage_locations WHERE media_id = m.id AND storage_role = 'derivative_thumb' LIMIT 1) as thumbnail_url,
      (SELECT provider FROM media_storage_locations WHERE media_id = m.id AND storage_role = 'primary' LIMIT 1) as provider,
      (SELECT COUNT(*) FROM product_media_links WHERE media_id = m.id) as linked_product_count
    FROM media_assets m
    WHERE m.id = ?
  `).get(id) as MediaAssetRecord | undefined;

  if (!asset) return null;

  const links = db.prepare(`
    SELECT pml.product_id as productId, it.title as productTitle, it.sku as productSku, pml.slot_type as slotType, pml.display_order as displayOrder
    FROM product_media_links pml
    JOIN items it ON pml.product_id = it.id
    WHERE pml.media_id = ?
    ORDER BY pml.display_order ASC
  `).all(id) as any[];

  asset.linked_products = links;
  return asset;
}

// -------------------------------------------------------------
// Ingestion Pipeline
// -------------------------------------------------------------

export interface IngestMediaParams {
  buffer: Buffer;
  originalFilename: string;
  displayTitle?: string;
  uploadSource?: 'web_upload' | 'google_drive_import' | 'camera_capture' | 'migration';
  uploaderId?: string;
  productId?: string;
  slotType?: 'cover' | 'front' | 'back' | 'close_up' | 'model' | 'packaging' | 'video' | 'gallery';
  approvalStatus?: 'pending_review' | 'approved';
}

export interface IngestResult {
  asset: MediaAssetRecord;
  isDuplicate: boolean;
  duplicateAssetId?: string;
}

export async function ingestMediaFile(params: IngestMediaParams): Promise<IngestResult> {
  const checksumSha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');

  // Check if identical content bytes already exist in media_assets
  const existing = db.prepare('SELECT id FROM media_assets WHERE checksum_sha256 = ? AND is_deleted = 0').get(checksumSha256) as { id: string } | undefined;
  if (existing) {
    const full = getMediaAssetById(existing.id);

    // If a product linkage was requested, link existing asset without duplicate cloud upload
    if (params.productId && full) {
      linkMediaToProduct({
        productId: params.productId,
        mediaId: full.id,
        slotType: params.slotType || 'gallery',
      });
    }

    return {
      asset: full!,
      isDuplicate: true,
      duplicateAssetId: existing.id,
    };
  }

  const mediaId = `med_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const format = sniffFileFormat(params.buffer, params.originalFilename);
  const primaryAdapter = getPrimaryStorageAdapter();
  const settings = getMediaStorageSettings();

  // 1. Initiate and Complete Primary Storage Upload
  const session = await primaryAdapter.initiateUpload({
    filename: params.originalFilename,
    mimeType: format.mimeType,
    byteSize: params.buffer.length,
    checksumSha256,
    mediaId,
  });

  const locationDetails = await primaryAdapter.completeUpload(session);

  // 2. Generate Thumbnails and Derivatives
  const derivatives = generateDerivatives(params.buffer, mediaId, format);

  // 3. Persist Records Transactionally
  const asset = db.transaction(() => {
    const title = params.displayTitle || path.parse(params.originalFilename).name.replace(/[-_]/g, ' ');

    db.prepare(`
      INSERT INTO media_assets (
        id, original_filename, display_title, mime_type, byte_size, checksum_sha256,
        upload_source, uploader_id, media_type, classification, processing_status,
        approval_status, processing_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'original', 'ready', ?, ?)
    `).run(
      mediaId,
      params.originalFilename,
      title,
      format.mimeType,
      params.buffer.length,
      checksumSha256,
      params.uploadSource || 'web_upload',
      params.uploaderId || 'usr_admin_root',
      format.category,
      params.approvalStatus || 'approved',
      derivatives.statusNotes
    );

    // Insert primary storage location
    db.prepare(`
      INSERT INTO media_storage_locations (
        id, media_id, provider, storage_role, storage_key, bucket_or_drive_id, public_delivery_url, replication_status
      ) VALUES (?, ?, ?, 'primary', ?, ?, ?, 'synced')
    `).run(
      `loc_${mediaId}_prim`,
      mediaId,
      primaryAdapter.providerName,
      locationDetails.storageKey,
      locationDetails.bucketOrDriveId || null,
      locationDetails.publicDeliveryUrl || null
    );

    // Insert thumbnail derivative location if generated
    if (derivatives.thumbnailUrl) {
      db.prepare(`
        INSERT INTO media_storage_locations (
          id, media_id, provider, storage_role, storage_key, public_delivery_url, replication_status
        ) VALUES (?, ?, 'local_disk', 'derivative_thumb', ?, ?, 'synced')
      `).run(
        `loc_${mediaId}_thumb`,
        mediaId,
        derivatives.thumbnailUrl,
        derivatives.thumbnailUrl
      );
    }

    // Link to product if specified
    if (params.productId) {
      db.prepare(`
        INSERT OR IGNORE INTO product_media_links (
          id, product_id, media_id, slot_type, display_order, alt_text
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        `pml_${params.productId}_${mediaId}`,
        params.productId,
        mediaId,
        params.slotType || 'cover',
        0,
        `${title} for ${params.productId}`
      );
    }

    return getMediaAssetById(mediaId)!;
  })();

  // 4. Asynchronous Replication to Google Drive if Backup Enabled
  if (settings.backupEnabled && settings.backupProvider !== primaryAdapter.providerName) {
    db.prepare(`
      INSERT INTO media_processing_jobs (
        id, job_type, media_id, status, payload
      ) VALUES (?, 'replicate_backup', ?, 'queued', ?)
    `).run(
      `job_rep_${mediaId}`,
      mediaId,
      JSON.stringify({ targetProvider: settings.backupProvider })
    );
  }

  return { asset, isDuplicate: false };
}

// -------------------------------------------------------------
// Product-Media Association Services
// -------------------------------------------------------------

export function linkMediaToProduct(params: {
  productId: string;
  mediaId: string;
  slotType: 'cover' | 'front' | 'back' | 'close_up' | 'model' | 'packaging' | 'video' | 'gallery';
  displayOrder?: number;
  altText?: string;
}): boolean {
  const currentCount = db.prepare('SELECT COUNT(*) as count FROM product_media_links WHERE product_id = ?').get(params.productId) as { count: number };
  const displayOrder = params.displayOrder !== undefined ? params.displayOrder : currentCount.count;

  db.prepare(`
    INSERT INTO product_media_links (
      id, product_id, media_id, slot_type, display_order, alt_text
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, media_id, slot_type) DO UPDATE SET
      display_order = excluded.display_order,
      alt_text = excluded.alt_text
  `).run(
    `pml_${params.productId}_${params.mediaId}_${params.slotType}`,
    params.productId,
    params.mediaId,
    params.slotType,
    displayOrder,
    params.altText || null
  );

  return true;
}

export function unlinkMediaFromProduct(productId: string, mediaId: string, slotType?: string): boolean {
  if (slotType) {
    db.prepare('DELETE FROM product_media_links WHERE product_id = ? AND media_id = ? AND slot_type = ?')
      .run(productId, mediaId, slotType);
  } else {
    db.prepare('DELETE FROM product_media_links WHERE product_id = ? AND media_id = ?')
      .run(productId, mediaId);
  }
  return true;
}

export function reorderProductMedia(productId: string, orderings: Array<{ linkId?: string; mediaId: string; displayOrder: number }>): boolean {
  db.transaction(() => {
    const stmt = db.prepare('UPDATE product_media_links SET display_order = ? WHERE product_id = ? AND media_id = ?');
    for (const o of orderings) {
      stmt.run(o.displayOrder, productId, o.mediaId);
    }
  })();
  return true;
}

// -------------------------------------------------------------
// Soft Delete & Purge
// -------------------------------------------------------------

export function softDeleteMediaAsset(mediaId: string, userId = 'usr_admin_root'): boolean {
  db.prepare(`
    UPDATE media_assets
    SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
    WHERE id = ?
  `).run(userId, mediaId);
  return true;
}

export function purgeMediaAsset(mediaId: string): boolean {
  return db.transaction(() => {
    const locations = db.prepare('SELECT * FROM media_storage_locations WHERE media_id = ?').all(mediaId) as any[];

    for (const loc of locations) {
      const adapter = getStorageAdapter(loc.provider);
      adapter.deleteFile({
        mediaId: loc.media_id,
        provider: loc.provider,
        storageRole: loc.storage_role,
        storageKey: loc.storage_key,
        bucketOrDriveId: loc.bucket_or_drive_id,
      }, false);
    }

    db.prepare('DELETE FROM media_assets WHERE id = ?').run(mediaId);
    return true;
  })();
}

// -------------------------------------------------------------
// Cross-Provider Migration Engine
// -------------------------------------------------------------

export interface MigrationSummary {
  totalScanned: number;
  migratedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
}

export async function migrateAllMedia(sourceProvider: StorageProviderType, targetProvider: StorageProviderType): Promise<MigrationSummary> {
  const assets = db.prepare(`
    SELECT m.id, m.checksum_sha256, m.original_filename, loc.storage_key, loc.public_delivery_url, loc.bucket_or_drive_id
    FROM media_assets m
    JOIN media_storage_locations loc ON m.id = loc.media_id AND loc.provider = ? AND loc.storage_role = 'primary'
    WHERE m.is_deleted = 0
  `).all(sourceProvider) as Array<{ id: string; checksum_sha256: string; original_filename: string; storage_key: string; public_delivery_url?: string; bucket_or_drive_id?: string }>;

  const targetAdapter = getStorageAdapter(targetProvider);
  const summary: MigrationSummary = { totalScanned: assets.length, migratedCount: 0, skippedCount: 0, errorCount: 0, errors: [] };

  for (const a of assets) {
    try {
      // 1. Check if target location already exists
      const existingTarget = db.prepare('SELECT 1 FROM media_storage_locations WHERE media_id = ? AND provider = ?').get(a.id, targetProvider);
      if (existingTarget) {
        summary.skippedCount++;
        continue;
      }

      // 2. Initiate target upload session
      const session = await targetAdapter.initiateUpload({
        filename: a.original_filename,
        mimeType: 'image/jpeg',
        byteSize: 1024,
        checksumSha256: a.checksum_sha256,
        mediaId: a.id,
      });

      const locationDetails = await targetAdapter.completeUpload(session);

      // 3. Register target location
      db.prepare(`
        INSERT INTO media_storage_locations (
          id, media_id, provider, storage_role, storage_key, bucket_or_drive_id, public_delivery_url, replication_status
        ) VALUES (?, ?, ?, 'primary', ?, ?, ?, 'synced')
      `).run(
        `loc_${a.id}_${targetProvider}`,
        a.id,
        targetProvider,
        locationDetails.storageKey,
        locationDetails.bucketOrDriveId || null,
        locationDetails.publicDeliveryUrl || null
      );

      summary.migratedCount++;
    } catch (err: any) {
      summary.errorCount++;
      summary.errors.push(`Asset ${a.id}: ${err.message}`);
    }
  }

  return summary;
}
