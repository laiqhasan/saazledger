import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Persistent data directory (supports Railway Volumes or local fallback)
export const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.resolve(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const DB_PATH = path.join(DATA_DIR, 'saaz_ledger.db');

export function initDatabase(customPath?: string): Database.Database {
  const db = new Database(customPath || DB_PATH);

  // Performance and integrity pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('busy_timeout = 10000');

  // Load and apply schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);

  // Safe schema evolution
  const safeAlter = (sql: string) => {
    try { db.prepare(sql).run(); } catch {}
  };
  safeAlter("ALTER TABLE items ADD COLUMN sku_format_version TEXT DEFAULT 'V1'");
  safeAlter("ALTER TABLE items ADD COLUMN global_serial INTEGER");
  safeAlter("ALTER TABLE items ADD COLUMN is_deleted INTEGER DEFAULT 0");
  safeAlter("ALTER TABLE items ADD COLUMN deleted_at TEXT");
  safeAlter("ALTER TABLE items ADD COLUMN deleted_reason TEXT");
  safeAlter("CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(is_deleted)");
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN po_id TEXT");
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN variant_id TEXT");
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN lot_number TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN google_id TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN email TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN avatar_url TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'local'");
  safeAlter("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'");
  safeAlter("ALTER TABLE users ADD COLUMN approved_by TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN approved_at DATETIME");

  // Automated Shopify Listing Media Pack columns
  safeAlter("ALTER TABLE media_assets ADD COLUMN file_role TEXT DEFAULT 'gallery'");
  safeAlter("ALTER TABLE media_assets ADD COLUMN source_type TEXT DEFAULT 'original_upload'");
  safeAlter("ALTER TABLE media_assets ADD COLUMN quality_score REAL DEFAULT 80.0");
  safeAlter("ALTER TABLE media_assets ADD COLUMN blur_score REAL DEFAULT 0.0");
  safeAlter("ALTER TABLE media_assets ADD COLUMN cropping_safety_score REAL DEFAULT 100.0");
  safeAlter("ALTER TABLE media_assets ADD COLUMN duplicate_group TEXT");
  safeAlter("ALTER TABLE media_assets ADD COLUMN generation_prompt TEXT");
  safeAlter("ALTER TABLE media_assets ADD COLUMN generation_template TEXT");
  safeAlter("ALTER TABLE media_assets ADD COLUMN generated_from_media_id TEXT");
  safeAlter("ALTER TABLE media_assets ADD COLUMN shopify_upload_status TEXT DEFAULT 'not_started'");
  safeAlter("ALTER TABLE media_assets ADD COLUMN shopify_file_id TEXT");
  safeAlter("ALTER TABLE media_assets ADD COLUMN shopify_media_id TEXT");
  safeAlter("ALTER TABLE media_assets ADD COLUMN shopify_position INTEGER");
  safeAlter("ALTER TABLE media_assets ADD COLUMN selection_status TEXT DEFAULT 'candidate'");
  safeAlter("ALTER TABLE media_assets ADD COLUMN alt_text TEXT");

  safeAlter("ALTER TABLE product_media_links ADD COLUMN gallery_position INTEGER DEFAULT 0");
  safeAlter("ALTER TABLE product_media_links ADD COLUMN is_cover INTEGER DEFAULT 0");
  safeAlter("ALTER TABLE product_media_links ADD COLUMN shopify_position INTEGER");

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_media_role ON media_assets(file_role);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_media_shopify_status ON media_assets(shopify_upload_status);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_media_duplicate_group ON media_assets(duplicate_group);");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS photo_blobs (
        filename TEXT PRIMARY KEY,
        mime_type TEXT NOT NULL,
        data BLOB NOT NULL,
        file_size INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_photo_blobs_created ON photo_blobs(created_at);

      CREATE TABLE IF NOT EXISTS product_measurements (
        id TEXT PRIMARY KEY,
        product_id TEXT,
        media_id TEXT,
        source_filename TEXT,
        pixels_per_mm REAL,
        calibration_source TEXT DEFAULT 'ruler_scale',
        necklace_drop_mm REAL,
        necklace_width_mm REAL,
        pendant_height_mm REAL,
        pendant_width_mm REAL,
        earring_height_mm REAL,
        earring_width_mm REAL,
        measurement_confidence REAL,
        measured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        raw_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_product_measurements_prod ON product_measurements(product_id);
      CREATE INDEX IF NOT EXISTS idx_product_measurements_media ON product_measurements(media_id);
    `);
  } catch {}

  // Migrate users table if role check constraint needs expansion
  try {
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as { sql: string };
    if (tableSql && !tableSql.sql.includes("'viewer'")) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT,
          full_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'staff', 'clerk', 'viewer')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'rejected', 'suspended')),
          approved_by TEXT,
          approved_at DATETIME,
          google_id TEXT UNIQUE,
          email TEXT UNIQUE,
          avatar_url TEXT,
          auth_provider TEXT DEFAULT 'local',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT OR IGNORE INTO users_new (id, username, password_hash, full_name, role, status, approved_by, approved_at, google_id, email, avatar_url, auth_provider, created_at)
        SELECT id, username, password_hash, full_name, role, COALESCE(status, 'active'), approved_by, approved_at, google_id, email, avatar_url, auth_provider, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch (err) {
    console.error('Failed to migrate users table check constraint:', err);
  }

  return db;
}

// Global shared database instance
export const db = initDatabase();

export default db;
