import { db } from '../db/database';

export type MovementType =
  | 'PURCHASE_RECEIPT'
  | 'SALE_COMMITMENT'
  | 'SALE_FULFILMENT'
  | 'SALE_RELEASE'
  | 'CUSTOMER_RETURN'
  | 'DAMAGED_RETURN'
  | 'MANUAL_ADJUSTMENT'
  | 'STOCKTAKE_CORRECTION'
  | 'CHANNEL_RESERVATION'
  | 'TRANSFER';

export interface MultiStateBalance {
  id: string;
  locationId: string;
  variantId: string;
  sku: string;
  title: string;
  onHand: number;
  available: number;
  committed: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  incoming: number;
  updatedAt: string;
}

export interface InventoryMovementRecord {
  id: string;
  variantId: string;
  locationId: string;
  movementType: MovementType;
  quantity: number;
  referenceType?: string;
  referenceId?: string;
  beforeBalance: number;
  afterBalance: number;
  unitCost?: number;
  notes?: string;
  createdBy: string;
  createdAt: string;
}

export interface ChannelAllocation {
  channel: 'shopify' | 'amazon' | 'myntra' | 'offline';
  allocatedQty: number;
  reservedQty: number;
  syncStatus: 'in_sync' | 'pending' | 'failed';
  lastSyncedAt?: string;
}

/**
 * Retrieves multi-state balance across locations
 */
export function getInventoryBalances(variantId?: string, locationId = 'loc_main_vault'): MultiStateBalance[] {
  let query = `
    SELECT b.*, v.sku, p.title
    FROM inventory_balances b
    JOIN product_variants v ON v.id = b.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE b.location_id = ?
  `;
  const params: any[] = [locationId];

  if (variantId) {
    query += ' AND b.variant_id = ?';
    params.push(variantId);
  }

  const rows = db.prepare(query).all(...params) as any[];

  if (variantId && rows.length === 0) {
    const v = db.prepare('SELECT pv.id, pv.sku, p.title FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id = ?').get(variantId) as any;
    if (v) {
      db.prepare(`
        INSERT OR IGNORE INTO inventory_balances (id, location_id, variant_id, on_hand, available, committed, reserved, damaged, safety_stock, incoming)
        VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0)
      `).run(`bal_${v.id}_${locationId}`, locationId, v.id);

      return [{
        id: `bal_${v.id}_${locationId}`,
        locationId,
        variantId: v.id,
        sku: v.sku,
        title: v.title,
        onHand: 0,
        available: 0,
        committed: 0,
        reserved: 0,
        damaged: 0,
        safetyStock: 0,
        incoming: 0,
        updatedAt: new Date().toISOString(),
      }];
    }
  }

  return rows.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    variantId: r.variant_id,
    sku: r.sku,
    title: r.title,
    onHand: r.on_hand,
    available: r.available,
    committed: r.committed,
    reserved: r.reserved,
    damaged: r.damaged,
    safetyStock: r.safety_stock,
    incoming: r.incoming,
    updatedAt: r.updated_at,
  }));
}

/**
 * Atomically records an inventory movement in the append-only ledger
 * and updates multi-state balances accordingly.
 */
export function recordInventoryMovement(params: {
  variantId: string;
  locationId?: string;
  movementType: MovementType;
  quantity: number;
  unitCost?: number;
  referenceType?: string;
  referenceId?: string;
  notes?: string;
  actor?: string;
}): InventoryMovementRecord {
  const locId = params.locationId || 'loc_main_vault';
  const qty = Math.abs(params.quantity);

  return db.transaction(() => {
    // 1. Ensure balance row exists
    let bal = db.prepare('SELECT * FROM inventory_balances WHERE location_id = ? AND variant_id = ?')
      .get(locId, params.variantId) as any;

    if (!bal) {
      db.prepare(`
        INSERT INTO inventory_balances (id, location_id, variant_id, on_hand, available, committed, reserved, damaged, safety_stock, incoming)
        VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0)
      `).run(`bal_${params.variantId}_${locId}`, locId, params.variantId);

      bal = db.prepare('SELECT * FROM inventory_balances WHERE location_id = ? AND variant_id = ?')
        .get(locId, params.variantId) as any;
    }

    const beforeOnHand = bal.on_hand;
    let newOnHand = bal.on_hand;
    let newAvailable = bal.available;
    let newCommitted = bal.committed;
    let newReserved = bal.reserved;
    let newDamaged = bal.damaged;
    const safety = bal.safety_stock;

    switch (params.movementType) {
      case 'PURCHASE_RECEIPT':
      case 'CUSTOMER_RETURN':
        newOnHand += qty;
        newAvailable = Math.max(0, newOnHand - newCommitted - newReserved - newDamaged - safety);
        break;

      case 'SALE_COMMITMENT':
        newCommitted += qty;
        newAvailable = Math.max(0, newOnHand - newCommitted - newReserved - newDamaged - safety);
        break;

      case 'SALE_FULFILMENT':
        newOnHand = Math.max(0, newOnHand - qty);
        newCommitted = Math.max(0, newCommitted - qty);
        newAvailable = Math.max(0, newOnHand - newCommitted - newReserved - newDamaged - safety);
        break;

      case 'SALE_RELEASE':
        newCommitted = Math.max(0, newCommitted - qty);
        newAvailable = Math.max(0, newOnHand - newCommitted - newReserved - newDamaged - safety);
        break;

      case 'DAMAGED_RETURN':
        newOnHand += qty;
        newDamaged += qty;
        newAvailable = Math.max(0, newOnHand - newCommitted - newReserved - newDamaged - safety);
        break;

      case 'MANUAL_ADJUSTMENT':
      case 'STOCKTAKE_CORRECTION':
        newOnHand = params.quantity; // direct count adjustment
        newAvailable = Math.max(0, newOnHand - newCommitted - newReserved - newDamaged - safety);
        break;

      default:
        break;
    }

    // 2. Update multi-state balance
    db.prepare(`
      UPDATE inventory_balances
      SET on_hand = ?, available = ?, committed = ?, reserved = ?, damaged = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newOnHand, newAvailable, newCommitted, newReserved, newDamaged, bal.id);

    // 3. Mirror onHand to legacy items table for 100% backward compatibility
    const variantRow = db.prepare('SELECT product_id, sku FROM product_variants WHERE id = ?').get(params.variantId) as any;
    if (variantRow) {
      db.prepare('UPDATE items SET quantity = ? WHERE id = ? OR sku = ?').run(newOnHand, variantRow.product_id, variantRow.sku);
    }

    // 4. Append to immutable inventory movements ledger
    const movementId = `mov_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    db.prepare(`
      INSERT INTO inventory_movements (
        id, variant_id, location_id, movement_type, quantity, reference_type, reference_id,
        before_balance, after_balance, unit_cost, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      movementId,
      params.variantId,
      locId,
      params.movementType,
      params.quantity,
      params.referenceType || null,
      params.referenceId || null,
      beforeOnHand,
      newOnHand,
      params.unitCost || null,
      params.notes || null,
      params.actor || 'usr_system'
    );

    return {
      id: movementId,
      variantId: params.variantId,
      locationId: locId,
      movementType: params.movementType,
      quantity: params.quantity,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      beforeBalance: beforeOnHand,
      afterBalance: newOnHand,
      unitCost: params.unitCost,
      notes: params.notes,
      createdBy: params.actor || 'usr_system',
      createdAt: new Date().toISOString(),
    };
  })();
}

/**
 * Fetches omnichannel allocations for a variant
 */
export function getChannelAllocations(variantId: string): ChannelAllocation[] {
  const rows = db.prepare('SELECT channel, allocated_qty, reserved_qty, sync_status, last_synced_at FROM channel_allocations WHERE variant_id = ?')
    .all(variantId) as any[];

  return rows.map((r) => ({
    channel: r.channel,
    allocatedQty: r.allocated_qty,
    reservedQty: r.reserved_qty,
    syncStatus: r.sync_status,
    lastSyncedAt: r.last_synced_at,
  }));
}

/**
 * Updates omnichannel allocations verifying they do not exceed physical available stock
 */
export function updateChannelAllocations(
  variantId: string,
  allocations: Array<{ channel: 'shopify' | 'amazon' | 'myntra' | 'offline'; allocatedQty: number }>
): boolean {
  const bal = db.prepare('SELECT on_hand FROM inventory_balances WHERE variant_id = ?').get(variantId) as { on_hand: number } | undefined;
  const totalPhysical = bal ? bal.on_hand : 0;

  const totalRequested = allocations.reduce((acc, a) => acc + (Number(a.allocatedQty) || 0), 0);
  if (totalRequested > totalPhysical) {
    throw new Error(`Total channel allocations (${totalRequested}) cannot exceed physical stock (${totalPhysical}) in vault.`);
  }

  db.transaction(() => {
    for (const alloc of allocations) {
      db.prepare(`
        INSERT INTO channel_allocations (id, variant_id, channel, allocated_qty, reserved_qty, sync_status, updated_at)
        VALUES (?, ?, ?, ?, 0, 'in_sync', datetime('now'))
        ON CONFLICT(variant_id, channel) DO UPDATE SET
          allocated_qty = excluded.allocated_qty,
          updated_at = datetime('now')
      `).run(`alloc_${variantId}_${alloc.channel}`, variantId, alloc.channel, alloc.allocatedQty);
    }
  })();

  return true;
}

/**
 * Operational Exception ("Needs Attention") management
 */
export function getNeedsAttentionItems(category?: string, unresolvedOnly = true) {
  let query = 'SELECT * FROM needs_attention_items WHERE 1=1';
  const params: any[] = [];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (unresolvedOnly) {
    query += ' AND is_resolved = 0';
  }
  query += ' ORDER BY created_at DESC';

  return db.prepare(query).all(...params) as any[];
}

export function createNeedsAttentionItem(params: {
  category: 'order' | 'inventory' | 'sku' | 'media' | 'attribute' | 'supplier';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  referenceType?: string;
  referenceId?: string;
}) {
  const id = `attn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  db.prepare(`
    INSERT INTO needs_attention_items (id, category, severity, title, message, reference_type, reference_id, is_resolved)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, params.category, params.severity, params.title, params.message, params.referenceType || null, params.referenceId || null);
  return id;
}

export function resolveNeedsAttentionItem(id: string, actor = 'admin') {
  db.prepare(`
    UPDATE needs_attention_items
    SET is_resolved = 1, resolved_by = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(actor, id);
  return true;
}
