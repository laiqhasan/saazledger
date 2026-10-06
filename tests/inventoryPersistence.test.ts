import { describe, it, expect } from 'vitest';
import {
  persistItem,
  decideSaveIntent,
  toLocalOnlyItem,
  mergeSavedItem,
  mergeServerWithLocalOnly,
  migratableItems,
  isPlaceholderSku,
  PENDING_SKU_PREFIX,
} from '../src/services/inventoryPersistence';
import type { JewelryItem } from '../src/types/inventory';

const draft = (over: Partial<JewelryItem> = {}): JewelryItem => ({
  id: 'draft-1',
  sku: `${PENDING_SKU_PREFIX}ABCD1234`,
  title: 'Test',
  typeCode: 'PD', stoneCode: 'D', colorCode: '01', serial: '',
  buyingPrice: 1, sellingPrice: 2, quantity: 1, reorderLevel: 1, vendor: 'v',
  dateAdded: '2026-01-01',
  clientItemId: 'cli_x',
  originalImageUrl: '/orig.jpg',
  ...over,
});

/** Fake fetch backed by an in-memory "server" mirroring the real route semantics. */
function fakeServer(opts: { failCreate?: number; status?: number } = {}) {
  const calls: { method: string; url: string; body: any; headers: any }[] = [];
  const store = new Map<string, any>();
  let failures = opts.failCreate ?? 0;
  let serial = 0;
  const fetchImpl = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, body, headers: init.headers });
    const json = (status: number, data: any) => ({ ok: status < 400, status, json: async () => data });
    if (init.method === 'POST') {
      if (failures > 0) { failures--; return json(opts.status ?? 500, { error: 'boom' }); }
      const key = body.clientItemId;
      const prior = [...store.values()].find((i) => i.clientItemId === key);
      if (prior) return json(200, { item: prior, created: false, idempotentReplay: true });
      const item = { ...body, id: `srv_${++serial}`, sku: body.sku || `SRV-${serial}` };
      store.set(item.id, item);
      return json(201, { item, created: true, idempotentReplay: false });
    }
    if (init.method === 'PUT') {
      const id = decodeURIComponent(url.split('/').pop()!);
      if (!store.has(id)) return json(404, { error: 'Item not found' });
      const item = { ...store.get(id), ...body, id };
      store.set(id, item);
      return json(200, { item });
    }
    return json(405, {});
  };
  return { fetchImpl, calls, store };
}

const deps = (s: ReturnType<typeof fakeServer>, withAlloc = true) => ({
  fetchImpl: s.fetchImpl,
  getHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer t' }),
  allocateSku: withAlloc ? async () => ({ sku: 'PDD01-00042', formattedSerial: '00042' }) : undefined,
});

describe('inventory persistence (client logic)', () => {
  it('create is routed to POST (never PUT), with auth + idempotency headers, and returns the server item', async () => {
    const s = fakeServer();
    const r = await persistItem('create', draft(), deps(s));
    expect(r.ok).toBe(true);
    expect(s.calls.map((c) => c.method)).toEqual(['POST']);
    expect(s.calls[0].headers.Authorization).toBe('Bearer t');
    expect(s.calls[0].headers['Idempotency-Key']).toBe('cli_x');
    expect(s.calls[0].body.id).toBeUndefined(); // draft id not sent
    if (r.ok) {
      expect(r.item.id).toBe('srv_1'); // authoritative server id, not the draft one
      expect(r.item.sku).toBe('PDD01-00042'); // reserved SKU honoured
      expect(r.item.syncStatus).toBe('synced');
    }
  });

  it('a brand-new id never triggers PUT even if the same id already exists in the local cache', async () => {
    const s = fakeServer();
    // intent is explicit: unsynced drafts (or no itemToEdit) are creates
    expect(decideSaveIntent(null)).toBe('create');
    expect(decideSaveIntent(draft({ syncStatus: 'local' }))).toBe('create');
    expect(decideSaveIntent(draft({ syncStatus: 'synced' }))).toBe('update');
    await persistItem(decideSaveIntent(null), draft({ id: 'item-already-in-local-storage' }), deps(s));
    expect(s.calls.every((c) => c.method === 'POST')).toBe(true);
  });

  it('update is routed to PUT with auth and keeps photo fields', async () => {
    const s = fakeServer();
    s.store.set('srv_9', { id: 'srv_9', sku: 'A-1', originalImageUrl: '/orig.jpg' });
    const r = await persistItem('update', draft({ id: 'srv_9', sku: 'A-1', syncStatus: 'synced' }), deps(s));
    expect(r.ok).toBe(true);
    expect(s.calls[0].method).toBe('PUT');
    expect(s.calls[0].url).toBe('/api/inventory/srv_9');
    expect(s.calls[0].headers.Authorization).toBe('Bearer t');
    expect(s.calls[0].body.originalImageUrl).toBe('/orig.jpg');
    expect(s.calls[0].body.syncStatus).toBeUndefined();
    if (r.ok) expect(r.item.originalImageUrl).toBe('/orig.jpg');
  });

  it('failed save reports failure (not silent), keeps reserved SKU for retry, and 404 on update is a failure', async () => {
    const s = fakeServer({ failCreate: 1 });
    const r = await persistItem('create', draft(), deps(s));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('boom');
      expect(r.retryable).toBe(true);
      expect(r.reservedSku).toBe('PDD01-00042');
    }
    const u = await persistItem('update', draft({ id: 'nope', syncStatus: 'synced' }), deps(s));
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.status).toBe(404);
  });

  it('network failure is reported as retryable failure', async () => {
    const r = await persistItem('create', draft(), {
      fetchImpl: async () => { throw new Error('offline'); },
      getHeaders: () => ({}),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('offline'); expect(r.retryable).toBe(true); }
  });

  it('failure leaves a recoverable, clearly-labelled local draft that retries without duplicating', async () => {
    const s = fakeServer({ failCreate: 1 });
    const d = draft();
    const first = await persistItem('create', d, deps(s));
    expect(first.ok).toBe(false);
    const local = toLocalOnlyItem(d, 'cli_x', 'boom', (first as any).reservedSku, (first as any).reservedSerial);
    expect(local.syncStatus).toBe('local');
    expect(local.syncError).toBe('boom');
    expect(local.sku).toBe('PDD01-00042');
    expect(local.title).toBe('Test'); // work preserved
    // retry from the local item, then a second (double-click) retry
    const retry = await persistItem(decideSaveIntent(local), local, deps(s));
    const again = await persistItem('create', local, deps(s));
    expect(retry.ok && again.ok).toBe(true);
    expect(s.store.size).toBe(1);
    if (again.ok) expect(again.idempotentReplay).toBe(true);
  });

  it('double-click / retry: same clientItemId twice -> one item, same id', async () => {
    const s = fakeServer();
    const [a, b] = await Promise.all([
      persistItem('create', draft(), deps(s, false)),
      persistItem('create', draft(), deps(s, false)),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(s.store.size).toBe(1);
    if (a.ok && b.ok) expect(a.item.id).toBe(b.item.id);
  });

  it('merge helpers: server item replaces draft without duplicates; local-only survive refresh; placeholders never migrate', () => {
    const d = draft();
    const saved = { ...d, id: 'srv_1', sku: 'S-1', syncStatus: 'synced' as const };
    const merged = mergeSavedItem([d, { ...d, id: 'other', sku: 'O', clientItemId: undefined }], d, saved);
    expect(merged.map((i) => i.id)).toEqual(['srv_1', 'other']);

    const local = toLocalOnlyItem(draft({ id: 'draft-2', clientItemId: 'cli_2' }), 'cli_2', 'err');
    expect(isPlaceholderSku(local.sku)).toBe(true);
    const refreshed = mergeServerWithLocalOnly([{ ...saved }], [local, saved]);
    expect(refreshed.map((i) => i.id).sort()).toEqual(['draft-2', 'srv_1']);
    expect(refreshed.find((i) => i.id === 'srv_1')?.syncStatus).toBe('synced');
    // once the server has it (by clientItemId) the local copy is dropped
    const resolved = mergeServerWithLocalOnly([{ ...saved, clientItemId: 'cli_2', id: 'srv_2', sku: 'S-2' }], [local]);
    expect(resolved).toHaveLength(1);
    // browser->server re-upload safeguard never sends unconfirmed local-only items
    expect(migratableItems([local, saved])).toEqual([saved]);
  });
});
