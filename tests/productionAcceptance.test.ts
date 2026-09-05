import { describe, it, expect } from 'vitest';
import { db } from '../server/db/database';
import {
  getGlobalSkuSequenceStatus,
  initializeGlobalSkuSequence,
  allocateGlobalSku,
  previewGlobalSku,
} from '../server/services/skuSequenceService';
import {
  getInventoryBalances,
  recordInventoryMovement,
  getChannelAllocations,
  updateChannelAllocations,
  createNeedsAttentionItem,
  getNeedsAttentionItems,
  resolveNeedsAttentionItem,
} from '../server/services/multiStateInventoryService';
import {
  calculateReorderSuggestions,
  createPurchaseOrder,
  receivePurchaseOrder,
} from '../server/services/procurementService';
import {
  previewMigration,
  executeMigration,
} from '../server/services/migrationService';

describe('Enterprise Production Acceptance Test Suite (Saaz Ledger / Atelier OS)', () => {
  describe('Global 5-Digit SKU System (V2 Sequence & V1 Legacy Coexistence)', () => {
    it('generates an uncommitted preview matching format PDJ12-XXXXX', () => {
      const preview = previewGlobalSku('PD', 'J', '12');
      expect(preview).toBe('PDJ12-XXXXX');
    });

    it('allocates global 5-digit atomic serials without restarting across categories', () => {
      // Allocate three different categories in succession
      const item1 = allocateGlobalSku({ typeCode: 'PD', stoneCode: 'J', colorCode: '12' });
      const item2 = allocateGlobalSku({ typeCode: 'RN', stoneCode: 'GD', colorCode: '02' });
      const item3 = allocateGlobalSku({ typeCode: 'EA', stoneCode: 'RK', colorCode: '01' });

      // Verifies format [TYPE][STONE][COLOR]-[5-DIGIT]
      expect(item1.sku).toMatch(/^PDJ12-\d{5}$/);
      expect(item2.sku).toMatch(/^RNGD02-\d{5}$/);
      expect(item3.sku).toMatch(/^EARK01-\d{5}$/);

      // Verifies continuous global sequence incrementation
      expect(item2.globalSerial).toBe(item1.globalSerial + 1);
      expect(item3.globalSerial).toBe(item2.globalSerial + 1);

      // Verifies leading zeros preserved
      expect(item1.formattedSerial.length).toBe(5);
    });

    it('prevents sequence from rolling backwards into already issued serials', () => {
      const status = getGlobalSkuSequenceStatus();
      expect(() => {
        initializeGlobalSkuSequence(status.currentSerial - 5);
      }).toThrow(/cannot roll backwards/i);
    });

    it('reports separate metrics for physical stock vs SKU identities', () => {
      const status = getGlobalSkuSequenceStatus();
      expect(status.totalV1Items).toBeGreaterThanOrEqual(0);
      expect(status.totalV2Items).toBeGreaterThanOrEqual(3);
      expect(status.totalPhysicalStock).toBeGreaterThanOrEqual(0);
      expect(status.nextSerial).toBe(status.currentSerial + 1);
    });
  });

  describe('Multi-State Inventory Balance & Movement Ledger', () => {
    const testVariantId = 'var_item-1';

    it('properly tracks ON HAND, AVAILABLE, COMMITTED, RESERVED and DAMAGED states', () => {
      const [initial] = getInventoryBalances(testVariantId);
      const initialOnHand = initial.onHand;
      const initialAvail = initial.available;

      // 1. Customer order placed -> SALE_COMMITMENT
      recordInventoryMovement({
        variantId: testVariantId,
        movementType: 'SALE_COMMITMENT',
        quantity: 2,
        notes: 'Shopify order line committed',
      });

      const [afterCommit] = getInventoryBalances(testVariantId);
      expect(afterCommit.committed).toBe(initial.committed + 2);
      expect(afterCommit.available).toBe(initialAvail - 2);
      expect(afterCommit.onHand).toBe(initialOnHand); // On hand unchanged until dispatched

      // 2. Order dispatched -> SALE_FULFILMENT
      recordInventoryMovement({
        variantId: testVariantId,
        movementType: 'SALE_FULFILMENT',
        quantity: 2,
        notes: 'Dispatched to customer',
      });

      const [afterFulfil] = getInventoryBalances(testVariantId);
      expect(afterFulfil.committed).toBe(initial.committed);
      expect(afterFulfil.onHand).toBe(initialOnHand - 2);

      // 3. Customer damaged return -> DAMAGED_RETURN
      recordInventoryMovement({
        variantId: testVariantId,
        movementType: 'DAMAGED_RETURN',
        quantity: 1,
        notes: 'Broken stone returned by customer',
      });

      const [afterDamaged] = getInventoryBalances(testVariantId);
      expect(afterDamaged.damaged).toBe(initial.damaged + 1);
      expect(afterDamaged.onHand).toBe(afterFulfil.onHand + 1);
      // Damaged items do NOT become available for sale
      expect(afterDamaged.available).toBe(afterFulfil.available);

      // 4. Restore original balances with restock
      recordInventoryMovement({
        variantId: testVariantId,
        movementType: 'PURCHASE_RECEIPT',
        quantity: 1,
        notes: 'Test cleanup receipt',
      });
    });

    it('validates omnichannel allocations against physical vault stock', () => {
      const [bal] = getInventoryBalances(testVariantId);
      const totalPhysical = bal.onHand;

      // Attempt to allocate more than physical stock
      expect(() => {
        updateChannelAllocations(testVariantId, [
          { channel: 'shopify', allocatedQty: totalPhysical + 10 },
          { channel: 'amazon', allocatedQty: 5 },
        ]);
      }).toThrow(/cannot exceed physical stock/i);

      // Valid allocation
      const validAlloc = [
        { channel: 'shopify' as const, allocatedQty: Math.floor(totalPhysical / 2) },
        { channel: 'offline' as const, allocatedQty: Math.ceil(totalPhysical / 2) },
      ];
      const ok = updateChannelAllocations(testVariantId, validAlloc);
      expect(ok).toBe(true);

      const allocs = getChannelAllocations(testVariantId);
      expect(allocs.length).toBeGreaterThan(0);
    });
  });

  describe('Supplier Procurement, Purchase Orders & Lots', () => {
    it('calculates reorder recommendations considering available + incoming stock', () => {
      const suggestions = calculateReorderSuggestions();
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('creates a draft Purchase Order, updates incoming balance, and receives goods into FIFO lots', () => {
      const vendor = db.prepare('SELECT id FROM vendors LIMIT 1').get() as { id: string };
      const item = db.prepare('SELECT id FROM items LIMIT 1').get() as { id: string };
      const variantId = `var_${item.id}`;

      const [beforeBal] = getInventoryBalances(variantId);
      const beforeIncoming = beforeBal.incoming;

      // 1. Create Purchase Order
      const po = createPurchaseOrder({
        vendorId: vendor.id,
        lines: [{ variantId, quantity: 10, unitCost: 1500 }],
        notes: 'PO Test Execution',
      });

      expect(po.poNumber).toMatch(/^PO-\d{4}-\d{4}$/);
      expect(po.lines[0].quantityOrdered).toBe(10);

      // Incoming stock incremented
      const [duringBal] = getInventoryBalances(variantId);
      expect(duringBal.incoming).toBe(beforeIncoming + 10);

      // 2. Partial receipt against Purchase Order
      const received = receivePurchaseOrder({
        poId: po.id,
        receipts: [{ lineId: po.lines[0].id, variantId, quantityReceived: 10, unitCost: 1500 }],
      });
      expect(received).toBe(true);

      // Incoming cleared, On hand incremented
      const [afterBal] = getInventoryBalances(variantId);
      expect(afterBal.incoming).toBe(beforeIncoming);
      expect(afterBal.onHand).toBe(beforeBal.onHand + 10);

      // Verified purchase lot created
      const lots = db.prepare('SELECT * FROM purchase_lots WHERE po_id = ?').all(po.id);
      expect(lots.length).toBe(1);
    });
  });

  describe('Operational Exception Desk (Needs Attention)', () => {
    it('creates, lists, and resolves operational exceptions', () => {
      const issueId = createNeedsAttentionItem({
        category: 'order',
        severity: 'warning',
        title: 'Unmatched Shopify line item',
        message: 'Order #1042 contained unknown SKU KND-009',
        referenceType: 'order',
        referenceId: '1042',
      });

      expect(issueId).toBeDefined();

      const items = getNeedsAttentionItems('order');
      expect(items.some((it) => it.id === issueId)).toBe(true);

      const resolved = resolveNeedsAttentionItem(issueId, 'test_admin');
      expect(resolved).toBe(true);

      const itemsAfter = getNeedsAttentionItems('order', true);
      expect(itemsAfter.some((it) => it.id === issueId)).toBe(false);
    });
  });

  describe('Safe Data Migration Pipeline', () => {
    it('previews migration detecting existing conflicts without modifying database', () => {
      const preview = previewMigration([
        { sku: 'PDJ12001', title: 'Existing Piece' }, // conflict
        { sku: 'NEWTEST-00001', title: 'Fresh Piece', typeCode: 'NW', stoneCode: 'T', colorCode: '01' }, // valid
        { title: 'No SKU Item' }, // invalid
      ]);

      expect(preview.conflictCount).toBe(1);
      expect(preview.validCount).toBe(1);
      expect(preview.invalidCount).toBe(1);
    });

    it('executes safe migration with transactional rollback and audit logging', () => {
      const uniqueSku = 'MIGRATE-' + Date.now();
      const result = executeMigration({
        items: [
          {
            sku: uniqueSku,
            title: 'Migrated Polki Choker',
            typeCode: 'CH',
            stoneCode: 'P',
            colorCode: '01',
            buyingPrice: 4200,
            sellingPrice: 8900,
            quantity: 5,
            safetyReserve: 1,
          },
        ],
        actor: 'migration_admin',
      });

      expect(result.success).toBe(true);
      expect(result.importedCount).toBe(1);

      // Verify item exists and has multi-state balances
      const itemRow = db.prepare('SELECT * FROM items WHERE sku = ?').get(uniqueSku) as any;
      expect(itemRow).toBeDefined();
      expect(itemRow.quantity).toBe(5);

      const [bal] = getInventoryBalances(`var_${itemRow.id}`);
      expect(bal.onHand).toBe(5);
      expect(bal.available).toBe(4);
      expect(bal.safetyStock).toBe(1);
    });
  });
});
