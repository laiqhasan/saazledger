-- SAAZ LEDGER ENTERPRISE POSTGRESQL SCHEMA
-- Authoritative, transactional relational database for Atelier OS

-- 1. Users and RBAC
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(64) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(128) NOT NULL,
  role VARCHAR(32) NOT NULL CHECK(role IN ('admin', 'catalogue', 'inventory', 'finance', 'viewer')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Master Coding Reference
CREATE TABLE IF NOT EXISTS code_reference (
  category VARCHAR(32) NOT NULL CHECK(category IN ('types', 'stones', 'colors')),
  code VARCHAR(32) NOT NULL,
  label VARCHAR(128) NOT NULL,
  description TEXT,
  display_order INTEGER DEFAULT 0,
  PRIMARY KEY (category, code)
);

-- 3. Global 5-Digit SKU Sequence
CREATE TABLE IF NOT EXISTS global_sku_sequence (
  id VARCHAR(32) PRIMARY KEY,
  current_serial INTEGER NOT NULL DEFAULT 0,
  is_initialized BOOLEAN NOT NULL DEFAULT FALSE,
  starting_serial INTEGER NOT NULL DEFAULT 1,
  locked_at TIMESTAMP WITH TIME ZONE,
  initialized_at TIMESTAMP WITH TIME ZONE,
  initialized_by VARCHAR(64)
);

-- 4. Legacy Combination Sequence (V1 backwards compatibility)
CREATE TABLE IF NOT EXISTS sku_sequences (
  type_code VARCHAR(16) NOT NULL,
  stone_code VARCHAR(16) NOT NULL,
  color_code VARCHAR(16) NOT NULL,
  last_serial INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (type_code, stone_code, color_code)
);

-- 5. Artisans & Vendors Master
CREATE TABLE IF NOT EXISTS vendors (
  id VARCHAR(64) PRIMARY KEY,
  code VARCHAR(32) UNIQUE NOT NULL,
  name VARCHAR(128) NOT NULL,
  contact_person VARCHAR(128),
  phone VARCHAR(32),
  email VARCHAR(128),
  city VARCHAR(64),
  address TEXT,
  gstin VARCHAR(32),
  specialty VARCHAR(128),
  lead_time_days INTEGER DEFAULT 10,
  payment_terms VARCHAR(64) DEFAULT 'Net 15',
  rating INTEGER DEFAULT 5,
  status VARCHAR(16) DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Products Table
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category_code VARCHAR(32),
  status VARCHAR(32) DEFAULT 'active' CHECK(status IN ('draft', 'active', 'archived', 'discontinued')),
  created_by VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. Product Variants (Commercial Identities)
CREATE TABLE IF NOT EXISTS product_variants (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(64) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku VARCHAR(64) UNIQUE NOT NULL,
  global_serial INTEGER UNIQUE,
  sku_format_version VARCHAR(8) NOT NULL DEFAULT 'V2' CHECK(sku_format_version IN ('V1', 'V2')),
  type_code VARCHAR(16) NOT NULL,
  stone_code VARCHAR(16) NOT NULL,
  color_code VARCHAR(16) NOT NULL,
  serial_number VARCHAR(16) NOT NULL,
  barcode VARCHAR(64),
  buying_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 3,
  vendor_id VARCHAR(64) REFERENCES vendors(id) ON DELETE SET NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. Master Items (Compatibility Layer)
CREATE TABLE IF NOT EXISTS items (
  id VARCHAR(64) PRIMARY KEY,
  sku VARCHAR(64) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  type_code VARCHAR(16) NOT NULL,
  stone_code VARCHAR(16) NOT NULL,
  color_code VARCHAR(16) NOT NULL,
  serial VARCHAR(16) NOT NULL,
  buying_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  reorder_level INTEGER NOT NULL DEFAULT 3,
  vendor_id VARCHAR(64) REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name VARCHAR(128),
  notes TEXT,
  image_url TEXT,
  image_hash VARCHAR(128),
  date_added VARCHAR(32) NOT NULL,
  last_restocked VARCHAR(32),
  safety_reserve INTEGER DEFAULT 0 CHECK(safety_reserve >= 0),
  is_listed_on_shopify BOOLEAN DEFAULT TRUE,
  shopify_product_id VARCHAR(64),
  shopify_variant_id VARCHAR(64),
  shopify_synced_at VARCHAR(32),
  is_listed_on_amazon BOOLEAN DEFAULT FALSE,
  amazon_asin VARCHAR(64),
  amazon_sku VARCHAR(64),
  is_listed_on_myntra BOOLEAN DEFAULT FALSE,
  myntra_style_id VARCHAR(64),
  myntra_sku VARCHAR(64),
  confirmed_attributes TEXT,
  ai_suggestions TEXT,
  sku_format_version VARCHAR(8) DEFAULT 'V1',
  global_serial INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
CREATE INDEX IF NOT EXISTS idx_items_combo ON items(type_code, stone_code, color_code);
CREATE INDEX IF NOT EXISTS idx_items_vendor ON items(vendor_id);

-- 9. Inventory Locations
CREATE TABLE IF NOT EXISTS inventory_locations (
  id VARCHAR(64) PRIMARY KEY,
  code VARCHAR(32) UNIQUE NOT NULL,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(32) NOT NULL CHECK(type IN ('vault', 'boutique', 'damaged_hold', 'in_transit')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- 10. Inventory Balances (Multi-State Stock)
CREATE TABLE IF NOT EXISTS inventory_balances (
  id VARCHAR(64) PRIMARY KEY,
  location_id VARCHAR(64) NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  variant_id VARCHAR(64) NOT NULL,
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
  available INTEGER NOT NULL DEFAULT 0 CHECK(available >= 0),
  committed INTEGER NOT NULL DEFAULT 0 CHECK(committed >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  damaged INTEGER NOT NULL DEFAULT 0 CHECK(damaged >= 0),
  safety_stock INTEGER NOT NULL DEFAULT 0 CHECK(safety_stock >= 0),
  incoming INTEGER NOT NULL DEFAULT 0 CHECK(incoming >= 0),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(location_id, variant_id)
);

-- 11. Append-Only Inventory Movements
CREATE TABLE IF NOT EXISTS inventory_movements (
  id VARCHAR(64) PRIMARY KEY,
  variant_id VARCHAR(64) NOT NULL,
  location_id VARCHAR(64) NOT NULL REFERENCES inventory_locations(id),
  movement_type VARCHAR(32) NOT NULL CHECK(movement_type IN (
    'PURCHASE_RECEIPT',
    'SALE_COMMITMENT',
    'SALE_FULFILMENT',
    'SALE_RELEASE',
    'CUSTOMER_RETURN',
    'DAMAGED_RETURN',
    'MANUAL_ADJUSTMENT',
    'STOCKTAKE_CORRECTION',
    'CHANNEL_RESERVATION',
    'TRANSFER'
  )),
  quantity INTEGER NOT NULL,
  reference_type VARCHAR(32),
  reference_id VARCHAR(64),
  before_balance INTEGER NOT NULL,
  after_balance INTEGER NOT NULL,
  unit_cost NUMERIC(12, 2),
  notes TEXT,
  created_by VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_movements_variant ON inventory_movements(variant_id);
CREATE INDEX IF NOT EXISTS idx_movements_type ON inventory_movements(movement_type);

-- 12. Omnichannel Allocations
CREATE TABLE IF NOT EXISTS channel_allocations (
  id VARCHAR(64) PRIMARY KEY,
  variant_id VARCHAR(64) NOT NULL,
  channel VARCHAR(32) NOT NULL CHECK(channel IN ('shopify', 'amazon', 'myntra', 'offline')),
  allocated_qty INTEGER NOT NULL DEFAULT 0 CHECK(allocated_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK(reserved_qty >= 0),
  sync_status VARCHAR(32) DEFAULT 'in_sync' CHECK(sync_status IN ('in_sync', 'pending', 'failed')),
  last_synced_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(variant_id, channel)
);

-- 13. Purchase Orders
CREATE TABLE IF NOT EXISTS purchase_orders (
  id VARCHAR(64) PRIMARY KEY,
  po_number VARCHAR(32) UNIQUE NOT NULL,
  vendor_id VARCHAR(64) NOT NULL REFERENCES vendors(id),
  status VARCHAR(32) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'sent', 'partially_received', 'received', 'cancelled')),
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  expected_date DATE,
  notes TEXT,
  created_by VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 14. Purchase Order Lines
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id VARCHAR(64) PRIMARY KEY,
  po_id VARCHAR(64) NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id VARCHAR(64) NOT NULL,
  quantity_ordered INTEGER NOT NULL CHECK(quantity_ordered > 0),
  quantity_received INTEGER NOT NULL DEFAULT 0 CHECK(quantity_received >= 0),
  unit_cost NUMERIC(12, 2) NOT NULL CHECK(unit_cost >= 0),
  notes TEXT
);

-- 15. Purchase Lots (FIFO Cost Tracking)
CREATE TABLE IF NOT EXISTS purchase_lots (
  id VARCHAR(64) PRIMARY KEY,
  lot_number VARCHAR(64) UNIQUE NOT NULL,
  item_id VARCHAR(64) NOT NULL,
  variant_id VARCHAR(64),
  vendor_id VARCHAR(64) REFERENCES vendors(id) ON DELETE SET NULL,
  po_id VARCHAR(64) REFERENCES purchase_orders(id) ON DELETE SET NULL,
  quantity_received INTEGER NOT NULL CHECK(quantity_received > 0),
  quantity_remaining INTEGER NOT NULL CHECK(quantity_remaining >= 0),
  unit_cost NUMERIC(12, 2) NOT NULL CHECK(unit_cost >= 0),
  received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lots_item ON purchase_lots(item_id);

-- 16. Orders & Order Lines
CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(64) PRIMARY KEY,
  order_number VARCHAR(64) UNIQUE NOT NULL,
  channel VARCHAR(32) NOT NULL CHECK(channel IN ('shopify', 'amazon', 'myntra', 'manual', 'boutique')),
  channel_order_id VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'paid' CHECK(status IN ('paid', 'authorized', 'cod', 'cancelled', 'refunded', 'fulfilled')),
  customer_name VARCHAR(128),
  customer_email VARCHAR(128),
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_lines (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id VARCHAR(64) NOT NULL,
  sku VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
  realized_profit NUMERIC(12, 2) NOT NULL DEFAULT 0
);

-- 17. Durable Integration Order Events
CREATE TABLE IF NOT EXISTS order_events (
  id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(128) UNIQUE,
  channel VARCHAR(32) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  raw_payload TEXT NOT NULL,
  processing_status VARCHAR(32) NOT NULL CHECK(processing_status IN ('pending', 'processed', 'ignored', 'failed')),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 18. Media Assets
CREATE TABLE IF NOT EXISTS media_assets (
  id VARCHAR(64) PRIMARY KEY,
  original_filename VARCHAR(255) NOT NULL,
  display_title VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  byte_size BIGINT NOT NULL,
  checksum_sha256 VARCHAR(64) NOT NULL,
  perceptual_hash VARCHAR(64),
  width INTEGER,
  height INTEGER,
  duration_seconds NUMERIC(8, 2),
  upload_source VARCHAR(64) DEFAULT 'web_upload',
  uploader_id VARCHAR(64),
  media_type VARCHAR(32) DEFAULT 'image' CHECK(media_type IN ('image', 'video', 'document')),
  classification VARCHAR(32) DEFAULT 'original' CHECK(classification IN ('original', 'edited', 'ai_generated', 'derivative')),
  processing_status VARCHAR(32) DEFAULT 'ready' CHECK(processing_status IN ('pending', 'uploading', 'verifying', 'processing', 'ready', 'failed')),
  approval_status VARCHAR(32) DEFAULT 'approved' CHECK(approval_status IN ('pending_review', 'approved', 'rejected')),
  is_deleted INTEGER DEFAULT 0,
  deleted_at TIMESTAMP WITH TIME ZONE,
  deleted_by VARCHAR(64),
  parent_media_id VARCHAR(64) REFERENCES media_assets(id) ON DELETE SET NULL,
  processing_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_hash ON media_assets(checksum_sha256);

-- 19. Media Storage Locations
CREATE TABLE IF NOT EXISTS media_storage_locations (
  id VARCHAR(64) PRIMARY KEY,
  media_id VARCHAR(64) NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL CHECK(provider IN ('s3', 'google_drive', 'local_disk')),
  storage_role VARCHAR(32) NOT NULL CHECK(storage_role IN ('primary', 'backup', 'derivative_thumb', 'derivative_optimized')),
  storage_key TEXT NOT NULL,
  bucket_or_drive_id VARCHAR(128),
  version_id VARCHAR(128),
  etag VARCHAR(128),
  public_delivery_url TEXT,
  replication_status VARCHAR(32) DEFAULT 'synced' CHECK(replication_status IN ('synced', 'pending', 'failed', 'not_applicable')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 20. Product Media Relationships
CREATE TABLE IF NOT EXISTS product_media_links (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(64) NOT NULL,
  media_id VARCHAR(64) NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  slot_type VARCHAR(32) NOT NULL CHECK(slot_type IN ('cover', 'front', 'back', 'close_up', 'model', 'packaging', 'video', 'gallery')),
  display_order INTEGER DEFAULT 0,
  alt_text VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(product_id, media_id, slot_type)
);

-- 21. Shopify Media Mappings
CREATE TABLE IF NOT EXISTS shopify_media_mappings (
  id VARCHAR(64) PRIMARY KEY,
  media_id VARCHAR(64) NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  shopify_media_id VARCHAR(64) NOT NULL,
  shopify_image_url TEXT,
  source_checksum VARCHAR(64) NOT NULL,
  sync_status VARCHAR(32) DEFAULT 'synced' CHECK(sync_status IN ('synced', 'pending', 'failed')),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 22. Background Media Processing Jobs
CREATE TABLE IF NOT EXISTS media_processing_jobs (
  id VARCHAR(64) PRIMARY KEY,
  media_id VARCHAR(64) NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  job_type VARCHAR(32) NOT NULL CHECK(job_type IN ('derivative_generation', 'backup_replication', 'perceptual_hash', 'ai_vision_tagging')),
  status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE
);

-- 23. Attribute Provenance
CREATE TABLE IF NOT EXISTS attribute_provenances (
  id VARCHAR(64) PRIMARY KEY,
  variant_id VARCHAR(64) NOT NULL,
  attribute_name VARCHAR(64) NOT NULL,
  attribute_value TEXT NOT NULL,
  source VARCHAR(32) NOT NULL CHECK(source IN ('AI_OBSERVATION', 'USER_CONFIRMED', 'SUPPLIER_CONFIRMED', 'DOCUMENT_CONFIRMED', 'MEASURED')),
  verification_status VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_status IN ('UNVERIFIED', 'CONFIRMED', 'REJECTED')),
  verified_by VARCHAR(64),
  verified_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 24. Needs Attention Items (Exception Hub)
CREATE TABLE IF NOT EXISTS needs_attention_items (
  id VARCHAR(64) PRIMARY KEY,
  category VARCHAR(32) NOT NULL CHECK(category IN ('order', 'inventory', 'sku', 'media', 'attribute', 'supplier')),
  severity VARCHAR(16) NOT NULL CHECK(severity IN ('critical', 'warning', 'info')),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  reference_type VARCHAR(32),
  reference_id VARCHAR(64),
  is_resolved BOOLEAN DEFAULT FALSE,
  resolved_by VARCHAR(64),
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 25. Durable Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  actor VARCHAR(128) NOT NULL,
  action VARCHAR(64) NOT NULL,
  affected_record VARCHAR(64) NOT NULL,
  before_state TEXT,
  after_state TEXT,
  reason TEXT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 26. App Settings
CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(64) PRIMARY KEY,
  value TEXT NOT NULL,
  is_secret BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
