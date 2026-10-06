/**
 * Maps a SaazLedger inventory item (DB row or client JewelryItem) to the Shopify
 * draft fields: price (sellingPrice), cost (buyingPrice), stock (quantity),
 * product_type (jewellery type label) and tags (type / stone / colour labels).
 * Nothing here is hard-coded; every value comes from the item.
 */
import { db } from '../db/database';
import { DEFAULT_CODE_TABLES } from '../../src/services/initialData';
import type { DraftProductInput } from './shopifyDraftService';

function pick(...vals: unknown[]): unknown {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

function labelFor(category: 'types' | 'stones' | 'colors', code?: string): string | undefined {
  const c = String(code || '').trim();
  if (!c) return undefined;
  try {
    const row = db.prepare('SELECT label FROM code_reference WHERE category = ? AND code = ?').get(category, c) as { label?: string } | undefined;
    if (row?.label) return row.label;
  } catch { /* table may be missing */ }
  return DEFAULT_CODE_TABLES[category].find((x) => x.code === c)?.label;
}

/** Looks up the authoritative local inventory row by id or SKU. */
export function findLocalItem(id?: string, sku?: string): any | null {
  try {
    if (id) {
      const r = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
      if (r) return r;
    }
    if (sku) {
      const r = db.prepare('SELECT * FROM items WHERE sku = ?').get(sku);
      if (r) return r;
    }
  } catch { /* ignored */ }
  return null;
}

/**
 * `client` is the request-supplied item (camelCase JewelryItem or productData);
 * `local` is the DB row (snake_case) when one exists. The DB row wins: it is the inventory truth.
 */
export function buildDraftInputFromItem(client: any, local: any | null, extra: Partial<DraftProductInput> = {}): DraftProductInput {
  const c = client || {};
  const l = local || {};
  const typeCode = String(pick(l.type_code, c.typeCode, c.type_code) || '').trim();
  const stoneCode = String(pick(l.stone_code, c.stoneCode, c.stone_code) || '').trim();
  const colorCode = String(pick(l.color_code, c.colorCode, c.color_code) || '').trim();
  const typeLabel = labelFor('types', typeCode) || (typeof c.productType === 'string' ? c.productType : undefined);
  const stoneLabel = labelFor('stones', stoneCode);
  const colorLabel = labelFor('colors', colorCode);

  const qtyRaw = pick(l.quantity, c.quantity);
  const qtyNum = qtyRaw === undefined ? NaN : Number(qtyRaw);
  const sell = pick(l.selling_price, c.sellingPrice, c.selling_price, c.price);
  const buy = pick(l.buying_price, c.buyingPrice, c.buying_price, c.cost);

  const sku = String(pick(l.sku, c.sku) || '').trim();
  const tags = [typeLabel, stoneLabel, colorLabel, sku ? `SKU:${sku}` : undefined].filter((t): t is string => !!t);

  return {
    sku: sku || undefined,
    itemId: String(pick(l.id, c.id) || '') || undefined,
    title: String(pick(c.title, l.title) || ''),
    price: sell as any,
    cost: buy as any,
    quantity: Number.isFinite(qtyNum) ? Math.floor(qtyNum) : undefined,
    typeCode: typeCode || undefined,
    category: typeLabel || 'Jewelry',
    vendor: (pick(c.vendor, l.vendor_name) as string | undefined) || undefined,
    tags,
    ...extra,
  };
}
