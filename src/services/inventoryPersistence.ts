/**
 * Pure, dependency-injected inventory persistence logic (no localStorage / DOM access) so it can be
 * unit-tested. Rules:
 *  - create vs update is an explicit intent (create -> POST, update -> PUT), never inferred from local cache
 *  - success is only reported after the server confirmed and returned the authoritative item
 *  - failures are reported (never swallowed) and a retry reuses the same idempotency key / reserved SKU
 */
import type { JewelryItem } from '../types/inventory';

export type SaveIntent = 'create' | 'update';

export interface SaveMeta {
  intent: SaveIntent;
  clientItemId?: string;
}

export interface PersistDeps {
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  getHeaders: () => Record<string, string>;
  /** Reserves a global SKU. Only called for creates that have no reserved SKU yet. */
  allocateSku?: (item: JewelryItem) => Promise<{ sku: string; formattedSerial?: string; serial?: string }>;
  baseUrl?: string;
}

/**
 * The server item DTO doesn't carry client-held media packs. Carry the draft's galleryPack/mediaPack over
 * and re-bind them to the server-issued id/SKU so packs made for a not-yet-saved item belong to the saved one.
 */
export function carryMediaPacks(draft: JewelryItem, saved: JewelryItem): JewelryItem {
  const out: any = { ...saved };
  const gp: any = (saved as any).galleryPack || (draft as any).galleryPack;
  const mp: any = (saved as any).mediaPack || (draft as any).mediaPack;
  if (gp) {
    out.galleryPack = {
      ...gp,
      productId: saved.id,
      sku: saved.sku,
      slots: Array.isArray(gp.slots) ? gp.slots.map((sl: any) => (sl && 'productId' in sl ? { ...sl, productId: saved.id } : sl)) : gp.slots,
    };
  }
  if (mp) out.mediaPack = mp && typeof mp === 'object' && 'productId' in mp ? { ...mp, productId: saved.id } : mp;
  return out as JewelryItem;
}

export type PersistResult =
  | { ok: true; item: JewelryItem; intent: SaveIntent; idempotentReplay: boolean }
  | { ok: false; intent: SaveIntent; error: string; status: number; retryable: boolean; reservedSku?: string; reservedSerial?: string };

export const PENDING_SKU_PREFIX = 'PENDING-';

export function newClientItemId(): string {
  try {
    const c: any = (globalThis as any).crypto;
    if (c?.randomUUID) return `cli_${c.randomUUID()}`;
  } catch {
    // fall through
  }
  return `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isPlaceholderSku(sku?: string): boolean {
  return !sku || sku.startsWith(PENDING_SKU_PREFIX);
}

/** Decide intent from explicit knowledge: only items the server is known to hold are updated. */
export function decideSaveIntent(itemToEdit: JewelryItem | null | undefined): SaveIntent {
  if (!itemToEdit) return 'create';
  if (itemToEdit.syncStatus === 'local') return 'create';
  return 'update';
}

const CLIENT_ONLY_KEYS = ['syncStatus', 'syncError'] as const;

function stripClientOnly(item: JewelryItem): Record<string, any> {
  const copy: Record<string, any> = { ...item };
  for (const k of CLIENT_ONLY_KEYS) delete copy[k];
  return copy;
}

async function readError(res: { status: number; json: () => Promise<any> }): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error) return String(body.error);
  } catch {
    // ignore
  }
  return `Server responded with HTTP ${res.status}`;
}

function isRetryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export async function persistItem(
  intent: SaveIntent,
  draft: JewelryItem,
  deps: PersistDeps
): Promise<PersistResult> {
  const base = deps.baseUrl ?? '';
  let reservedSku: string | undefined;
  let reservedSerial: string | undefined;

  try {
    if (intent === 'update') {
      const res = await deps.fetchImpl(`${base}/api/inventory/${encodeURIComponent(draft.id)}`, {
        method: 'PUT',
        headers: deps.getHeaders(),
        body: JSON.stringify(stripClientOnly(draft)),
      });
      if (!res.ok) {
        return { ok: false, intent, status: res.status, error: await readError(res), retryable: isRetryable(res.status) };
      }
      const data = await res.json();
      if (!data?.item) {
        return { ok: false, intent, status: res.status, error: 'Server did not return the saved item.', retryable: true };
      }
      return { ok: true, intent, item: carryMediaPacks(draft, { ...data.item, syncStatus: 'synced' }), idempotentReplay: false };
    }

    // ---- create ----
    const clientItemId = draft.clientItemId || newClientItemId();
    let sku = draft.sku;
    let serial = draft.serial;
    if (isPlaceholderSku(sku)) {
      if (deps.allocateSku) {
        const alloc = await deps.allocateSku(draft);
        sku = alloc.sku;
        serial = alloc.formattedSerial || alloc.serial || serial;
        reservedSku = sku;
        reservedSerial = serial;
      } else {
        sku = undefined as any; // let the server allocate
      }
    }
    const body: Record<string, any> = { ...stripClientOnly(draft), clientItemId };
    delete body.id; // server issues the authoritative id
    if (sku) { body.sku = sku; body.serial = serial; } else { delete body.sku; }

    const headers = { ...deps.getHeaders(), 'Idempotency-Key': clientItemId };
    const res = await deps.fetchImpl(`${base}/api/inventory`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        ok: false, intent, status: res.status, error: await readError(res),
        retryable: isRetryable(res.status), reservedSku, reservedSerial,
      };
    }
    const data = await res.json();
    if (!data?.item) {
      return { ok: false, intent, status: res.status, error: 'Server did not return the saved item.', retryable: true, reservedSku, reservedSerial };
    }
    return {
      ok: true, intent,
      item: carryMediaPacks(draft, { ...data.item, clientItemId, syncStatus: 'synced' }),
      idempotentReplay: Boolean(data.idempotentReplay),
    };
  } catch (err: any) {
    return {
      ok: false, intent, status: 0, retryable: true, reservedSku, reservedSerial,
      error: `Could not reach the server: ${err?.message || err}`,
    };
  }
}

/** Marks a draft as existing only locally so it is visibly flagged and retryable. */
export function toLocalOnlyItem(draft: JewelryItem, clientItemId: string, error: string, reservedSku?: string, reservedSerial?: string): JewelryItem {
  const sku = !isPlaceholderSku(draft.sku)
    ? draft.sku
    : reservedSku || `${PENDING_SKU_PREFIX}${clientItemId.slice(-8).toUpperCase()}`;
  return {
    ...draft,
    sku,
    serial: reservedSerial || draft.serial,
    clientItemId,
    syncStatus: 'local',
    syncError: error,
  };
}

/** Replace the draft (matched by id or clientItemId) with the server-confirmed item, no duplicates. */
export function mergeSavedItem(inventory: JewelryItem[], draft: JewelryItem, saved: JewelryItem): JewelryItem[] {
  const matches = (i: JewelryItem) =>
    i.id === draft.id ||
    i.id === saved.id ||
    (!!saved.clientItemId && i.clientItemId === saved.clientItemId) ||
    (!!saved.sku && i.sku?.toUpperCase() === saved.sku.toUpperCase());
  const idx = inventory.findIndex(matches);
  const rest = inventory.filter((i) => !matches(i));
  if (idx < 0) return [saved, ...inventory];
  const out = [...rest];
  out.splice(Math.min(idx, out.length), 0, saved);
  return out;
}

/** Insert/replace a local-only draft in the list. */
export function upsertLocalItem(inventory: JewelryItem[], local: JewelryItem): JewelryItem[] {
  const idx = inventory.findIndex(
    (i) => i.id === local.id || (!!local.clientItemId && i.clientItemId === local.clientItemId)
  );
  if (idx < 0) return [local, ...inventory];
  const out = [...inventory];
  out[idx] = local;
  return out;
}

/**
 * Server list is authoritative, but local-only drafts the server doesn't know yet must survive a refresh.
 */
export function mergeServerWithLocalOnly(serverItems: JewelryItem[], cached: JewelryItem[]): JewelryItem[] {
  const cachedById = new Map(cached.map((c) => [c.id, c]));
  const synced = serverItems.map((i) => {
    const c: any = cachedById.get(i.id);
    const out: any = { ...i, syncStatus: 'synced' as const };
    // media packs live client-side; don't lose them when the server list replaces the cache
    if (c?.galleryPack && !out.galleryPack) out.galleryPack = c.galleryPack;
    if (c?.mediaPack && !out.mediaPack) out.mediaPack = c.mediaPack;
    return out as JewelryItem;
  });
  const clientIds = new Set(synced.map((i) => i.clientItemId).filter(Boolean));
  const skus = new Set(synced.map((i) => i.sku?.toUpperCase()));
  const ids = new Set(synced.map((i) => i.id));
  const localOnly = cached.filter(
    (i) =>
      i.syncStatus === 'local' &&
      !ids.has(i.id) &&
      !(i.clientItemId && clientIds.has(i.clientItemId)) &&
      !(!isPlaceholderSku(i.sku) && skus.has(i.sku.toUpperCase()))
  );
  return [...localOnly, ...synced];
}

/** Items eligible for the browser->server migration safeguard (never upload unconfirmed placeholders). */
export function migratableItems(items: JewelryItem[]): JewelryItem[] {
  return items.filter((i) => i.syncStatus !== 'local' && !isPlaceholderSku(i.sku));
}
