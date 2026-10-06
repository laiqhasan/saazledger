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

  // NOTE: updated for draft-only behaviour. Shopify writes now go through the server
  // endpoint /api/shopify/send-draft (which enforces status "draft"), not the browser proxy.
  it('only pushes selected items when a subset is passed to bulkPushToShopify', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any, opts: any) => {
      expect(String(url)).toBe('/api/shopify/send-draft');
      const body = JSON.parse(opts.body);
      expect(JSON.stringify(body)).not.toMatch(/"status"|active/);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            shopifyProductId: '111222333',
            shopifyVariantId: '444555666',
            verification: { verified: true, productId: '111222333', status: 'draft', isDraft: true, mediaCount: 0 },
          }),
      } as any;
    });

    const progressTracked: string[] = [];
    const { result, updatedItems } = await bulkPushToShopify(
      [sampleItems[0]],
      mockConfig,
      { status: 'active' }, // ignored: draft-only
      (_curr, _total, item) => {
        progressTracked.push(item.sku);
      }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

  it('reports a needs-manual-review block from the server as a failed (unwritten) item', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({
            success: false,
            error: 'Existing Shopify product 1 is ACTIVE (live).',
            needsManualReview: { needsManualReview: true, code: 'live_product_match', reason: 'live', candidates: [] },
          }),
      } as any;
    });

    const logs: string[] = [];
    const { result, updatedItems } = await bulkPushToShopify([sampleItems[0]], mockConfig, undefined, undefined, (m) => logs.push(m));

    expect(result.createdCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0]).toContain('NEEDS MANUAL REVIEW');
    expect(updatedItems[0].shopifyProductId).toBeUndefined();
    fetchSpy.mockRestore();
  });
});
