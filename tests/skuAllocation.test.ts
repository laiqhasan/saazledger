import { describe, it, expect, afterAll } from 'vitest';
import { db } from '../server/db/database';
import { allocateNextSku, registerSkuAlias, resolveSkuAlias } from '../server/services/skuService';

describe('SKU Allocation & Sequence Engine', () => {
  it('allocates strictly sequential serials for a prefix combination', () => {
    // Generate two consecutive SKUs for a specific combination
    const alloc1 = allocateNextSku('TEST', 'A', '01');
    const alloc2 = allocateNextSku('TEST', 'A', '01');

    expect(alloc1.prefix).toBe('TESTA01');
    expect(alloc2.prefix).toBe('TESTA01');
    expect(alloc2.serialNum).toBe(alloc1.serialNum + 1);
    expect(alloc1.sku).toBe(`TESTA01${String(alloc1.serialNum).padStart(3, '0')}`);
    expect(alloc2.sku).toBe(`TESTA01${String(alloc2.serialNum).padStart(3, '0')}`);
  });

  it('guarantees unique SKUs under simulated rapid allocation', () => {
    const prefixType = 'RAPID';
    const allocatedSkus = new Set<string>();

    for (let i = 0; i < 20; i++) {
      const alloc = allocateNextSku(prefixType, 'D', '01');
      expect(allocatedSkus.has(alloc.sku)).toBe(false);
      allocatedSkus.add(alloc.sku);
    }

    expect(allocatedSkus.size).toBe(20);
  });

  it('registers and resolves SKU aliases properly without rewriting original SKU', () => {
    let item = db.prepare('SELECT id, sku FROM items LIMIT 1').get() as { id: string; sku: string } | undefined;
    if (!item) {
      db.prepare(`
        INSERT INTO items (id, sku, title, type_code, stone_code, color_code, serial, buying_price, selling_price, quantity, date_added, vendor_name)
        VALUES ('test_item_alias', 'TESTAL001', 'Test Alias Piece', 'TE', 'ST', '01', '001', 100, 200, 1, '2026-08-15', 'Jaipur')
      `).run();
      item = { id: 'test_item_alias', sku: 'TESTAL001' };
    }

    const legacySku = `LEGACY-${Date.now()}`;

    registerSkuAlias(item.id, legacySku, 'legacy_migration');
    const resolved = resolveSkuAlias(legacySku);

    expect(resolved).toBe(item.sku);

    // Non-existent alias should resolve to itself
    expect(resolveSkuAlias('UNKNOWN-SKU-999')).toBe('UNKNOWN-SKU-999');
  });

  afterAll(() => {
    db.prepare("DELETE FROM sku_aliases WHERE alias_sku LIKE 'LEGACY-%'").run();
    db.prepare("DELETE FROM items WHERE id = 'test_item_alias'").run();
  });
});
