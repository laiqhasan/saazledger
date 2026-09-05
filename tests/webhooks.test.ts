import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  verifyShopifyWebhookHmac,
  processShopifyOrderWebhook,
} from '../server/services/webhookService';
import { createItem, getItemById } from '../server/services/inventoryService';

describe('Shopify Webhook Security & Idempotency', () => {
  const testSecret = 'saaz_webhook_secret_key_testing_123';

  it('validates authentic HMAC-SHA256 signatures and rejects forged requests', () => {
    const rawPayload = JSON.stringify({ id: 12345, total_price: '2500.00' });
    const validSignature = crypto
      .createHmac('sha256', testSecret)
      .update(rawPayload, 'utf8')
      .digest('base64');

    expect(verifyShopifyWebhookHmac(rawPayload, validSignature, testSecret)).toBe(true);

    // Tampered payload should fail
    const tamperedPayload = JSON.stringify({ id: 12345, total_price: '9999.00' });
    expect(verifyShopifyWebhookHmac(tamperedPayload, validSignature, testSecret)).toBe(false);

    // Invalid signature should fail
    expect(verifyShopifyWebhookHmac(rawPayload, 'invalid-signature==', testSecret)).toBe(false);
  });

  it('processes order webhooks idempotently without duplicate inventory deductions', () => {
    // Create an item to link with Shopify line item SKU
    const item = createItem({
      title: 'Webhook Test Earring',
      typeCode: 'TESTW',
      stoneCode: 'D',
      colorCode: '01',
      buyingPrice: 400,
      sellingPrice: 1100,
      quantity: 10,
    });

    const uniqueOrderId = `SHOP-TEST-${Date.now()}`;
    const orderPayload = {
      id: uniqueOrderId,
      financial_status: 'paid',
      line_items: [
        {
          id: 101,
          sku: item.sku,
          title: item.title,
          quantity: 2,
          price: '1100.00',
        },
      ],
    };

    // 1st delivery of webhook
    const result1 = processShopifyOrderWebhook('order_placed', orderPayload);
    expect(result1.status).toBe('processed');
    expect(result1.affectedItems?.length).toBeGreaterThan(0);

    let updated = getItemById(item.id);
    expect(updated?.quantity).toBe(8); // 10 - 2 = 8

    // 2nd delivery of the exact same webhook (e.g. network retry)
    const result2 = processShopifyOrderWebhook('order_placed', orderPayload);
    expect(result2.status).toBe('already_processed');

    // Stock should NOT have been deducted a second time
    updated = getItemById(item.id);
    expect(updated?.quantity).toBe(8);
  });
});
