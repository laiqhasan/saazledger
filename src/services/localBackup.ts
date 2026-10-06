/**
 * Pure local-data backup / import logic (storage is injected so it is unit-testable).
 * Guarantees: building a backup only READS storage; importing only ADDS (never overwrites an existing item,
 * vendor or pack draft, never removes any key).
 */
import type { JewelryItem, VendorItem } from '../types/inventory';
import { newClientItemId } from './inventoryPersistence';

export const BACKUP_FORMAT = 'saaz-ledger-local-backup';
export const BACKUP_VERSION = 1;

export const KEY_INVENTORY = 'saaz_ledger_inventory_v1';
export const KEY_CODES = 'saaz_ledger_codes_v1';
export const KEY_VENDORS = 'saaz_ledger_vendors_v1';
export const KEY_TRANSACTIONS = 'saaz_ledger_transactions_v1';
/** Own keys (this app created them): local copy of an in-progress media pack, per clientItemId. */
export const PACK_DRAFT_KEY_PREFIX = 'saaz_media_pack_draft_v1:';
/** Own key: append-only safety net for cached items a server refresh would otherwise drop from the cache. */
export const KEY_DROPPED_SNAPSHOT = 'saaz_ledger_inventory_dropped_snapshot_v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface PackMeta {
  itemId: string;
  clientItemId?: string;
  sku: string;
  syncStatus?: string;
  hasGalleryPack: boolean;
  hasMediaPack: boolean;
  slotCount: number;
  isListingReady?: boolean;
}

export interface LocalBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  inventory: JewelryItem[];
  vendors: VendorItem[];
  codeTables: unknown;
  transactions: unknown[];
  /** in-progress pack drafts kept under PACK_DRAFT_KEY_PREFIX, keyed by clientItemId */
  packDrafts: Record<string, unknown>;
  /** items a server refresh dropped from the cache (kept so nothing is lost silently) */
  droppedSnapshot: JewelryItem[];
  packMetadata: PackMeta[];
  summary: { items: number; localOnlyItems: number; itemsWithPacks: number; packDrafts: number; vendors: number };
}

function readJson<T>(storage: StorageLike, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function readPackDrafts(storage: StorageLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(PACK_DRAFT_KEY_PREFIX)) {
        const v = readJson<unknown>(storage, k, null);
        if (v) out[k.slice(PACK_DRAFT_KEY_PREFIX.length)] = v;
      }
    }
  } catch {
    // ignore
  }
  return out;
}

export function packMetaFor(items: JewelryItem[]): PackMeta[] {
  return items
    .filter((i: any) => i.galleryPack || i.mediaPack)
    .map((i: any) => ({
      itemId: i.id,
      clientItemId: i.clientItemId,
      sku: i.sku,
      syncStatus: i.syncStatus,
      hasGalleryPack: Boolean(i.galleryPack),
      hasMediaPack: Boolean(i.mediaPack),
      slotCount: Array.isArray(i.galleryPack?.slots) ? i.galleryPack.slots.length : 0,
      isListingReady: i.galleryPack?.isListingReady,
    }));
}

/** Read-only snapshot of everything this app keeps in the browser. Auth tokens are NOT included. */
export function buildLocalBackup(storage: StorageLike, now: Date = new Date()): LocalBackup {
  const inventory = readJson<JewelryItem[]>(storage, KEY_INVENTORY, []);
  const vendors = readJson<VendorItem[]>(storage, KEY_VENDORS, []);
  const packDrafts = readPackDrafts(storage);
  const droppedSnapshot = readJson<JewelryItem[]>(storage, KEY_DROPPED_SNAPSHOT, []);
  const itemsArr = Array.isArray(inventory) ? inventory : [];
  const packMetadata = packMetaFor(itemsArr);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    inventory: itemsArr,
    vendors: Array.isArray(vendors) ? vendors : [],
    codeTables: readJson<unknown>(storage, KEY_CODES, null),
    transactions: readJson<unknown[]>(storage, KEY_TRANSACTIONS, []),
    packDrafts,
    droppedSnapshot: Array.isArray(droppedSnapshot) ? droppedSnapshot : [],
    packMetadata,
    summary: {
      items: itemsArr.length,
      localOnlyItems: itemsArr.filter((i) => i.syncStatus === 'local').length,
      itemsWithPacks: packMetadata.length,
      packDrafts: Object.keys(packDrafts).length,
      vendors: Array.isArray(vendors) ? vendors.length : 0,
    },
  };
}

export function backupFileName(now: Date = new Date()): string {
  return `saaz-ledger-local-backup-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

export function parseLocalBackup(text: string): { ok: true; backup: LocalBackup } | { ok: false; error: string } {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  if (!data || data.format !== BACKUP_FORMAT) return { ok: false, error: 'This is not a Saaz Ledger local backup file.' };
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
    return { ok: false, error: `Unsupported backup version ${data.version}.` };
  }
  if (!Array.isArray(data.inventory)) return { ok: false, error: 'Backup has no inventory list.' };
  return {
    ok: true,
    backup: {
      ...data,
      vendors: Array.isArray(data.vendors) ? data.vendors : [],
      transactions: Array.isArray(data.transactions) ? data.transactions : [],
      packDrafts: data.packDrafts && typeof data.packDrafts === 'object' ? data.packDrafts : {},
      droppedSnapshot: Array.isArray(data.droppedSnapshot) ? data.droppedSnapshot : [],
      packMetadata: Array.isArray(data.packMetadata) ? data.packMetadata : [],
    } as LocalBackup,
  };
}

export interface ImportPlan {
  addItems: JewelryItem[];
  skippedItems: number;
  addVendors: VendorItem[];
  addPackDrafts: Record<string, unknown>;
  skippedPackDrafts: number;
}

/** Decide what a backup would ADD to the current data. Existing items/vendors/drafts always win. */
export function planImport(
  backup: LocalBackup,
  current: { inventory: JewelryItem[]; vendors: VendorItem[]; packDraftKeys: string[] }
): ImportPlan {
  const ids = new Set(current.inventory.map((i) => i.id));
  const cids = new Set(current.inventory.map((i) => i.clientItemId).filter(Boolean) as string[]);
  const skus = new Set(current.inventory.map((i) => (i.sku || '').toUpperCase()).filter(Boolean));
  const addItems: JewelryItem[] = [];
  let skippedItems = 0;
  for (const raw of [...backup.inventory, ...backup.droppedSnapshot]) {
    if (!raw || typeof raw !== 'object' || !raw.id) { skippedItems++; continue; }
    const sku = (raw.sku || '').toUpperCase();
    const placeholder = !sku || sku.startsWith('PENDING-');
    if (ids.has(raw.id) || (raw.clientItemId && cids.has(raw.clientItemId)) || (!placeholder && skus.has(sku))) {
      skippedItems++;
      continue;
    }
    const clientItemId = raw.clientItemId || newClientItemId();
    // Not known to this server's inventory: flag as local so the user can retry sync (never auto-deleted).
    addItems.push({ ...raw, clientItemId, syncStatus: 'local', syncError: raw.syncError || 'Restored from local backup; not yet confirmed on server' });
    ids.add(raw.id);
    cids.add(clientItemId);
    if (!placeholder) skus.add(sku);
  }
  const vIds = new Set(current.vendors.map((v) => v.id));
  const addVendors = backup.vendors.filter((v) => v && v.id && !vIds.has(v.id));
  const have = new Set(current.packDraftKeys);
  const addPackDrafts: Record<string, unknown> = {};
  let skippedPackDrafts = 0;
  for (const [k, v] of Object.entries(backup.packDrafts)) {
    if (have.has(k)) skippedPackDrafts++;
    else addPackDrafts[k] = v;
  }
  return { addItems, skippedItems, addVendors, addPackDrafts, skippedPackDrafts };
}

/** Applies a plan using setItem only (no removeItem, no clear). Returns the resulting lists. */
export function applyImport(
  storage: StorageLike,
  plan: ImportPlan
): { inventory: JewelryItem[]; vendors: VendorItem[] } {
  const inventory = readJson<JewelryItem[]>(storage, KEY_INVENTORY, []);
  const vendors = readJson<VendorItem[]>(storage, KEY_VENDORS, []);
  const nextInv = [...plan.addItems, ...(Array.isArray(inventory) ? inventory : [])];
  const nextVendors = [...(Array.isArray(vendors) ? vendors : []), ...plan.addVendors];
  if (plan.addItems.length) storage.setItem(KEY_INVENTORY, JSON.stringify(nextInv));
  if (plan.addVendors.length) storage.setItem(KEY_VENDORS, JSON.stringify(nextVendors));
  for (const [cid, pack] of Object.entries(plan.addPackDrafts)) {
    storage.setItem(PACK_DRAFT_KEY_PREFIX + cid, JSON.stringify(pack));
  }
  return { inventory: nextInv, vendors: nextVendors };
}

/**
 * Append-only safety net: remember cached items that a refresh would drop. Never removes anything; items
 * already in the snapshot (by id) are kept as they are.
 */
export function snapshotDroppedItems(storage: StorageLike, dropped: JewelryItem[]): void {
  if (!dropped.length) return;
  try {
    const prev = readJson<JewelryItem[]>(storage, KEY_DROPPED_SNAPSHOT, []);
    const have = new Set((Array.isArray(prev) ? prev : []).map((i) => i.id));
    const add = dropped.filter((i) => !have.has(i.id));
    if (add.length) storage.setItem(KEY_DROPPED_SNAPSHOT, JSON.stringify([...(Array.isArray(prev) ? prev : []), ...add]));
  } catch {
    // never block a refresh
  }
}

/** Browser-side wrappers (DOM only): download the backup file / read an import file. */
export function downloadLocalBackup(storage: StorageLike = localStorage): { fileName: string; summary: LocalBackup['summary'] } {
  const backup = buildLocalBackup(storage);
  const fileName = backupFileName();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { fileName, summary: backup.summary };
}
