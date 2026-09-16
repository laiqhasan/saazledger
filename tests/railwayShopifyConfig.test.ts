import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getShopifyConfig,
  saveShopifyConfig,
  normalizeShopifyDomain,
} from '../server/services/shopifyBackendService';

describe('Railway Persistent Shopify Environment Configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all shopify env vars before each test
    delete process.env.SHOPIFY_SHOP_DOMAIN;
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_DOMAIN;
    delete process.env.SHOPIFY_STORE;
    delete process.env.SHOPIFY_SHOP;
    delete process.env.SHOPIFY_STORE_URL;
    delete process.env.SHOPIFY_URL;

    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    delete process.env.SHOPIFY_ACCESS_TOKEN;
    delete process.env.SHOPIFY_ADMIN_TOKEN;
    delete process.env.SHOPIFY_API_TOKEN;
    delete process.env.SHOPIFY_TOKEN;

    delete process.env.SHOPIFY_PRIMARY_LOCATION_ID;
    delete process.env.SHOPIFY_LOCATION_ID;
    delete process.env.SHOPIFY_API_VERSION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('normalizes various domain input formats correctly', () => {
    expect(normalizeShopifyDomain('saazaura')).toBe('saazaura.myshopify.com');
    expect(normalizeShopifyDomain('https://saazaura.myshopify.com/')).toBe('saazaura.myshopify.com');
    expect(normalizeShopifyDomain('"saaz-jewels.myshopify.com"')).toBe('saaz-jewels.myshopify.com');
    expect(normalizeShopifyDomain('  http://mystore.myshopify.com/  ')).toBe('mystore.myshopify.com');
  });

  it('reads standard Railway environment variables and marks isEnvConfigured: true', () => {
    process.env.SHOPIFY_SHOP_DOMAIN = 'saazaura.myshopify.com';
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'shpat_railway_secret_999';
    process.env.SHOPIFY_PRIMARY_LOCATION_ID = '905684977';

    const config = getShopifyConfig();
    expect(config.shopDomain).toBe('saazaura.myshopify.com');
    expect(config.adminAccessToken).toBe('shpat_railway_secret_999');
    expect(config.primaryLocationId).toBe('905684977');
    expect(config.isEnvConfigured).toBe(true);
  });

  it('recognizes domain aliases like SHOPIFY_STORE_DOMAIN and SHOPIFY_DOMAIN', () => {
    process.env.SHOPIFY_STORE_DOMAIN = 'https://aura-gems.myshopify.com/';
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_alias_token_456';

    const config = getShopifyConfig();
    expect(config.shopDomain).toBe('aura-gems.myshopify.com');
    expect(config.adminAccessToken).toBe('shpat_alias_token_456');
    expect(config.isEnvConfigured).toBe(true);
  });

  it('recognizes token aliases like SHOPIFY_API_TOKEN and location alias SHOPIFY_LOCATION_ID', () => {
    process.env.SHOPIFY_SHOP = 'luxury-jewels';
    process.env.SHOPIFY_API_TOKEN = 'shpat_api_token_123';
    process.env.SHOPIFY_LOCATION_ID = '8881234';

    const config = getShopifyConfig();
    expect(config.shopDomain).toBe('luxury-jewels.myshopify.com');
    expect(config.adminAccessToken).toBe('shpat_api_token_123');
    expect(config.primaryLocationId).toBe('8881234');
    expect(config.isEnvConfigured).toBe(true);
  });

  it('protects Railway environment variables from being wiped by empty save requests', () => {
    process.env.SHOPIFY_SHOP_DOMAIN = 'permanent-store.myshopify.com';
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'shpat_permanent_token_777';

    // Attempt to save empty config from a UI reset or empty payload
    saveShopifyConfig({ shopDomain: '', adminAccessToken: '' });

    const active = getShopifyConfig();
    expect(active.shopDomain).toBe('permanent-store.myshopify.com');
    expect(active.adminAccessToken).toBe('shpat_permanent_token_777');
    expect(active.isEnvConfigured).toBe(true);
  });
});
