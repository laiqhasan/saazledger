/**
 * Per-Shopify-product record of what SaazLedger LAST WROTE for stock / price / cost,
 * plus whether the standard taxonomy category was mapped. Used to detect values that
 * were changed manually in Shopify so they are never silently overwritten.
 *
 * Additive only: CREATE TABLE IF NOT EXISTS, no migration of existing tables.
 * The DB is loaded lazily so pure unit tests that never touch persistence do not
 * create a database. Every failure degrades to "no state" (which is the SAFE
 * direction: an unknown history means a differing value needs confirmation).
 */

export type CategoryStatus = 'mapped' | 'manual_required';

export interface SyncState {
  shopify_product_id: string;
  item_id?: string | null;
  sku?: string | null;
  variant_id?: string | null;
  inventory_item_id?: string | null;
  location_id?: string | null;
  last_synced_quantity?: number | null;
  last_synced_price?: number | null;
  last_synced_cost?: number | null;
  category_status?: CategoryStatus | null;
  synced_at?: string | null;
}

export const SYNC_STATE_DDL = `CREATE TABLE IF NOT EXISTS shopify_sync_state (
  shopify_product_id TEXT PRIMARY KEY,
  item_id TEXT,
  sku TEXT,
  variant_id TEXT,
  inventory_item_id TEXT,
  location_id TEXT,
  last_synced_quantity INTEGER,
  last_synced_price REAL,
  last_synced_cost REAL,
  category_status TEXT,
  synced_at TEXT
)`;

let dbPromise: Promise<any> | null = null;
async function getDb(): Promise<any | null> {
  try {
    if (!dbPromise) {
      dbPromise = import('../db/database').then((m) => {
        m.db.prepare(SYNC_STATE_DDL).run();
        return m.db;
      });
    }
    return await dbPromise;
  } catch {
    dbPromise = null;
    return null;
  }
}

export async function readSyncState(shopifyProductId: string): Promise<SyncState | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    return (db.prepare('SELECT * FROM shopify_sync_state WHERE shopify_product_id = ?').get(String(shopifyProductId)) as SyncState) || null;
  } catch {
    return null;
  }
}

export async function listSyncStates(): Promise<SyncState[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM shopify_sync_state ORDER BY synced_at DESC').all() as SyncState[];
  } catch {
    return [];
  }
}

/** Upserts; `undefined` fields keep their previous value, `null` clears. */
export async function writeSyncState(patch: SyncState): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    const prev = (db.prepare('SELECT * FROM shopify_sync_state WHERE shopify_product_id = ?').get(String(patch.shopify_product_id)) as SyncState) || ({} as SyncState);
    const m: Record<string, any> = { ...prev };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) m[k] = v;
    m.synced_at = new Date().toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO shopify_sync_state
       (shopify_product_id, item_id, sku, variant_id, inventory_item_id, location_id,
        last_synced_quantity, last_synced_price, last_synced_cost, category_status, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      String(m.shopify_product_id), m.item_id ?? null, m.sku ?? null, m.variant_id ?? null, m.inventory_item_id ?? null,
      m.location_id ?? null, m.last_synced_quantity ?? null, m.last_synced_price ?? null, m.last_synced_cost ?? null,
      m.category_status ?? null, m.synced_at
    );
  } catch (e: any) {
    console.warn('[Shopify sync-state] could not persist:', e?.message);
  }
}
