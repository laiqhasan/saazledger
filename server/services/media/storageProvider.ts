import { db } from '../../db/database';

export type StorageProviderType = 's3' | 'google_drive' | 'local_disk';
export type StorageRole = 'primary' | 'backup' | 'derivative_thumb' | 'derivative_optimized';

export interface UploadInitParams {
  filename: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  mediaId: string;
  businessId?: string;
}

export interface UploadSession {
  sessionId: string;
  mediaId: string;
  provider: StorageProviderType;
  uploadUrl: string; // Presigned URL or Drive Resumable URI
  headers?: Record<string, string>;
  storageKey: string;
  bucketOrDriveId?: string;
  expiresAt: string;
  isMultipart?: boolean;
}

export interface StorageLocationDetails {
  id?: string;
  mediaId: string;
  provider: StorageProviderType;
  storageRole: StorageRole;
  storageKey: string;
  bucketOrDriveId?: string;
  versionId?: string;
  etag?: string;
  publicDeliveryUrl?: string;
  replicationStatus?: 'synced' | 'pending' | 'failed' | 'not_applicable';
}

export interface RemoteFileMetadata {
  exists: boolean;
  byteSize: number;
  mimeType: string;
  etag?: string;
  versionId?: string;
  checksumSha256?: string;
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

export interface CopyParams {
  targetKey: string;
  targetRole: StorageRole;
}

export interface StorageProviderAdapter {
  readonly providerName: StorageProviderType;
  initiateUpload(params: UploadInitParams): Promise<UploadSession>;
  completeUpload(session: UploadSession, parts?: Array<{ partNumber: number; etag: string }>): Promise<StorageLocationDetails>;
  cancelUpload(session: UploadSession): Promise<void>;
  getFileMetadata(location: StorageLocationDetails): Promise<RemoteFileMetadata>;
  getAuthorizedReadUrl(location: StorageLocationDetails, expiresInSeconds?: number): Promise<string>;
  verifyContent(location: StorageLocationDetails, expectedSha256: string): Promise<boolean>;
  copyFile(sourceLocation: StorageLocationDetails, targetParams: CopyParams): Promise<StorageLocationDetails>;
  deleteFile(location: StorageLocationDetails, softDelete?: boolean): Promise<boolean>;
  testConnection(): Promise<ConnectionTestResult>;
}

// -------------------------------------------------------------
// Provider Configuration & Settings Helpers
// -------------------------------------------------------------

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
  serviceAccountJson?: string;
}

export interface MediaStorageSettings {
  primaryProvider: StorageProviderType;
  backupEnabled: boolean;
  backupProvider: StorageProviderType;
  s3: S3Config;
  googleDrive: GoogleDriveConfig;
}

export function getMediaStorageSettings(): MediaStorageSettings {
  const getSetting = (k: string, defaultVal: string) => {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(k) as { value: string } | undefined;
    return row ? row.value : defaultVal;
  };

  let s3Config: S3Config = { bucket: '', region: 'ap-south-1', prefix: 'saaz-ledger/media', encryption: 'AES256', versioning: false };
  let gdriveConfig: GoogleDriveConfig = { folderId: '', sharedDrive: '', connectedEmail: '', tokenHealth: 'not_configured' };

  try {
    s3Config = { ...s3Config, ...JSON.parse(getSetting('media_s3_config', '{}')) };
  } catch {
    // pass
  }

  try {
    gdriveConfig = { ...gdriveConfig, ...JSON.parse(getSetting('media_gdrive_config', '{}')) };
  } catch {
    // pass
  }

  return {
    primaryProvider: (getSetting('media_primary_provider', 'local_disk') as StorageProviderType),
    backupEnabled: getSetting('media_backup_enabled', '0') === '1',
    backupProvider: (getSetting('media_backup_provider', 'google_drive') as StorageProviderType),
    s3: s3Config,
    googleDrive: gdriveConfig,
  };
}

export function saveMediaStorageSettings(settings: Partial<MediaStorageSettings>): void {
  db.transaction(() => {
    if (settings.primaryProvider) {
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value, is_secret) VALUES (?, ?, 0)')
        .run('media_primary_provider', settings.primaryProvider);
    }
    if (settings.backupEnabled !== undefined) {
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value, is_secret) VALUES (?, ?, 0)')
        .run('media_backup_enabled', settings.backupEnabled ? '1' : '0');
    }
    if (settings.backupProvider) {
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value, is_secret) VALUES (?, ?, 0)')
        .run('media_backup_provider', settings.backupProvider);
    }
    if (settings.s3) {
      const existing = getMediaStorageSettings().s3;
      const merged = { ...existing, ...settings.s3 };
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value, is_secret) VALUES (?, ?, 1)')
        .run('media_s3_config', JSON.stringify(merged));
    }
    if (settings.googleDrive) {
      const existing = getMediaStorageSettings().googleDrive;
      const merged = { ...existing, ...settings.googleDrive };
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value, is_secret) VALUES (?, ?, 1)')
        .run('media_gdrive_config', JSON.stringify(merged));
    }
  })();
}
