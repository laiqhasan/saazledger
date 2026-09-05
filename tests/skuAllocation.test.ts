import { describe, it, expect } from 'vitest';
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
    const item = db.prepare('SELECT id, sku FROM items LIMIT 1').get() as { id: string; sku: string };
    const legacySku = `LEGACY-${Date.now()}`;

    registerSkuAlias(item.id, legacySku, 'legacy_migration');
    const resolved = resolveSkuAlias(legacySku);

    expect(resolved).toBe(item.sku);

    // Non-existent alias should resolve to itself
    expect(resolveSkuAlias('UNKNOWN-SKU-999')).toBe('UNKNOWN-SKU-999');
  });
});
