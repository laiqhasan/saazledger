import { describe, it, expect, afterAll } from 'vitest';
import { db } from '../server/db/database';
import {
  createItem,
  restockItem,
  recordSaleFifo,
  handleOrderReversal,
  getItemById,
} from '../server/services/inventoryService';

describe('FIFO Purchase Lot Depletion & Financials', () => {
  it('accurately deallocates purchase lots in FIFO order and computes exact cost basis', () => {
    // 1. Create piece with initial lot of 5 units @ ₹500
    const item = createItem({
      title: 'Kundan Choker FIFO Test',
      typeCode: 'TESTF',
      stoneCode: 'K',
      colorCode: '01',
      buyingPrice: 500,
      sellingPrice: 1200,
      quantity: 5,
    });

    expect(item.quantity).toBe(5);

    // 2. Restock 10 units @ ₹600
    restockItem({
      itemId: item.id,
      quantityToAdd: 10,
      unitCost: 600,
      batchRef: 'Batch 2 restock',
    });

    const updatedAfterRestock = getItemById(item.id);
    expect(updatedAfterRestock?.quantity).toBe(15);

    // 3. Record sale of 8 units @ ₹1500
    // Expected:
    // 5 units from Lot 1 @ ₹500 = 2500
    // 3 units from Lot 2 @ ₹600 = 1800
    // Total Cost = 4300
    // Total Revenue = 8 * 1500 = 12000
    // Realized Profit = 12000 - 4300 = 7700
    const saleResult = recordSaleFifo({
      itemId: item.id,
      quantitySold: 8,
      salePricePerUnit: 1500,
      channel: 'Retail Store',
      externalOrderId: `ORDER-FIFO-${Date.now()}`,
      notes: 'FIFO depletion verification',
    });

    expect(saleResult.newQuantity).toBe(7);
    expect(saleResult.totalCost).toBe(4300);
    expect(saleResult.realizedGrossProfit).toBe(7700);

    // Verify lots in DB
    const remainingLots = db
      .prepare('SELECT * FROM purchase_lots WHERE item_id = ? ORDER BY created_at ASC')
      .all(item.id) as any[];

    expect(remainingLots.length).toBe(2);
    // Lot 1 fully depleted
    expect(remainingLots[0].quantity_remaining).toBe(0);

    // Lot 2 partially depleted: 10 - 3 = 7 remaining
    expect(remainingLots[1].quantity_remaining).toBe(7);
  });

  it('restores stock safely on order reversal (e.g. cancellation / return)', () => {
    const item = createItem({
      title: 'Maangtikka Reversal Test',
      typeCode: 'TESTR',
      stoneCode: 'P',
      colorCode: '02',
      buyingPrice: 300,
      sellingPrice: 800,
      quantity: 4,
    });

    const testOrderId = `REV-TEST-${Date.now()}`;

    // Sell 3 units
    recordSaleFifo({
      itemId: item.id,
      quantitySold: 3,
      salePricePerUnit: 800,
      channel: 'Online Store',
      externalOrderId: testOrderId,
    });

    let currentItem = getItemById(item.id);
    expect(currentItem?.quantity).toBe(1);

    // Cancel order and return items to inventory
    const reversal = handleOrderReversal({
      itemId: item.id,
      quantity: 3,
      isRestockable: true,
      reason: 'Customer cancelled before dispatch',
      channel: 'Online Store',
      externalOrderId: testOrderId,
    });
    expect(reversal.newQuantity).toBe(4);

    currentItem = getItemById(item.id);
    expect(currentItem?.quantity).toBe(4);
  });

  afterAll(() => {
    db.prepare("DELETE FROM purchase_lots WHERE item_id IN (SELECT id FROM items WHERE type_code LIKE 'TEST%')").run();
    db.prepare("DELETE FROM stock_movements WHERE item_id IN (SELECT id FROM items WHERE type_code LIKE 'TEST%')").run();
    db.prepare("DELETE FROM items WHERE type_code LIKE 'TEST%'").run();
  });
});
