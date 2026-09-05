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

-- 12. Media Assets (Enterprise Cloud Media Library)
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  original_filename TEXT NOT NULL,
  display_title TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL UNIQUE,
  perceptual_hash TEXT,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  upload_source TEXT NOT NULL CHECK(upload_source IN ('web_upload', 'google_drive_import', 'camera_capture', 'migration')),
  uploader_id TEXT REFERENCES users(id),
  media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video', 'document')),
  classification TEXT NOT NULL CHECK(classification IN ('original', 'edited', 'ai_generated', 'derivative')),
  processing_status TEXT NOT NULL CHECK(processing_status IN ('pending', 'uploading', 'verifying', 'processing', 'ready', 'failed')),
  approval_status TEXT NOT NULL CHECK(approval_status IN ('pending_review', 'approved', 'rejected')),
  is_deleted INTEGER DEFAULT 0,
  deleted_at DATETIME,
  deleted_by TEXT,
  parent_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  processing_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_checksum ON media_assets(checksum_sha256);
CREATE INDEX IF NOT EXISTS idx_media_status ON media_assets(processing_status, approval_status, is_deleted);
CREATE INDEX IF NOT EXISTS idx_media_type ON media_assets(media_type);

-- 13. Physical Media Storage Locations
CREATE TABLE IF NOT EXISTS media_storage_locations (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('s3', 'google_drive', 'local_disk')),
  storage_role TEXT NOT NULL CHECK(storage_role IN ('primary', 'backup', 'derivative_thumb', 'derivative_optimized')),
  storage_key TEXT NOT NULL,
  bucket_or_drive_id TEXT,
  version_id TEXT,
  etag TEXT,
  public_delivery_url TEXT,
  replication_status TEXT NOT NULL CHECK(replication_status IN ('synced', 'pending', 'failed', 'not_applicable')),
  last_verified_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_storage_loc_media ON media_storage_locations(media_id, provider, storage_role);
CREATE INDEX IF NOT EXISTS idx_storage_loc_key ON media_storage_locations(storage_key);

-- 14. Product Media Links (Multi-Image & Variant Slot Allocations)
CREATE TABLE IF NOT EXISTS product_media_links (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  variant_id TEXT,
  media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  slot_type TEXT NOT NULL CHECK(slot_type IN ('cover', 'front', 'back', 'close_up', 'model', 'packaging', 'video', 'gallery')),
  display_order INTEGER NOT NULL DEFAULT 0,
  alt_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, media_id, slot_type)
);

CREATE INDEX IF NOT EXISTS idx_product_media_product ON product_media_links(product_id, display_order);
CREATE INDEX IF NOT EXISTS idx_product_media_media ON product_media_links(media_id);

-- 15. Shopify Media Remote Channel Tracking
CREATE TABLE IF NOT EXISTS shopify_media_mappings (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  shopify_product_id TEXT NOT NULL,
  shopify_media_id TEXT NOT NULL,
  shopify_image_url TEXT,
  source_checksum_sha256 TEXT NOT NULL,
  published_status TEXT NOT NULL CHECK(published_status IN ('staged', 'processing', 'published', 'failed', 'removed')),
  published_at DATETIME,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_shopify_media_remote ON shopify_media_mappings(shopify_product_id, shopify_media_id);

-- 16. Media Background Processing & Replication Queue
CREATE TABLE IF NOT EXISTS media_processing_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK(job_type IN ('generate_derivatives', 'replicate_backup', 'verify_checksum', 'ai_vision_analysis', 'shopify_publish', 'migration')),
  media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued', 'in_progress', 'completed', 'failed', 'cancelled')),
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  payload TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_processing_jobs(status, job_type);

-- 17. Global 5-Digit SKU Sequence Tracker
CREATE TABLE IF NOT EXISTS global_sku_sequence (
  id TEXT PRIMARY KEY,
  current_serial INTEGER NOT NULL DEFAULT 0,
  is_initialized INTEGER NOT NULL DEFAULT 0,
  starting_serial INTEGER NOT NULL DEFAULT 1,
  locked_at DATETIME,
  initialized_at DATETIME,
  initialized_by TEXT
);

-- 18. Normalized Products
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category_code TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('draft', 'active', 'archived', 'discontinued')),
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 19. Normalized Product Variants
CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT UNIQUE NOT NULL,
  global_serial INTEGER UNIQUE,
  sku_format_version TEXT NOT NULL DEFAULT 'V2' CHECK(sku_format_version IN ('V1', 'V2')),
  type_code TEXT NOT NULL,
  stone_code TEXT NOT NULL,
  color_code TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  barcode TEXT,
  buying_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 3,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 20. Inventory Locations
CREATE TABLE IF NOT EXISTS inventory_locations (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('vault', 'boutique', 'damaged_hold', 'in_transit')),
  is_active INTEGER NOT NULL DEFAULT 1
);

-- 21. Multi-State Inventory Balances
CREATE TABLE IF NOT EXISTS inventory_balances (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
  available INTEGER NOT NULL DEFAULT 0 CHECK(available >= 0),
  committed INTEGER NOT NULL DEFAULT 0 CHECK(committed >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  damaged INTEGER NOT NULL DEFAULT 0 CHECK(damaged >= 0),
  safety_stock INTEGER NOT NULL DEFAULT 0 CHECK(safety_stock >= 0),
  incoming INTEGER NOT NULL DEFAULT 0 CHECK(incoming >= 0),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(location_id, variant_id)
);

-- 21B. Append-Only Inventory Movements
CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  location_id TEXT NOT NULL REFERENCES inventory_locations(id),
  movement_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  before_balance INTEGER NOT NULL,
  after_balance INTEGER NOT NULL,
  unit_cost REAL,
  notes TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_movements_variant ON inventory_movements(variant_id);
CREATE INDEX IF NOT EXISTS idx_movements_type ON inventory_movements(movement_type);

-- 22. Omnichannel Allocations
CREATE TABLE IF NOT EXISTS channel_allocations (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('shopify', 'amazon', 'myntra', 'offline')),
  allocated_qty INTEGER NOT NULL DEFAULT 0 CHECK(allocated_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK(reserved_qty >= 0),
  sync_status TEXT DEFAULT 'in_sync' CHECK(sync_status IN ('in_sync', 'pending', 'failed')),
  last_synced_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(variant_id, channel)
);

-- 23. Purchase Orders
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  po_number TEXT UNIQUE NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'sent', 'partially_received', 'received', 'cancelled')),
  total_amount REAL NOT NULL DEFAULT 0,
  expected_date TEXT,
  notes TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 24. Purchase Order Lines
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  quantity_ordered INTEGER NOT NULL CHECK(quantity_ordered > 0),
  quantity_received INTEGER NOT NULL DEFAULT 0 CHECK(quantity_received >= 0),
  unit_cost REAL NOT NULL CHECK(unit_cost >= 0),
  notes TEXT
);

-- 25. Attribute Provenance
CREATE TABLE IF NOT EXISTS attribute_provenances (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  attribute_value TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('AI_OBSERVATION', 'USER_CONFIRMED', 'SUPPLIER_CONFIRMED', 'DOCUMENT_CONFIRMED', 'MEASURED')),
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_status IN ('UNVERIFIED', 'CONFIRMED', 'REJECTED')),
  verified_by TEXT,
  verified_at DATETIME,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 26. Operational Needs Attention Items
CREATE TABLE IF NOT EXISTS needs_attention_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('order', 'inventory', 'sku', 'media', 'attribute', 'supplier')),
  severity TEXT NOT NULL CHECK(severity IN ('critical', 'warning', 'info')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  is_resolved INTEGER DEFAULT 0,
  resolved_by TEXT,
  resolved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


