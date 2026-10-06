/**
 * Client side of the unpublished media pack backup. Pure + dependency-injected.
 * Failures are returned, never thrown, never block the user, and NEVER delete the local copy.
 */
import type { StorageLike } from './localBackup';
import { PACK_DRAFT_KEY_PREFIX } from './localBackup';

export type BackupStatus = 'idle' | 'saving' | 'ok' | 'failed';

export interface BackupDeps {
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
  getHeaders: () => Record<string, string>;
  baseUrl?: string;
}

export function packBackupLabel(status: BackupStatus, detail?: string): string {
  switch (status) {
    case 'saving': return 'Backing up pack to server...';
    case 'ok': return 'Pack backed up to server';
    case 'failed': return `Backup failed – local only${detail ? ` (${detail})` : ''}`;
    default: return '';
  }
}

/** Own-key local copy (setItem only). Returns false when storage is unavailable/full; never throws. */
export function saveLocalPackDraft(storage: StorageLike, clientItemId: string, pack: unknown): boolean {
  try {
    storage.setItem(PACK_DRAFT_KEY_PREFIX + clientItemId, JSON.stringify(pack));
    return true;
  } catch {
    return false;
  }
}

export function loadLocalPackDraft(storage: StorageLike, clientItemId: string): any | null {
  try {
    const raw = storage.getItem(PACK_DRAFT_KEY_PREFIX + clientItemId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function backupPackToServer(
  clientItemId: string,
  pack: unknown,
  meta: { sku?: string; itemId?: string },
  deps: BackupDeps
): Promise<{ ok: true; changed: boolean } | { ok: false; status: number; error: string }> {
  try {
    const res = await deps.fetchImpl(`${deps.baseUrl ?? ''}/api/media-pack-drafts/${encodeURIComponent(clientItemId)}`, {
      method: 'PUT',
      headers: deps.getHeaders(),
      body: JSON.stringify({ pack, sku: meta.sku, itemId: meta.itemId }),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok) return { ok: false, status: res.status, error: body?.error || `HTTP ${res.status}` };
    return { ok: true, changed: Boolean(body?.changed) };
  } catch (err: any) {
    return { ok: false, status: 0, error: `Could not reach the server: ${err?.message || err}` };
  }
}

export async function fetchPackFromServer(clientItemId: string, deps: BackupDeps): Promise<any | null> {
  try {
    const res = await deps.fetchImpl(`${deps.baseUrl ?? ''}/api/media-pack-drafts/${encodeURIComponent(clientItemId)}`, {
      headers: deps.getHeaders(),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.draft?.pack ?? null;
  } catch {
    return null;
  }
}

/**
 * Restore order when opening a form / loading: local item pack -> own local draft key -> server copy.
 * Only used when the local pack is MISSING; an existing local pack is never replaced.
 */
export async function resolvePackForItem(
  clientItemId: string | undefined,
  localPack: unknown | null | undefined,
  storage: StorageLike,
  deps: BackupDeps
): Promise<{ pack: any | null; source: 'local' | 'local-draft' | 'server' | 'none' }> {
  if (localPack) return { pack: localPack, source: 'local' };
  if (!clientItemId) return { pack: null, source: 'none' };
  const draft = loadLocalPackDraft(storage, clientItemId);
  if (draft) return { pack: draft, source: 'local-draft' };
  const server = await fetchPackFromServer(clientItemId, deps);
  if (server) {
    saveLocalPackDraft(storage, clientItemId, server); // cache it; add-only
    return { pack: server, source: 'server' };
  }
  return { pack: null, source: 'none' };
}

/** After an inventory load: fill ONLY missing packs on items from the server backup. Never overwrites. */
export async function restoreMissingPacks<T extends { clientItemId?: string; galleryPack?: any; mediaPack?: any; id: string }>(
  items: T[],
  deps: BackupDeps,
  maxFetches = 20
): Promise<{ items: T[]; restored: string[] }> {
  const restored: string[] = [];
  let listed: Set<string> | null = null;
  try {
    const res = await deps.fetchImpl(`${deps.baseUrl ?? ''}/api/media-pack-drafts`, { headers: deps.getHeaders() });
    if (res.ok) {
      const body = await res.json();
      listed = new Set((body?.drafts || []).map((d: any) => d.clientItemId));
    }
  } catch { /* offline: nothing to restore */ }
  if (!listed) return { items, restored };
  const out: T[] = [];
  let fetches = 0;
  for (const it of items) {
    if (!it.galleryPack && !it.mediaPack && it.clientItemId && listed.has(it.clientItemId) && fetches < maxFetches) {
      fetches++;
      const pack = await fetchPackFromServer(it.clientItemId, deps);
      if (pack) {
        restored.push(it.id);
        out.push({ ...it, galleryPack: pack, mediaPack: pack.mediaPack || it.mediaPack });
        continue;
      }
    }
    out.push(it);
  }
  return { items: out, restored };
}
