import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR } from '../server/db/database';
import { UPLOADS_DIR, DERIVATIVES_DIR, LEGACY_UPLOADS_DIR } from '../server/services/photoService';

const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.realpathSync(os.tmpdir());
const isUnderTmp = (p: string) => path.resolve(p).startsWith(tmp + path.sep) || path.resolve(p).startsWith(os.tmpdir() + path.sep);

describe('test data isolation (vitest setup)', () => {
  it('uses a temp DATA_DIR and upload dirs, never the repo ./data or ./uploads', () => {
    for (const dir of [DATA_DIR, UPLOADS_DIR, DERIVATIVES_DIR, LEGACY_UPLOADS_DIR]) {
      expect(isUnderTmp(dir), `${dir} must be under ${tmp}`).toBe(true);
      expect(path.resolve(dir).startsWith(path.join(repoRoot, 'data'))).toBe(false);
      expect(path.resolve(dir).startsWith(path.join(repoRoot, 'uploads'))).toBe(false);
    }
    expect(process.env.RAILWAY_VOLUME_MOUNT_PATH).toBeUndefined();
  });

  it('no provider API keys are visible to tests', () => {
    expect(process.env.PHOTOROOM_API_KEY).toBeUndefined();
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("the user's real photo name is never present in the repo data/uploads dirs", () => {
    for (const d of [path.join(repoRoot, 'data/uploads/photos'), path.join(repoRoot, 'uploads/photos')]) {
      if (!fs.existsSync(d)) continue;
      expect(fs.readdirSync(d).filter((f) => f.startsWith('IMG_20261001_120958'))).toEqual([]);
    }
  });
});
