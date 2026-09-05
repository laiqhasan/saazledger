import { db } from '../db/database';
import { logAudit } from './auditService';

export interface MigrationValidationItem {
  sku: string;
  title: string;
  status: 'valid' | 'conflict' | 'invalid';
  reason?: string;
  skuFormatVersion: 'V1' | 'V2';
}

export interface MigrationPreviewReport {
  totalItemsFound: number;
  validCount: number;
  conflictCount: number;
  invalidCount: number;
  existingDatabaseItems: number;
  recommendedStartingSerial: number;
  items: MigrationValidationItem[];
}

export interface MigrationExecutionResult {
  success: boolean;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  errors: string[];
  reportTimestamp: string;
}

/**
 * Validates and previews a LocalStorage or CSV snapshot without committing changes
 */
export function previewMigration(items: any[]): MigrationPreviewReport {
  const existingSkus = new Set(
    (db.prepare('SELECT sku FROM items').all() as Array<{ sku: string }>).map((r) => r.sku.trim().toUpperCase())
  );
  const existingCount = (db.prepare('SELECT COUNT(*) as count FROM items').get() as { count: number }).count;

  let valid = 0;
  let conflict = 0;
  let invalid = 0;
  const validationItems: MigrationValidationItem[] = [];

  for (const item of items) {
    const rawSku = (item.sku || '').trim().toUpperCase();
    if (!rawSku || !item.title) {
      invalid++;
      validationItems.push({
        sku: rawSku || 'UNKNOWN',
        title: item.title || 'Untitled',
        status: 'invalid',
        reason: 'Missing SKU or Title',
        skuFormatVersion: rawSku.includes('-') ? 'V2' : 'V1',
      });
      continue;
    }

    const isV2 = rawSku.includes('-');
    if (existingSkus.has(rawSku)) {
      conflict++;
      validationItems.push({
        sku: rawSku,
        title: item.title,
        status: 'conflict',
        reason: 'SKU already exists in authoritative database',
        skuFormatVersion: isV2 ? 'V2' : 'V1',
      });
    } else {
      valid++;
      validationItems.push({
        sku: rawSku,
        title: item.title,
        status: 'valid',
        skuFormatVersion: isV2 ? 'V2' : 'V1',
      });
    }
  }

  const recommendedStartingSerial = existingCount + valid + 1;

  return {
    totalItemsFound: items.length,
    validCount: valid,
    conflictCount: conflict,
    invalidCount: invalid,
    existingDatabaseItems: existingCount,
    recommendedStartingSerial,
    items: validationItems,
  };
}

/**
 * Imports validated items safely into PostgreSQL / SQLite database with transaction protection
 */
export function executeMigration(params: {
  items: any[];
  overwriteConflicts?: boolean;
  actor?: string;
}): MigrationExecutionResult {
  let importedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];

  db.transaction(() => {
    for (const item of params.items) {
      const rawSku = (item.sku || '').trim().toUpperCase();
      if (!rawSku) {
        skippedCount++;
        continue;
      }

      const existing = db.prepare('SELECT id FROM items WHERE sku = ?').get(rawSku) as { id: string } | undefined;

      if (existing) {
        if (!params.overwriteConflicts) {
          skippedCount++;
          continue;
        }
        // Update existing
        db.prepare(`
          UPDATE items
          SET title = ?, buying_price = ?, selling_price = ?, quantity = ?, notes = ?, updated_at = datetime('now')
          WHERE sku = ?
        `).run(
          item.title,
          Number(item.buyingPrice) || 0,
          Number(item.sellingPrice) || 0,
          Number(item.quantity) || 0,
          item.notes || null,
          rawSku
        );
        updatedCount++;
      } else {
        // Insert new
        const id = item.id || `item_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const isV2 = rawSku.includes('-');
        const serial = item.serial || rawSku.slice(-3);

        db.prepare(`
          INSERT INTO items (
            id, sku, title, type_code, stone_code, color_code, serial,
            buying_price, selling_price, quantity, reorder_level, vendor_name,
            notes, image_url, image_hash, date_added, safety_reserve, is_listed_on_shopify,
            sku_format_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          rawSku,
          item.title,
          item.typeCode || 'PD',
          item.stoneCode || 'J',
          item.colorCode || '01',
          serial,
          Number(item.buyingPrice) || 0,
          Number(item.sellingPrice) || 0,
          Number(item.quantity) || 0,
          Number(item.reorderLevel) || 3,
          item.vendor || null,
          item.notes || null,
          item.imageUrl || null,
          item.imageHash || null,
          item.dateAdded || new Date().toISOString().split('T')[0],
          Number(item.safetyReserve) || 0,
          item.isListedOnShopify ? 1 : 0,
          isV2 ? 'V2' : 'V1'
        );

        // Normalize into products and product_variants
        db.prepare(`
          INSERT OR IGNORE INTO products (id, title, description, category_code, status)
          VALUES (?, ?, ?, ?, 'active')
        `).run(id, item.title, item.notes || '', item.typeCode || 'PD');

        const variantId = `var_${id}`;
        db.prepare(`
          INSERT OR IGNORE INTO product_variants (
            id, product_id, sku, sku_format_version, type_code, stone_code, color_code,
            serial_number, barcode, buying_price, selling_price, is_active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          variantId, id, rawSku, isV2 ? 'V2' : 'V1',
          item.typeCode || 'PD', item.stoneCode || 'J', item.colorCode || '01',
          serial, rawSku, Number(item.buyingPrice) || 0, Number(item.sellingPrice) || 0
        );

        // Multi-state balances
        const qty = Number(item.quantity) || 0;
        const safety = Number(item.safetyReserve) || 0;
        const avail = Math.max(0, qty - safety);
        db.prepare(`
          INSERT OR REPLACE INTO inventory_balances (
            id, location_id, variant_id, on_hand, available, committed, reserved, damaged, safety_stock, incoming
          ) VALUES (?, 'loc_main_vault', ?, ?, ?, 0, 0, 0, ?, 0)
        `).run(`bal_${variantId}_vault`, variantId, qty, avail, safety);

        importedCount++;
      }
    }

    logAudit({
      userId: params.actor || 'admin',
      action: 'DATA_MIGRATION_COMPLETED',
      entityType: 'system',
      entityId: 'migration',
      newState: { importedCount, updatedCount, skippedCount },
    });
  })();

  return {
    success: true,
    importedCount,
    updatedCount,
    skippedCount,
    errors,
    reportTimestamp: new Date().toISOString(),
  };
}
