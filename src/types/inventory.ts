export interface CodeReferenceItem {
  code: string;
  label: string;
  description?: string;
}

export interface CodeTables {
  types: CodeReferenceItem[];
  stones: CodeReferenceItem[];
  colors: CodeReferenceItem[];
}

export interface JewelryItem {
  id: string;
  sku: string; // e.g. PDJ12001
  title: string;
  typeCode: string;
  stoneCode: string;
  colorCode: string;
  serial: string; // '001', '002', etc.
  buyingPrice: number; // Cost Price
  sellingPrice: number; // Retail Price
  quantity: number;
  reorderLevel: number;
  vendor: string;
  notes?: string;
  imageUrl?: string;
  imageHash?: string;
  dateAdded: string;
  lastRestocked?: string;
  shopifyProductId?: string;
  shopifyVariantId?: string;
  shopifySyncedAt?: string;
  // Multi-Channel Marketplace Attributes
  isListedOnShopify?: boolean;
  isListedOnAmazon?: boolean;
  amazonAsin?: string;
  amazonSku?: string;
  isListedOnMyntra?: boolean;
  myntraStyleId?: string;
  myntraSku?: string;
  safetyReserve?: number; // Minimum buffer units held back from marketplaces
  channelAllocations?: {
    shopify?: number;
    amazon?: number;
    myntra?: number;
    boutique?: number;
  };
}

export interface DuplicateCheckResult {
  status: 'clean' | 'exact_sku_conflict' | 'combo_match' | 'image_match';
  conflictingItem?: JewelryItem;
  message?: string;
  suggestedSerial?: string;
  suggestedSku?: string;
  matchScore?: number;
}

export type InventoryFilter =
  | 'all'
  | 'in_stock'
  | 'low_stock'
  | 'out_of_stock'
  | 'shopify'
  | 'amazon'
  | 'myntra';
export type SortField = 'dateAdded' | 'sku' | 'quantity' | 'margin' | 'retailValue';
export type SortOrder = 'asc' | 'desc';

export type TagPrintLayout = 'dumbbell' | 'price_sticker' | 'sheet_grid';

export interface StockMovement {
  id: string;
  itemId: string;
  sku: string;
  itemTitle: string;
  type: 'sale' | 'restock' | 'adjustment';
  quantityDelta: number; // negative for sales, positive for restock
  unitPrice: number;
  totalPrice: number;
  costPrice: number;
  realizedProfit: number;
  channel?: string; // 'Retail Store' | 'Online / Instagram' | 'Exhibition' | 'Wholesale' | 'Direct'
  timestamp: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Shopify Integration Types
// ---------------------------------------------------------------------------
export interface ShopifyConfig {
  shopDomain: string; // e.g. "saaz-jewels.myshopify.com"
  adminAccessToken: string; // "shpat_..."
  apiVersion: string; // "2024-07", "2024-10", "2025-01"
  defaultStatus: 'draft' | 'active';
  isConnected: boolean;
  shopName?: string;
  email?: string;
  currency?: string;
  lastSyncTimestamp?: string;
}

export interface ShopifySyncResult {
  success: boolean;
  totalProcessed: number;
  createdCount: number;
  updatedCount: number;
  failedCount: number;
  errors: string[];
}

export interface ShopifyOrderLineItem {
  id: number;
  title: string;
  quantity: number;
  sku: string;
  price: string;
  variant_id?: number;
}

export interface ShopifyOrder {
  id: number;
  name: string; // e.g. "#1001"
  created_at: string;
  financial_status: string; // "paid", "pending", etc.
  total_price: string;
  customer?: {
    first_name?: string;
    last_name?: string;
    email?: string;
  };
  line_items: ShopifyOrderLineItem[];
}

export interface OrderSyncSummary {
  ordersFetched: number;
  newOrdersProcessed: number;
  itemsDeductedCount: number;
  loggedSalesTotal: number;
  details: string[];
}

export type MarketplaceChannel = 'shopify' | 'amazon' | 'myntra' | 'boutique' | 'exhibition';

export interface VendorItem {
  id: string;
  code: string; // e.g. "ACJ", "RZC", "SSI"
  name: string; // Artisan or Workshop name
  contactPerson?: string; // e.g. "Vikram Sharma"
  phone?: string; // WhatsApp / Phone number
  email?: string;
  city?: string; // e.g. "Jaipur", "Surat", "Mumbai"
  address?: string;
  gstin?: string; // Tax ID
  specialty?: string; // e.g. "Kundan & Meenakari", "Polki Jadau", "CZ & Brass Casting"
  leadTimeDays?: number; // Estimated days for batch restocking
  paymentTerms?: string; // e.g. "Consignment", "Net 15", "50% Advance", "Immediate"
  rating?: number; // 1 to 5 stars
  status: 'active' | 'inactive';
  notes?: string;
  createdAt: string;
}

export interface VendorPerformanceMetrics {
  vendorId: string;
  totalPiecesSupplied: number;
  inStockUnits: number;
  costValuation: number;
  retailValuation: number;
  realizedSalesUnits: number;
  realizedSalesRevenue: number;
  realizedGrossProfit: number;
  lowStockItemCount: number;
  averageMarginPercent: number;
}
