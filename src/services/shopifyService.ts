import type { JewelryItem, CodeTables, ShopifyConfig, ShopifySyncResult } from '../types/inventory';
import { getStoredTransactions, saveStoredTransactions, saveStoredInventory } from './storage';

const SHOPIFY_STORAGE_KEY = 'saaz_ledger_shopify_v1';

export const DEFAULT_SHOPIFY_CONFIG: ShopifyConfig = {
  shopDomain: '',
  adminAccessToken: '',
  apiVersion: '2026-07',
  defaultStatus: 'draft',
  isConnected: false,
};

/**
 * Normalizes shop domain input to standard format: e.g. "saaz-jewels.myshopify.com"
 */
export function normalizeShopDomain(domain: string): string {
  let clean = domain.trim().toLowerCase();
  clean = clean.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (clean && !clean.includes('.')) {
    clean = `${clean}.myshopify.com`;
  }
  return clean;
}

export function getStoredShopifyConfig(): ShopifyConfig {
  try {
    const raw = localStorage.getItem(SHOPIFY_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Failed reading Shopify config from storage:', err);
  }
  return DEFAULT_SHOPIFY_CONFIG;
}

export function saveStoredShopifyConfig(config: ShopifyConfig): void {
  try {
    localStorage.setItem(SHOPIFY_STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.error('Failed saving Shopify config to storage:', err);
  }
}

/**
 * Sends a request to Shopify Admin API via the Vite local proxy
 */
async function callShopifyProxy(
  config: ShopifyConfig,
  path: string,
  options?: {
    method?: string;
    body?: any;
  }
): Promise<{ status: number; ok: boolean; data: any }> {
  const cleanShop = normalizeShopDomain(config.shopDomain);
  if (!cleanShop) {
    throw new Error('Shopify store domain is required.');
  }
  if (!config.adminAccessToken) {
    throw new Error('Shopify Admin API Access Token is required.');
  }

  const proxyUrl = `/api/shopify-proxy?shop=${encodeURIComponent(cleanShop)}&path=${encodeURIComponent(path)}`;

  const response = await fetch(proxyUrl, {
    method: options?.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Shopify-Access-Token': config.adminAccessToken.trim(),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  let data: any;
  const rawText = await response.text();
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { error: rawText ? (rawText.length > 200 ? rawText.slice(0, 200) + '...' : rawText) : `HTTP ${response.status}: Failed to parse response.` };
  }

  return {
    status: response.status,
    ok: response.ok,
    data,
  };
}

/**
 * Probes Shopify Admin API to verify credentials and fetch store info
 */
export async function testShopifyConnection(config: ShopifyConfig): Promise<{
  success: boolean;
  shopName?: string;
  email?: string;
  currency?: string;
  primaryLocationId?: number;
  locationName?: string;
  locationWarning?: string;
  error?: string;
}> {
  try {
    const res = await callShopifyProxy(config, `/admin/api/${config.apiVersion}/shop.json`);

    if (!res.ok) {
      const errMsg =
        res.data?.errors ||
        res.data?.error ||
        (res.status === 401
          ? 'Invalid Access Token or permissions. Ensure "write_products" scope is enabled in your Shopify Custom App.'
          : res.status === 404
          ? 'Store not found. Verify your myshopify.com domain.'
          : `HTTP ${res.status}: Failed to authenticate with Shopify.`);
      return { success: false, error: String(errMsg) };
    }

    const shop = res.data?.shop;
    if (!shop) {
      return { success: false, error: 'Shopify returned an unexpected payload structure.' };
    }

    // Discover primary inventory location
    let locId = await getShopifyPrimaryLocationId(config);
    let locName: string | undefined = undefined;
    let locWarning: string | undefined = undefined;

    if (locId) {
      locName = `Store Location #${locId}`;
    } else {
      locWarning = 'Notice: Could not auto-detect inventory location. Ensure "read_locations" scope is enabled in Shopify, or enter your Location ID in Settings.';
    }

    return {
      success: true,
      shopName: shop.name,
      email: shop.email,
      currency: shop.currency || 'INR',
      primaryLocationId: locId || undefined,
      locationName: locName,
      locationWarning: locWarning,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Connection error connecting to Shopify.',
    };
  }
}

let cachedPrimaryLocationId: number | null = null;
let cachedLocationShop: string | null = null;

/**
 * Discovers and caches the store's primary active inventory location ID
 * Supports:
 * 1. Explicit config.primaryLocationId
 * 2. Official /locations.json (requires read_locations scope)
 * 3. Product inventory level sniffing fallback (works with standard read_inventory scope)
 */
export async function getShopifyPrimaryLocationId(config: ShopifyConfig): Promise<number | null> {
  const cleanShop = normalizeShopDomain(config.shopDomain);

  // 1. Direct configuration override
  if (config.primaryLocationId) {
    return Number(config.primaryLocationId);
  }

  // 2. Memory cache hit
  if (cachedPrimaryLocationId && cachedLocationShop === cleanShop) {
    return cachedPrimaryLocationId;
  }

  // 3. Official /locations.json endpoint (requires read_locations scope)
  try {
    const locRes = await callShopifyProxy(config, `/admin/api/${config.apiVersion}/locations.json`);
    if (locRes.ok && Array.isArray(locRes.data?.locations) && locRes.data.locations.length > 0) {
      const activeLocations = locRes.data.locations.filter((l: any) => l.active);
      const loc = activeLocations.find((l: any) => !l.legacy) || activeLocations[0] || locRes.data.locations[0];
      if (loc?.id) {
        cachedPrimaryLocationId = Number(loc.id);
        cachedLocationShop = cleanShop;
        return cachedPrimaryLocationId;
      }
    }
  } catch (err) {
    console.warn('Could not query /locations.json:', err);
  }

  // 4. Fallback: Sniff active location ID from existing products' inventory levels
  // This succeeds with standard read_inventory scope even when read_locations is not granted
  try {
    const prodRes = await callShopifyProxy(
      config,
      `/admin/api/${config.apiVersion}/products.json?limit=10&fields=id,variants`
    );
    if (prodRes.ok && Array.isArray(prodRes.data?.products)) {
      for (const prod of prodRes.data.products) {
        const variant = prod.variants?.[0];
        if (variant?.inventory_item_id) {
          const lvlRes = await callShopifyProxy(
            config,
            `/admin/api/${config.apiVersion}/inventory_levels.json?inventory_item_ids=${variant.inventory_item_id}`
          );
          if (lvlRes.ok && Array.isArray(lvlRes.data?.inventory_levels) && lvlRes.data.inventory_levels.length > 0) {
            const locId = Number(lvlRes.data.inventory_levels[0].location_id);
            if (locId) {
              cachedPrimaryLocationId = locId;
              cachedLocationShop = cleanShop;
              return cachedPrimaryLocationId;
            }
          }
        }
      }
    }
  } catch (invErr) {
    console.warn('Fallback location discovery from products/inventory_levels failed:', invErr);
  }

  return null;
}

/**
 * Resolves local photos, base64 data URLs, or CDN images to a Shopify-compliant image payload
 * Converts WebP/PNG/data URLs to standard JPEG format with filename for 100% Shopify REST API compatibility.
 */
async function resolveImagePayload(
  imageUrl?: string,
  sku?: string
): Promise<{ attachment?: string; src?: string; filename?: string } | null> {
  if (!imageUrl || typeof imageUrl !== 'string') return null;

  const cleanSku = (sku || 'jewelry_piece').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${cleanSku}.jpg`;

  // Public remote image URL (not localhost) can be passed directly as src
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    if (!imageUrl.includes('localhost') && !imageUrl.includes('127.0.0.1')) {
      return { src: imageUrl };
    }
  }

  // Helper: converts any image Blob into a clean JPEG base64 string via HTML Canvas
  const convertBlobToJpegBase64 = async (blob: Blob): Promise<string | null> => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    let objectUrl = '';
    try {
      objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      // blob: URLs are same-origin, DO NOT set crossOrigin
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (e) => reject(e);
        img.src = objectUrl;
      });

      const canvas = document.createElement('canvas');
      const maxDim = 1800;
      let width = img.naturalWidth || img.width || 800;
      let height = img.naturalHeight || img.height || 800;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // Clean white background for jewelry presentation (eliminates transparent holes)
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      const comma = dataUrl.indexOf(',');
      return comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
    } catch (err) {
      console.warn('Canvas conversion from blob failed:', err);
      return null;
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  };

  // 1. If relative photo URL (/api/photos/...)
  if (imageUrl.startsWith('/api/photos/') || imageUrl.startsWith('/uploads/')) {
    try {
      const res = await fetch(imageUrl);
      if (res.ok) {
        const blob = await res.blob();
        const jpegBase64 = await convertBlobToJpegBase64(blob);
        if (jpegBase64) {
          return { attachment: jpegBase64, filename };
        }
      }
    } catch (err) {
      console.warn('Fetch photo for Shopify upload failed:', err);
    }
  }

  // 2. If data: URL (e.g. data:image/webp;base64,... or data:image/png;base64,...)
  if (imageUrl.startsWith('data:')) {
    try {
      const res = await fetch(imageUrl);
      const blob = await res.blob();
      const jpegBase64 = await convertBlobToJpegBase64(blob);
      if (jpegBase64) {
        return { attachment: jpegBase64, filename };
      }
      // If Canvas not available (e.g. Node tests), and it's already a JPEG data URL:
      if (imageUrl.startsWith('data:image/jpeg') || imageUrl.startsWith('data:image/jpg')) {
        const comma = imageUrl.indexOf(',');
        return { attachment: comma !== -1 ? imageUrl.slice(comma + 1) : imageUrl, filename };
      }
    } catch (err) {
      console.warn('Data URL conversion failed:', err);
    }
  }

  return null;
}

/**
 * Maps item to Internal Category and Shopify Taxonomy Category:
 *
 * IF product contains:
 *   Pendant + Earrings OR Pendant + Chain + Earrings
 * THEN:
 *   Internal Category = Pendant Set
 *   Shopify Category = Jewelry Sets in Jewelry
 *
 * IF product contains:
 *   Pendant only OR Pendant + Chain only
 * THEN:
 *   Internal Category = Pendant / Pendant Necklace
 *   Shopify Category = Pendants
 */
export function resolveJewelryCategories(item: Partial<JewelryItem>): {
  internalCategory: 'Pendant Set' | 'Pendant / Pendant Necklace' | string;
  shopifyCategory: 'Jewelry Sets in Jewelry' | 'Pendants' | string;
  shopifyCategoryPath: string;
} {
  const typeCode = (item.typeCode || '').trim().toUpperCase();
  const prodType = (item.productType || '').trim().toLowerCase();
  const title = (item.title || '').trim().toLowerCase();
  const components = (item.includedComponents || '').trim().toLowerCase();
  const notes = (item.notes || '').trim().toLowerCase();

  const isPendant =
    typeCode === 'PD' ||
    typeCode === 'PDN' ||
    typeCode === 'PND' ||
    prodType.includes('pendant') ||
    title.includes('pendant');

  if (isPendant) {
    const mentionsEarrings =
      components.includes('earring') ||
      components.includes('stud') ||
      components.includes('jhumka') ||
      title.includes('earring') ||
      title.includes('with matching') ||
      notes.includes('earring');

    const mentionsPendantOnlyOrChainOnly =
      components.includes('only') ||
      components.includes('pendant only') ||
      components.includes('chain only') ||
      title.includes('pendant only') ||
      title.includes('chain only') ||
      title.includes('pendant necklace') ||
      typeCode === 'PDN' ||
      prodType === 'pendant' ||
      prodType === 'pendant necklace' ||
      prodType.includes('pendant / pendant necklace') ||
      ((components.includes('pendant') || components.includes('chain')) && !mentionsEarrings);

    // Classification Rule:
    // IF product contains: Pendant + Earrings OR Pendant + Chain + Earrings
    //   -> Internal: Pendant Set, Shopify: Jewelry Sets in Jewelry
    // IF product contains: Pendant only OR Pendant + Chain only
    //   -> Internal: Pendant / Pendant Necklace, Shopify: Pendants
    const isPendantSet = mentionsEarrings || (!mentionsPendantOnlyOrChainOnly && (typeCode === 'PD' || prodType.includes('set') || title.includes('set')));

    if (isPendantSet) {
      return {
        internalCategory: 'Pendant Set',
        shopifyCategory: 'Jewelry Sets in Jewelry',
        shopifyCategoryPath: 'Apparel & Accessories > Jewelry > Jewelry Sets',
      };
    } else {
      return {
        internalCategory: 'Pendant / Pendant Necklace',
        shopifyCategory: 'Pendants',
        shopifyCategoryPath: 'Apparel & Accessories > Jewelry > Charms & Pendants > Pendants',
      };
    }
  }

  if (typeCode === 'NLS' || prodType.includes('necklace set')) {
    return {
      internalCategory: 'Necklace Set',
      shopifyCategory: 'Jewelry Sets in Jewelry',
      shopifyCategoryPath: 'Apparel & Accessories > Jewelry > Jewelry Sets',
    };
  }
  if (typeCode === 'EAR' || prodType.includes('earring')) {
    return {
      internalCategory: 'Earrings / Jhumkas',
      shopifyCategory: 'Earrings',
      shopifyCategoryPath: 'Apparel & Accessories > Jewelry > Earrings',
    };
  }
  if (typeCode === 'RNG' || prodType.includes('ring')) {
    return {
      internalCategory: 'Finger Ring',
      shopifyCategory: 'Rings',
      shopifyCategoryPath: 'Apparel & Accessories > Jewelry > Rings',
    };
  }
  if (typeCode === 'BNG' || typeCode === 'BRC' || prodType.includes('bangle') || prodType.includes('bracelet')) {
    return {
      internalCategory: 'Bangles / Kadas',
      shopifyCategory: 'Bracelets & Bangles',
      shopifyCategoryPath: 'Apparel & Accessories > Jewelry > Bracelets',
    };
  }

  return {
    internalCategory: item.productType || 'Jewelry Piece',
    shopifyCategory: 'Jewelry',
    shopifyCategoryPath: 'Apparel & Accessories > Jewelry',
  };
}

const cachedTaxonomyGids = new Map<string, string>();

async function getShopifyTaxonomyCategoryGid(config: ShopifyConfig, categoryName: string): Promise<string | null> {
  if (cachedTaxonomyGids.has(categoryName)) {
    return cachedTaxonomyGids.get(categoryName)!;
  }
  try {
    const searchTerm = categoryName.includes('Jewelry Sets') ? 'Jewelry Sets' : categoryName;
    const query = `
      query searchTaxonomy($q: String!) {
        taxonomy {
          categories(first: 10, query: $q) {
            edges {
              node {
                id
                name
                fullName
              }
            }
          }
        }
      }
    `;
    const res = await callShopifyProxy(config, `/admin/api/${config.apiVersion}/graphql.json`, {
      method: 'POST',
      body: { query, variables: { q: searchTerm } },
    });
    if (res.ok && Array.isArray(res.data?.data?.taxonomy?.categories?.edges)) {
      const edges = res.data.data.taxonomy.categories.edges;
      // Prefer nodes belonging to Jewelry / Apparel & Accessories / Charms & Pendants
      const match = edges.find((e: any) => {
        const full = (e.node?.fullName || '').toLowerCase();
        const name = (e.node?.name || '').toLowerCase();
        const isJewelryRelated = full.includes('jewelry') || full.includes('charm') || full.includes('apparel');
        return isJewelryRelated && (name === searchTerm.toLowerCase() || full.includes(searchTerm.toLowerCase()));
      }) || edges.find((e: any) => (e.node?.fullName || '').toLowerCase().includes('jewelry')) || edges[0];

      if (match?.node?.id) {
        cachedTaxonomyGids.set(categoryName, match.node.id);
        return match.node.id;
      }
    }
  } catch (err) {
    console.warn('Shopify taxonomy category GID lookup error:', err);
  }
  return null;
}

/**
 * Pushes a single JewelryItem to Shopify as a Product (Create or Update)
 * Fully populates Price, Stock Inventory Level, Cost, Product Image, and Taxonomy Category
 */
export async function pushItemToShopify(
  item: JewelryItem,
  config: ShopifyConfig,
  options?: { status?: 'draft' | 'active' }
): Promise<{
  success: boolean;
  shopifyProductId?: string;
  shopifyVariantId?: string;
  error?: string;
  imageUploaded?: boolean;
  stockUpdated?: boolean;
  warning?: string;
}> {
  try {
    const productStatus = options?.status || config.defaultStatus || 'draft';
    const bodyHtml = item.notes ? `<p>${item.notes.replace(/\n/g, '<br/>')}</p>` : '';
    const categoryInfo = resolveJewelryCategories(item);

    const tags = [
      `SKU:${item.sku}`,
      `Type:${item.typeCode}`,
      `Category:${categoryInfo.shopifyCategory}`,
      `Stone:${item.stoneCode}`,
      `Color:${item.colorCode}`,
      'SaazLedger',
    ].join(', ');

    const sellingPrice = Number(item.sellingPrice) || 0;
    const buyingPrice = Number(item.buyingPrice) || 0;
    const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0));

    // Resolve high-fidelity image payload
    const imagePayload = await resolveImagePayload(item.imageUrl, item.sku);

    let productId = item.shopifyProductId ? String(item.shopifyProductId) : undefined;
    let variantId = item.shopifyVariantId ? String(item.shopifyVariantId) : undefined;
    let inventoryItemId: string | undefined = undefined;

    // STEP 1: CREATE OR UPDATE PRODUCT CORE RECORD
    if (productId) {
      // Update existing product metadata (images must not be passed in PUT body)
      const updatePayload = {
        product: {
          id: Number(productId),
          title: item.title,
          body_html: bodyHtml,
          vendor: item.vendor || 'Saaz Aura Atelier',
          product_type: categoryInfo.shopifyCategory,
          status: productStatus,
          tags,
        },
      };

      const res = await callShopifyProxy(
        config,
        `/admin/api/${config.apiVersion}/products/${productId}.json`,
        { method: 'PUT', body: updatePayload }
      );

      if (!res.ok) {
        const errMsg = res.data?.errors ? JSON.stringify(res.data.errors) : `HTTP ${res.status}: Failed to update product.`;
        return { success: false, error: errMsg };
      }
    } else {
      // Create new product
      const createPayload: any = {
        product: {
          title: item.title,
          body_html: bodyHtml,
          vendor: item.vendor || 'Saaz Aura Atelier',
          product_type: categoryInfo.shopifyCategory,
          status: productStatus,
          tags,
          variants: [
            {
              sku: item.sku,
              price: sellingPrice > 0 ? sellingPrice.toFixed(2) : '0.00',
              compare_at_price: sellingPrice > 0 ? (sellingPrice * 1.25).toFixed(2) : undefined,
              inventory_management: 'shopify',
            },
          ],
        },
      };

      // If we have an image payload, attach during initial creation
      if (imagePayload) {
        createPayload.product.images = [imagePayload];
      }

      const res = await callShopifyProxy(
        config,
        `/admin/api/${config.apiVersion}/products.json`,
        { method: 'POST', body: createPayload }
      );

      if (!res.ok) {
        const errMsg = res.data?.errors ? JSON.stringify(res.data.errors) : `HTTP ${res.status}: Failed to create product.`;
        return { success: false, error: errMsg };
      }

      if (res.data?.product?.id) {
        productId = String(res.data.product.id);
      }
      if (res.data?.product?.variants?.[0]?.id) {
        variantId = String(res.data.product.variants[0].id);
        inventoryItemId = res.data.product.variants[0].inventory_item_id ? String(res.data.product.variants[0].inventory_item_id) : undefined;
      }
    }

    if (!productId) {
      return { success: false, error: 'No product ID returned by Shopify.' };
    }

    // STEP 1b: ASSIGN SHOPIFY STANDARDIZED TAXONOMY CATEGORY VIA GRAPHQL
    try {
      const taxonomyGid = await getShopifyTaxonomyCategoryGid(config, categoryInfo.shopifyCategory);
      if (taxonomyGid) {
        const updateMutation = `
          mutation assignCategory($input: ProductInput!) {
            productUpdate(input: $input) {
              product {
                id
                category {
                  id
                  name
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `;
        await callShopifyProxy(config, `/admin/api/${config.apiVersion}/graphql.json`, {
          method: 'POST',
          body: {
            query: updateMutation,
            variables: {
              input: {
                id: `gid://shopify/Product/${productId}`,
                category: taxonomyGid,
              },
            },
          },
        });
      }
    } catch (taxErr) {
      console.warn('Taxonomy assignment via GraphQL skipped:', taxErr);
    }

    let imageUploaded = false;
    let stockUpdated = false;
    let syncWarning: string | undefined = undefined;

    // STEP 2: GUARANTEED IMAGE ATTACHMENT VIA DEDICATED PRODUCT IMAGES API
    if (imagePayload) {
      try {
        const imgListRes = await callShopifyProxy(
          config,
          `/admin/api/${config.apiVersion}/products/${productId}/images.json`
        );
        const existingImages = Array.isArray(imgListRes.data?.images) ? imgListRes.data.images : [];
        
        // Upload image if product was updated, or if product was created but has 0 images in Shopify
        if (item.shopifyProductId || existingImages.length === 0) {
          const addImgRes = await callShopifyProxy(
            config,
            `/admin/api/${config.apiVersion}/products/${productId}/images.json`,
            {
              method: 'POST',
              body: { image: imagePayload },
            }
          );
          if (addImgRes.ok) {
            imageUploaded = true;
          } else {
            const imgErr = addImgRes.data?.errors ? JSON.stringify(addImgRes.data.errors) : `HTTP ${addImgRes.status}`;
            console.warn('Dedicated image upload warning:', addImgRes.status, addImgRes.data);
            syncWarning = `Image upload warning: ${imgErr}`;
          }
        } else {
          imageUploaded = true;
        }
      } catch (imgErr: any) {
        console.warn('Failed attaching product image on Shopify:', imgErr);
        syncWarning = `Image attach error: ${imgErr.message}`;
      }
    }

    // STEP 3: RETRIEVE LIVE VARIANT & INVENTORY_ITEM_ID
    if (!variantId || !inventoryItemId) {
      try {
        const varListRes = await callShopifyProxy(
          config,
          `/admin/api/${config.apiVersion}/products/${productId}/variants.json`
        );
        if (varListRes.ok && Array.isArray(varListRes.data?.variants) && varListRes.data.variants.length > 0) {
          const liveVariant = varListRes.data.variants[0];
          variantId = String(liveVariant.id);
          if (liveVariant.inventory_item_id) {
            inventoryItemId = String(liveVariant.inventory_item_id);
          }
        }
      } catch (varErr) {
        console.warn('Could not query live variant:', varErr);
      }
    }

    // STEP 4: UPDATE VARIANT (Price, SKU, Inventory Management)
    if (variantId) {
      try {
        const varUpdateRes = await callShopifyProxy(
          config,
          `/admin/api/${config.apiVersion}/variants/${variantId}.json`,
          {
            method: 'PUT',
            body: {
              variant: {
                id: Number(variantId),
                price: sellingPrice > 0 ? sellingPrice.toFixed(2) : '0.00',
                compare_at_price: sellingPrice > 0 ? (sellingPrice * 1.25).toFixed(2) : null,
                sku: item.sku,
                inventory_management: 'shopify',
                inventory_policy: 'deny',
              },
            },
          }
        );
        if (varUpdateRes.ok && varUpdateRes.data?.variant?.inventory_item_id) {
          inventoryItemId = String(varUpdateRes.data.variant.inventory_item_id);
        }
      } catch (varErr) {
        console.warn('Variant price update error on Shopify:', varErr);
      }
    }

    // STEP 5: ENABLE INVENTORY TRACKING ON INVENTORY ITEM
    if (inventoryItemId) {
      try {
        await callShopifyProxy(
          config,
          `/admin/api/${config.apiVersion}/inventory_items/${inventoryItemId}.json`,
          {
            method: 'PUT',
            body: {
              inventory_item: {
                id: Number(inventoryItemId),
                tracked: true,
                cost: buyingPrice > 0 ? buyingPrice.toFixed(2) : undefined,
              },
            },
          }
        );
      } catch (costErr) {
        console.warn('Cost price set error on Shopify:', costErr);
      }

      // STEP 6: CONNECT TO STORE LOCATION & SET AVAILABLE STOCK LEVEL
      try {
        let locationId = await getShopifyPrimaryLocationId(config);

        // Fallback: If primary location discovery did not return, check item's assigned level location
        if (!locationId) {
          const levelsRes = await callShopifyProxy(
            config,
            `/admin/api/${config.apiVersion}/inventory_levels.json?inventory_item_ids=${inventoryItemId}`
          );
          if (levelsRes.ok && Array.isArray(levelsRes.data?.inventory_levels) && levelsRes.data.inventory_levels.length > 0) {
            locationId = Number(levelsRes.data.inventory_levels[0].location_id);
          }
        }

        if (locationId) {
          // 6a. Connect inventory item to location (ensures item is stocked at location)
          await callShopifyProxy(
            config,
            `/admin/api/${config.apiVersion}/inventory_levels/connect.json`,
            {
              method: 'POST',
              body: {
                location_id: Number(locationId),
                inventory_item_id: Number(inventoryItemId),
              },
            }
          );

          // 6b. Set exact available stock quantity
          const setRes = await callShopifyProxy(
            config,
            `/admin/api/${config.apiVersion}/inventory_levels/set.json`,
            {
              method: 'POST',
              body: {
                location_id: Number(locationId),
                inventory_item_id: Number(inventoryItemId),
                available: quantity,
              },
            }
          );

          if (setRes.ok) {
            stockUpdated = true;
          } else {
            const stockErr = setRes.data?.errors ? JSON.stringify(setRes.data.errors) : `HTTP ${setRes.status}`;
            console.warn('Shopify inventory_levels/set error:', setRes.status, setRes.data);
            syncWarning = (syncWarning ? syncWarning + ' | ' : '') + `Stock sync warning: ${stockErr}`;
          }
        } else {
          console.warn('No active Shopify location found to set inventory level.');
          syncWarning = (syncWarning ? syncWarning + ' | ' : '') + 'Shopify location not detected (enable read_locations scope or enter Location ID)';
        }
      } catch (invErr: any) {
        console.warn('Inventory level set error on Shopify:', invErr);
        syncWarning = (syncWarning ? syncWarning + ' | ' : '') + `Stock update error: ${invErr.message}`;
      }
    }

    return {
      success: true,
      shopifyProductId: productId,
      shopifyVariantId: variantId,
      imageUploaded,
      stockUpdated,
      warning: syncWarning,
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed pushing piece to Shopify.' };
  }
}

/**
 * Bulk pushes a list of jewelry pieces to Shopify with progress reporting
 */
export async function bulkPushToShopify(
  items: JewelryItem[],
  config: ShopifyConfig,
  options?: { status?: 'draft' | 'active' },
  onProgress?: (current: number, total: number, item: JewelryItem) => void
): Promise<{
  result: ShopifySyncResult;
  updatedItems: JewelryItem[];
}> {
  const errors: string[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  let failedCount = 0;

  const updatedItemsMap = new Map<string, JewelryItem>();
  const total = items.length;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (onProgress) {
      onProgress(i + 1, total, item);
    }

    const res = await pushItemToShopify(item, config, options);
    if (res.success && res.shopifyProductId) {
      if (item.shopifyProductId) {
        updatedCount++;
      } else {
        createdCount++;
      }
      updatedItemsMap.set(item.id, {
        ...item,
        shopifyProductId: res.shopifyProductId,
        shopifyVariantId: res.shopifyVariantId || item.shopifyVariantId,
        shopifySyncedAt: new Date().toISOString(),
      });

      if (res.warning) {
        errors.push(`${item.sku}: ⚠️ ${res.warning}`);
      }
    } else {
      failedCount++;
      errors.push(`${item.sku} (${item.title}): ${res.error || 'Unknown error'}`);
    }

    // Gentle throttle to respect Shopify's 2 requests/sec standard bucket
    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const updatedItems = items.map((i) => updatedItemsMap.get(i.id) || i);

  return {
    result: {
      success: failedCount === 0,
      totalProcessed: total,
      createdCount,
      updatedCount,
      failedCount,
      errors,
    },
    updatedItems,
  };
}

/**
 * Fetches products from Shopify and updates or imports matching pieces
 */
export async function pullProductsFromShopify(
  config: ShopifyConfig,
  codeTables: CodeTables,
  existingInventory: JewelryItem[]
): Promise<{
  updatedInventory: JewelryItem[];
  importedCount: number;
  updatedCount: number;
  error?: string;
}> {
  try {
    const res = await callShopifyProxy(
      config,
      `/admin/api/${config.apiVersion}/products.json?limit=250`
    );

    if (!res.ok) {
      return {
        updatedInventory: existingInventory,
        importedCount: 0,
        updatedCount: 0,
        error: res.data?.errors ? JSON.stringify(res.data.errors) : `HTTP ${res.status}: Failed to fetch Shopify products.`,
      };
    }

    const products = res.data?.products;
    if (!Array.isArray(products)) {
      return {
        updatedInventory: existingInventory,
        importedCount: 0,
        updatedCount: 0,
        error: 'No products array in response from Shopify.',
      };
    }

    const workingInventory = [...existingInventory];
    let importedCount = 0;
    let updatedCount = 0;

    const defaultType = codeTables.types[0]?.code || 'PD';
    const defaultStone = codeTables.stones[0]?.code || 'D';
    const defaultColor = codeTables.colors[0]?.code || '01';

    for (const prod of products) {
      const firstVariant = prod.variants?.[0];
      const prodSku = (firstVariant?.sku || '').trim().toUpperCase();
      const prodPrice = parseFloat(firstVariant?.price) || 0;
      const prodImage = prod.images?.[0]?.src || '';

      if (prodSku) {
        // Check if item exists in inventory
        const existingIdx = workingInventory.findIndex((i) => i.sku.toUpperCase() === prodSku);
        if (existingIdx !== -1) {
          // Link Shopify IDs and update price if appropriate
          workingInventory[existingIdx] = {
            ...workingInventory[existingIdx],
            shopifyProductId: String(prod.id),
            shopifyVariantId: firstVariant?.id ? String(firstVariant.id) : workingInventory[existingIdx].shopifyVariantId,
            shopifySyncedAt: new Date().toISOString(),
          };
          updatedCount++;
          continue;
        }
      }

      // If missing from local inventory, import product
      let detectedType = defaultType;
      let detectedStone = defaultStone;
      let detectedColor = defaultColor;

      // Extract from tags if available (e.g. Type:PD, Stone:D)
      if (prod.tags && typeof prod.tags === 'string') {
        const typeTag = prod.tags.match(/Type:([A-Z0-9]+)/i);
        if (typeTag && codeTables.types.some((t) => t.code === typeTag[1].toUpperCase())) {
          detectedType = typeTag[1].toUpperCase();
        }
        const stoneTag = prod.tags.match(/Stone:([A-Z0-9]+)/i);
        if (stoneTag && codeTables.stones.some((s) => s.code === stoneTag[1].toUpperCase())) {
          detectedStone = stoneTag[1].toUpperCase();
        }
        const colorTag = prod.tags.match(/Color:([A-Z0-9]+)/i);
        if (colorTag && codeTables.colors.some((c) => c.code === colorTag[1].toUpperCase())) {
          detectedColor = colorTag[1].toUpperCase();
        }
      }

      // Sequential serial
      const matchingItems = workingInventory.filter(
        (i) => i.typeCode === detectedType && i.stoneCode === detectedStone && i.colorCode === detectedColor
      );
      let maxSerial = 0;
      for (const i of matchingItems) {
        const num = parseInt(i.serial, 10);
        if (!isNaN(num) && num > maxSerial) maxSerial = num;
      }
      const serial = String(maxSerial + 1).padStart(3, '0');
      const finalSku = prodSku || `${detectedType}${detectedStone}${detectedColor}${serial}`;

      const newItem: JewelryItem = {
        id: 'item_shopify_' + prod.id,
        sku: finalSku,
        title: prod.title || `Shopify Piece #${prod.id}`,
        typeCode: detectedType,
        stoneCode: detectedStone,
        colorCode: detectedColor,
        serial,
        buyingPrice: Math.round(prodPrice * 0.4),
        sellingPrice: prodPrice > 0 ? prodPrice : 1500,
        quantity: 5,
        reorderLevel: 2,
        vendor: prod.vendor || 'Shopify Store',
        notes: prod.body_html ? prod.body_html.replace(/<[^>]+>/g, '').trim() : '',
        imageUrl: prodImage,
        dateAdded: new Date().toISOString().split('T')[0],
        lastRestocked: new Date().toISOString().split('T')[0],
        shopifyProductId: String(prod.id),
        shopifyVariantId: firstVariant?.id ? String(firstVariant.id) : undefined,
        shopifySyncedAt: new Date().toISOString(),
      };

      workingInventory.push(newItem);
      importedCount++;
    }

    return {
      updatedInventory: workingInventory,
      importedCount,
      updatedCount,
    };
  } catch (err: any) {
    return {
      updatedInventory: existingInventory,
      importedCount: 0,
      updatedCount: 0,
      error: err.message || 'Failed pulling products from Shopify.',
    };
  }
}

// ---------------------------------------------------------------------------
// Shopify Orders Auto-Sync & Stock Maintenance
// ---------------------------------------------------------------------------
const PROCESSED_ORDERS_KEY = 'saaz_ledger_processed_orders_v1';

export function getProcessedShopifyOrderIds(): number[] {
  try {
    const raw = localStorage.getItem(PROCESSED_ORDERS_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return [];
}

export function saveProcessedShopifyOrderIds(orderIds: number[]): void {
  try {
    localStorage.setItem(PROCESSED_ORDERS_KEY, JSON.stringify(orderIds));
  } catch {}
}

/**
 * Fetches recent orders from Shopify Admin API
 */
export async function fetchRecentShopifyOrders(
  config: ShopifyConfig,
  limit = 50
): Promise<{ orders: import('../types/inventory').ShopifyOrder[]; error?: string }> {
  try {
    const res = await callShopifyProxy(
      config,
      `/admin/api/${config.apiVersion}/orders.json?status=any&limit=${limit}`
    );

    if (!res.ok) {
      return {
        orders: [],
        error: res.data?.errors ? JSON.stringify(res.data.errors) : `HTTP ${res.status}: Failed to fetch orders.`,
      };
    }

    const orders = res.data?.orders || [];
    return { orders };
  } catch (err: any) {
    return { orders: [], error: err.message || 'Network error fetching Shopify orders.' };
  }
}

/**
 * Scans recent orders on Shopify, identifies items sold, decrements local stock,
 * and records realized profit in the sales ledger automatically!
 */
export async function syncShopifyOrdersToInventory(
  inventory: JewelryItem[],
  config: ShopifyConfig
): Promise<{
  updatedInventory: JewelryItem[];
  newTransactions: import('../types/inventory').StockMovement[];
  summary: import('../types/inventory').OrderSyncSummary;
  error?: string;
}> {
  const { orders, error } = await fetchRecentShopifyOrders(config);
  if (error) {
    return {
      updatedInventory: inventory,
      newTransactions: [],
      summary: {
        ordersFetched: 0,
        newOrdersProcessed: 0,
        itemsDeductedCount: 0,
        loggedSalesTotal: 0,
        details: [`Sync failed: ${error}`],
      },
      error,
    };
  }

  const processedSet = new Set<number>(getProcessedShopifyOrderIds());
  const newTransactions: import('../types/inventory').StockMovement[] = [];
  const workingInventory = [...inventory];
  const newlyProcessedIds: number[] = [];
  const details: string[] = [];

  let itemsDeductedCount = 0;
  let loggedSalesTotal = 0;

  for (const order of orders) {
    if (processedSet.has(order.id)) {
      continue; // Order already reconciled
    }

    newlyProcessedIds.push(order.id);
    const custName = order.customer
      ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || 'Online Customer'
      : 'Online Customer';

    for (const item of order.line_items) {
      const orderSku = (item.sku || '').trim().toUpperCase();
      if (!orderSku) continue;

      // Find matching item in inventory by SKU
      const matchIdx = workingInventory.findIndex((i) => i.sku.trim().toUpperCase() === orderSku);
      if (matchIdx !== -1) {
        const matchedItem = workingInventory[matchIdx];
        const qtySold = Math.max(1, item.quantity);
        const newQty = Math.max(0, matchedItem.quantity - qtySold);

        // Update local quantity
        workingInventory[matchIdx] = {
          ...matchedItem,
          quantity: newQty,
          lastRestocked: matchedItem.lastRestocked,
        };

        const unitSalePrice = parseFloat(item.price) || matchedItem.sellingPrice;
        const totalSale = unitSalePrice * qtySold;
        const totalCost = matchedItem.buyingPrice * qtySold;
        const profit = totalSale - totalCost;

        itemsDeductedCount += qtySold;
        loggedSalesTotal += totalSale;

        // Record automated sales ledger transaction
        const tx: import('../types/inventory').StockMovement = {
          id: `tx_shopify_${order.id}_${item.id}_${Date.now()}`,
          itemId: matchedItem.id,
          sku: matchedItem.sku,
          itemTitle: matchedItem.title,
          type: 'sale',
          quantityDelta: -qtySold,
          unitPrice: unitSalePrice,
          totalPrice: totalSale,
          costPrice: matchedItem.buyingPrice,
          realizedProfit: profit,
          channel: 'SaazAura.com (Shopify)',
          timestamp: order.created_at || new Date().toISOString(),
          notes: `Shopify Order ${order.name} - ${custName}`,
        };

        newTransactions.push(tx);
        details.push(`Order ${order.name}: Sold ${qtySold}x ${matchedItem.sku} (${matchedItem.title}) - Stock: ${matchedItem.quantity} -> ${newQty}`);
      }
    }
  }

  // Save newly processed order IDs so we don't deduct again
  if (newlyProcessedIds.length > 0) {
    const updatedIds = [...newlyProcessedIds, ...Array.from(processedSet)];
    saveProcessedShopifyOrderIds(updatedIds);
  }

  // Persist transactions and updated inventory to storage automatically
  if (newTransactions.length > 0) {
    try {
      const currentTxs = getStoredTransactions();
      saveStoredTransactions([...newTransactions, ...currentTxs]);
      saveStoredInventory(workingInventory);
    } catch (e) {
      console.error('Failed auto-saving reconciled transactions:', e);
    }
  }

  return {
    updatedInventory: workingInventory,
    newTransactions,
    summary: {
      ordersFetched: orders.length,
      newOrdersProcessed: newlyProcessedIds.length,
      itemsDeductedCount,
      loggedSalesTotal,
      details,
    },
  };
}
