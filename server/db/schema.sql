-- SAAZ LEDGER DATABASE SCHEMA (SQLite WAL Mode)
PRAGMA foreign_keys = ON;

-- 1. Users and RBAC
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'clerk')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Master Coding Reference
CREATE TABLE IF NOT EXISTS code_reference (
  category TEXT NOT NULL CHECK(category IN ('types', 'stones', 'colors')),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  display_order INTEGER DEFAULT 0,
  PRIMARY KEY (category, code)
);

-- 3. Atomic SKU Sequence Tracking (Prevents duplicate serials in concurrent environments)
CREATE TABLE IF NOT EXISTS sku_sequences (
  type_code TEXT NOT NULL,
  stone_code TEXT NOT NULL,
  color_code TEXT NOT NULL,
  last_serial INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type_code, stone_code, color_code)
);

-- 4. Artisans & Vendors Master
CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  city TEXT,
  address TEXT,
  gstin TEXT,
  specialty TEXT,
  lead_time_days INTEGER DEFAULT 10,
  payment_terms TEXT DEFAULT 'Net 15',
  rating INTEGER DEFAULT 5,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. Master Inventory Items
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  type_code TEXT NOT NULL,
  stone_code TEXT NOT NULL,
  color_code TEXT NOT NULL,
  serial TEXT NOT NULL,
  buying_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 3,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name TEXT,
  notes TEXT,
  image_url TEXT,
  image_hash TEXT,
  date_added TEXT NOT NULL,
  last_restocked TEXT,
  safety_reserve INTEGER DEFAULT 0 CHECK(safety_reserve >= 0),
  is_listed_on_shopify INTEGER DEFAULT 1,
  shopify_product_id TEXT,
  shopify_variant_id TEXT,
  shopify_synced_at TEXT,
  is_listed_on_amazon INTEGER DEFAULT 0,
  amazon_asin TEXT,
  amazon_sku TEXT,
  is_listed_on_myntra INTEGER DEFAULT 0,
  myntra_style_id TEXT,
  myntra_sku TEXT,
  confirmed_attributes TEXT, -- JSON verified attributes (e.g. {"metalPurity":"Brass Micro-Plated","tested":true})
  ai_suggestions TEXT,       -- JSON AI detected attributes without overwriting confirmed facts
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
CREATE INDEX IF NOT EXISTS idx_items_combo ON items(type_code, stone_code, color_code);
CREATE INDEX IF NOT EXISTS idx_items_vendor ON items(vendor_id);

-- 6. SKU Aliases & External Channel Barcodes
CREATE TABLE IF NOT EXISTS sku_aliases (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  alias_sku TEXT UNIQUE NOT NULL,
  channel TEXT NOT NULL, -- 'amazon', 'myntra', 'shopify', 'fnsku', 'legacy'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_aliases_alias ON sku_aliases(alias_sku);

-- 7. Receipt-Level Purchase Lots & Cost Tracking (FIFO Inventory Engine)
CREATE TABLE IF NOT EXISTS purchase_lots (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  batch_ref TEXT,
  received_date TEXT NOT NULL,
  quantity_received INTEGER NOT NULL CHECK(quantity_received >= 0),
  quantity_remaining INTEGER NOT NULL CHECK(quantity_remaining >= 0),
  unit_cost REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lots_item_remaining ON purchase_lots(item_id, quantity_remaining);

-- 8. Append-Only Stock Movements & Financial Ledger
CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  item_title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('sale', 'restock', 'adjustment', 'return', 'cancellation', 'scrap')),
  quantity_delta INTEGER NOT NULL,
  unit_price REAL DEFAULT 0,
  total_price REAL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  realized_profit REAL DEFAULT 0,
  channel TEXT,
  external_order_id TEXT,
  notes TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_movements_item ON stock_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_movements_type ON stock_movements(type);
CREATE INDEX IF NOT EXISTS idx_movements_timestamp ON stock_movements(timestamp);

-- 9. Durable Order Events & Webhook Reconciliation
CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('shopify', 'amazon', 'myntra', 'pos')),
  external_order_id TEXT NOT NULL,
  external_line_id TEXT,
  event_type TEXT NOT NULL, -- 'order_placed', 'order_edited', 'order_cancelled', 'refund_created', 'return_inspected'
  status TEXT NOT NULL CHECK(status IN ('pending', 'processed', 'ignored', 'failed')),
  payload TEXT NOT NULL,
  processed_at DATETIME,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, external_order_id, external_line_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_order_events_dedup ON order_events(source, external_order_id, external_line_id, event_type);

-- 10. Immutable Audit Trail
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  prev_state TEXT,
  new_state TEXT,
  ip_address TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 11. Secure System Settings & Encrypted Vault
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  is_secret INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
