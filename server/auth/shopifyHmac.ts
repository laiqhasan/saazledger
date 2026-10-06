import crypto from 'crypto';

/** Secret Shopify signs webhooks with: SHOPIFY_WEBHOOK_SECRET, else the app's client secret. */
export function getShopifyWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET || '').trim();
}

/**
 * Verifies the HMAC Shopify attaches to OAuth redirect query strings:
 * hex(HMAC_SHA256(secret, sorted "k=v&k=v" of every param except `hmac`)).
 */
export function verifyShopifyOAuthQueryHmac(query: Record<string, unknown>, secret: string): boolean {
  const provided = typeof query.hmac === 'string' ? query.hmac : '';
  if (!provided || !secret) return false;
  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${Array.isArray(query[k]) ? (query[k] as unknown[]).join(',') : String(query[k])}`)
    .join('&');
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Only genuine *.myshopify.com hostnames may be contacted with Shopify credentials. */
export function isValidMyshopifyHost(host: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(host);
}
