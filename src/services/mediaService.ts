import type {
  MediaAsset,
  MediaStorageSettings,
  ConnectionTestResult,
  MediaSlotType,
} from '../types/media';

const BASE_URL = ''; // Relative path leverages Vite dev proxy & prod origin

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
