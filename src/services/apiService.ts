import type { JewelryItem, VendorItem, CodeTables, StockMovement } from '../types/inventory';
import { getStoredInventory, saveStoredInventory, getStoredCodeTables } from './storage';
import { getStoredVendors, saveStoredVendors } from './vendorService';

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
    const res = await fetch(`${BASE_URL}/api/inventory`);
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
  // Always update local cache first for instant UI response
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
      // Update
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
      // Create
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
export async function deleteItem(id: string): Promise<boolean> {
  const current = getStoredInventory();
  saveStoredInventory(current.filter((i) => i.id !== id));

  try {
    const res = await fetch(`${BASE_URL}/api/inventory/${id}`, { method: 'DELETE' });
    return res.ok;
  } catch (err) {
    console.warn('Failed deleting item on backend, deleted locally:', err);
    return true;
  }
}

/**
 * Fetch vendors master data from backend SQLite database.
 */
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

/**
 * Save or update a vendor on backend SQLite database.
 */
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

/**
 * Records a sale transaction with FIFO cost basis depletion on backend.
 */
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
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed recording sale to backend:', err);
  }
  return null;
}

/**
 * Uploads a base64 photo to server content-addressable disk storage.
 * Returns public URL and sha256 hash.
 */
export async function uploadPhotoToBackend(base64Data: string): Promise<{ url: string; hash: string } | null> {
  if (!base64Data || !base64Data.startsWith('data:')) {
    return null;
  }
  try {
    const res = await fetch(`${BASE_URL}/api/photos/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64Data }),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed uploading photo to backend:', err);
  }
  return null;
}

/**
 * Safe one-time browser migration:
 * Imports existing browser items and vendors into SQLite without overwriting.
 */
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

// -------------------------------------------------------------
// Global SKU & Sequence Helpers
// -------------------------------------------------------------

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

// -------------------------------------------------------------
// Operational Needs Attention Helpers
// -------------------------------------------------------------

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

