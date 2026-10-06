import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end rollback drill (deployed commit 68398e6 <-> this branch) with real SQLite files and real servers.
 * ~1 minute, so it only runs when RUN_ROLLBACK_DRILL=1 (e.g. before a release):
 *   RUN_ROLLBACK_DRILL=1 npx vitest run tests/rollbackDrill.test.ts
 * It also needs the deployed commit to exist in the local clone (git fetch if shallow).
 */
const hasCommit = (() => { try { execFileSync('git', ['cat-file', '-e', '68398e6^{commit}'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe('rollback drill', () => {
  it.skipIf(!process.env.RUN_ROLLBACK_DRILL || !hasCommit)('all A-E steps pass (old<->new code, snapshot restore, photos)', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-rb-test-')), 'out.txt');
    const r = spawnSync(path.resolve('node_modules/.bin/tsx'), ['scripts/rollback-drill/run.ts'], { env: { ...process.env, OUT: out }, encoding: 'utf8', timeout: 280000 });
    const text = (fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '') + '\n--- stdout/stderr tail ---\n' + (r.stdout + r.stderr).slice(-3000);
    expect(text).not.toMatch(/^FAIL /m);
    expect(text).toMatch(/\d+\/\d+ steps passed/);
    expect(r.status).toBe(0);
  }, 300000);
});
