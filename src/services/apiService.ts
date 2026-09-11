import type { JewelryItem, VendorItem, CodeTables, StockMovement } from '../types/inventory';
import { getStoredInventory, saveStoredInventory, getStoredCodeTables } from './storage';
import { getStoredVendors, saveStoredVendors } from './vendorService';
import { savePhotoToClientCache } from './photoCacheService';

const BASE_URL = ''; // Relative URL leverages Vite proxy in dev and same-origin in prod

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem('saaz_auth_token') || localStorage.getItem('saaz_token') || null;
  } catch {
    return null;
  }
}

export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * Fetch inventory from backend SQLite database.
 * Updates localStorage cache on success, falls back to localStorage on network error.
 */
export async function fetchInventory(): Promise<JewelryItem[]> {
  try {
    const res = await fetch(`${BASE_URL}/api/inventory?include_deleted=true`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.items) && data.items.length > 0) {
        saveStoredInventory(data.items);
        return data.items;
      }
    }
  } catch (err) {
    console.warn('Backend /api/inventory unavailable, using local cache:', err);
  }
  return getStoredInventory();
}

/**
 * Persist or update an item to backend SQLite database.
 */
export async function saveItem(item: JewelryItem): Promise<JewelryItem> {
  const current = getStoredInventory();
  const existingIdx = current.findIndex((i) => i.id === item.id || i.sku.toUpperCase() === item.sku.toUpperCase());
  let updatedList: JewelryItem[];
  if (existingIdx >= 0) {
    updatedList = [...current];
    updatedList[existingIdx] = item;
  } else {
    updatedList = [item, ...current];
  }
  saveStoredInventory(updatedList);

  try {
    if (existingIdx >= 0) {
      const res = await fetch(`${BASE_URL}/api/inventory/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.item) return data.item;
      }
    } else {
      const res = await fetch(`${BASE_URL}/api/inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.item) return data.item;
      }
    }
  } catch (err) {
    console.warn('Failed syncing item to backend, saved to offline cache:', err);
  }

  return item;
}

/**
 * Delete an item from backend SQLite database and local cache.
 */
export async function deleteItem(id: string, hard = false, reason?: string): Promise<boolean> {
  const current = getStoredInventory();
  if (hard) {
    saveStoredInventory(current.filter((i) => i.id !== id));
  } else {
    saveStoredInventory(
      current.map((i) =>
        i.id === id
          ? { ...i, isDeleted: true, deletedAt: new Date().toISOString(), deletedReason: reason || 'User deleted' }
          : i
      )
    );
  }

  try {
    const res = await fetch(`${BASE_URL}/api/inventory/${id}?hard=${hard ? 'true' : 'false'}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ hard, reason }),
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed deleting item on backend, updated locally:', err);
    return true;
  }
}

export async function restoreItem(id: string): Promise<boolean> {
  const current = getStoredInventory();
  saveStoredInventory(
    current.map((i) =>
      i.id === id ? { ...i, isDeleted: false, deletedAt: undefined, deletedReason: undefined } : i
    )
  );

  try {
    const res = await fetch(`${BASE_URL}/api/inventory/${id}/restore`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed restoring item on backend, restored locally:', err);
    return true;
  }
}

export async function bulkDeleteItems(ids: string[], hard = false, reason?: string): Promise<boolean> {
  const current = getStoredInventory();
  const idSet = new Set(ids);
  if (hard) {
    saveStoredInventory(current.filter((i) => !idSet.has(i.id)));
  } else {
    saveStoredInventory(
      current.map((i) =>
        idSet.has(i.id)
          ? { ...i, isDeleted: true, deletedAt: new Date().toISOString(), deletedReason: reason || 'User deleted' }
          : i
      )
    );
  }

  try {
    const res = await fetch(`${BASE_URL}/api/inventory/bulk-delete`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ ids, hard, reason }),
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed bulk delete on backend, updated locally:', err);
    return true;
  }
}

export async function bulkRestoreItems(ids: string[]): Promise<boolean> {
  const current = getStoredInventory();
  const idSet = new Set(ids);
  saveStoredInventory(
    current.map((i) =>
      idSet.has(i.id) ? { ...i, isDeleted: false, deletedAt: undefined, deletedReason: undefined } : i
    )
  );

  try {
    const res = await fetch(`${BASE_URL}/api/inventory/bulk-restore`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed bulk restore on backend, updated locally:', err);
    return true;
  }
}

export async function emptyTrash(): Promise<boolean> {
  const current = getStoredInventory();
  saveStoredInventory(current.filter((i) => !i.isDeleted));

  try {
    const res = await fetch(`${BASE_URL}/api/inventory/empty-trash`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed empty trash on backend, updated locally:', err);
    return true;
  }
}

/** Fetch vendors master data from backend SQLite database. */
export async function fetchVendors(): Promise<VendorItem[]> {
  try {
    const res = await fetch(`${BASE_URL}/api/vendors`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.vendors) && data.vendors.length > 0) {
        saveStoredVendors(data.vendors);
        return data.vendors;
      }
    }
  } catch (err) {
    console.warn('Backend /api/vendors unavailable, using local cache:', err);
  }
  return getStoredVendors();
}

export async function saveVendor(vendor: VendorItem): Promise<VendorItem> {
  const current = getStoredVendors();
  const existingIdx = current.findIndex((v) => v.id === vendor.id || v.code.toUpperCase() === vendor.code.toUpperCase());
  let updatedList: VendorItem[];
  if (existingIdx >= 0) {
    updatedList = [...current];
    updatedList[existingIdx] = vendor;
  } else {
    updatedList = [...current, vendor];
  }
  saveStoredVendors(updatedList);

  try {
    const res = await fetch(`${BASE_URL}/api/vendors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vendor),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.vendor) return data.vendor;
    }
  } catch (err) {
    console.warn('Failed syncing vendor to backend, saved to offline cache:', err);
  }

  return vendor;
}

export async function recordSaleOnBackend(saleData: {
  itemId: string;
  quantitySold: number;
  salePrice: number;
  channel?: string;
  externalOrderId?: string;
  notes?: string;
}): Promise<{ stockMovement: StockMovement; remainingStock: number } | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/inventory/sale`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(saleData),
    });
    if (res.ok) return await res.json();
  } catch (err) {
    console.warn('Failed recording sale to backend:', err);
  }
  return null;
}

export async function uploadPhotoToBackend(base64Data: string): Promise<{ url: string; hash: string } | null> {
  if (!base64Data || !base64Data.startsWith('data:')) return null;
  try {
    const res = await fetch(`${BASE_URL}/api/photos/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Data }),
    });
    if (res.ok) {
      const data = await res.json();
      savePhotoToClientCache(data.url, base64Data).catch(() => {});
      return data;
    }
  } catch (err) {
    console.warn('Failed uploading photo to backend:', err);
  }
  return null;
}

/**
 * Generates the Register Item "White BG" image through the same validated
 * deterministic white-cover pipeline used by Media Pack Slot 1.
 *
 * Important: it no longer trusts the older /clean-background route, which could
 * return the original rectangular photo while still claiming white-background success.
 */
export async function cleanPhotoBackground(
  imageBase64: string,
  filename?: string
): Promise<{
  success: boolean;
  originalUrl: string;
  originalFilename: string;
  cleanCoverUrl: string;
  cleanFilename: string;
  whiteBgBase64: string;
  providerUsed: string;
  notes?: string;
  quality?: any;
} | null> {
  if (!imageBase64) return null;

  try {
    const res = await fetch(`${BASE_URL}/api/media/white-cover`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        imageBase64,
        backgroundMode: 'pure_white',
        occupancyPercent: 82,
      }),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success || !data?.url || !data?.base64) {
      console.warn('White background generation needs review:', data?.error || `HTTP ${res.status}`);
      return null;
    }

    if (data.backgroundMode !== 'pure_white' || data.quality?.isAcceptable === false) {
      console.warn('White background rejected by quality gate:', data.quality?.issues || []);
      return null;
    }

    const cleanFilename = String(data.url).split('/').pop() || `white_${filename || 'jewelry.jpg'}`;
    return {
      success: true,
      originalUrl: imageBase64,
      originalFilename: filename || 'jewelry.jpg',
      cleanCoverUrl: data.url,
      cleanFilename,
      whiteBgBase64: data.base64,
      providerUsed: 'deterministic-white-cover',
      notes: Array.isArray(data.quality?.issues) ? data.quality.issues.join(' ') : undefined,
      quality: data.quality,
    };
  } catch (err) {
    console.warn('Failed cleaning photo background:', err);
    return null;
  }
}

export async function syncBrowserDataToBackend(
  items: JewelryItem[],
  vendors: VendorItem[],
  codeTables?: CodeTables
): Promise<number> {
  try {
    const res = await fetch(`${BASE_URL}/api/backup/migrate-browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inventory: items,
        vendors,
        codeTables: codeTables || getStoredCodeTables(),
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.importedItemsCount || 0;
    }
  } catch (err) {
    console.warn('Browser data migration check note:', err);
  }
  return 0;
}

export async function fetchGlobalSkuStatus(): Promise<any> {
  try {
    const res = await fetch(`${BASE_URL}/api/sku/sequence-status`);
    if (res.ok) return await res.json();
  } catch (err) {
    console.warn('Failed fetching SKU status:', err);
  }
  return null;
}

export async function allocateBackendGlobalSku(typeCode: string, stoneCode: string, colorCode: string): Promise<any> {
  const token = localStorage.getItem('saaz_token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/api/sku/allocate-global`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ typeCode, stoneCode, colorCode }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to allocate global SKU');
  }
  return await res.json();
}

export async function previewBackendGlobalSku(typeCode: string, stoneCode: string, colorCode: string): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/api/sku/preview?typeCode=${typeCode}&stoneCode=${stoneCode}&colorCode=${colorCode}`);
    if (res.ok) {
      const data = await res.json();
      return data.previewSku;
    }
  } catch {
    // fallback
  }
  return `${typeCode}${stoneCode}${colorCode}-XXXXX`;
}

export async function fetchNeedsAttention(category?: string): Promise<any[]> {
  try {
    const url = category ? `${BASE_URL}/api/needs-attention?category=${category}` : `${BASE_URL}/api/needs-attention`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      return data.items || [];
    }
  } catch (err) {
    console.warn('Failed to fetch needs attention items:', err);
  }
  return [];
}

export async function resolveNeedsAttention(id: string): Promise<boolean> {
  try {
    const token = localStorage.getItem('saaz_token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${BASE_URL}/api/needs-attention/${id}/resolve`, {
      method: 'POST',
      headers,
    });
    return res.ok;
  } catch {
    return false;
  }
}
