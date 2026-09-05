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
  created_at: string;
  updated_at: string;
}

export function getAllItems(): ItemRecord[] {
  return db.prepare('SELECT * FROM items ORDER BY date_added DESC, created_at DESC').all() as ItemRecord[];
}

export function getItemById(id: string): ItemRecord | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRecord | undefined;
}

export function itemRecordToJewelryItem(r: ItemRecord): any {
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
    confirmedAttributes: r.confirmed_attributes ? JSON.parse(r.confirmed_attributes) : undefined,
    aiSuggestions: r.ai_suggestions ? JSON.parse(r.ai_suggestions) : undefined,
  };
}

export function getItemBySku(sku: string): ItemRecord | undefined {
  const clean = sku.trim().toUpperCase();
  return db.prepare('SELECT * FROM items WHERE sku = ?').get(clean) as ItemRecord | undefined;
}

export interface CreateItemInput {
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
}

/**
 * Creates a new jewelry item with atomic SKU allocation and initial purchase lot
 */
export function createItem(input: CreateItemInput): ItemRecord {
  return db.transaction(() => {
    // 1. Allocate unique SKU atomically
    const alloc = allocateNextSku(input.typeCode, input.stoneCode, input.colorCode);

    const itemId = `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const today = new Date().toISOString().split('T')[0];

    // 2. Insert item record
    db.prepare(`
      INSERT INTO items (
        id, sku, title, type_code, stone_code, color_code, serial,
        buying_price, selling_price, quantity, reorder_level,
        vendor_id, vendor_name, notes, image_url, image_hash,
        date_added, last_restocked, safety_reserve,
        is_listed_on_shopify, is_listed_on_amazon, amazon_asin, amazon_sku,
        is_listed_on_myntra, myntra_style_id, myntra_sku,
        confirmed_attributes, ai_suggestions
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
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
      input.vendorName || null,
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
      input.confirmedAttributes ? JSON.stringify(input.confirmedAttributes) : null,
      input.aiSuggestions ? JSON.stringify(input.aiSuggestions) : null
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

    return getItemById(itemId)!;
  })();
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
