/**
 * Durable server-side copy of UNPUBLISHED media packs, keyed by the client's idempotency id.
 * Rules: URLs only (data: URLs are first saved through the photo-save helper), size-capped, upsert-only
 * (this module never deletes a draft), and linking to a saved item never fails an inventory save.
 */
import crypto from 'crypto';
import { db } from '../db/database';
import { saveBase64Photo } from './photoService';

export const MAX_PACK_BYTES = 2 * 1024 * 1024;
export const PACK_SCHEMA_VERSION = 1;
const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export class PackDraftError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export interface PackDraftRecord {
  id: string;
  clientItemId: string;
  itemId: string | null;
  sku: string | null;
  pack: any;
  originalRefs: string[];
  sizeBytes: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export function isValidClientItemId(id: string): boolean {
  return CLIENT_ID_RE.test(id || '');
}

/** Deep copy of `value` with every data: URL saved to photo storage and replaced by its URL. */
export function externalizeDataUrls(value: any): { value: any; converted: number; dropped: number } {
  let converted = 0;
  let dropped = 0;
  const cache = new Map<string, string>();
  const walk = (v: any): any => {
    if (typeof v === 'string') {
      if (v.startsWith('data:')) {
        const hit = cache.get(v);
        if (hit) return hit;
        const saved = saveBase64Photo(v);
        if (saved?.url) {
          converted++;
          cache.set(v, saved.url);
          return saved.url;
        }
        dropped++;
        return '';
      }
      if (v.startsWith('blob:')) { dropped++; return ''; } // browser-session-only URL, meaningless server side
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return { value: walk(value), converted, dropped };
}

function collectOriginalRefs(pack: any): string[] {
  const refs = new Set<string>();
  const visit = (v: any, depth = 0) => {
    if (depth > 6) return;
    if (typeof v === 'string') {
      if (v.startsWith('/api/photos/') || /^https?:\/\//.test(v)) refs.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  visit(pack?.originalAssets);
  return [...refs];
}

function rowToRecord(row: any): PackDraftRecord {
  return {
    id: row.id,
    clientItemId: row.client_item_id,
    itemId: row.item_id ?? null,
    sku: row.sku ?? null,
    pack: JSON.parse(row.pack_json),
    originalRefs: row.original_refs ? JSON.parse(row.original_refs) : [],
    sizeBytes: row.size_bytes,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPackDraft(clientItemId: string): PackDraftRecord | null {
  const row = db.prepare('SELECT * FROM media_pack_drafts WHERE client_item_id = ?').get(clientItemId);
  return row ? rowToRecord(row) : null;
}

export function listPackDrafts(): Array<Omit<PackDraftRecord, 'pack'>> {
  const rows = db.prepare('SELECT * FROM media_pack_drafts ORDER BY updated_at DESC LIMIT 500').all() as any[];
  return rows.map((r) => {
    const { pack: _omit, ...meta } = rowToRecord({ ...r, pack_json: '{}' });
    return meta;
  });
}

export function upsertPackDraft(
  clientItemId: string,
  pack: unknown,
  opts: { sku?: string | null; itemId?: string | null } = {}
): { record: PackDraftRecord; created: boolean; changed: boolean; convertedDataUrls: number; droppedRefs: number } {
  if (!isValidClientItemId(clientItemId)) {
    throw new PackDraftError(400, 'INVALID_CLIENT_ITEM_ID', 'clientItemId must be 1-128 chars of letters, digits, _ . : -');
  }
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    throw new PackDraftError(400, 'INVALID_PACK', 'pack must be a JSON object.');
  }
  const { value, converted, dropped } = externalizeDataUrls(pack);
  const packJson = JSON.stringify(value);
  const sizeBytes = Buffer.byteLength(packJson, 'utf8');
  if (sizeBytes > MAX_PACK_BYTES) {
    throw new PackDraftError(
      413, 'PACK_TOO_LARGE',
      `Media pack metadata is ${sizeBytes} bytes after moving images to photo storage; the limit is ${MAX_PACK_BYTES} bytes. Nothing was stored; your local copy is untouched.`,
      { sizeBytes, limitBytes: MAX_PACK_BYTES }
    );
  }
  const refs = JSON.stringify(collectOriginalRefs(value));

  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM media_pack_drafts WHERE client_item_id = ?').get(clientItemId) as any;
    const linked = opts.itemId
      ? (db.prepare('SELECT id, sku FROM items WHERE id = ?').get(opts.itemId) as any)
      : (db.prepare('SELECT id, sku FROM items WHERE client_item_id = ?').get(clientItemId) as any);
    const itemId = linked?.id ?? existing?.item_id ?? null;
    const sku = linked?.sku ?? opts.sku ?? existing?.sku ?? null;

    if (!existing) {
      db.prepare(`INSERT INTO media_pack_drafts
        (id, client_item_id, item_id, sku, pack_json, original_refs, size_bytes, schema_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`mpd_${crypto.randomUUID()}`, clientItemId, itemId, sku, packJson, refs, sizeBytes, PACK_SCHEMA_VERSION);
    } else if (existing.pack_json !== packJson || existing.item_id !== itemId || existing.sku !== sku) {
      db.prepare(`UPDATE media_pack_drafts SET item_id = ?, sku = ?, pack_json = ?, original_refs = ?, size_bytes = ?,
        schema_version = ?, updated_at = CURRENT_TIMESTAMP WHERE client_item_id = ?`)
        .run(itemId, sku, packJson, refs, sizeBytes, PACK_SCHEMA_VERSION, clientItemId);
    }
    const record = getPackDraft(clientItemId)!;
    return {
      record,
      created: !existing,
      changed: !existing || existing.pack_json !== packJson,
      convertedDataUrls: converted,
      droppedRefs: dropped,
    };
  })();
}

/**
 * Link-on-save: attach the draft stored under `clientItemId` to the server-issued item. Re-binds
 * productId/sku inside the stored pack. Never throws (an inventory save must not fail because of this).
 */
export function linkPackDraftToItem(clientItemId: string | undefined, item: { id: string; sku: string }): boolean {
  try {
    if (!clientItemId) return false;
    const draft = getPackDraft(clientItemId);
    if (!draft) return false;
    if (draft.itemId === item.id && draft.sku === item.sku) return true;
    const pack = { ...draft.pack, productId: item.id, sku: item.sku };
    if (Array.isArray(pack.slots)) {
      pack.slots = pack.slots.map((s: any) => (s && typeof s === 'object' && 'productId' in s ? { ...s, productId: item.id } : s));
    }
    const json = JSON.stringify(pack);
    db.prepare(`UPDATE media_pack_drafts SET item_id = ?, sku = ?, pack_json = ?, size_bytes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE client_item_id = ?`).run(item.id, item.sku, json, Buffer.byteLength(json, 'utf8'), clientItemId);
    return true;
  } catch (err) {
    console.warn('[MediaPackDrafts] link-on-save skipped:', (err as Error)?.message);
    return false;
  }
}
