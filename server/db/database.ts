import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database storage location
const DB_DIR = path.resolve(__dirname, '../../data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export const DB_PATH = path.join(DB_DIR, 'saaz_ledger.db');

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
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN po_id TEXT");
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN variant_id TEXT");
  safeAlter("ALTER TABLE purchase_lots ADD COLUMN lot_number TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN google_id TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN email TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN avatar_url TEXT");
  safeAlter("ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'local'");
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;");
  } catch {}

  return db;
}

// Global shared database instance
export const db = initDatabase();

export default db;
