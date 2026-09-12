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

export type SourceMode = 'auto' | 'manual' | 'skip';

export interface ProductMediaAsset {
  id: string;
  role: string;
  url?: string;
  localPath?: string;
  cloudUrl?: string;
  sourceMediaId?: string;
  sourceMode: SourceMode;
  provider?: string;
  generationProvider?: string;
  createdAt?: string;
  generatedAt?: string;
  width?: number | null;
  height?: number | null;
  isManual?: boolean;
  included?: boolean;
}

export interface ProductMediaPack {
  whiteProduct?: ProductMediaAsset;
  fashionModel?: ProductMediaAsset;
  closeUp?: ProductMediaAsset;
  silkStyled?: ProductMediaAsset;
  originalPhoto?: ProductMediaAsset;
  isolatedMaster?: ProductMediaAsset;
  /** @deprecated use originalPhoto */
  originalImage?: ProductMediaAsset;
  /** @deprecated use originalPhoto with sourceMode="manual" */
  manualOriginal?: ProductMediaAsset;
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

export type StyledSlot2Option =
  | 'silk_cloth'
  | 'flower_styling'
  | 'silk_and_flower'
  | 'minimal_luxury_flat_lay';

export interface GallerySlot {
  slotNumber: number; // 1 to 5
  slotRole:
    | 'HERO_COVER'
    | 'STYLED_SUPPORTING'
    | 'ALT_ANGLE'
    | 'ALT_VIEW'
    | 'DETAIL_CLOSEUP'
    | 'AI_MODEL_LIFESTYLE_1'
    | 'AI_MODEL_LIFESTYLE_2'
    | 'MODEL_1'
    | 'MODEL_2_OR_SUPPORTING'
    | 'REAL_PHOTO_FALLBACK';
  mediaAssetId: string;
  sourceType: 'REAL_PHOTO' | 'AI_MODEL' | 'DERIVATIVE' | 'real_photo' | 'ai_model' | 'ai_lifestyle' | 'detail_crop';
  url: string;
  thumbnailUrl?: string;
  altText: string;
  seoKeywords: string[];
  dimensions: { width: number; height: number };
  fileSize?: number;
  qualityScore?: number;
  generationPrompt?: string;
  generationTemplate?: string;
  isCover: boolean;
  shopifyUploadStatus?: 'PENDING' | 'SUCCESS' | 'FAILED';
  shopifyMediaId?: string;
  slotTitle?: string;
  isAiGenerated?: boolean;
  canRegenerate?: boolean;
  modelPresetKey?: string;
  styledOption?: StyledSlot2Option;
  included?: boolean;
  sourceReferenceUrl?: string;
  sourceReferenceName?: string;
  originalUrl?: string;
  cleanCoverUrl?: string;
  transparentUrl?: string;
  isolatedMasterUrl?: string;
  imageUrl?: string;
  currentBgMode?: 'original' | 'white' | 'transparent';
  generationFailed?: boolean;
  generationError?: string;
  sourceMode?: SourceMode;
  mediaPackRole?: 'white' | 'model' | 'detail' | 'silk' | 'original';
  role?: string;
  sourceMediaId?: string;
  generationProvider?: string;
  provider?: string;
  createdAt?: string;
  generatedAt?: string;
  /** Output format ratio for White Product images. Defaults to '1:1'. */
  outputRatio?: '1:1' | '4:5' | '9:16';
  whiteProductMode?: 'exact_cutout' | 'ai_presentation';
  productMatchScore?: number;
  matchVerdict?: 'HIGH_MATCH' | 'REVIEW_RECOMMENDED' | 'NEEDS_REVIEW';
  accuracyAnalysis?: any;
  exactCutoutUrl?: string;
}

export interface GalleryPack {
  productId?: string;
  sku?: string;
  slots: GallerySlot[];
  realPhotoCount: number;
  aiModelCount: number;
  warnings: string[];
  slot2StyleOption?: StyledSlot2Option;
  styledSlot2Used?: boolean;
  socialDerivatives?: {
    social_1x1?: string;
    social_4x5?: string;
    social_9x16?: string;
    detail_crop?: string;
    shopify_master?: string;
  };
  mediaPack?: ProductMediaPack;
  sourceModes?: Partial<Record<'white' | 'model' | 'detail' | 'silk' | 'original', SourceMode>>;
  createdAt: string;
}

export interface StylingPreset {
  id: string;
  name: string;
  description: string;
  defaultPrompt: string;
}

export interface MediaPackJobStatus {
  id: string;
  product_id?: string;
  job_type: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  progress_percent: number;
  current_step?: string;
  result_summary?: {
    galleryPack?: GalleryPack;
    socialDerivatives?: Record<string, string>;
    warnings?: string[];
  };
  error_message?: string;
  created_at: string;
  updated_at: string;
}
