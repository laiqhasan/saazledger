import type { JewelryItem } from '../types/inventory';

/**
 * Amazon Seller Central: Flat File Inventory Loader CSV format
 * Used by Amazon merchants to bulk-update price and inventory levels across ASINs/SKUs.
 */
export function generateAmazonInventoryCsv(items: JewelryItem[]): string {
  const headers = [
    'sku',
    'price',
    'minimum-seller-allowed-price',
    'maximum-seller-allowed-price',
    'quantity',
    'leadtime-to-ship',
    'fulfillment-channel',
  ];

  const rows = items.map((item) => {
    const effectiveStock = Math.max(0, item.quantity - (item.safetyReserve || 0));
    const minPrice = (item.sellingPrice * 0.85).toFixed(2);
    const maxPrice = (item.sellingPrice * 1.3).toFixed(2);

    return [
      `"${item.amazonSku || item.sku}"`,
      item.sellingPrice.toFixed(2),
      minPrice,
      maxPrice,
      effectiveStock,
      '2', // 2 days handling time standard
      'DEFAULT', // Merchant Fulfilled
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Myntra Partner Portal: Stock & Price Manifest CSV format
 * Used by Indian fashion sellers to update inventory and MRPs across style IDs.
 */
export function generateMyntraStockManifestCsv(items: JewelryItem[]): string {
  const headers = [
    'Style ID',
    'Seller SKU',
    'Product Title',
    'Size',
    'Physical Stock',
    'Safety Reserve',
    'Allocated for Myntra',
    'MRP (INR)',
    'Listing Price (INR)',
  ];

  const rows = items.map((item) => {
    const effectiveStock = Math.max(0, item.quantity - (item.safetyReserve || 0));
    const myntraStyleId = item.myntraStyleId || `MYN-${item.typeCode}-${item.serial}`;
    const mrp = (item.sellingPrice * 1.35).toFixed(0);

    return [
      `"${myntraStyleId}"`,
      `"${item.myntraSku || item.sku}"`,
      `"${item.title.replace(/"/g, '""')}"`,
      '"Free Size"',
      item.quantity,
      item.safetyReserve || 0,
      effectiveStock,
      mrp,
      item.sellingPrice.toFixed(0),
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Calculates marketplace breakdown metrics
 */
export function calculateMarketplaceDistribution(items: JewelryItem[]) {
  let shopifyCount = 0;
  let amazonCount = 0;
  let myntraCount = 0;
  let totalReserveUnits = 0;
  let totalInventoryUnits = 0;

  for (const item of items) {
    totalInventoryUnits += item.quantity;
    totalReserveUnits += item.safetyReserve || 0;

    if (item.shopifyProductId || item.isListedOnShopify !== false) {
      shopifyCount++;
    }
    if (item.isListedOnAmazon || item.amazonAsin) {
      amazonCount++;
    }
    if (item.isListedOnMyntra || item.myntraStyleId) {
      myntraCount++;
    }
  }

  return {
    totalPieces: items.length,
    totalInventoryUnits,
    totalReserveUnits,
    availableForSale: Math.max(0, totalInventoryUnits - totalReserveUnits),
    shopifyCount,
    amazonCount,
    myntraCount,
  };
}
