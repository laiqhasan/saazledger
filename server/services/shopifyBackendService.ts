import { db } from '../db/database';

export interface ShopifyBackendConfig {
  shopDomain: string;
  adminAccessToken: string;
  apiVersion: string;
  primaryLocationId?: string;
}

export function getShopifyConfig(): ShopifyBackendConfig {
  // Check environment variables first
  const envShop = process.env.SHOPIFY_SHOP_DOMAIN || '';
  const envToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';

  if (envShop && envToken) {
    return {
      shopDomain: envShop,
      adminAccessToken: envToken,
      apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
    };
  }

  // Fallback to secure system settings table
  const shopRow = db.prepare("SELECT value FROM system_settings WHERE key = 'shopify_shop_domain'").get() as { value: string } | undefined;
  const tokenRow = db.prepare("SELECT value FROM system_settings WHERE key = 'shopify_admin_access_token'").get() as { value: string } | undefined;
  const locRow = db.prepare("SELECT value FROM system_settings WHERE key = 'shopify_primary_location_id'").get() as { value: string } | undefined;

  return {
    shopDomain: shopRow?.value || '',
    adminAccessToken: tokenRow?.value || '',
    apiVersion: '2026-07',
    primaryLocationId: locRow?.value || undefined,
  };
}

export function saveShopifyConfig(config: Partial<ShopifyBackendConfig>): void {
  const insert = db.prepare(`
    INSERT INTO system_settings (key, value, is_secret)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `);

  if (config.shopDomain !== undefined) {
    insert.run('shopify_shop_domain', config.shopDomain, 0, config.shopDomain);
  }
  if (config.adminAccessToken !== undefined) {
    insert.run('shopify_admin_access_token', config.adminAccessToken, 1, config.adminAccessToken);
  }
  if (config.primaryLocationId !== undefined) {
    insert.run('shopify_primary_location_id', config.primaryLocationId, 0, config.primaryLocationId);
  }
}

/**
 * Server-side Shopify Admin API Client with rate-limiting backoff
 */
export async function callShopifyAdminApi(
  endpointPath: string,
  options: {
    method?: string;
    body?: any;
    query?: Record<string, string>;
  } = {}
): Promise<{ status: number; ok: boolean; data: any; linkHeader?: string | null }> {
  const config = getShopifyConfig();
  if (!config.shopDomain || !config.adminAccessToken) {
    throw new Error('Shopify backend credentials are not configured.');
  }

  let cleanDomain = config.shopDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!cleanDomain.includes('.')) {
    cleanDomain = `${cleanDomain}.myshopify.com`;
  }

  const url = new URL(`https://${cleanDomain}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v);
    }
  }

  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    const response = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Shopify-Access-Token': config.adminAccessToken,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 429) {
      // Rate limited: respect Retry-After
      const retryAfter = parseFloat(response.headers.get('Retry-After') || '2.0');
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      data = { error: 'Failed parsing response' };
    }

    return {
      status: response.status,
      ok: response.ok,
      data,
      linkHeader: response.headers.get('Link'),
    };
  }

  throw new Error('Shopify API request exceeded maximum retry attempts.');
}

/**
 * Exchanges Client Credentials (Client ID + Client Secret) for a Shopify Admin API Access Token
 */
export async function exchangeClientCredentials(
  shopDomain: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; scope: string; expiresIn?: number }> {
  let cleanDomain = shopDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!cleanDomain.includes('.')) {
    cleanDomain = `${cleanDomain}.myshopify.com`;
  }

  const tokenUrl = `https://${cleanDomain}/admin/oauth/access_token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      grant_type: 'client_credentials',
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
      data.error ||
      data.errors ||
      `Shopify authentication failed (HTTP ${res.status}). Ensure the app is installed or custom distribution is enabled for ${cleanDomain}.`
    );
  }

  saveShopifyConfig({
    shopDomain: cleanDomain,
    adminAccessToken: data.access_token,
  });

  return {
    accessToken: data.access_token,
    scope: data.scope || '',
    expiresIn: data.expires_in,
  };
}

/**
 * Exchanges OAuth authorization code for an Admin Access Token
 */
export async function exchangeAuthCode(
  shopDomain: string,
  code: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; scope: string }> {
  let cleanDomain = shopDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!cleanDomain.includes('.')) {
    cleanDomain = `${cleanDomain}.myshopify.com`;
  }

  const tokenUrl = `https://${cleanDomain}/admin/oauth/access_token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      code: code.trim(),
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || data.errors || 'OAuth token exchange failed');
  }

  saveShopifyConfig({
    shopDomain: cleanDomain,
    adminAccessToken: data.access_token,
  });

  return {
    accessToken: data.access_token,
    scope: data.scope || '',
  };
}
