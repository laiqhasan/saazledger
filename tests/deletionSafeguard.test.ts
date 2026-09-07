import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../server/db/database';
import {
  getAllItems,
  getTrashItems,
  softDeleteItem,
  restoreItem,
  hardDeleteItem,
  emptyTrash,
  getItemById,
} from '../server/services/inventoryService';

describe('Accidental Data Loss Safeguard: Soft Delete & Hard Delete', () => {
  const testItemId1 = 'test_del_item_1';
  const testItemId2 = 'test_del_item_2';
  const testItemId3 = 'test_del_item_3';

  beforeAll(() => {
    // Seed 3 test items
    db.prepare(`
      INSERT OR REPLACE INTO items (
        id, sku, title, type_code, stone_code, color_code, serial, buying_price, selling_price, quantity, date_added, is_deleted
      ) VALUES
        (?, 'TEST-DEL-01', 'Emerald Choker Piece', 'PD', 'J', '12', '001', 500, 1200, 10, '2026-09-01', 0),
        (?, 'TEST-DEL-02', 'Ruby Stud Earrings', 'EAR', 'R', '15', '002', 300, 800, 5, '2026-09-01', 0),
        (?, 'TEST-DEL-03', 'Sapphire Cocktail Ring', 'RNG', 'S', '16', '003', 400, 950, 8, '2026-09-01', 0)
    `).run(testItemId1, testItemId2, testItemId3);
  });

  afterAll(() => {
    // Clean up
    db.prepare('DELETE FROM items WHERE id IN (?, ?, ?)').run(testItemId1, testItemId2, testItemId3);
  });

  it('1. getAllItems() excludes soft-deleted items by default', () => {
    const initialActive = getAllItems(false);
    expect(initialActive.some((i) => i.id === testItemId1)).toBe(true);

    // Soft delete item 1
    const softRes = softDeleteItem(testItemId1, 'Accidental click test');
    expect(softRes).toBe(true);

    // Verify item 1 is excluded from active inventory list
    const afterSoftActive = getAllItems(false);
    expect(afterSoftActive.some((i) => i.id === testItemId1)).toBe(false);

    // Verify item 1 still exists in database and has is_deleted = 1 and deleted_at timestamp
    const itemInDb = getItemById(testItemId1);
    expect(itemInDb).toBeDefined();
    expect(itemInDb?.is_deleted).toBe(1);
    expect(itemInDb?.deleted_at).toBeDefined();
    expect(itemInDb?.deleted_reason).toBe('Accidental click test');
  });

  it('2. getTrashItems() lists soft-deleted items with reason and timestamp', () => {
    const trash = getTrashItems();
    const foundInTrash = trash.find((i) => i.id === testItemId1);
    expect(foundInTrash).toBeDefined();
    expect(foundInTrash?.sku).toBe('TEST-DEL-01');
    expect(foundInTrash?.deleted_reason).toBe('Accidental click test');
  });

  it('3. restoreItem() restores soft-deleted item back to active inventory', () => {
    const restoreRes = restoreItem(testItemId1);
    expect(restoreRes).toBe(true);

    // Verify it is back in active list
    const activeItems = getAllItems(false);
    expect(activeItems.some((i) => i.id === testItemId1)).toBe(true);

    // Verify it is no longer in trash
    const trash = getTrashItems();
    expect(trash.some((i) => i.id === testItemId1)).toBe(false);

    // Verify database flags reset
    const restored = getItemById(testItemId1);
    expect(restored?.is_deleted).toBe(0);
    expect(restored?.deleted_at).toBeNull();
  });

  it('4. hardDeleteItem() permanently removes item from the database', () => {
    // Hard delete item 2
    const hardRes = hardDeleteItem(testItemId2);
    expect(hardRes).toBe(true);

    // Verify item 2 is completely gone from both active and trash
    expect(getItemById(testItemId2)).toBeUndefined();
    expect(getAllItems(false).some((i) => i.id === testItemId2)).toBe(false);
    expect(getTrashItems().some((i) => i.id === testItemId2)).toBe(false);
  });

  it('5. emptyTrash() only purges soft-deleted items and preserves active items', () => {
    // Soft delete item 3
    softDeleteItem(testItemId3, 'Ready to empty');
    expect(getTrashItems().some((i) => i.id === testItemId3)).toBe(true);

    // Empty trash
    const purgedCount = emptyTrash();
    expect(purgedCount).toBeGreaterThanOrEqual(1);

    // Verify item 3 is gone
    expect(getItemById(testItemId3)).toBeUndefined();
    expect(getTrashItems().some((i) => i.id === testItemId3)).toBe(false);

    // Verify item 1 (active) was NOT touched
    expect(getItemById(testItemId1)).toBeDefined();
    expect(getAllItems(false).some((i) => i.id === testItemId1)).toBe(true);
  });
});
