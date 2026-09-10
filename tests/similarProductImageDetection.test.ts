import { describe, it, expect } from 'vitest';
import {
  findSimilarProducts,
  calculateHammingDistance,
} from '../src/services/skuEngine';
import type { JewelryItem } from '../src/types/inventory';

describe('Product Image-Centric Duplicate Detection (findSimilarProducts)', () => {
  const baseItem: JewelryItem = {
    id: 'item-101',
    sku: 'PDJ01-001',
    title: 'Royal Emerald Green Kundan Pendant Necklace Set',
    typeCode: 'PD',
    stoneCode: 'J',
    colorCode: '01',
    serial: '001',
    buyingPrice: 1200,
    sellingPrice: 2800,
    quantity: 10,
    reorderLevel: 2,
    vendor: 'Aura Creations',
    dateAdded: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
    imageUrl: '/api/photos/abcd1234ef567890.webp',
    imageHash: '1111000011110000111100001111000011110000111100001111000011110000',
  };

  it('RULE 1: MUST NOT alert on behalf of matching title keywords when image is different or missing', () => {
    // New upload has an identical or very similar title, but no image or completely different image
    const matches = findSimilarProducts({
      inventory: [baseItem],
      title: 'Royal Emerald Green Kundan Pendant Necklace Set with Earrings',
      // Completely different 64-bit visual hash
      imageHash: '0000111100001111000011110000111100001111000011110000111100001111',
    });

    expect(matches).toHaveLength(0);
  });

  it('RULE 2: MUST NOT alert on behalf of matching type, stone, and color codes alone', () => {
    const matches = findSimilarProducts({
      inventory: [baseItem],
      typeCode: 'PD',
      stoneCode: 'J',
      colorCode: '01',
      title: 'Different Pendant Design in Emerald',
      // Different image
      imageHash: '0000000000000000000000000000000000000000000000000000000000000000',
    });

    expect(matches).toHaveLength(0);
  });

  it('RULE 3: MUST alert when product image has a close visual hash match (dist <= 14)', () => {
    // Perturb hash by only 3 bits (very close photo of same piece)
    const slightlyDifferentPhotoHash =
      '1111000011110000111100001111000011110000111100001111000011110111'; // 3 bits flipped

    const matches = findSimilarProducts({
      inventory: [baseItem],
      imageHash: slightlyDifferentPhotoHash,
      title: 'Something completely different', // Even with different title, image matches!
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].item.sku).toBe('PDJ01-001');
    expect(matches[0].matchType).toBe('recent_upload'); // Added 5 mins ago
    expect(matches[0].confidence).toBeGreaterThanOrEqual(90);
    expect(matches[0].reason).toContain('minute');
  });

  it('RULE 4: MUST alert when product image has identical visual hash (100% visual match)', () => {
    const matches = findSimilarProducts({
      inventory: [baseItem],
      imageHash: baseItem.imageHash,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe(100);
    expect(matches[0].matchType).toBe('recent_upload');
  });

  it('RULE 5: MUST alert when product image URL or content-addressed filename matches', () => {
    const matches = findSimilarProducts({
      inventory: [baseItem],
      imageUrl: '/api/photos/abcd1234ef567890.webp',
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe(100);
    expect(matches[0].item.id).toBe('item-101');
  });

  it('RULE 6: calculateHammingDistance correctly returns 0 for identical hashes', () => {
    expect(calculateHammingDistance('abc', 'abc')).toBe(0);
    expect(
      calculateHammingDistance(
        '1010101010101010101010101010101010101010101010101010101010101010',
        '1010101010101010101010101010101010101010101010101010101010101010'
      )
    ).toBe(0);
    expect(
      calculateHammingDistance(
        '1111111111111111111111111111111111111111111111111111111111111111',
        '0000000000000000000000000000000000000000000000000000000000000000'
      )
    ).toBe(64);
  });
});
