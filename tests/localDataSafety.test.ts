import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildLocalBackup,
  parseLocalBackup,
  planImport,
  applyImport,
  KEY_INVENTORY,
  KEY_VENDORS,
  KEY_DROPPED_SNAPSHOT,
  PACK_DRAFT_KEY_PREFIX,
  type StorageLike,
} from '../src/services/localBackup';
import {
  mergeServerWithLocalOnly,
  itemsDroppedByMerge,
  shouldSyncBrowserData,
  migratableItems,
} from '../src/services/inventoryPersistence';
import {
  backupPackToServer,
  resolvePackForItem,
  restoreMissingPacks,
  saveLocalPackDraft,
  packBackupLabel,
} from '../src/services/mediaPackBackup';

/** In-memory localStorage that FAILS THE TEST if anything removes or clears a key. */
class GuardedStorage implements StorageLike {
  map = new Map<string, string>();
  removed: string[] = [];
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.removed.push(k); this.map.delete(k); }
  clear() { this.removed.push('*'); this.map.clear(); }
}

const item = (o: any = {}): any => ({
  id: 'i1', sku: 'NKZ09-00001', title: 'T', typeCode: 'NK', stoneCode: 'Z', colorCode: '09', serial: '00001',
  buyingPrice: 500, sellingPrice: 1200, quantity: 5, reorderLevel: 3, vendor: 'V', notes: '', imageUrl: '', imageHash: '',
  dateAdded: '2026-10-06', ...o,
});
const pack = { slots: [{ slotNumber: 1, url: '/api/photos/aaaaaaaaaaaaaaaa.webp' }], realPhotoCount: 1, aiModelCount: 0, warnings: [], createdAt: 'x' };

const pilotLocal = item({ id: 'draft-cli_pilot', clientItemId: 'cli_pilot', sku: 'PENDING-ABCD1234', syncStatus: 'local', galleryPack: pack });

describe('local backup / import (pure)', () => {
  it('builds a backup that includes inventory, vendors, codes, packs and drafts, and only reads storage', () => {
    const s = new GuardedStorage();
    s.setItem(KEY_INVENTORY, JSON.stringify([pilotLocal, item({ id: 'srv1', syncStatus: 'synced' })]));
    s.setItem(KEY_VENDORS, JSON.stringify([{ id: 'v1', name: 'Vend', code: 'V' }]));
    s.setItem('saaz_ledger_codes_v1', JSON.stringify({ types: [] }));
    s.setItem('saaz_auth_token', 'SECRET-TOKEN');
    saveLocalPackDraft(s, 'cli_pilot', pack);
    const before = JSON.stringify([...s.map]);
    const b = buildLocalBackup(s, new Date('2026-10-06T00:00:00Z'));
    expect(b.summary).toEqual({ items: 2, localOnlyItems: 1, itemsWithPacks: 1, packDrafts: 1, vendors: 1 });
    expect(b.packMetadata[0]).toMatchObject({ clientItemId: 'cli_pilot', slotCount: 1, hasGalleryPack: true });
    expect(JSON.stringify(b)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify([...s.map])).toBe(before);
    expect(s.removed).toEqual([]);
  });

  it('import only ADDS missing items/vendors/pack drafts; never overwrites or removes', () => {
    const src = new GuardedStorage();
    src.setItem(KEY_INVENTORY, JSON.stringify([pilotLocal, item({ id: 'same', sku: 'NKZ09-00002', title: 'FROM BACKUP' })]));
    src.setItem(KEY_VENDORS, JSON.stringify([{ id: 'v1', name: 'Backup vendor' }, { id: 'v2', name: 'New' }]));
    saveLocalPackDraft(src, 'cli_pilot', pack);
    saveLocalPackDraft(src, 'cli_other', pack);
    const parsed = parseLocalBackup(JSON.stringify(buildLocalBackup(src)));
    expect(parsed.ok).toBe(true);

    const dst = new GuardedStorage();
    dst.setItem(KEY_INVENTORY, JSON.stringify([item({ id: 'same', sku: 'NKZ09-00002', title: 'CURRENT' })]));
    dst.setItem(KEY_VENDORS, JSON.stringify([{ id: 'v1', name: 'Current vendor' }]));
    saveLocalPackDraft(dst, 'cli_other', { slots: [], mine: true });
    dst.setItem('unrelated_key', 'keep-me');

    const plan = planImport((parsed as any).backup, {
      inventory: JSON.parse(dst.getItem(KEY_INVENTORY)!),
      vendors: JSON.parse(dst.getItem(KEY_VENDORS)!),
      packDraftKeys: ['cli_other'],
    });
    expect(plan.addItems.map((i) => i.id)).toEqual(['draft-cli_pilot']);
    expect(plan.addItems[0].syncStatus).toBe('local');
    expect(plan.skippedItems).toBe(1);
    expect(plan.addVendors.map((v) => v.id)).toEqual(['v2']);
    expect(Object.keys(plan.addPackDrafts)).toEqual(['cli_pilot']);

    const out = applyImport(dst, plan);
    const inv = JSON.parse(dst.getItem(KEY_INVENTORY)!);
    expect(inv.map((i: any) => i.id).sort()).toEqual(['draft-cli_pilot', 'same']);
    expect(inv.find((i: any) => i.id === 'same').title).toBe('CURRENT');
    expect(JSON.parse(dst.getItem(KEY_VENDORS)!).find((v: any) => v.id === 'v1').name).toBe('Current vendor');
    expect(JSON.parse(dst.getItem(PACK_DRAFT_KEY_PREFIX + 'cli_other')!).mine).toBe(true);
    expect(dst.getItem(PACK_DRAFT_KEY_PREFIX + 'cli_pilot')).toBeTruthy();
    expect(dst.getItem('unrelated_key')).toBe('keep-me');
    expect(out.inventory).toHaveLength(2);
    expect(dst.removed).toEqual([]);
    // importing twice adds nothing more
    const plan2 = planImport((parsed as any).backup, { inventory: out.inventory, vendors: out.vendors, packDraftKeys: ['cli_other', 'cli_pilot'] });
    expect(plan2.addItems).toHaveLength(0);
  });

  it('rejects files that are not backups', () => {
    expect(parseLocalBackup('{nope').ok).toBe(false);
    expect(parseLocalBackup('{"format":"other"}').ok).toBe(false);
  });
});

describe('media pack backup client', () => {
  const deps = (fetchImpl: any) => ({ fetchImpl, getHeaders: () => ({}) });

  it('a failed server backup returns a status, never throws, and the local copy stays', async () => {
    const s = new GuardedStorage();
    saveLocalPackDraft(s, 'cli_x', pack);
    for (const f of [
      async () => { throw new Error('offline'); },
      async () => ({ ok: false, status: 413, json: async () => ({ error: 'too big' }) }),
      async () => ({ ok: false, status: 500, json: async () => { throw new Error('bad json'); } }),
    ]) {
      const r = await backupPackToServer('cli_x', pack, {}, deps(f));
      expect(r.ok).toBe(false);
    }
    expect(s.getItem(PACK_DRAFT_KEY_PREFIX + 'cli_x')).toBeTruthy();
    expect(s.removed).toEqual([]);
    expect(packBackupLabel('ok')).toBe('Pack backed up to server');
    expect(packBackupLabel('failed')).toMatch(/^Backup failed . local only/);
  });

  it('restores from the server only when no local pack exists, and never replaces a local pack', async () => {
    const s = new GuardedStorage();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ draft: { pack: { slots: [], fromServer: true } } }) }));
    const local = await resolvePackForItem('cli_x', pack, s, deps(fetchImpl));
    expect(local.source).toBe('local');
    expect(fetchImpl).not.toHaveBeenCalled();
    const srv = await resolvePackForItem('cli_x', null, s, deps(fetchImpl));
    expect(srv.source).toBe('server');
    expect(s.getItem(PACK_DRAFT_KEY_PREFIX + 'cli_x')).toBeTruthy();
    const down = await resolvePackForItem('cli_y', null, s, deps(async () => { throw new Error('offline'); }));
    expect(down).toEqual({ pack: null, source: 'none' });
  });

  it('restoreMissingPacks fills only items without a pack', async () => {
    const f = async (url: string) =>
      url.endsWith('/api/media-pack-drafts')
        ? { ok: true, status: 200, json: async () => ({ drafts: [{ clientItemId: 'c1' }, { clientItemId: 'c2' }] }) }
        : { ok: true, status: 200, json: async () => ({ draft: { pack: { slots: [], restored: true } } }) };
    const mine = { slots: [], mine: true };
    const { items, restored } = await restoreMissingPacks(
      [item({ id: 'a', clientItemId: 'c1' }), item({ id: 'b', clientItemId: 'c2', galleryPack: mine })] as any[],
      deps(f)
    );
    expect(restored).toEqual(['a']);
    expect((items[0] as any).galleryPack.restored).toBe(true);
    expect((items[1] as any).galleryPack).toBe(mine);
  });
});

describe('deploy safety: load / merge / re-upload safeguard preserve local-only data', () => {
  it('mergeServerWithLocalOnly keeps local-only items and packs when the server list differs or is empty', () => {
    const server = [item({ id: 'srv1', sku: 'NKZ09-00009' })];
    const merged = mergeServerWithLocalOnly(server, [pilotLocal, item({ id: 'srv1', sku: 'NKZ09-00009', galleryPack: pack, syncStatus: 'synced' })]);
    expect(merged.map((i) => i.id)).toEqual(['draft-cli_pilot', 'srv1']);
    expect((merged[0] as any).galleryPack).toBe(pack);
    expect((merged[1] as any).galleryPack).toBe(pack); // local pack carried onto server item
    expect(mergeServerWithLocalOnly([], [pilotLocal]).map((i) => i.id)).toEqual(['draft-cli_pilot']);
  });

  it('a local pack is carried onto the server item matched by clientItemId (different id)', () => {
    const merged = mergeServerWithLocalOnly(
      [item({ id: 'srv_new', clientItemId: 'cli_pilot', sku: 'NKZ09-00010' })],
      [pilotLocal]
    );
    expect(merged).toHaveLength(1);
    expect((merged[0] as any).galleryPack).toBe(pack);
  });

  it('a legacy un-flagged item that holds a pack is kept (and flagged local); plain stale cache items are snapshotted, not lost', () => {
    const legacyPack = item({ id: 'legacy', sku: 'NKZ09-00077', galleryPack: pack });
    const stale = item({ id: 'stale', sku: 'NKZ09-00078', syncStatus: 'synced' });
    const merged = mergeServerWithLocalOnly([item({ id: 'srv1', sku: 'NKZ09-00009' })], [legacyPack, stale]);
    expect(merged.find((i) => i.id === 'legacy')?.syncStatus).toBe('local');
    expect(merged.find((i) => i.id === 'stale')).toBeUndefined();
    expect(itemsDroppedByMerge([legacyPack, stale], merged).map((i) => i.id)).toEqual(['stale']);
  });

  it('re-upload safeguard never fires on a server error and never uploads local-only or placeholder items', () => {
    expect(shouldSyncBrowserData(false, false, true)).toBe(false); // server error => serverEmpty=false
    expect(shouldSyncBrowserData(false, true, true)).toBe(true);
    expect(shouldSyncBrowserData(false, true, false)).toBe(false);
    expect(shouldSyncBrowserData(true, false, true)).toBe(true);
    const up = migratableItems([pilotLocal, item({ id: 'p', sku: 'PENDING-1' }), item({ id: 'ok', syncStatus: 'synced' })]);
    expect(up.map((i) => i.id)).toEqual(['ok']);
  });

  describe('fetchInventory with real storage helpers', () => {
    let store: GuardedStorage;
    let api: typeof import('../src/services/apiService');
    beforeEach(async () => {
      store = new GuardedStorage();
      vi.stubGlobal('localStorage', store);
      store.setItem('saaz_ledger_initialized', 'true');
      store.setItem(KEY_INVENTORY, JSON.stringify([pilotLocal]));
      store.setItem(PACK_DRAFT_KEY_PREFIX + 'cli_pilot', JSON.stringify(pack));
      store.setItem('some_other_app_key', 'not-ours');
      api = await import('../src/services/apiService');
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const expectUntouched = () => {
      expect(store.removed).toEqual([]);
      expect(store.getItem('some_other_app_key')).toBe('not-ours');
      expect(store.getItem(PACK_DRAFT_KEY_PREFIX + 'cli_pilot')).toBeTruthy();
      const inv = JSON.parse(store.getItem(KEY_INVENTORY)!);
      expect(inv.find((i: any) => i.id === 'draft-cli_pilot').galleryPack).toBeTruthy();
    };

    it('server unreachable -> cache returned and untouched', async () => {
      vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
      const items = await api.fetchInventory();
      expect(items.map((i) => i.id)).toEqual(['draft-cli_pilot']);
      expectUntouched();
    });
    it('server 500 -> cache returned and untouched', async () => {
      vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
      expect((await api.fetchInventory()).map((i) => i.id)).toEqual(['draft-cli_pilot']);
      expectUntouched();
    });
    it('server empty -> cache returned and untouched; isServerInventoryEmpty only true for a successful empty answer', async () => {
      vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }));
      expect((await api.fetchInventory()).map((i) => i.id)).toEqual(['draft-cli_pilot']);
      expect(await api.isServerInventoryEmpty()).toBe(true);
      vi.stubGlobal('fetch', async () => { throw new Error('down'); });
      expect(await api.isServerInventoryEmpty()).toBe(false);
      expectUntouched();
    });
    it('server has different items -> local-only pilot item and its pack stay in the cache; stale synced items are snapshotted', async () => {
      store.setItem(KEY_INVENTORY, JSON.stringify([pilotLocal, item({ id: 'old_synced', sku: 'NKZ09-00555', syncStatus: 'synced' })]));
      vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ items: [item({ id: 'srv1', sku: 'NKZ09-00009' })] }) }));
      const items = await api.fetchInventory();
      expect(items.map((i) => i.id)).toEqual(['draft-cli_pilot', 'srv1']);
      expectUntouched();
      const snap = JSON.parse(store.getItem(KEY_DROPPED_SNAPSHOT)!);
      expect(snap.map((i: any) => i.id)).toEqual(['old_synced']);
    });
  });
});
