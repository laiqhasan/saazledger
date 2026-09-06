import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import { db } from './database';
import { DEFAULT_CODE_TABLES, INITIAL_INVENTORY } from '../../src/services/initialData';
import { DEFAULT_VENDORS } from '../../src/services/vendorService';

export function runInitialMigrations(database: Database.Database = db): void {
  // 1. Seed Master Users
  const userCount = database.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (userCount.count === 0) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync('admin123', salt);
    database.prepare(`
      INSERT INTO users (id, username, password_hash, full_name, role)
      VALUES (?, ?, ?, ?, ?)
    `).run('usr_admin_root', 'admin', hash, 'Atelier Director', 'admin');

    const clerkHash = bcrypt.hashSync('clerk123', salt);
    database.prepare(`
      INSERT INTO users (id, username, password_hash, full_name, role)
      VALUES (?, ?, ?, ?, ?)
    `).run('usr_clerk_1', 'salesclerk', clerkHash, 'Boutique Sales Clerk', 'clerk');
  }

  // Migration: Ensure 'status', 'approved_by', 'approved_at' columns exist in users table
  try {
    const tableInfo = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    const columnNames = tableInfo.map((col) => col.name);

    if (!columnNames.includes('status')) {
      database.prepare("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'").run();
    }
    if (!columnNames.includes('approved_by')) {
      database.prepare("ALTER TABLE users ADD COLUMN approved_by TEXT").run();
    }
    if (!columnNames.includes('approved_at')) {
      database.prepare("ALTER TABLE users ADD COLUMN approved_at DATETIME").run();
    }
  } catch (err) {
    console.error('Failed to run users table column migration:', err);
  }

  // Ensure Main Super Admin hasan.laiq@gmail.com is configured and active
  try {
    const mainAdmin = database.prepare("SELECT * FROM users WHERE email = 'hasan.laiq@gmail.com'").get() as any;
    if (!mainAdmin) {
      database.prepare(`
        INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, status, email, auth_provider)
        VALUES ('usr_admin_hasan', 'hasan_laiq', 'GOOGLE_OAUTH', 'Laiq Hasan', 'admin', 'active', 'hasan.laiq@gmail.com', 'google')
      `).run();
    } else {
      database.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?").run(mainAdmin.id);
    }

    // Pre-seed Google OAuth Client ID
    database.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('google_oauth_client_id', '319932828190-1891h3n974u85qm4g1lq75nm3bhj76tf.apps.googleusercontent.com', CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run();
  } catch {}

  // 2. Seed Master Code Tables
  const codeCount = database.prepare('SELECT COUNT(*) as count FROM code_reference').get() as { count: number };
  if (codeCount.count === 0) {
    const insertCode = database.prepare(`
      INSERT OR IGNORE INTO code_reference (category, code, label, description, display_order)
      VALUES (?, ?, ?, ?, ?)
    `);

    database.transaction(() => {
      DEFAULT_CODE_TABLES.types.forEach((t, i) => insertCode.run('types', t.code, t.label, t.description || '', i));
      DEFAULT_CODE_TABLES.stones.forEach((s, i) => insertCode.run('stones', s.code, s.label, s.description || '', i));
      DEFAULT_CODE_TABLES.colors.forEach((c, i) => insertCode.run('colors', c.code, c.label, c.description || '', i));
    })();
  }

  // 2B. Ensure Silver Plated (02) and Rhodium Plated (04) are distinct in master tables
  database.prepare(`
    UPDATE code_reference 
    SET label = 'Silver Plated', description = 'High-polish pure silver electroplated finish'
    WHERE category = 'colors' AND code = '02'
  `).run();
  database.prepare(`
    INSERT OR IGNORE INTO code_reference (category, code, label, description, display_order)
    VALUES ('colors', '04', 'Rhodium Plated', 'Bright white rhodium plating', 3)
  `).run();

  // 3. Seed Master Vendors
  const vendorCount = database.prepare('SELECT COUNT(*) as count FROM vendors').get() as { count: number };
  if (vendorCount.count === 0) {
    const insertVendor = database.prepare(`
      INSERT OR IGNORE INTO vendors (
        id, code, name, contact_person, phone, email, city, address, gstin, specialty, lead_time_days, payment_terms, rating, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    database.transaction(() => {
      for (const v of DEFAULT_VENDORS) {
        insertVendor.run(
          v.id,
          v.code,
          v.name,
          v.contactPerson || null,
          v.phone || null,
          v.email || null,
          v.city || null,
          v.address || null,
          v.gstin || null,
          v.specialty || null,
          v.leadTimeDays || 10,
          v.paymentTerms || 'Net 15',
          v.rating || 5,
          v.status || 'active',
          v.notes || null
        );
      }
    })();
  }

  // 4. Seed Initial Inventory Items & Purchase Lots if empty
  const itemCount = database.prepare('SELECT COUNT(*) as count FROM items').get() as { count: number };
  if (itemCount.count === 0) {
    const insertItem = database.prepare(`
      INSERT OR IGNORE INTO items (
        id, sku, title, type_code, stone_code, color_code, serial,
        buying_price, selling_price, quantity, reorder_level, vendor_name,
        notes, image_url, date_added, safety_reserve, is_listed_on_shopify
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertLot = database.prepare(`
      INSERT INTO purchase_lots (
        id, item_id, batch_ref, received_date, quantity_received, quantity_remaining, unit_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMovement = database.prepare(`
      INSERT INTO stock_movements (
        id, item_id, sku, item_title, type, quantity_delta, unit_price, total_price, cost_price, channel, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    database.transaction(() => {
      for (const item of INITIAL_INVENTORY) {
        insertItem.run(
          item.id,
          item.sku,
          item.title,
          item.typeCode,
          item.stoneCode,
          item.colorCode,
          item.serial,
          item.buyingPrice,
          item.sellingPrice,
          item.quantity,
          item.reorderLevel,
          item.vendor,
          item.notes || null,
          item.imageUrl || null,
          item.dateAdded,
          item.safetyReserve || 0,
          item.isListedOnShopify ? 1 : 0
        );

        // Create initial purchase lot for lot cost tracking
        insertLot.run(
          `lot_${item.id}_init`,
          item.id,
          'INIT_LOT_2026',
          item.dateAdded,
          item.quantity,
          item.quantity,
          item.buyingPrice
        );

        // Record initial intake stock movement
        insertMovement.run(
          `tx_init_${item.id}`,
          item.id,
          item.sku,
          item.title,
          'restock',
          item.quantity,
          item.buyingPrice,
          item.buyingPrice * item.quantity,
          item.buyingPrice,
          'Initial Intake',
          'Catalog initialization'
        );
      }
    })();
  }

  // 5. Re-synchronize sku_sequences from all existing items
  database.transaction(() => {
    database.prepare('DELETE FROM sku_sequences').run();
    const rows = database.prepare(`
      SELECT type_code, stone_code, color_code, MAX(CAST(serial AS INTEGER)) as max_serial
      FROM items
      GROUP BY type_code, stone_code, color_code
    `).all() as Array<{ type_code: string; stone_code: string; color_code: string; max_serial: number }>;

    const insertSeq = database.prepare(`
      INSERT INTO sku_sequences (type_code, stone_code, color_code, last_serial)
      VALUES (?, ?, ?, ?)
    `);

    for (const r of rows) {
      insertSeq.run(r.type_code, r.stone_code, r.color_code, r.max_serial || 0);
    }
  })();

  // 6. Seed Default Media Storage Configurations
  const defaultMediaSettings = [
    { key: 'media_primary_provider', value: 'local_disk', isSecret: 0 },
    { key: 'media_backup_enabled', value: '0', isSecret: 0 },
    { key: 'media_backup_provider', value: 'google_drive', isSecret: 0 },
    { key: 'media_s3_config', value: JSON.stringify({ bucket: '', region: 'ap-south-1', prefix: 'saaz-ledger/media', encryption: 'AES256', versioning: false }), isSecret: 1 },
    { key: 'media_gdrive_config', value: JSON.stringify({ folderId: '', sharedDrive: '', connectedEmail: '', tokenHealth: 'not_configured' }), isSecret: 1 },
  ];

  const insertSetting = database.prepare(`
    INSERT OR IGNORE INTO system_settings (key, value, is_secret)
    VALUES (?, ?, ?)
  `);

  for (const s of defaultMediaSettings) {
    insertSetting.run(s.key, s.value, s.isSecret);
  }

  // 7. Catalog Existing Product Photos into Media Library (Backward Compatibility)
  database.transaction(() => {
    const itemsWithPhotos = database.prepare(`
      SELECT id, sku, title, image_url, image_hash, created_at FROM items
      WHERE image_url IS NOT NULL AND image_url != ''
    `).all() as Array<{ id: string; sku: string; title: string; image_url: string; image_hash: string; created_at: string }>;

    for (const it of itemsWithPhotos) {
      const checksum = it.image_hash || `legacy_hash_${it.sku}`;
      const mediaId = `med_${it.id.replace('item-', '')}`;

      // Insert media asset if not already registered
      database.prepare(`
        INSERT OR IGNORE INTO media_assets (
          id, original_filename, display_title, mime_type, byte_size, checksum_sha256,
          upload_source, media_type, classification, processing_status, approval_status, created_at
        ) VALUES (
          ?, ?, ?, 'image/jpeg', 102400, ?, 'migration', 'image', 'original', 'ready', 'approved', ?
        )
      `).run(mediaId, `${it.sku}.jpg`, it.title, checksum, it.created_at || new Date().toISOString());

      // Register primary storage location
      database.prepare(`
        INSERT OR IGNORE INTO media_storage_locations (
          id, media_id, provider, storage_role, storage_key, public_delivery_url, replication_status
        ) VALUES (
          ?, ?, 'local_disk', 'primary', ?, ?, 'synced'
        )
      `).run(`loc_${mediaId}_prim`, mediaId, it.image_url, it.image_url);

      // Link to product as Cover image
      database.prepare(`
        INSERT OR IGNORE INTO product_media_links (
          id, product_id, media_id, slot_type, display_order, alt_text
        ) VALUES (
          ?, ?, ?, 'cover', 0, ?
        )
      `).run(`pml_${it.id}_${mediaId}`, it.id, mediaId, `${it.title} - Official Cover`);
    }
  })();

  // 7B. Alter schema to ensure optional columns exist on items and purchase_lots
  const safeAlter = (sql: string) => {
    try { database.prepare(sql).run(); } catch {}
  };
  safeAlter("ALTER TABLE items ADD COLUMN sku_format_version TEXT DEFAULT 'V1'");
  safeAlter("ALTER TABLE items ADD COLUMN global_serial INTEGER");
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN po_id TEXT");
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN variant_id TEXT");
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN lot_number TEXT");

  database.prepare(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY,
      variant_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
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
    )
  `).run();

  // 8. Seed Default Inventory Locations
  database.transaction(() => {
    const insertLoc = database.prepare(`
      INSERT OR IGNORE INTO inventory_locations (id, code, name, type, is_active)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertLoc.run('loc_main_vault', 'VAULT-01', 'Atelier Primary Vault', 'vault', 1);
    insertLoc.run('loc_boutique', 'BOUTIQUE-01', 'Boutique Flagship Floor', 'boutique', 1);
    insertLoc.run('loc_damaged', 'DAMAGED-HOLD', 'Quality & Damaged Hold', 'damaged_hold', 1);
  })();

  // 9. Initialize Global 5-Digit SKU Sequence
  database.transaction(() => {
    const existingCountRow = database.prepare('SELECT COUNT(*) as count FROM items').get() as { count: number };
    const seqRow = database.prepare('SELECT * FROM global_sku_sequence WHERE id = ?').get('global') as any;

    if (!seqRow) {
      const starting = existingCountRow.count + 1;
      database.prepare(`
        INSERT INTO global_sku_sequence (id, current_serial, is_initialized, starting_serial, initialized_at, initialized_by)
        VALUES ('global', ?, 1, ?, datetime('now'), 'system_auto_init')
      `).run(existingCountRow.count, starting);
    }
  })();

  // 10. Normalize Existing Items into Products, Product Variants & Inventory Balances
  database.transaction(() => {
    const allItems = database.prepare('SELECT * FROM items').all() as any[];

    for (const item of allItems) {
      // Products
      database.prepare(`
        INSERT OR IGNORE INTO products (id, title, description, category_code, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(item.id, item.title, item.notes || '', item.type_code, item.created_at || new Date().toISOString(), item.updated_at || new Date().toISOString());

      // Product Variants
      const variantId = `var_${item.id}`;
      database.prepare(`
        INSERT OR IGNORE INTO product_variants (
          id, product_id, sku, global_serial, sku_format_version,
          type_code, stone_code, color_code, serial_number, barcode,
          buying_price, selling_price, reorder_level, vendor_id, is_active, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'V1',
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, 1, ?, ?
        )
      `).run(
        variantId, item.id, item.sku, null,
        item.type_code, item.stone_code, item.color_code, item.serial, item.sku,
        item.buying_price, item.selling_price, item.reorder_level, item.vendor_id || null,
        item.created_at || new Date().toISOString(), item.updated_at || new Date().toISOString()
      );

      // Multi-State Inventory Balances
      const onHand = Number(item.quantity) || 0;
      const safetyStock = Number(item.safety_reserve) || 0;
      const available = Math.max(0, onHand - safetyStock);

      database.prepare(`
        INSERT OR REPLACE INTO inventory_balances (
          id, location_id, variant_id, on_hand, available, committed, reserved, damaged, safety_stock, incoming, updated_at
        ) VALUES (?, 'loc_main_vault', ?, ?, ?, 0, 0, 0, ?, 0, datetime('now'))
      `).run(`bal_${variantId}_vault`, variantId, onHand, available, safetyStock);

      // Channel Allocations
      database.prepare(`
        INSERT OR IGNORE INTO channel_allocations (id, variant_id, channel, allocated_qty, reserved_qty, sync_status)
        VALUES (?, ?, 'shopify', ?, 0, 'in_sync')
      `).run(`alloc_${variantId}_shopify`, variantId, available);

      database.prepare(`
        INSERT OR IGNORE INTO channel_allocations (id, variant_id, channel, allocated_qty, reserved_qty, sync_status)
        VALUES (?, ?, 'offline', ?, 0, 'in_sync')
      `).run(`alloc_${variantId}_offline`, variantId, safetyStock);
    }
  })();
}

// Run migrations on start
runInitialMigrations();

