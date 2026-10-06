import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { paperPhoto, ticks } from './helpers/jewelleryFixtures';
import { chainPhoto, chainLine } from './helpers/chainFixtures';

const repoRoot = path.resolve(__dirname, '..');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function runTool(photo: string, outDir: string, extra: string[] = []) {
  const r = spawnSync('npx', ['tsx', 'scripts/verify-real-photo.ts', photo, '--out', outDir, '--label', 'SYNTHETIC FIXTURE - NOT A REAL PHOTO', ...extra], {
    cwd: repoRoot, encoding: 'utf8', timeout: 150_000,
  });
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
  return { status: r.status, report };
}

describe('scripts/verify-real-photo.ts (offline real-photo verification tool)', () => {
  let tmp: string;
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-verify-tool-test-')); });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('passes on a complete synthetic pendant set, leaves the original untouched and writes all outputs', async () => {
    const photo = path.join(tmp, 'clean.jpg');
    const bytes = await paperPhoto();
    fs.writeFileSync(photo, bytes);
    const out = path.join(tmp, 'out-clean');
    const { status, report } = runTool(photo, out);
    expect(report.checks.filter((c: any) => c.status === 'FAIL')).toEqual([]);
    expect(status).toBe(0);
    expect(report.overall).toBe('PASS');
    expect(report.cropRecovery.sourceUsed).toMatchObject({ width: 2276, height: 4048, isTrueOriginal: true, sha256: sha(bytes) });
    expect(report.networkAttempts).toBe(0);
    expect(sha(fs.readFileSync(photo))).toBe(sha(bytes));
    for (const f of ['original_copy.jpg', 'white_background.jpg', 'crop_recovery.jpg', 'contact_sheet.png', 'report.json', 'report.txt']) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }
  }, 180_000);

  it('exits non-zero and reports FAIL when a ruler is in the photo', async () => {
    const ruler = `<rect x="2020" y="250" width="190" height="3500" fill="#f3ead0" stroke="#555" stroke-width="4"/>${ticks(58, (i) => `<rect x="2020" y="${270 + i * 60}" width="${i % 5 === 0 ? 110 : 60}" height="8" fill="#1a1a1a"/>`)}`;
    const photo = path.join(tmp, 'ruler.jpg');
    fs.writeFileSync(photo, await paperPhoto(ruler));
    const { status, report } = runTool(photo, path.join(tmp, 'out-ruler'));
    expect(status).not.toBe(0);
    expect(report.checks.find((c: any) => c.id === 'A1').status).toBe('FAIL');
  }, 180_000);

  it('F2 FAILS (exit non-zero, lost region reported) when the output loses a chain segment (SYNTHETIC faint chain the local cutout drops)', async () => {
    const faint = chainLine(300, 700, 300, 3300).replace(/#8b909a/g, '#d9d9ca');
    const photo = path.join(tmp, 'faint.jpg');
    fs.writeFileSync(photo, await chainPhoto({ hangingChain: true, earrings: true, extraSvg: faint }));
    const out = path.join(tmp, 'out-faint');
    const { status, report } = runTool(photo, out);
    expect(status).not.toBe(0);
    expect(report.overall).toBe('FAIL');
    expect(report.checks.find((c: any) => c.id === 'F2').status).toBe('FAIL');
    expect(report.jewelleryCompleteness.lostRegions.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(out, 'report.txt'), 'utf8')).toMatch(/<-- LOST/);
  }, 180_000);

  it('--require-original-dims passes on matching dims and FAILS (O1) on a different size; sha256 is printed', async () => {
    const photo = path.join(tmp, 'dims.jpg');
    fs.writeFileSync(photo, await paperPhoto());
    const ok = runTool(photo, path.join(tmp, 'out-dims-ok'), ['--require-original-dims', '2276x4048']);
    expect(ok.report.checks.find((c: any) => c.id === 'O1').status).toBe('PASS');
    const bad = runTool(photo, path.join(tmp, 'out-dims-bad'), ['--require-original-dims', '3000x4000']);
    expect(bad.status).not.toBe(0);
    expect(bad.report.checks.find((c: any) => c.id === 'O1').status).toBe('FAIL');
    expect(bad.report.input.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 240_000);
});
