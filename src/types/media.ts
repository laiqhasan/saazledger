export type StorageProviderType = 's3' | 'google_drive' | 'local_disk';

export type MediaSlotType =
  | 'cover'
  | 'front'
  | 'back'
  | 'close_up'
  | 'model'
  | 'packaging'
  | 'video'
  | 'gallery';

export interface LinkedProductInfo {
  productId: string;
  productTitle: string;
  productSku: string;
  slotType: MediaSlotType;
  displayOrder: number;
}

export interface MediaAsset {
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
  upload_source: 'web_upload' | 'google_drive_import' | 'camera_capture' | 'migration';
  uploader_id?: string | null;
  media_type: 'image' | 'video' | 'document';
  classification: 'original' | 'edited' | 'ai_generated' | 'derivative';
  processing_status: 'pending' | 'uploading' | 'verifying' | 'processing' | 'ready' | 'failed';
  approval_status: 'pending_review' | 'approved' | 'rejected';
  is_deleted: number;
  deleted_at?: string | null;
  processing_notes?: string | null;
  created_at: string;
  updated_at: string;
  // Dynamic joins
  primary_url?: string;
  thumbnail_url?: string;
  provider?: StorageProviderType;
  linked_product_count?: number;
  linked_products?: LinkedProductInfo[];
}

export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  encryption?: string;
  versioning?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  cdnCustomDomain?: string;
}

export interface GoogleDriveConfig {
  folderId: string;
  sharedDrive?: string;
  connectedEmail?: string;
  tokenHealth: 'connected' | 'expired' | 'revoked' | 'not_configured';
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

export interface MediaStorageSettings {
  primaryProvider: StorageProviderType;
  backupEnabled: boolean;
  backupProvider: StorageProviderType;
  s3: S3Config;
  googleDrive: GoogleDriveConfig;
}

export interface ConnectionTestResult {
  success: boolean;
  provider: StorageProviderType;
  message: string;
  testedAt: string;
  latencyMs?: number;
  details?: {
    bucketName?: string;
    region?: string;
    encryption?: string;
    versioningEnabled?: boolean;
    folderId?: string;
    connectedAccount?: string;
  };
}
