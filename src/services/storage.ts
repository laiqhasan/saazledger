import type { CodeTables, JewelryItem } from '../types/inventory';
import { DEFAULT_CODE_TABLES, INITIAL_INVENTORY } from './initialData';

const INVENTORY_STORAGE_KEY = 'saaz_ledger_inventory_v1';
const CODES_STORAGE_KEY = 'saaz_ledger_codes_v1';
const HAS_INITIALIZED_KEY = 'saaz_ledger_initialized';

export function getStoredCodeTables(): CodeTables {
  try {
    const raw = localStorage.getItem(CODES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CodeTables;
      let needsSave = false;
      const c02 = parsed.colors?.find((c) => c.code === '02');
      if (c02 && (c02.label !== 'Silver Plated' || c02.label.includes('Rhodium'))) {
        c02.label = 'Silver Plated';
        c02.description = 'High-polish pure silver electroplated finish';
        needsSave = true;
      }
      if (parsed.colors && !parsed.colors.some((c) => c.code === '04')) {
        parsed.colors.splice(3, 0, {
          code: '04',
          label: 'Rhodium Plated',
          description: 'Bright white rhodium plating',
        });
        needsSave = true;
      }
      if (needsSave) {
        saveStoredCodeTables(parsed);
      }
      return parsed;
    }
  } catch (err) {
    console.error('Failed reading code tables from storage:', err);
  }
  return DEFAULT_CODE_TABLES;
}

export function saveStoredCodeTables(codes: CodeTables): void {
  try {
    localStorage.setItem(CODES_STORAGE_KEY, JSON.stringify(codes));
  } catch (err) {
    console.error('Failed saving code tables to storage:', err);
  }
}

export function getStoredInventory(): JewelryItem[] {
  try {
    const initialized = localStorage.getItem(HAS_INITIALIZED_KEY);
    if (!initialized) {
      // First launch: initialize with sample items and mark initialized
      localStorage.setItem(HAS_INITIALIZED_KEY, 'true');
      saveStoredInventory(INITIAL_INVENTORY);
      return INITIAL_INVENTORY;
    }
    const raw = localStorage.getItem(INVENTORY_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
    return [];
  } catch (err) {
    console.error('Failed reading inventory from storage:', err);
    return INITIAL_INVENTORY;
  }
}

export function saveStoredInventory(items: JewelryItem[]): void {
  try {
    localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(items));
  } catch (err) {
    console.error('Failed saving inventory to storage:', err);
  }
}

/**
 * Wipes only inventory items, strictly preserving code schemes
 */
export function clearInventoryPreservingCodes(): void {
  try {
    localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify([]));
    localStorage.setItem(HAS_INITIALIZED_KEY, 'true');
  } catch (err) {
    console.error('Failed clearing inventory:', err);
  }
}

/**
 * Restore default demo data
 */
export function restoreDemoData(): void {
  saveStoredInventory(INITIAL_INVENTORY);
  saveStoredCodeTables(DEFAULT_CODE_TABLES);
}

/**
 * Export inventory as Shopify-compatible CSV
 */
export function exportToShopifyCSV(items: JewelryItem[]): string {
  const headers = [
    'Handle',
    'Title',
    'Body (HTML)',
    'Vendor',
    'Product Category',
    'Type',
    'Tags',
    'Published',
    'Option1 Name',
    'Option1 Value',
    'Variant SKU',
    'Variant Grams',
    'Variant Inventory Tracker',
    'Variant Inventory Qty',
    'Variant Inventory Policy',
    'Variant Fulfillment Service',
    'Variant Price',
    'Variant Compare At Price',
    'Variant Requires Shipping',
    'Variant Taxable',
    'Variant Barcode',
    'Image Src',
    'Cost per item'
  ];

  const rows = items.map((item) => {
    const handle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || item.sku.toLowerCase();
    return [
      `"${handle}"`,
      `"${item.title.replace(/"/g, '""')}"`,
      `"${(item.notes || '').replace(/"/g, '""')}"`,
      `"${(item.vendor || 'Saaz Aura').replace(/"/g, '""')}"`,
      '"Apparel & Accessories > Jewelry"',
      `"${item.typeCode}"`,
      `"SKU:${item.sku}, Type:${item.typeCode}, Stone:${item.stoneCode}, Color:${item.colorCode}"`,
      'TRUE',
      'Title',
      'Default Title',
      `"${item.sku}"`,
      '50',
      'shopify',
      item.quantity,
      'deny',
      'manual',
      item.sellingPrice.toFixed(2),
      (item.sellingPrice * 1.2).toFixed(2),
      'TRUE',
      'TRUE',
      `"${item.sku}"`,
      `"${item.imageUrl || ''}"`,
      item.buyingPrice.toFixed(2)
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Download arbitrary file to browser
 */
export function downloadFile(content: string, filename: string, mimeType = 'text/csv'): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Transactions & Sales Ledger Storage
// ---------------------------------------------------------------------------
const TRANSACTIONS_STORAGE_KEY = 'saaz_ledger_transactions_v1';

export function getStoredTransactions(): import('../types/inventory').StockMovement[] {
  try {
    const raw = localStorage.getItem(TRANSACTIONS_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Failed reading transactions from storage:', err);
  }
  return [];
}

export function saveStoredTransactions(transactions: import('../types/inventory').StockMovement[]): void {
  try {
    localStorage.setItem(TRANSACTIONS_STORAGE_KEY, JSON.stringify(transactions));
  } catch (err) {
    console.error('Failed saving transactions to storage:', err);
  }
}

export function recordStockMovement(
  movement: Omit<import('../types/inventory').StockMovement, 'id' | 'timestamp'>
): import('../types/inventory').StockMovement {
  const all = getStoredTransactions();
  const entry: import('../types/inventory').StockMovement = {
    ...movement,
    id: 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    timestamp: new Date().toISOString(),
  };
  const updated = [entry, ...all];
  saveStoredTransactions(updated);
  return entry;
}

// ---------------------------------------------------------------------------
// CSV Import Parser with Intelligent Header Mapping
// ---------------------------------------------------------------------------
export interface ParsedCsvResult {
  validItems: JewelryItem[];
  errors: string[];
  skippedCount: number;
}

export function parseJewelryCSV(
  csvText: string,
  codeTables: CodeTables,
  existingInventory: JewelryItem[]
): ParsedCsvResult {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return {
      validItems: [],
      errors: ['CSV file appears empty or is missing header row.'],
      skippedCount: 0,
    };
  }

  // Parse header
  const parseRow = (line: string): string[] => {
    const values: string[] = [];
    let insideQuotes = false;
    let current = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // Skip escaped quote
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  };

  const headers = parseRow(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const headerMap: Record<string, number> = {};

  headers.forEach((col, idx) => {
    if (col.includes('title') || col.includes('name') || col.includes('item')) headerMap['title'] = idx;
    if (col === 'sku' || col.includes('variantsku')) headerMap['sku'] = idx;
    if (col === 'type' || col.includes('typecode') || col.includes('category')) headerMap['type'] = idx;
    if (col === 'stone' || col.includes('stonecode') || col.includes('material')) headerMap['stone'] = idx;
    if (col === 'color' || col.includes('colorcode') || col.includes('shade')) headerMap['color'] = idx;
    if (col.includes('buying') || col.includes('cost')) headerMap['cost'] = idx;
    if (col.includes('selling') || col.includes('retail') || col.includes('price')) headerMap['price'] = idx;
    if (col.includes('qty') || col.includes('quantity') || col.includes('stock')) headerMap['quantity'] = idx;
    if (col.includes('reorder') || col.includes('minstock')) headerMap['reorder'] = idx;
    if (col.includes('vendor') || col.includes('supplier')) headerMap['vendor'] = idx;
    if (col.includes('note') || col.includes('body') || col.includes('desc')) headerMap['notes'] = idx;
    if (col.includes('image') || col.includes('img')) headerMap['image'] = idx;
  });

  const validItems: JewelryItem[] = [];
  const errors: string[] = [];
  let skippedCount = 0;

  // Track inventory dynamically as new items are added to assign correct sequential serials
  const currentRunningInventory = [...existingInventory];

  const defaultType = codeTables.types[0]?.code || 'PD';
  const defaultStone = codeTables.stones[0]?.code || 'D';
  const defaultColor = codeTables.colors[0]?.code || '01';

  for (let r = 1; r < lines.length; r++) {
    const row = parseRow(lines[r]);
    if (row.length === 0 || row.every((c) => c === '')) {
      skippedCount++;
      continue;
    }

    const rawTitle = headerMap['title'] !== undefined ? row[headerMap['title']] : `Jewelry Item ${r}`;
    if (!rawTitle || rawTitle.trim() === '') {
      errors.push(`Row ${r + 1}: Skipped due to missing item title.`);
      skippedCount++;
      continue;
    }

    // Resolve type code
    let typeVal = headerMap['type'] !== undefined ? row[headerMap['type']].trim().toUpperCase() : '';
    const matchType = codeTables.types.find(
      (t) => t.code.toUpperCase() === typeVal || t.label.toLowerCase() === typeVal.toLowerCase()
    );
    const resolvedType = matchType ? matchType.code : defaultType;

    // Resolve stone code
    let stoneVal = headerMap['stone'] !== undefined ? row[headerMap['stone']].trim().toUpperCase() : '';
    const matchStone = codeTables.stones.find(
      (s) => s.code.toUpperCase() === stoneVal || s.label.toLowerCase() === stoneVal.toLowerCase()
    );
    const resolvedStone = matchStone ? matchStone.code : defaultStone;

    // Resolve color code
    let colorVal = headerMap['color'] !== undefined ? row[headerMap['color']].trim().toUpperCase() : '';
    const matchColor = codeTables.colors.find(
      (c) => c.code.toUpperCase() === colorVal || c.label.toLowerCase() === colorVal.toLowerCase()
    );
    const resolvedColor = matchColor ? matchColor.code : defaultColor;

    // Cost & Selling price
    const rawCost = headerMap['cost'] !== undefined ? parseFloat(row[headerMap['cost']].replace(/[^0-9.]/g, '')) : 0;
    const rawPrice = headerMap['price'] !== undefined ? parseFloat(row[headerMap['price']].replace(/[^0-9.]/g, '')) : 0;
    const buyingPrice = isNaN(rawCost) ? 0 : rawCost;
    const sellingPrice = isNaN(rawPrice) ? (buyingPrice > 0 ? buyingPrice * 2.5 : 0) : rawPrice;

    // Quantity & Reorder
    const rawQty = headerMap['quantity'] !== undefined ? parseInt(row[headerMap['quantity']], 10) : 1;
    const quantity = isNaN(rawQty) ? 1 : Math.max(0, rawQty);

    const rawReorder = headerMap['reorder'] !== undefined ? parseInt(row[headerMap['reorder']], 10) : 3;
    const reorderLevel = isNaN(rawReorder) ? 3 : Math.max(1, rawReorder);

    const vendor = headerMap['vendor'] !== undefined && row[headerMap['vendor']] ? row[headerMap['vendor']] : 'Imported Vendor';
    const notes = headerMap['notes'] !== undefined ? row[headerMap['notes']] : '';
    const imageUrl = headerMap['image'] !== undefined ? row[headerMap['image']] : '';

    // Check if valid SKU provided, otherwise auto-calculate serial
    let resolvedSku = '';
    let resolvedSerial = '001';

    const providedSku = headerMap['sku'] !== undefined ? row[headerMap['sku']].trim().toUpperCase() : '';
    if (providedSku && !currentRunningInventory.some((i) => i.sku.toUpperCase() === providedSku)) {
      resolvedSku = providedSku;
      // Try extract serial if SKU matches formula
      const trailingDigits = providedSku.match(/\d{3}$/);
      resolvedSerial = trailingDigits ? trailingDigits[0] : '001';
    } else {
      // Auto-assign next sequential serial for (type, stone, color)
      const matchingItems = currentRunningInventory.filter(
        (item) =>
          item.typeCode.toUpperCase() === resolvedType &&
          item.stoneCode.toUpperCase() === resolvedStone &&
          item.colorCode.toUpperCase() === resolvedColor
      );
      let maxSerial = 0;
      for (const item of matchingItems) {
        const num = parseInt(item.serial, 10);
        if (!isNaN(num) && num > maxSerial) {
          maxSerial = num;
        }
      }
      resolvedSerial = String(maxSerial + 1).padStart(3, '0');
      resolvedSku = `${resolvedType}${resolvedStone}${resolvedColor}${resolvedSerial}`;
    }

    const newItem: JewelryItem = {
      id: 'item_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7) + '_' + r,
      sku: resolvedSku,
      title: rawTitle,
      typeCode: resolvedType,
      stoneCode: resolvedStone,
      colorCode: resolvedColor,
      serial: resolvedSerial,
      buyingPrice,
      sellingPrice,
      quantity,
      reorderLevel,
      vendor,
      notes,
      imageUrl,
      dateAdded: new Date().toISOString().split('T')[0],
      lastRestocked: new Date().toISOString().split('T')[0],
    };

    validItems.push(newItem);
    currentRunningInventory.push(newItem);
  }

  return { validItems, errors, skippedCount };
}
