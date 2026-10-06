import { describe, it, expect } from 'vitest';
import { assertSafeRealShop, KNOWN_PRODUCTION_SHOPS, maskDomain } from '../scripts/browser-e2e/lib/stack';

describe('browser E2E real-mode safety guard', () => {
  const prod = [...KNOWN_PRODUCTION_SHOPS, 'my-live-shop.myshopify.com'];
  it('accepts a dev/test *.myshopify.com store', () => {
    expect(() => assertSafeRealShop('e2e-test-4821.myshopify.com', prod)).not.toThrow();
  });
  it('refuses the production domain, anything containing it, and non-myshopify domains', () => {
    expect(() => assertSafeRealShop('saazaura.myshopify.com', prod)).toThrow(/production/i);
    expect(() => assertSafeRealShop('SaazAura-Test.myshopify.com', prod)).toThrow(/production/i);
    expect(() => assertSafeRealShop('my-live-shop.myshopify.com', prod)).toThrow(/production/i);
    expect(() => assertSafeRealShop('shop.example.com', prod)).toThrow(/myshopify/);
    expect(() => assertSafeRealShop('https://e2e.myshopify.com/', prod)).toThrow();
    expect(() => assertSafeRealShop('', prod)).toThrow();
  });
  it('masks the domain in reports', () => {
    expect(maskDomain('e2e-test-4821.myshopify.com')).toBe('e2e***.myshopify.com');
  });
});
