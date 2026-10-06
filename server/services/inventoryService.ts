import { db } from '../db/database';
import { allocateNextSku, registerSkuAlias } from './skuService';

export interface ItemRecord {
  id: string;
  sku: string;
  title: string;
  type_code: string;
  stone_code: string;
  color_code: string;
  serial: string;
  buying_price: number;
  selling_price: number;
  quantity: number;
  reorder_level: number;
  vendor_id?: string | null;
  vendor_name?: string | null;
  notes?: string | null;
  image_url?: string | null;
  image_hash?: string | null;
  original_image_url?: string | null;
  white_bg_image_url?: string | null;
  client_item_id?: string | null;
  date_added: string;
  last_restocked?: string | null;
  safety_reserve: number;
  is_listed_on_shopify: number;
  shopify_product_id?: string | null;
  shopify_variant_id?: string | null;
  shopify_synced_at?: string | null;
  is_listed_on_amazon: number;
  amazon_asin?: string | null;
  amazon_sku?: string | null;
  is_listed_on_myntra: number;
  myntra_style_id?: string | null;
  myntra_sku?: string | null;
  confirmed_attributes?: string | null;
  ai_suggestions?: string | null;
  is_deleted?: number;
  deleted_at?: string | null;
  deleted_reason?: string | null;
  created_at: string;
  updated_at: string;
}

export function getAllItems(includeDeleted = false): ItemRecord[] {
  if (includeDeleted) {
    return db.prepare('SELECT * FROM items ORDER BY date_added DESC, created_at DESC').all() as ItemRecord[];
  }
  return db.prepare('SELECT * FROM items WHERE is_deleted = 0 OR is_deleted IS NULL ORDER BY date_added DESC, created_at DESC').all() as ItemRecord[];
}

export function getTrashItems(): ItemRecord[] {
  return db.prepare('SELECT * FROM items WHERE is_deleted = 1 ORDER BY deleted_at DESC, date_added DESC').all() as ItemRecord[];
}

export function softDeleteItem(id: string, reason?: string): boolean {
  const info = db.prepare(`
    UPDATE items 
    SET is_deleted = 1, deleted_at = datetime('now'), deleted_reason = ? 
    WHERE id = ?
  `).run(reason || 'User deleted', id);
  return info.changes > 0;
}

export function restoreItem(id: string): boolean {
  const info = db.prepare(`
    UPDATE items 
    SET is_deleted = 0, deleted_at = NULL, deleted_reason = NULL 
    WHERE id = ?
  `).run(id);
  return info.changes > 0;
}

// Records a SKU into the tombstone table before it's permanently removed from `items`, so a
// stale browser/device inventory snapshot can never silently re-insert it later (the browser
// migration import upserts by SKU with ON CONFLICT DO NOTHING - a hard-deleted row is genuinely
// gone from `items`, so without this tombstone that upsert has no way to distinguish "this SKU
// was deleted" from "this SKU never existed", and would just recreate it as active).
function recordDeletedSku(sku: string | undefined | null): void {
  if (!sku) return;
  try {
    db.prepare('INSERT OR IGNORE INTO deleted_skus (sku) VALUES (?)').run(sku);
  } catch {}
}

/** Whether this SKU was ever hard-deleted (or trashed-then-emptied) and should never be
 * silently resurrected by an upsert-by-SKU import path (e.g. the browser-migration endpoint). */
export function isSkuTombstoned(sku: string | undefined | null): boolean {
  if (!sku) return false;
  try {
    return Boolean(db.prepare('SELECT 1 FROM deleted_skus WHERE sku = ?').get(sku));
  } catch {
    return false;
  }
}

export function hardDeleteItem(id: string): boolean {
  const item = db.prepare('SELECT sku FROM items WHERE id = ?').get(id) as { sku: string } | undefined;
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(id);
  if (info.changes > 0 && item?.sku) {
    recordDeletedSku(item.sku);
  }
  return info.changes > 0;
}

export function emptyTrash(): number {
  const trashed = db.prepare('SELECT sku FROM items WHERE is_deleted = 1').all() as { sku: string }[];
  const info = db.prepare('DELETE FROM items WHERE is_deleted = 1').run();
  for (const row of trashed) {
    recordDeletedSku(row.sku);
  }
  return info.changes;
}

export function getItemById(id: string): ItemRecord | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRecord | undefined;
}

export function itemRecordToJewelryItem(r: ItemRecord): any {
  let confirmed: Record<string, any> = {};
  if (r.confirmed_attributes) {
    try {
      confirmed = JSON.parse(r.confirmed_attributes);
    } catch {
      confirmed = {};
    }
  }

  let suggestions: Record<string, any> | undefined = undefined;
  if (r.ai_suggestions) {
    try {
      suggestions = JSON.parse(r.ai_suggestions);
    } catch {
      suggestions = undefined;
    }
  }

  return {
    id: r.id,
    sku: r.sku,
    title: r.title,
    typeCode: r.type_code,
    stoneCode: r.stone_code,
    colorCode: r.color_code,
    serial: r.serial,
    buyingPrice: Number(r.buying_price) || 0,
    sellingPrice: Number(r.selling_price) || 0,
    quantity: Number(r.quantity) || 0,
    reorderLevel: Number(r.reorder_level) || 0,
    vendor: r.vendor_name || 'Aura Creations',
    notes: r.notes || '',
    imageUrl: r.image_url || '',
    imageHash: r.image_hash || '',
    originalImageUrl: r.original_image_url || undefined,
    whiteBgImageUrl: r.white_bg_image_url || undefined,
    clientItemId: r.client_item_id || undefined,
    dateAdded: r.date_added,
    lastRestocked: r.last_restocked || undefined,
    safetyReserve: Number(r.safety_reserve) || 0,
    isListedOnShopify: Boolean(r.is_listed_on_shopify),
    shopifyProductId: r.shopify_product_id || undefined,
    shopifyVariantId: r.shopify_variant_id || undefined,
    shopifySyncedAt: r.shopify_synced_at || undefined,
    isListedOnAmazon: Boolean(r.is_listed_on_amazon),
    amazonAsin: r.amazon_asin || undefined,
    amazonSku: r.amazon_sku || undefined,
    isListedOnMyntra: Boolean(r.is_listed_on_myntra),
    myntraStyleId: r.myntra_style_id || undefined,
    myntraSku: r.myntra_sku || undefined,
    confirmedAttributes: confirmed,
    aiSuggestions: suggestions,
    isDeleted: Boolean(r.is_deleted),
    deletedAt: r.deleted_at || undefined,
    deletedReason: r.deleted_reason || undefined,
    displayColour: confirmed.displayColour,
    stoneMaterial: confirmed.stoneMaterial,
    metalFinish: confirmed.metalFinish,
    plating: confirmed.plating,
    designMotif: confirmed.designMotif,
    productType: confirmed.productType,
    includedComponents: confirmed.includedComponents,
    titleSource: confirmed.titleSource,
    isTitleLocked: confirmed.isTitleLocked,
    platingConfirmed: confirmed.platingConfirmed,
    stoneConfirmed: confirmed.stoneConfirmed,
  };
}

export function getItemBySku(sku: string): ItemRecord | undefined {
  const clean = sku.trim().toUpperCase();
  return db.prepare('SELECT * FROM items WHERE sku = ?').get(clean) as ItemRecord | undefined;
}

export interface CreateItemInput {
  /** Stable client-generated idempotency key: a repeated create with the same key returns the same item. */
  clientItemId?: string;
  /** Optional pre-reserved SKU (e.g. from /api/sku/allocate-global). Rejected if already used by another item. */
  sku?: string;
  serial?: string;
  originalImageUrl?: string;
  whiteBgImageUrl?: string;
  title: string;
  typeCode: string;
  stoneCode: string;
  colorCode: string;
  buyingPrice: number;
  sellingPrice: number;
  quantity: number;
  reorderLevel?: number;
  vendorId?: string;
  vendorName?: string;
  /** The browser sends the artisan as `vendor` (JewelryItem.vendor); accepted as an alias of vendorName. */
  vendor?: string;
  notes?: string;
  imageUrl?: string;
  imageHash?: string;
  safetyReserve?: number;
  isListedOnShopify?: boolean;
  isListedOnAmazon?: boolean;
  amazonAsin?: string;
  amazonSku?: string;
  isListedOnMyntra?: boolean;
  myntraStyleId?: string;
  myntraSku?: string;
  confirmedAttributes?: Record<string, any>;
  aiSuggestions?: Record<string, any>;
  displayColour?: string;
  stoneMaterial?: string;
  metalFinish?: string;
  plating?: string;
  designMotif?: string;
  productType?: string;
  includedComponents?: string;
  titleSource?: string;
  isTitleLocked?: boolean;
  platingConfirmed?: boolean;
  stoneConfirmed?: boolean;
}

/**
 * Creates a new jewelry item with atomic SKU allocation and initial purchase lot
 */
export function createItem(input: CreateItemInput): ItemRecord {
  return createItemIdempotent(input).item;
}

export class DuplicateSkuError extends Error {
  code = 'DUPLICATE_SKU';
  constructor(sku: string) {
    super(`SKU ${sku} already belongs to another item.`);
  }
}

/**
 * Idempotent create: when `clientItemId` was already used, returns the stored item with created=false
 * instead of inserting a second one (safe for retries and double-clicks).
 */
export function createItemIdempotent(input: CreateItemInput): { item: ItemRecord; created: boolean } {
  return db.transaction((): { item: ItemRecord; created: boolean } => {
    const clientItemId = input.clientItemId ? String(input.clientItemId).trim() : '';
    if (clientItemId) {
      const prior = db.prepare('SELECT * FROM items WHERE client_item_id = ?').get(clientItemId) as ItemRecord | undefined;
      if (prior) return { item: prior, created: false };
    }
    if (!input.title || !String(input.title).trim()) {
      throw new Error('Title is required to create an item.');
    }

    // 1. Use a pre-reserved SKU (duplicate-guarded) or allocate a unique SKU atomically
    let alloc: { sku: string; typeCode: string; stoneCode: string; colorCode: string; serial: string };
    const requestedSku = input.sku ? String(input.sku).trim().toUpperCase() : '';
    if (requestedSku) {
      const taken = db.prepare(
        'SELECT 1 FROM items WHERE sku = ? UNION SELECT 1 FROM sku_aliases WHERE alias_sku = ?'
      ).get(requestedSku, requestedSku);
      if (taken) throw new DuplicateSkuError(requestedSku);
      alloc = {
        sku: requestedSku,
        typeCode: String(input.typeCode || '').trim().toUpperCase(),
        stoneCode: String(input.stoneCode || '').trim().toUpperCase(),
        colorCode: String(input.colorCode || '').trim().toUpperCase(),
        serial: input.serial ? String(input.serial) : requestedSku.replace(/^.*?(\d+)$/, '$1'),
      };
    } else {
      alloc = allocateNextSku(input.typeCode, input.stoneCode, input.colorCode);
    }

    const itemId = `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const today = new Date().toISOString().split('T')[0];

    const finalConfirmed = input.confirmedAttributes || (
      (input.displayColour || input.stoneMaterial || input.metalFinish || input.designMotif || input.titleSource || input.isTitleLocked !== undefined)
        ? {
            displayColour: input.displayColour,
            stoneMaterial: input.stoneMaterial,
            metalFinish: input.metalFinish,
            plating: input.plating,
            designMotif: input.designMotif,
            productType: input.productType,
            includedComponents: input.includedComponents,
            titleSource: input.titleSource,
            isTitleLocked: input.isTitleLocked,
            platingConfirmed: input.platingConfirmed,
            stoneConfirmed: input.stoneConfirmed,
          }
        : null
    );

    // 2. Insert item record
    db.prepare(`
      INSERT INTO items (
        id, sku, title, type_code, stone_code, color_code, serial,
        buying_price, selling_price, quantity, reorder_level,
        vendor_id, vendor_name, notes, image_url, image_hash,
        date_added, last_restocked, safety_reserve,
        is_listed_on_shopify, is_listed_on_amazon, amazon_asin, amazon_sku,
        is_listed_on_myntra, myntra_style_id, myntra_sku,
        confirmed_attributes, ai_suggestions,
        client_item_id, original_image_url, white_bg_image_url
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?
      )
    `).run(
      itemId,
      alloc.sku,
      input.title.trim(),
      alloc.typeCode,
      alloc.stoneCode,
      alloc.colorCode,
      alloc.serial,
      input.buyingPrice || 0,
      input.sellingPrice || 0,
      input.quantity || 0,
      input.reorderLevel !== undefined ? input.reorderLevel : 3,
      input.vendorId || null,
      input.vendorName || input.vendor || null,
      input.notes || null,
      input.imageUrl || null,
      input.imageHash || null,
      today,
      today,
      input.safetyReserve || 0,
      input.isListedOnShopify !== false ? 1 : 0,
      input.isListedOnAmazon ? 1 : 0,
      input.amazonAsin || null,
      input.amazonSku || null,
      input.isListedOnMyntra ? 1 : 0,
      input.myntraStyleId || null,
      input.myntraSku || null,
      finalConfirmed ? JSON.stringify(finalConfirmed) : null,
      input.aiSuggestions ? JSON.stringify(input.aiSuggestions) : null,
      clientItemId || null,
      input.originalImageUrl || null,
      input.whiteBgImageUrl || null
    );

    // 3. Register channel aliases if present
    if (input.amazonAsin) registerSkuAlias(itemId, input.amazonAsin, 'amazon');
    if (input.amazonSku) registerSkuAlias(itemId, input.amazonSku, 'amazon');
    if (input.myntraStyleId) registerSkuAlias(itemId, input.myntraStyleId, 'myntra');
    if (input.myntraSku) registerSkuAlias(itemId, input.myntraSku, 'myntra');

    // 4. Create initial purchase lot if quantity > 0
    if (input.quantity > 0) {
      db.prepare(`
        INSERT INTO purchase_lots (
          id, item_id, vendor_id, batch_ref, received_date, quantity_received, quantity_remaining, unit_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `lot_${itemId}_init`,
        itemId,
        input.vendorId || null,
        `INTAKE_${today.replace(/-/g, '')}`,
        today,
        input.quantity,
        input.quantity,
        input.buyingPrice || 0
      );

      // Record initial intake movement
      db.prepare(`
        INSERT INTO stock_movements (
          id, item_id, sku, item_title, type, quantity_delta, unit_price, total_price, cost_price, channel, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `tx_init_${itemId}`,
        itemId,
        alloc.sku,
        input.title.trim(),
        'restock',
        input.quantity,
        input.buyingPrice,
        input.buyingPrice * input.quantity,
        input.buyingPrice,
        'Initial Intake',
        'Item registered in master catalog'
      );
    }

    return { item: getItemById(itemId)!, created: true };
  })();
}

/**
 * Partial update of an existing item. Never blanks stored photos (image/original/white-bg) with an
 * empty value and never touches product_media_links, so gallery packs and media links are preserved.
 */
export function updateItem(id: string, updates: Record<string, any>): ItemRecord | undefined {
  const existing = getItemById(id);
  if (!existing) return undefined;
  let confirmedAttrs: Record<string, any> = existing.confirmed_attributes ? (() => {
    try { return JSON.parse(existing.confirmed_attributes as string); } catch { return {}; }
  })() : {};

  for (const k of ['displayColour', 'stoneMaterial', 'metalFinish', 'plating', 'designMotif', 'productType',
    'includedComponents', 'titleSource', 'isTitleLocked', 'platingConfirmed', 'stoneConfirmed']) {
    if (updates[k] !== undefined) confirmedAttrs[k] = updates[k];
  }
  if (updates.confirmedAttributes) confirmedAttrs = { ...confirmedAttrs, ...updates.confirmedAttributes };
  const hasAttrUpdates = Object.keys(confirmedAttrs).length > 0;
  const nonEmpty = (v: any) => (v !== undefined && v !== null && v !== '' ? v : null);

  db.prepare(`
    UPDATE items SET
      title = COALESCE(?, title),
      buying_price = COALESCE(?, buying_price),
      selling_price = COALESCE(?, selling_price),
      quantity = COALESCE(?, quantity),
      reorder_level = COALESCE(?, reorder_level),
      vendor_name = COALESCE(?, vendor_name),
      notes = COALESCE(?, notes),
      image_url = COALESCE(?, image_url),
      image_hash = COALESCE(?, image_hash),
      original_image_url = COALESCE(?, original_image_url),
      white_bg_image_url = COALESCE(?, white_bg_image_url),
      safety_reserve = COALESCE(?, safety_reserve),
      is_listed_on_amazon = COALESCE(?, is_listed_on_amazon),
      amazon_asin = COALESCE(?, amazon_asin),
      is_listed_on_myntra = COALESCE(?, is_listed_on_myntra),
      myntra_style_id = COALESCE(?, myntra_style_id),
      confirmed_attributes = COALESCE(?, confirmed_attributes),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    updates.title !== undefined ? updates.title : null,
    updates.buyingPrice !== undefined ? updates.buyingPrice : null,
    updates.sellingPrice !== undefined ? updates.sellingPrice : null,
    updates.quantity !== undefined ? updates.quantity : null,
    updates.reorderLevel !== undefined ? updates.reorderLevel : null,
    updates.vendor !== undefined ? updates.vendor : null,
    updates.notes !== undefined ? updates.notes : null,
    nonEmpty(updates.imageUrl),
    nonEmpty(updates.imageHash),
    nonEmpty(updates.originalImageUrl),
    nonEmpty(updates.whiteBgImageUrl),
    updates.safetyReserve !== undefined ? updates.safetyReserve : null,
    updates.isListedOnAmazon !== undefined ? (updates.isListedOnAmazon ? 1 : 0) : null,
    updates.amazonAsin !== undefined ? updates.amazonAsin : null,
    updates.isListedOnMyntra !== undefined ? (updates.isListedOnMyntra ? 1 : 0) : null,
    updates.myntraStyleId !== undefined ? updates.myntraStyleId : null,
    hasAttrUpdates ? JSON.stringify(confirmedAttrs) : null,
    id
  );
  return getItemById(id);
}

/**
 * Read-only verification snapshot: exactly what the server stores for an item (raw row, as the client
 * sees it) plus every linked media asset (role, urls) and counts.
 */
export function getItemVerification(id: string) {
  const row = getItemById(id);
  if (!row) return null;
  const links = db.prepare(`
    SELECT l.id AS link_id, l.slot_type, l.display_order, l.gallery_position, l.is_cover, l.shopify_position,
           m.id AS media_id, m.original_filename, m.media_type, m.classification, m.file_role, m.source_type,
           m.processing_status, m.approval_status, m.selection_status, m.is_deleted, m.shopify_upload_status
    FROM product_media_links l
    JOIN media_assets m ON m.id = l.media_id
    WHERE l.product_id = ?
    ORDER BY l.display_order, l.gallery_position, l.created_at
  `).all(id) as any[];
  const locStmt = db.prepare(
    'SELECT provider, storage_role, storage_key, public_delivery_url, replication_status FROM media_storage_locations WHERE media_id = ?'
  );
  const media = links.map((l) => {
    const locations = locStmt.all(l.media_id) as any[];
    const primary = locations.find((x) => x.storage_role === 'primary') || locations[0];
    return {
      ...l,
      is_cover: Boolean(l.is_cover),
      is_deleted: Boolean(l.is_deleted),
      url: primary?.public_delivery_url || null,
      locations,
    };
  });
  const byRole: Record<string, number> = {};
  for (const m of media) {
    const r = m.file_role || m.slot_type || 'unknown';
    byRole[r] = (byRole[r] || 0) + 1;
  }
  return {
    id: row.id,
    sku: row.sku,
    stored: row,
    item: itemRecordToJewelryItem(row),
    media,
    counts: {
      totalLinks: media.length,
      activeLinks: media.filter((m) => !m.is_deleted).length,
      byRole,
      hasMainImage: Boolean(row.image_url),
      hasOriginalImage: Boolean(row.original_image_url),
    },
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Records a sale using FIFO (First-In, First-Out) purchase lot cost depletion
 */
export function recordSaleFifo(params: {
  itemId: string;
  quantitySold: number;
  salePricePerUnit: number;
  channel: string;
  externalOrderId?: string;
  notes?: string;
}): {
  movementId: string;
  totalCost: number;
  realizedGrossProfit: number;
  newQuantity: number;
} {
  return db.transaction(() => {
    const item = getItemById(params.itemId);
    if (!item) {
      throw new Error(`Item ${params.itemId} not found`);
    }

    const qtySold = Math.max(1, params.quantitySold);
    if (item.quantity < qtySold) {
      throw new Error(`Insufficient stock for ${item.sku}. Available: ${item.quantity}, requested: ${qtySold}`);
    }

    // Deplete from purchase lots via FIFO
    const lots = db.prepare(`
      SELECT * FROM purchase_lots
      WHERE item_id = ? AND quantity_remaining > 0
      ORDER BY received_date ASC, created_at ASC
    `).all(params.itemId) as Array<{
      id: string;
      quantity_remaining: number;
      unit_cost: number;
    }>;

    let remainingToDeplete = qtySold;
    let totalCost = 0;

    for (const lot of lots) {
      if (remainingToDeplete <= 0) break;

      const take = Math.min(remainingToDeplete, lot.quantity_remaining);
      db.prepare(`
        UPDATE purchase_lots
        SET quantity_remaining = quantity_remaining - ?
        WHERE id = ?
      `).run(take, lot.id);

      totalCost += take * lot.unit_cost;
      remainingToDeplete -= take;
    }

    // If remaining units exceed tracked lots, fallback to item's base buying price
    if (remainingToDeplete > 0) {
      totalCost += remainingToDeplete * item.buying_price;
    }

    const totalRevenue = params.salePricePerUnit * qtySold;
    const realizedGrossProfit = totalRevenue - totalCost;
    const newQuantity = item.quantity - qtySold;

    // Update item stock
    db.prepare(`
      UPDATE items
      SET quantity = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newQuantity, item.id);

    const movementId = `tx_sale_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // Append to stock movements
    db.prepare(`
      INSERT INTO stock_movements (
        id, item_id, sku, item_title, type, quantity_delta,
        unit_price, total_price, cost_price, realized_profit,
        channel, external_order_id, notes
      ) VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      movementId,
      item.id,
      item.sku,
      item.title,
      -qtySold,
      params.salePricePerUnit,
      totalRevenue,
      totalCost / qtySold,
      realizedGrossProfit,
      params.channel || 'Direct Sale',
      params.externalOrderId || null,
      params.notes || null
    );

    return {
      movementId,
      totalCost,
      realizedGrossProfit,
      newQuantity,
    };
  })();
}

/**
 * Restocks an item and creates an identifiable purchase lot
 */
export function restockItem(params: {
  itemId: string;
  quantityToAdd: number;
  unitCost?: number;
  batchRef?: string;
  vendorId?: string;
}): { newQuantity: number; lotId: string } {
  return db.transaction(() => {
    const item = getItemById(params.itemId);
    if (!item) throw new Error(`Item ${params.itemId} not found`);

    const qty = Math.max(1, params.quantityToAdd);
    const cost = params.unitCost !== undefined ? params.unitCost : item.buying_price;
    const today = new Date().toISOString().split('T')[0];
    const newQuantity = item.quantity + qty;

    // Update item quantity
    db.prepare(`
      UPDATE items
      SET quantity = ?, last_restocked = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newQuantity, today, item.id);

    const lotId = `lot_${item.id}_${Date.now()}`;

    // Create purchase lot
    db.prepare(`
      INSERT INTO purchase_lots (
        id, item_id, vendor_id, batch_ref, received_date, quantity_received, quantity_remaining, unit_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lotId,
      item.id,
      params.vendorId || item.vendor_id || null,
      params.batchRef || `RESTOCK_${today.replace(/-/g, '')}`,
      today,
      qty,
      qty,
      cost
    );

    // Record stock movement
    db.prepare(`
      INSERT INTO stock_movements (
        id, item_id, sku, item_title, type, quantity_delta, unit_price, total_price, cost_price, channel, notes
      ) VALUES (?, ?, ?, ?, 'restock', ?, ?, ?, ?, 'Procurement', ?)
    `).run(
      `tx_restock_${Date.now()}`,
      item.id,
      item.sku,
      item.title,
      qty,
      cost,
      cost * qty,
      cost,
      params.batchRef ? `Restock Batch: ${params.batchRef}` : 'Inventory restocked'
    );

    return { newQuantity, lotId };
  })();
}

/**
 * Reconciles an order cancellation or inspected return
 */
export function handleOrderReversal(params: {
  itemId: string;
  quantity: number;
  isRestockable: boolean;
  reason: string;
  channel: string;
  externalOrderId?: string;
}): { newQuantity: number } {
  return db.transaction(() => {
    const item = getItemById(params.itemId);
    if (!item) throw new Error(`Item ${params.itemId} not found`);

    const qty = Math.max(1, params.quantity);
    let newQuantity = item.quantity;

    if (params.isRestockable) {
      newQuantity = item.quantity + qty;
      db.prepare(`
        UPDATE items
        SET quantity = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newQuantity, item.id);

      // Re-create available lot
      db.prepare(`
        INSERT INTO purchase_lots (
          id, item_id, batch_ref, received_date, quantity_received, quantity_remaining, unit_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `lot_return_${item.id}_${Date.now()}`,
        item.id,
        `RETURN_${params.externalOrderId || 'CUST'}`,
        new Date().toISOString().split('T')[0],
        qty,
        qty,
        item.buying_price
      );

      // Record return movement
      db.prepare(`
        INSERT INTO stock_movements (
          id, item_id, sku, item_title, type, quantity_delta, unit_price, total_price, cost_price, channel, external_order_id, notes
        ) VALUES (?, ?, ?, ?, 'return', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `tx_ret_${Date.now()}`,
        item.id,
        item.sku,
        item.title,
        qty,
        item.selling_price,
        item.selling_price * qty,
        item.buying_price,
        params.channel,
        params.externalOrderId || null,
        `Inspected Return: ${params.reason}`
      );
    } else {
      // Non-restockable return (damaged / scrap)
      db.prepare(`
        INSERT INTO stock_movements (
          id, item_id, sku, item_title, type, quantity_delta, unit_price, total_price, cost_price, channel, external_order_id, notes
        ) VALUES (?, ?, ?, ?, 'scrap', 0, 0, 0, ?, ?, ?, ?)
      `).run(
        `tx_scrap_${Date.now()}`,
        item.id,
        item.sku,
        item.title,
        item.buying_price,
        params.channel,
        params.externalOrderId || null,
        `Damaged / Non-sellable return: ${params.reason}`
      );
    }

    return { newQuantity };
  })();
}
