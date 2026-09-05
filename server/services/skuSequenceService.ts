import { db } from '../db/database';
import { logAudit } from './auditService';

export interface GlobalSkuSequenceStatus {
  currentSerial: number;
  nextSerial: number;
  formattedNextSerial: string;
  isInitialized: boolean;
  startingSerial: number;
  totalV1Items: number;
  totalV2Items: number;
  totalPhysicalStock: number;
  lastIssuedSku?: string;
}

export interface AllocatedSkuResult {
  globalSerial: number;
  formattedSerial: string;
  sku: string;
  skuFormatVersion: 'V2';
  typeCode: string;
  stoneCode: string;
  colorCode: string;
}

/**
 * Returns current global 5-digit SKU sequence status & metrics
 */
export function getGlobalSkuSequenceStatus(): GlobalSkuSequenceStatus {
  let seq = db.prepare('SELECT * FROM global_sku_sequence WHERE id = ?').get('global') as any;

  if (!seq) {
    const existingCount = (db.prepare('SELECT COUNT(*) as count FROM items').get() as { count: number }).count;
    db.prepare(`
      INSERT INTO global_sku_sequence (id, current_serial, is_initialized, starting_serial, initialized_at, initialized_by)
      VALUES ('global', ?, 1, ?, datetime('now'), 'system_auto_init')
    `).run(existingCount, existingCount + 1);

    seq = db.prepare('SELECT * FROM global_sku_sequence WHERE id = ?').get('global') as any;
  }

  const v1ItemsCount = (db.prepare("SELECT COUNT(*) as count FROM items WHERE sku NOT LIKE '%-%'").get() as { count: number }).count;
  const v1VariantsCount = (db.prepare("SELECT COUNT(*) as count FROM product_variants WHERE sku_format_version = 'V1'").get() as { count: number }).count;
  const v1Count = Math.max(v1ItemsCount, v1VariantsCount);

  const v2ItemsCount = (db.prepare("SELECT COUNT(*) as count FROM items WHERE sku LIKE '%-%'").get() as { count: number }).count;
  const v2VariantsCount = (db.prepare("SELECT COUNT(*) as count FROM product_variants WHERE sku_format_version = 'V2'").get() as { count: number }).count;
  const v2Count = Math.max(v2ItemsCount, v2VariantsCount);

  const stockRow = db.prepare("SELECT COALESCE(SUM(quantity), 0) as total FROM items").get() as { total: number };

  const lastV2Item = db.prepare("SELECT sku FROM items WHERE sku LIKE '%-%' ORDER BY id DESC LIMIT 1").get() as { sku: string } | undefined;
  const lastItem = db.prepare("SELECT sku FROM items ORDER BY id DESC LIMIT 1").get() as { sku: string } | undefined;

  const nextSerial = seq.current_serial + 1;
  const formattedNextSerial = String(nextSerial).padStart(5, '0');

  return {
    currentSerial: seq.current_serial,
    nextSerial,
    formattedNextSerial,
    isInitialized: Boolean(seq.is_initialized),
    startingSerial: seq.starting_serial,
    totalV1Items: v1Count,
    totalV2Items: v2Count,
    totalPhysicalStock: stockRow.total,
    lastIssuedSku: lastV2Item?.sku || lastItem?.sku,
  };
}

/**
 * Allows administrator to explicitly initialize or calibrate the global starting serial
 */
export function initializeGlobalSkuSequence(startingSerial: number, actor = 'admin'): GlobalSkuSequenceStatus {
  if (startingSerial < 1 || startingSerial > 99999) {
    throw new Error('Starting serial must be between 1 and 99999');
  }

  db.transaction(() => {
    const current = db.prepare('SELECT current_serial FROM global_sku_sequence WHERE id = ?').get('global') as any;
    const currentVal = current ? current.current_serial : 0;

    // Safety: Prevent rolling sequence backwards into already minted numbers
    if (startingSerial <= currentVal) {
      throw new Error(`Cannot initialize starting sequence to ${startingSerial}. Current sequence has already reached ${currentVal}. Sequence cannot roll backwards.`);
    }

    db.prepare(`
      INSERT INTO global_sku_sequence (id, current_serial, is_initialized, starting_serial, initialized_at, initialized_by)
      VALUES ('global', ?, 1, ?, datetime('now'), ?)
      ON CONFLICT(id) DO UPDATE SET
        current_serial = excluded.current_serial,
        is_initialized = 1,
        starting_serial = excluded.starting_serial,
        initialized_at = excluded.initialized_at,
        initialized_by = excluded.initialized_by
    `).run(startingSerial - 1, startingSerial, actor);

    logAudit({
      userId: actor,
      action: 'SKU_SEQUENCE_INITIALIZED',
      entityType: 'global_sku_sequence',
      entityId: 'global',
      prevState: { currentSerial: currentVal },
      newState: { currentSerial: startingSerial - 1, startingSerial },
    });
  })();

  return getGlobalSkuSequenceStatus();
}

/**
 * Atomically allocates the next global 5-digit serial and mints permanent V2 SKU
 * Format: [TYPE][STONE][COLOR]-[00001]
 * Sequence does NOT restart per category, stone, or color.
 */
export function allocateGlobalSku(params: {
  typeCode: string;
  stoneCode: string;
  colorCode: string;
  actor?: string;
}): AllocatedSkuResult {
  const cleanType = (params.typeCode || '').trim().toUpperCase();
  const cleanStone = (params.stoneCode || '').trim().toUpperCase();
  const cleanColor = (params.colorCode || '').trim().toUpperCase();

  if (!cleanType || !cleanStone || !cleanColor) {
    throw new Error('Type code, stone code, and color code are required to allocate a SKU');
  }

  return db.transaction(() => {
    let seqRow = db.prepare('SELECT * FROM global_sku_sequence WHERE id = ?').get('global') as any;
    if (!seqRow) {
      const existingCount = (db.prepare('SELECT COUNT(*) as count FROM items').get() as { count: number }).count;
      db.prepare(`
        INSERT INTO global_sku_sequence (id, current_serial, is_initialized, starting_serial, initialized_at, initialized_by)
        VALUES ('global', ?, 1, ?, datetime('now'), 'system_auto_init')
      `).run(existingCount, existingCount + 1);
      seqRow = db.prepare('SELECT * FROM global_sku_sequence WHERE id = ?').get('global') as any;
    }

    const nextSerial = seqRow.current_serial + 1;

    if (nextSerial > 99999) {
      throw new Error('Global SKU sequence capacity (99999) reached. Administrator intervention required to expand format.');
    }

    const formattedSerial = String(nextSerial).padStart(5, '0');
    const sku = `${cleanType}${cleanStone}${cleanColor}-${formattedSerial}`;

    // Verify uniqueness in database
    const existingSku = db.prepare('SELECT id FROM items WHERE sku = ?').get(sku);
    if (existingSku) {
      throw new Error(`Conflict: SKU ${sku} is already assigned in database.`);
    }

    // Atomically increment counter
    db.prepare(`
      UPDATE global_sku_sequence
      SET current_serial = ?, locked_at = datetime('now')
      WHERE id = 'global'
    `).run(nextSerial);

    // Register product and commercial variant identity
    const prodId = `prod_gen_${nextSerial}`;
    db.prepare(`
      INSERT OR IGNORE INTO products (id, title, category_code, status)
      VALUES (?, ?, ?, 'active')
    `).run(prodId, `${cleanType} Piece`, cleanType);

    db.prepare(`
      INSERT OR IGNORE INTO product_variants (
        id, product_id, sku, global_serial, sku_format_version,
        type_code, stone_code, color_code, serial_number, barcode, is_active
      ) VALUES (?, ?, ?, ?, 'V2', ?, ?, ?, ?, ?, 1)
    `).run(
      `var_gen_${nextSerial}`,
      prodId,
      sku,
      nextSerial,
      cleanType,
      cleanStone,
      cleanColor,
      formattedSerial,
      sku
    );

    logAudit({
      userId: params.actor || 'usr_admin',
      action: 'SKU_CREATED',
      entityType: 'sku',
      entityId: sku,
      newState: { sku, globalSerial: nextSerial, formattedSerial },
    });

    return {
      globalSerial: nextSerial,
      formattedSerial,
      sku,
      skuFormatVersion: 'V2',
      typeCode: cleanType,
      stoneCode: cleanStone,
      colorCode: cleanColor,
    };
  })();
}

/**
 * Generates an uncommitted live preview of the SKU for display prior to permanent creation
 * e.g. PDJ12-XXXXX
 */
export function previewGlobalSku(typeCode: string, stoneCode: string, colorCode: string): string {
  const cleanType = (typeCode || 'PD').trim().toUpperCase();
  const cleanStone = (stoneCode || 'J').trim().toUpperCase();
  const cleanColor = (colorCode || '01').trim().toUpperCase();
  return `${cleanType}${cleanStone}${cleanColor}-XXXXX`;
}
