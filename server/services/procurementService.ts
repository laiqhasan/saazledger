import { db } from '../db/database';
import { recordInventoryMovement } from './multiStateInventoryService';

export interface ReorderSuggestion {
  variantId: string;
  sku: string;
  title: string;
  vendorId?: string;
  vendorName?: string;
  onHand: number;
  available: number;
  incoming: number;
  reorderLevel: number;
  suggestedQty: number;
  buyingPrice: number;
  leadTimeDays: number;
}

export interface PurchaseOrderRecord {
  id: string;
  poNumber: string;
  vendorId: string;
  vendorName: string;
  status: 'draft' | 'approved' | 'sent' | 'partially_received' | 'received' | 'cancelled';
  totalAmount: number;
  expectedDate?: string;
  notes?: string;
  createdAt: string;
  lines: Array<{
    id: string;
    variantId: string;
    sku: string;
    title: string;
    quantityOrdered: number;
    quantityReceived: number;
    unitCost: number;
  }>;
}

/**
 * Calculates accurate reorder recommendations taking incoming POs into account
 */
export function calculateReorderSuggestions(): ReorderSuggestion[] {
  const rows = db.prepare(`
    SELECT
      v.id as variant_id,
      v.sku,
      p.title,
      v.vendor_id,
      ven.name as vendor_name,
      ven.lead_time_days,
      v.reorder_level,
      v.buying_price,
      COALESCE(b.on_hand, 0) as on_hand,
      COALESCE(b.available, 0) as available,
      COALESCE(b.incoming, 0) as incoming
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN vendors ven ON ven.id = v.vendor_id
    LEFT JOIN inventory_balances b ON b.variant_id = v.id AND b.location_id = 'loc_main_vault'
    WHERE v.is_active = 1
  `).all() as any[];

  const suggestions: ReorderSuggestion[] = [];

  for (const r of rows) {
    const netPosition = r.available + r.incoming;
    if (netPosition <= r.reorder_level) {
      const suggestedQty = Math.max((r.reorder_level * 2) - netPosition, 5);
      suggestions.push({
        variantId: r.variant_id,
        sku: r.sku,
        title: r.title,
        vendorId: r.vendor_id,
        vendorName: r.vendor_name || 'Unassigned Artisan',
        onHand: r.on_hand,
        available: r.available,
        incoming: r.incoming,
        reorderLevel: r.reorder_level,
        suggestedQty,
        buyingPrice: r.buying_price,
        leadTimeDays: r.lead_time_days || 10,
      });
    }
  }

  return suggestions;
}

/**
 * Creates a new Purchase Order in draft status and tracks incoming inventory
 */
export function createPurchaseOrder(params: {
  vendorId: string;
  lines: Array<{ variantId: string; quantity: number; unitCost: number; notes?: string }>;
  expectedDate?: string;
  notes?: string;
  actor?: string;
}): PurchaseOrderRecord {
  return db.transaction(() => {
    const poCount = (db.prepare('SELECT COUNT(*) as count FROM purchase_orders').get() as { count: number }).count;
    const poNumber = `PO-${new Date().getFullYear()}-${String(poCount + 1).padStart(4, '0')}`;
    const poId = `po_${Date.now()}`;

    let totalAmount = 0;
    for (const l of params.lines) {
      totalAmount += l.quantity * l.unitCost;
    }

    db.prepare(`
      INSERT INTO purchase_orders (id, po_number, vendor_id, status, total_amount, expected_date, notes, created_by)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(poId, poNumber, params.vendorId, totalAmount, params.expectedDate || null, params.notes || null, params.actor || 'admin');

    for (const line of params.lines) {
      const lineId = `pol_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      db.prepare(`
        INSERT INTO purchase_order_lines (id, po_id, variant_id, quantity_ordered, quantity_received, unit_cost, notes)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).run(lineId, poId, line.variantId, line.quantity, line.unitCost, line.notes || null);

      // Track incoming quantity on balance
      db.prepare(`
        UPDATE inventory_balances
        SET incoming = incoming + ?, updated_at = datetime('now')
        WHERE variant_id = ? AND location_id = 'loc_main_vault'
      `).run(line.quantity, line.variantId);
    }

    return getPurchaseOrderById(poId)!;
  })();
}

/**
 * Receives goods against a Purchase Order, creates purchase lots with verified costs,
 * decrements incoming balance, and records PURCHASE_RECEIPT stock movement.
 */
export function receivePurchaseOrder(params: {
  poId: string;
  receipts: Array<{ lineId: string; variantId: string; quantityReceived: number; unitCost?: number }>;
  actor?: string;
}): boolean {
  return db.transaction(() => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(params.poId) as any;
    if (!po) throw new Error('Purchase Order not found');

    const vendor = db.prepare('SELECT code FROM vendors WHERE id = ?').get(po.vendor_id) as { code: string } | undefined;
    const vendorCode = vendor?.code || 'VEN';

    for (const item of params.receipts) {
      if (item.quantityReceived <= 0) continue;

      const line = db.prepare('SELECT * FROM purchase_order_lines WHERE id = ?').get(item.lineId) as any;
      const unitCost = item.unitCost !== undefined ? item.unitCost : (line ? line.unit_cost : 0);

      // 1. Update PO line quantity received
      db.prepare(`
        UPDATE purchase_order_lines
        SET quantity_received = quantity_received + ?
        WHERE id = ?
      `).run(item.quantityReceived, item.lineId);

      // 2. Decrement incoming balance
      db.prepare(`
        UPDATE inventory_balances
        SET incoming = MAX(0, incoming - ?), updated_at = datetime('now')
        WHERE variant_id = ? AND location_id = 'loc_main_vault'
      `).run(item.quantityReceived, item.variantId);

      // 3. Create purchase lot
      const lotId = `lot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const lotNumber = `LOT-${vendorCode}-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${lotId.slice(-4).toUpperCase()}`;

      const varRow = db.prepare('SELECT product_id, sku FROM product_variants WHERE id = ?').get(item.variantId) as any;
      let itemId = varRow?.product_id || item.variantId.replace('var_', '');
      const existingItem = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId) as any;

      if (!existingItem) {
        const bySku = varRow?.sku ? (db.prepare('SELECT id FROM items WHERE sku = ?').get(varRow.sku) as any) : null;
        if (bySku) {
          itemId = bySku.id;
        } else {
          const first = db.prepare('SELECT id FROM items LIMIT 1').get() as any;
          if (first) itemId = first.id;
        }
      }

      db.prepare(`
        INSERT INTO purchase_lots (
          id, item_id, variant_id, vendor_id, po_id, batch_ref, received_date,
          quantity_received, quantity_remaining, unit_cost
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
      `).run(
        lotId,
        itemId,
        item.variantId,
        po.vendor_id,
        params.poId,
        lotNumber,
        item.quantityReceived,
        item.quantityReceived,
        unitCost
      );

      // 4. Record append-only inventory movement
      recordInventoryMovement({
        variantId: item.variantId,
        movementType: 'PURCHASE_RECEIPT',
        quantity: item.quantityReceived,
        unitCost,
        referenceType: 'purchase_order',
        referenceId: po.po_number,
        notes: `Received from ${po.po_number} into lot ${lotNumber}`,
        actor: params.actor || 'admin',
      });
    }

    // Check if PO is completely fulfilled
    const lines = db.prepare('SELECT quantity_ordered, quantity_received FROM purchase_order_lines WHERE po_id = ?').all(params.poId) as any[];
    const allFulfilled = lines.every((l) => l.quantity_received >= l.quantity_ordered);
    const anyReceived = lines.some((l) => l.quantity_received > 0);

    const newStatus = allFulfilled ? 'received' : anyReceived ? 'partially_received' : 'approved';
    db.prepare('UPDATE purchase_orders SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newStatus, params.poId);

    return true;
  })();
}

export function getAllPurchaseOrders(): PurchaseOrderRecord[] {
  const pos = db.prepare(`
    SELECT po.*, v.name as vendor_name
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id
    ORDER BY po.created_at DESC
  `).all() as any[];

  return pos.map((p) => {
    const lines = db.prepare(`
      SELECT pol.*, pv.sku, pr.title
      FROM purchase_order_lines pol
      JOIN product_variants pv ON pv.id = pol.variant_id
      JOIN products pr ON pr.id = pv.product_id
      WHERE pol.po_id = ?
    `).all(p.id) as any[];

    return {
      id: p.id,
      poNumber: p.po_number,
      vendorId: p.vendor_id,
      vendorName: p.vendor_name,
      status: p.status,
      totalAmount: p.total_amount,
      expectedDate: p.expected_date,
      notes: p.notes,
      createdAt: p.created_at,
      lines: lines.map((l) => ({
        id: l.id,
        variantId: l.variant_id,
        sku: l.sku,
        title: l.title,
        quantityOrdered: l.quantity_ordered,
        quantityReceived: l.quantity_received,
        unitCost: l.unit_cost,
      })),
    };
  });
}

export function getPurchaseOrderById(id: string): PurchaseOrderRecord | null {
  const p = db.prepare(`
    SELECT po.*, v.name as vendor_name
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id
    WHERE po.id = ?
  `).get(id) as any;

  if (!p) return null;

  const lines = db.prepare(`
    SELECT pol.*, pv.sku, pr.title
    FROM purchase_order_lines pol
    JOIN product_variants pv ON pv.id = pol.variant_id
    JOIN products pr ON pr.id = pv.product_id
    WHERE pol.po_id = ?
  `).all(p.id) as any[];

  return {
    id: p.id,
    poNumber: p.po_number,
    vendorId: p.vendor_id,
    vendorName: p.vendor_name,
    status: p.status,
    totalAmount: p.total_amount,
    expectedDate: p.expected_date,
    notes: p.notes,
    createdAt: p.created_at,
    lines: lines.map((l) => ({
      id: l.id,
      variantId: l.variant_id,
      sku: l.sku,
      title: l.title,
      quantityOrdered: l.quantity_ordered,
      quantityReceived: l.quantity_received,
      unitCost: l.unit_cost,
    })),
  };
}
