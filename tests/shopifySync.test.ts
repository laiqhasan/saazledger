import { describe, it, expect, vi } from 'vitest';
import { bulkPushToShopify } from '../src/services/shopifyService';
import type { JewelryItem, ShopifyConfig } from '../src/types/inventory';

describe('Shopify Selected Items Push & Synchronization', () => {
  const mockConfig: ShopifyConfig = {
    shopDomain: 'saazaura.myshopify.com',
    adminAccessToken: 'shpat_test_token_123',
    apiVersion: '2026-07',
    defaultStatus: 'draft',
    isConnected: true,
    primaryLocationId: 905684977,
  };

  const sampleItems: JewelryItem[] = [
    {
      id: 'item-1',
      sku: 'PDD01-00001',
      title: 'Diamond Pendant Set',
      typeCode: 'PD',
      stoneCode: 'D',
      colorCode: '01',
      serialNumber: 1,
      quantity: 5,
      costPrice: 500,
      buyingPrice: 500,
      sellingPrice: 1200,
      notes: 'Gold finish',
      createdAt: '2026-09-01T00:00:00Z',
      dateAdded: '2026-09-01T00:00:00Z',
    },
    {
      id: 'item-2',
      sku: 'EAR02-00002',
      title: 'Silver Plated Earrings',
      typeCode: 'EAR',
      stoneCode: 'D',
      colorCode: '02',
      serialNumber: 2,
      quantity: 3,
      costPrice: 300,
      buyingPrice: 300,
      sellingPrice: 850,
      notes: 'Silver plated finish',
      createdAt: '2026-09-01T00:00:00Z',
      dateAdded: '2026-09-01T00:00:00Z',
    },
  ];

  it('only pushes selected items when a subset is passed to bulkPushToShopify', async () => {
    // Mock global fetch for Shopify proxy
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = decodeURIComponent(String(url));
      if (urlStr.includes('/products.json')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              product: {
                id: 111222333,
                variants: [
                  {
                    id: 444555666,
                    inventory_item_id: 777888999,
                  },
                ],
              },
            }),
        } as any;
      }
      if (urlStr.includes('/variants/')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ variant: { id: 444555666, inventory_item_id: 777888999 } }),
        } as any;
      }
      if (urlStr.includes('/inventory_items/')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ inventory_item: { id: 777888999, tracked: true } }),
        } as any;
      }
      if (urlStr.includes('/inventory_levels/connect.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ inventory_level: {} }),
        } as any;
      }
      if (urlStr.includes('/inventory_levels/set.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ inventory_level: { available: 5 } }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      } as any;
    });

    const singleSelectedItem = [sampleItems[0]]; // Only 1 selected item
    const progressTracked: string[] = [];

    const { result, updatedItems } = await bulkPushToShopify(
      singleSelectedItem,
      mockConfig,
      { status: 'draft' },
      (_curr, _total, item) => {
        progressTracked.push(item.sku);
      }
    );

    // Verify only the 1 selected item was processed
    expect(result.totalProcessed).toBe(1);
    expect(progressTracked).toEqual(['PDD01-00001']);
    expect(updatedItems.length).toBe(1);
    expect(updatedItems[0].shopifyProductId).toBe('111222333');
    expect(updatedItems[0].shopifyVariantId).toBe('444555666');

    fetchSpy.mockRestore();
  });

  it('correctly extracts clear diagnostic error messages from various Shopify error shapes', async () => {
    const { extractShopifyErrorMessage } = await import('../src/services/shopifyService');

    expect(extractShopifyErrorMessage({ status: 422, data: { errors: { image: ['Image source is invalid'] } } })).toBe('image: Image source is invalid');
    expect(extractShopifyErrorMessage({ status: 401, data: { errors: 'Invalid Access Token' } })).toBe('Invalid Access Token');
    expect(extractShopifyErrorMessage({ status: 502, data: { error: 'Proxy request to Shopify failed: ENOTFOUND' } })).toBe('Proxy request to Shopify failed: ENOTFOUND');
  });

  it('gracefully falls back and creates product even if image upload payload is rejected with 422', async () => {
    let callCount = 0;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any, opts: any) => {
      const urlStr = decodeURIComponent(String(url));
      if (urlStr.includes('/products.json')) {
        callCount++;
        const body = opts?.body ? JSON.parse(opts.body) : {};
        // First call with embedded images fails with 422
        if (body.product?.images && body.product.images.length > 0) {
          return {
            ok: false,
            status: 422,
            text: async () => JSON.stringify({ errors: { image: ['Image source is invalid'] } }),
          } as any;
        }
        // Second call without images succeeds
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              product: {
                id: 999888777,
                variants: [{ id: 111000, inventory_item_id: 222000 }],
              },
            }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({}),
      } as any;
    });

    const singleItem = [
      {
        ...sampleItems[0],
        imageUrl: 'https://saaz-aura-jewels-prod.s3.ap-south-1.amazonaws.com/test.jpg',
      },
    ];

    const logs: string[] = [];
    const { result, updatedItems } = await bulkPushToShopify(
      singleItem,
      mockConfig,
      { status: 'draft' },
      undefined,
      (msg) => logs.push(msg)
    );

    expect(result.createdCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(updatedItems[0].shopifyProductId).toBe('999888777');
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes('Created "PDD01-00001"'))).toBe(true);

    fetchSpy.mockRestore();
  });
});
