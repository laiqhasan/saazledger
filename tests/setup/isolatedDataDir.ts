/**
 * Vitest setup file (see vitest.config.ts). Runs before every test file.
 *
 * Guarantees that server modules imported by tests NEVER touch a real data directory:
 *  - DATA_DIR            -> fresh temp dir (so ./data, the SQLite db and uploads are never used)
 *  - LEGACY_UPLOADS_DIR  -> temp dir (so ./uploads/photos in the repo is never written)
 *  - RAILWAY_VOLUME_MOUNT_PATH is removed (it would take precedence over DATA_DIR)
 *  - provider API keys are removed so no test can reach an AI / background-removal provider
 * The temp dirs are deleted when the test file finishes and again on process exit.
 *
 * A test file that sets its own DATA_DIR before importing server code (e.g. inventoryServerSave)
 * simply overrides this one.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-vitest-'));
process.env.DATA_DIR = path.join(root, 'data');
process.env.LEGACY_UPLOADS_DIR = path.join(root, 'legacy-uploads', 'photos');
process.env.SAAZ_TEST_TEMP_ROOT = root;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
for (const k of [
  'PHOTOROOM_API_KEY', 'PHOTOROOM_KEY', 'PHOTOROOM_TOKEN', 'PHOTO_ROOM_API_KEY',
  'REMOVEBG_API_KEY', 'REMOVE_BG_API_KEY', 'CLIPDROP_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'VITE_GEMINI_API_KEY',
  'OPENAI_API_KEY', 'VITE_OPENAI_API_KEY',
]) delete process.env[k];

const cleanup = () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
};
afterAll(cleanup);
process.on('exit', cleanup);
