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

    return {
      success: true,
      shopName: shop.name,
      email: shop.email,
      currency: shop.currency || 'INR',
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
 */
export async function getShopifyPrimaryLocationId(config: ShopifyConfig): Promise<number | null> {
  const cleanShop = normalizeShopDomain(config.shopDomain);
  if (cachedPrimaryLocationId && cachedLocationShop === cleanShop) {
    return cachedPrimaryLocationId;
  }

  try {
    const locRes = await callShopifyProxy(config, `/admin/api/${config.apiVersion}/locations.json`);
    if (locRes.ok && locRes.data?.locations?.length > 0) {
      const activeLocations = locRes.data.locations.filter((l: any) => l.active);
      const loc = activeLocations.find((l: any) => !l.legacy) || activeLocations[0] || locRes.data.locations[0];
      if (loc?.id) {
        cachedPrimaryLocationId = Number(loc.id);
        cachedLocationShop = cleanShop;
        return cachedPrimaryLocationId;
      }
    }
  } catch (err) {
    console.warn('Failed fetching Shopify locations:', err);
  }
  return null;
}

/**
 * Resolves local photos, base64 data URLs, or CDN images to a Shopify image payload
 */
async function resolveImagePayload(imageUrl?: string): Promise<{ attachment?: string; src?: string } | null> {
  if (!imageUrl || typeof imageUrl !== 'string') return null;

  // Case 1: Pure base64 data URL
  if (imageUrl.startsWith('data:image/')) {
    const commaIndex = imageUrl.indexOf(',');
    const base64Data = commaIndex !== -1 ? imageUrl.slice(commaIndex + 1) : imageUrl;
    return { attachment: base64Data };
  }

  // Case 2: Relative local server photo (/api/photos/...)
  if (imageUrl.startsWith('/api/photos/')) {
    try {
      const res = await fetch(imageUrl);
      if (res.ok) {
        const blob = await res.blob();
        const base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const resStr = (reader.result as string) || '';
            const commaIdx = resStr.indexOf(',');
            resolve(commaIdx !== -1 ? resStr.slice(commaIdx + 1) : resStr);
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        if (base64Data) {
          return { attachment: base64Data };
        }
      }
    } catch (err) {
      console.warn('Could not read local photo for Shopify upload:', err);
    }
  }

  // Case 3: Public HTTP/HTTPS URL
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    if (imageUrl.includes('localhost') || imageUrl.includes('127.0.0.1')) {
      try {
        const res = await fetch(imageUrl);
        if (res.ok) {
          const blob = await res.blob();
          const base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const resStr = (reader.result as string) || '';
              const commaIdx = resStr.indexOf(',');
              resolve(commaIdx !== -1 ? resStr.slice(commaIdx + 1) : resStr);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          if (base64Data) {
            return { attachment: base64Data };
          }
        }
      } catch (err) {
        console.warn('Could not convert localhost image for Shopify:', err);
      }
    }
    return { src: imageUrl };
  }

  return null;
}

/**
 * Pushes a single JewelryItem to Shopify as a Product (Create or Update)
 * Fully populates Price, Stock Inventory Level, Cost, and Product Image
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
}> {
  try {
    const productStatus = options?.status || config.defaultStatus || 'draft';
    const cleanNotes = item.notes ? `<p>${item.notes.replace(/\n/g, '<br/>')}</p>` : '';
    const bodyHtml = `
      ${cleanNotes}
      <div style="margin-top: 12px; font-size: 0.9em; border-top: 1px solid #eee; padding-top: 8px;">
        <p><strong>SKU:</strong> ${item.sku}</p>
        <p><strong>Jewelry Type:</strong> ${item.typeCode} | <strong>Stone:</strong> ${item.stoneCode} | <strong>Color Tone:</strong> ${item.colorCode}</p>
        <p><em>Cataloged via Saaz Ledger Atelier Suite</em></p>
      </div>
    `.trim();

    const tags = [
      `SKU:${item.sku}`,
      `Type:${item.typeCode}`,
      `Stone:${item.stoneCode}`,
      `Color:${item.colorCode}`,
      'SaazLedger',
    ].join(', ');

    const sellingPrice = Number(item.sellingPrice) || 0;
    const buyingPrice = Number(item.buyingPrice) || 0;
    const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0));

    // Resolve Image
    const imagePayload = await resolveImagePayload(item.imageUrl);

    const productPayload: any = {
      product: {
        title: item.title,
        body_html: bodyHtml,
        vendor: item.vendor || 'Saaz Aura Atelier',
        product_type: 'Jewelry',
        status: productStatus,
        tags,
      },
    };

    if (imagePayload) {
      productPayload.product.images = [imagePayload];
    }

    // Set initial variant parameters
    productPayload.product.variants = [
      {
        sku: item.sku,
        price: sellingPrice > 0 ? sellingPrice.toFixed(2) : '0.00',
        compare_at_price: sellingPrice > 0 ? (sellingPrice * 1.25).toFixed(2) : undefined,
        inventory_management: 'shopify',
      },
    ];

    let res: { status: number; ok: boolean; data: any };

    if (item.shopifyProductId) {
      // Update existing Shopify product
      res = await callShopifyProxy(
        config,
        `/admin/api/${config.apiVersion}/products/${item.shopifyProductId}.json`,
        { method: 'PUT', body: productPayload }
      );
    } else {
      // Create new Shopify product
      res = await callShopifyProxy(
        config,
        `/admin/api/${config.apiVersion}/products.json`,
        { method: 'POST', body: productPayload }
      );
    }

    if (!res.ok) {
      const errMsg =
        res.data?.errors ? JSON.stringify(res.data.errors) : `HTTP ${res.status}: Failed to sync product.`;
      return { success: false, error: errMsg };
    }

    const createdProduct = res.data?.product;
    const productId = createdProduct?.id ? String(createdProduct.id) : (item.shopifyProductId ? String(item.shopifyProductId) : undefined);
    const variant = createdProduct?.variants?.[0];
    const variantId = variant?.id ? String(variant.id) : (item.shopifyVariantId ? String(item.shopifyVariantId) : undefined);
    const inventoryItemId = variant?.inventory_item_id ? String(variant.inventory_item_id) : undefined;

    // 1. Explicitly update Variant to ensure Price & SKU are registered in Shopify
    if (variantId) {
      try {
        await callShopifyProxy(
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
              },
            },
          }
        );
      } catch (varErr) {
        console.warn('Variant price update error on Shopify:', varErr);
      }
    }

    // 2. Set Available Stock Level at Primary Store Location
    if (inventoryItemId) {
      try {
        const locationId = await getShopifyPrimaryLocationId(config);
        if (locationId) {
          await callShopifyProxy(
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
        }
      } catch (invErr) {
        console.warn('Inventory level set error on Shopify:', invErr);
      }

      // 3. Set Cost on Inventory Item if buyingPrice exists
      if (buyingPrice > 0) {
        try {
          await callShopifyProxy(
            config,
            `/admin/api/${config.apiVersion}/inventory_items/${inventoryItemId}.json`,
            {
              method: 'PUT',
              body: {
                inventory_item: {
                  id: Number(inventoryItemId),
                  cost: buyingPrice.toFixed(2),
                  tracked: true,
                },
              },
            }
          );
        } catch (costErr) {
          console.warn('Cost price set error on Shopify:', costErr);
        }
      }
    }

    // 4. If updating an existing product and Shopify didn't have the image yet, upload it
    if (productId && imagePayload && item.shopifyProductId) {
      const existingImages = createdProduct?.images || [];
      if (existingImages.length === 0) {
        try {
          await callShopifyProxy(
            config,
            `/admin/api/${config.apiVersion}/products/${productId}/images.json`,
            {
              method: 'POST',
              body: { image: imagePayload },
            }
          );
        } catch (imgErr) {
          console.warn('Failed attaching product image on Shopify:', imgErr);
        }
      }
    }

    return {
      success: true,
      shopifyProductId: productId,
      shopifyVariantId: variantId,
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
