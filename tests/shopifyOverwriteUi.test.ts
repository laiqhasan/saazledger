import { describe, it, expect } from 'vitest';
import { buildOverwriteRequestFields, describeOverwriteConfirmation, CATEGORY_NOT_SET_MESSAGE } from '../src/services/shopifyService';

const conf: any = {
  code: 'stock_overwrite_requires_confirmation',
  conflicts: [{ field: 'stock', currentValue: 7, desiredValue: 5, lastSyncedValue: 5 }, { field: 'price', currentValue: 900, desiredValue: 1200, lastSyncedValue: 1200 }],
  productId: '1', adminUrl: 'https://x',
};

describe('Shopify overwrite confirmation UI helpers', () => {
  it('message matches the dialog wording', () => {
    expect(describeOverwriteConfirmation({ ...conf, conflicts: [conf.conflicts[0]] })).toBe('Shopify draft stock is 7 but SaazLedger says 5 - overwrite?');
    expect(CATEGORY_NOT_SET_MESSAGE).toBe('Category: NOT SET - assign in Shopify admin before publishing');
  });
  it('Keep (default) sends no confirmation, only keepShopifyValues', () => {
    expect(buildOverwriteRequestFields(conf, 'keep')).toEqual({ keepShopifyValues: true });
  });
  it('Overwrite sends explicit confirmation with the expected current values', () => {
    expect(buildOverwriteRequestFields(conf, 'overwrite')).toEqual({ confirmStockOverwrite: true, expectedCurrentQuantity: 7, confirmPriceOverwrite: true, expectedCurrentPrice: 900 });
  });
});
