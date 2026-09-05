import { db } from '../db/database';

export interface SkuAllocationResult {
  sku: string;
  serial: string;
  typeCode: string;
  stoneCode: string;
  colorCode: string;
}

/**
 * Atomically allocates the next sequential SKU for a given (typeCode, stoneCode, colorCode) combination.
 * Uses SQLite transaction to guarantee zero collisions even under high concurrency.
 */
export function allocateNextSku(
  typeCode: string,
  stoneCode: string,
  colorCode: string
): SkuAllocationResult {
  const cleanType = (typeCode || '').trim().toUpperCase();
  const cleanStone = (stoneCode || '').trim().toUpperCase();
  const cleanColor = (colorCode || '').trim().toUpperCase();

  if (!cleanType || !cleanStone || !cleanColor) {
    throw new Error('Type code, stone code, and color code are required for SKU allocation.');
  }

  const transaction = db.transaction(() => {
    // 1. Get or initialize sequence
    const existingSeq = db.prepare(`
      SELECT last_serial FROM sku_sequences
      WHERE type_code = ? AND stone_code = ? AND color_code = ?
    `).get(cleanType, cleanStone, cleanColor) as { last_serial: number } | undefined;

    let nextSerialNum = (existingSeq ? existingSeq.last_serial : 0) + 1;
    let candidateSku = `${cleanType}${cleanStone}${cleanColor}${String(nextSerialNum).padStart(3, '0')}`;

    // 2. Safeguard against any existing items or aliases that might occupy this candidate SKU
    let collision = db.prepare(`
      SELECT 1 FROM items WHERE sku = ?
      UNION
      SELECT 1 FROM sku_aliases WHERE alias_sku = ?
    `).get(candidateSku, candidateSku);

    while (collision) {
      nextSerialNum++;
      candidateSku = `${cleanType}${cleanStone}${cleanColor}${String(nextSerialNum).padStart(3, '0')}`;
      collision = db.prepare(`
        SELECT 1 FROM items WHERE sku = ?
        UNION
        SELECT 1 FROM sku_aliases WHERE alias_sku = ?
      `).get(candidateSku, candidateSku);
    }

    // 3. Upsert the sequence counter atomically
    db.prepare(`
      INSERT INTO sku_sequences (type_code, stone_code, color_code, last_serial)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(type_code, stone_code, color_code)
      DO UPDATE SET last_serial = ?
    `).run(cleanType, cleanStone, cleanColor, nextSerialNum, nextSerialNum);

    const serialStr = String(nextSerialNum).padStart(3, '0');

    return {
      sku: candidateSku,
      prefix: `${cleanType}${cleanStone}${cleanColor}`,
      serial: serialStr,
      serialNum: nextSerialNum,
      typeCode: cleanType,
      stoneCode: cleanStone,
      colorCode: cleanColor,
    };
  });

  return transaction();
}

/**
 * Registers an external channel alias or barcode (e.g. Amazon ASIN, FNSKU, Myntra SKU)
 */
export function registerSkuAlias(
  itemId: string,
  aliasSku: string,
  channel: string
): void {
  const cleanAlias = aliasSku.trim().toUpperCase();
  if (!cleanAlias) return;

  db.prepare(`
    INSERT INTO sku_aliases (id, item_id, alias_sku, channel)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(alias_sku) DO NOTHING
  `).run(`alias_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`, itemId, cleanAlias, channel);
}

/**
 * Finds an item ID by either master SKU or any registered alias
 */
export function findItemBySkuOrAlias(searchSku: string): { itemId: string; isMaster: boolean } | null {
  const clean = searchSku.trim().toUpperCase();

  const master = db.prepare('SELECT id FROM items WHERE sku = ?').get(clean) as { id: string } | undefined;
  if (master) {
    return { itemId: master.id, isMaster: true };
  }

  const alias = db.prepare('SELECT item_id FROM sku_aliases WHERE alias_sku = ?').get(clean) as { item_id: string } | undefined;
  if (alias) {
    return { itemId: alias.item_id, isMaster: false };
  }

  return null;
}

export function resolveSkuAlias(aliasOrSku: string): string {
  const clean = aliasOrSku.trim().toUpperCase();
  const res = db.prepare(`
    SELECT i.sku FROM sku_aliases a
    JOIN items i ON a.item_id = i.id
    WHERE a.alias_sku = ?
  `).get(clean) as { sku: string } | undefined;
  return res ? res.sku : clean;
}
