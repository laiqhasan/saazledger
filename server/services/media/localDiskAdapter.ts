import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type {
  StorageProviderAdapter,
  UploadInitParams,
  UploadSession,
  StorageLocationDetails,
  RemoteFileMetadata,
  ConnectionTestResult,
  CopyParams,
} from './storageProvider';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MEDIA_DIR = path.resolve(__dirname, '../../../uploads/photos');

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

export class LocalDiskStorageAdapter implements StorageProviderAdapter {
  readonly providerName = 'local_disk';

  async initiateUpload(params: UploadInitParams): Promise<UploadSession> {
    const ext = path.extname(params.filename) || '.webp';
    const storageKey = `/api/photos/${params.mediaId}${ext}`;

    return {
      sessionId: `sess_local_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      mediaId: params.mediaId,
      provider: 'local_disk',
      uploadUrl: `/api/media/upload-direct?mediaId=${params.mediaId}`,
      storageKey,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      isMultipart: false,
    };
  }

  async completeUpload(session: UploadSession): Promise<StorageLocationDetails> {
    return {
      mediaId: session.mediaId,
      provider: 'local_disk',
      storageRole: 'primary',
      storageKey: session.storageKey,
      publicDeliveryUrl: session.storageKey,
      replicationStatus: 'synced',
    };
  }

  async cancelUpload(_session: UploadSession): Promise<void> {
    // No-op for local
  }

  async getFileMetadata(location: StorageLocationDetails): Promise<RemoteFileMetadata> {
    const filename = path.basename(location.storageKey);
    const filePath = path.join(MEDIA_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return { exists: false, byteSize: 0, mimeType: 'application/octet-stream' };
    }

    const stat = fs.statSync(filePath);
    const buf = fs.readFileSync(filePath);
    const checksumSha256 = crypto.createHash('sha256').update(buf).digest('hex');

    return {
      exists: true,
      byteSize: stat.size,
      mimeType: 'image/webp',
      checksumSha256,
    };
  }

  async getAuthorizedReadUrl(location: StorageLocationDetails): Promise<string> {
    return location.publicDeliveryUrl || location.storageKey;
  }

  async verifyContent(location: StorageLocationDetails, expectedSha256: string): Promise<boolean> {
    const meta = await this.getFileMetadata(location);
    if (!meta.exists || !meta.checksumSha256) return false;
    return meta.checksumSha256.toLowerCase() === expectedSha256.toLowerCase();
  }

  async copyFile(sourceLocation: StorageLocationDetails, targetParams: CopyParams): Promise<StorageLocationDetails> {
    const srcFilename = path.basename(sourceLocation.storageKey);
    const srcPath = path.join(MEDIA_DIR, srcFilename);

    const targetFilename = path.basename(targetParams.targetKey);
    const targetPath = path.join(MEDIA_DIR, targetFilename);

    if (fs.existsSync(srcPath) && !fs.existsSync(targetPath)) {
      fs.copyFileSync(srcPath, targetPath);
    }

    return {
      mediaId: sourceLocation.mediaId,
      provider: 'local_disk',
      storageRole: targetParams.targetRole,
      storageKey: `/api/photos/${targetFilename}`,
      publicDeliveryUrl: `/api/photos/${targetFilename}`,
      replicationStatus: 'synced',
    };
  }

  async deleteFile(location: StorageLocationDetails, softDelete = true): Promise<boolean> {
    if (softDelete) return true;

    const storageKey = location.storageKey || (location as any).storage_key;
    if (!storageKey) return true;

    const filename = path.basename(storageKey);
    const filePath = path.join(MEDIA_DIR, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return true;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const startTime = Date.now();
    const testFile = path.join(MEDIA_DIR, `.test_${Date.now()}.tmp`);

    try {
      fs.writeFileSync(testFile, 'saaz_ledger_storage_probe');
      fs.unlinkSync(testFile);

      return {
        success: true,
        provider: 'local_disk',
        message: 'Local server storage is read/write accessible.',
        testedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
        details: {
          folderId: MEDIA_DIR,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        provider: 'local_disk',
        message: `Local disk access failed: ${err.message}`,
        testedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
      };
    }
  }
}
