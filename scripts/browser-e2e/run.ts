/**
 * Isolated, re-runnable BROWSER end-to-end workflow.
 *
 *   Playwright (Chromium)  ->  the REAL built SPA (vite build -> dist/)  ->  the REAL Express app (server/server.ts)
 *   ->  the REAL SQLite engine in a TEMP data dir  ->  fake Shopify on localhost  (or a real Shopify TEST store).
 *
 * Usage (see docs/browser-e2e.md):
 *   npx tsx scripts/browser-e2e/run.ts                                   # DRY RUN: synthetic photo + local fake Shopify
 *   npx tsx scripts/browser-e2e/run.ts --photo /abs/IMG_20261001_120958.jpg --require-original-dims 2276x4048
 *   npx tsx scripts/browser-e2e/run.ts --photo ... --shopify-mode real   # needs TEST_SHOPIFY_* env vars
 *
 * Never touches ./data or ./uploads, never uses production credentials. Google sign-in cannot be automated, so the
 * real username/password login form is used with two users seeded into the TEMP database.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import sharp from 'sharp';
import { startStack, openDb, ADMIN, VIEWER, REPO, type Stack } from './lib/stack';
import { loadPlaywright, findChromium } from './lib/browser';
import { syntheticPhoto } from './lib/fixtures';
import { Recorder, writeReports } from './lib/report';

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (n: string) => argv.includes(n);
if (flag('--help')) {
  console.log('npx tsx scripts/browser-e2e/run.ts [--photo ABS] [--require-original-dims WxH] [--shopify-mode fake|real] [--out DIR] [--headed] [--skip-build] [--skip-manual-stock] [--stop-after N]');
  process.exit(0);
}
const MODE = (arg('--shopify-mode') || 'fake') as 'fake' | 'real';
if (MODE !== 'fake' && MODE !== 'real') { console.error('--shopify-mode must be fake or real'); process.exit(2); }
const PHOTO_ARG = arg('--photo');
const REQ_DIMS = arg('--require-original-dims');
const OUT = path.resolve(arg('--out') || path.join(REPO, 'browser-e2e-output'));
const STOP_AFTER = Number(arg('--stop-after') || 99);
const HEADED = flag('--headed');

const QTY = 5, BUY = 500, SELL = 1200, VENDOR = 'E2E Test Atelier';
const TITLE = 'E2E Blue Pear Halo Pendant Set (browser-e2e)';
const CATEGORY_MSG = 'Category: NOT SET - assign in Shopify admin before publishing';

const logLines: string[] = [];
const log = (s: string) => { logLines.push(s); console.log(s); };
const rec = new Recorder(log);
let shotN = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });

  // ------------------------------------------------------------ photo
  rec.setPhase('0. Setup');
  let photoBuf: Buffer; let photoPath: string; let photoKind: 'synthetic' | 'supplied';
  const tmpPhotoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-e2e-photo-'));
  if (PHOTO_ARG) {
    photoPath = path.resolve(PHOTO_ARG); photoBuf = fs.readFileSync(photoPath); photoKind = 'supplied';
  } else {
    photoBuf = await syntheticPhoto(); photoPath = path.join(tmpPhotoDir, 'SYNTHETIC_2276x4048.jpg'); fs.writeFileSync(photoPath, photoBuf); photoKind = 'synthetic';
  }
  const meta = await sharp(photoBuf).metadata();
  const rawW = meta.width || 0, rawH = meta.height || 0;
  const swap = (meta.orientation || 1) >= 5;
  const orientedW = swap ? rawH : rawW, orientedH = swap ? rawW : rawH;
  const photoSha = sha256(photoBuf);
  const dimsOk = !REQ_DIMS || REQ_DIMS === `${rawW}x${rawH}` || REQ_DIMS === `${orientedW}x${orientedH}`;
  if (!dimsOk) {
    console.error(`REFUSING: --require-original-dims ${REQ_DIMS} but the photo is ${rawW}x${rawH} (oriented ${orientedW}x${orientedH}).`);
    process.exit(2);
  }
  if (REQ_DIMS) rec.pass('0.1', `Photo has the required original dimensions ${REQ_DIMS}`, `raw ${rawW}x${rawH}, EXIF-oriented ${orientedW}x${orientedH}`);

  const banner = MODE === 'fake' && photoKind === 'synthetic'
    ? 'DRY RUN — synthetic photo, fake Shopify — NOT the genuine photo / NOT a real store'
    : MODE === 'fake'
      ? `DRY RUN — supplied photo (sha256 ${photoSha.slice(0, 12)}…), FAKE Shopify — NOT a real store`
      : photoKind === 'synthetic'
        ? 'PARTIAL RUN — synthetic photo (NOT the genuine photo), REAL Shopify TEST store'
        : `TEST RUN — supplied photo (sha256 ${photoSha.slice(0, 12)}…), REAL Shopify TEST store (never production)`;
  log(banner);

  // ------------------------------------------------------------ stack
  let stack: Stack | undefined;
  const finish = async (code: number) => {
    const c = rec.counts();
    writeReports(OUT, {
      generatedAt: new Date().toISOString(),
      mode: MODE, photoKind, photo: { file: path.basename(photoPath), sha256: photoSha, bytes: photoBuf.length, rawDims: `${rawW}x${rawH}`, orientedDims: `${orientedW}x${orientedH}`, requiredDims: REQ_DIMS || null },
      versions: { node: process.version, platform: `${process.platform}/${process.arch}`, chromium: chromiumVersion, git: gitHead(), sharp: (sharp as any).versions?.sharp },
      shopify: { mode: MODE, store: stack?.shopDomainMasked, locationId: MODE === 'fake' ? stack?.locationId : '(set)', writeViolations: stack?.fake ? stack.fake.violations : 'n/a (real store: check Shopify admin; script only sends drafts)' },
      sign_in: 'Password login through the real login form with 2 users seeded in the TEMP database. Google sign-in cannot be automated and was NOT exercised.',
      tempDataDir: stack?.dataDir, outputDir: OUT,
    }, rec, banner, stack?.serverLog().slice(-6000) || '');
    log(`\nreport: ${path.join(OUT, 'report.txt')}   RESULT: ${c.FAIL === 0 ? 'ALL PASS' : c.FAIL + ' FAILED'}`);
    try { await stack?.stop(); } catch { /* ignore */ }
    if (!flag('--keep-temp') && stack) fs.rmSync(stack.tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpPhotoDir, { recursive: true, force: true });
    process.exit(code);
  };

  const repoDataBefore = snapshotRepoData();
  let chromiumVersion = '?';
  try {
    stack = await startStack({ mode: MODE, outDir: OUT, log, skipBuild: flag('--skip-build') });
  } catch (e: any) {
    rec.fail('0.2', 'Start isolated stack', e.message);
    return finish(1);
  }
  rec.pass('0.2', 'Isolated stack started (temp DATA_DIR, real Express app, real SQLite, real built SPA)', `${stack.baseUrl}  dataDir=${stack.dataDir}`);
  rec.check('0.3', 'Temp DATA_DIR is outside the repo ./data and ./uploads', !stack.dataDir.startsWith(path.join(REPO, 'data')) && !stack.dataDir.startsWith(path.join(REPO, 'uploads')));
  const S = stack;

  // ------------------------------------------------------------ node-side API helper (server truth, separate from the UI)
  const login = async (u: { username: string; password: string }) => {
    const r = await fetch(S.baseUrl + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(u) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const api = async (token: string | null, method: string, p: string, body?: any) => {
    const r = await fetch(S.baseUrl + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json };
  };
  const adminTok = (await login(ADMIN)).json.token as string;
  const viewerTok = (await login(VIEWER)).json.token as string;
  const dbq = <T = any>(sql: string, ...p: any[]): T[] => { const db = openDb(S); try { return db.prepare(sql).all(...p) as T[]; } finally { db.close(); } };

  // ------------------------------------------------------------ browser
  const pw = await loadPlaywright();
  const exe = findChromium();
  const browser = await pw.chromium.launch({ executablePath: exe, headless: !HEADED, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  chromiumVersion = browser.version();
  rec.info('0.4', 'Browser', `Chromium ${chromiumVersion}${exe ? ` (${exe})` : ''}`);
  const consoleErrors: string[] = [];
  const dialogs: string[] = [];
  let dialogAction: 'accept' | 'dismiss' = 'accept';

  async function newContext() {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    // Hard network isolation: the browser may only talk to the local app (no Google Fonts / GIS / CDNs).
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(S.baseUrl) || u.startsWith('data:') || u.startsWith('blob:')) return route.fallback();
      return route.abort();
    });
    if (MODE === 'fake') {
      // The SPA's background order poll goes through /api/shopify-proxy, which dials https://<shop>.myshopify.com.
      // In the dry run there is no such store (and no internet): answer locally.
      await ctx.route('**/api/shopify-proxy**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"orders":[]}' }));
    }
    return ctx;
  }
  async function newPage(ctx: import('playwright-core').BrowserContext) {
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 200)));
    page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); if (dialogAction === 'accept') await d.accept(); else await d.dismiss(); });
    return page;
  }
  const shot = async (page: import('playwright-core').Page, name: string) => {
    const f = `${String(++shotN).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: path.join(OUT, 'screenshots', f) });
    rec.screenshots.push(`screenshots/${f}`);
  };
  const uiLogin = async (page: import('playwright-core').Page, u: { username: string; password: string }) => {
    await page.goto(S.baseUrl);
    await page.waitForSelector('[data-testid=login-username]', { timeout: 30_000 });
    await page.fill('[data-testid=login-username]', u.username);
    await page.fill('[data-testid=login-password]', u.password);
    await page.click('[data-testid=login-submit]');
  };

  // =============================================================== 1. LOGIN / ROLES
  rec.setPhase('1. Login and roles');
  const anon = await newContext();
  const ap = await newPage(anon);
  await rec.step('1.1', 'Login form is shown to an anonymous visitor', async () => {
    await ap.goto(S.baseUrl);
    await ap.waitForSelector('[data-testid=login-username]', { timeout: 30_000 });
    rec.pass('1.1', 'Login form is shown to an anonymous visitor (no inventory visible)');
    await shot(ap, 'login-screen');
  });
  const anonInv = await api(null, 'GET', '/api/inventory');
  rec.check('1.2', 'Anonymous API call is rejected with 401', anonInv.status === 401, `GET /api/inventory -> ${anonInv.status}`);
  await rec.step('1.3', 'Wrong password is rejected in the UI', async () => {
    await ap.fill('[data-testid=login-username]', ADMIN.username);
    await ap.fill('[data-testid=login-password]', 'definitely-wrong-password');
    await ap.click('[data-testid=login-submit]');
    await ap.getByText(/Invalid credentials/i).waitFor({ timeout: 15_000 });
    const tok = await ap.evaluate(() => localStorage.getItem('saaz_auth_token'));
    rec.check('1.3', 'Wrong password is rejected: error shown, still on login form, no token stored', !tok && (await ap.locator('[data-testid=login-username]').count()) === 1);
    await shot(ap, 'wrong-password-rejected');
  });
  await anon.close();

  // viewer
  const vctx = await newContext();
  const vp = await newPage(vctx);
  await rec.step('1.4', 'Viewer can log in', async () => {
    await uiLogin(vp, VIEWER);
    await vp.getByText('Stock on hand', { exact: false }).first().waitFor({ timeout: 30_000 });
    rec.pass('1.4', 'Viewer logs in through the real form and sees the dashboard');
    const newBtn = await vp.getByRole('button', { name: /New Piece/ }).count();
    rec.check('1.5', 'Viewer UI has NO "New Piece" (add item) button', newBtn === 0, `buttons named New Piece: ${newBtn}`);
    await shot(vp, 'viewer-dashboard');
  });
  const vAdd = await api(viewerTok, 'POST', '/api/inventory', { id: 'x', clientItemId: 'cli_viewer_attempt', sku: 'ZZ-VIEWER', title: 'viewer attempt', typeCode: 'PD', stoneCode: 'D', colorCode: '01', quantity: 1 });
  rec.check('1.6', 'Viewer cannot create items (server enforces: 403)', vAdd.status === 403, `POST /api/inventory as viewer -> ${vAdd.status}`);
  const vShop = await api(viewerTok, 'POST', '/api/shopify/send-draft', { item: { id: 'x', sku: 'ZZ-VIEWER', title: 'x', quantity: 1 } });
  rec.check('1.7', 'Viewer cannot use Shopify send-draft (server enforces: 403)', vShop.status === 403, `POST /api/shopify/send-draft as viewer -> ${vShop.status}`);
  rec.check('1.8', 'No inventory row was created by the viewer attempts', dbq('SELECT COUNT(*) c FROM items')[0].c === 0);
  if (STOP_AFTER < 2) return finish(rec.counts().FAIL ? 1 : 0);

  // =============================================================== 2. NEW PIECE + MEDIA PACK STUDIO
  rec.setPhase('2. New piece, Media Pack Studio (Product Accuracy / Exact Cutout)');
  const actx = await newContext();
  const page = await newPage(actx);
  await uiLogin(page, ADMIN);
  await page.getByRole('button', { name: /New Piece/ }).waitFor({ timeout: 30_000 });
  rec.pass('2.1', 'Admin logs in through the real form; "New Piece" is available');
  // after login the inventory must be fetched WITH the token (regression: initial load ran before login and 401'd)
  await page.getByText(/No pieces found/).waitFor({ timeout: 15_000 }).catch(() => {});
  await shot(page, 'admin-dashboard-empty');

  let clientItemId = '';
  page.on('request', (r) => { const m = r.url().match(/\/api\/media-pack-drafts\/([^/?]+)/); if (m && r.method() === 'PUT') clientItemId = decodeURIComponent(m[1]); });
  const cropRequests: any[] = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/media/crop') && r.method() === 'POST') { try { cropRequests.push(JSON.parse(r.postData() || '{}')); } catch { /* ignore */ } } });

  await page.getByRole('button', { name: /New Piece/ }).click();
  await page.getByText('Register New Jewelry Piece').waitFor();
  const whiteCover = page.waitForResponse((r) => r.url().includes('/api/media/white-cover') && r.request().method() === 'POST', { timeout: 120_000 });
  await page.locator('.modal-content input[type=file]').first().setInputFiles(photoPath);
  const wcResp = await whiteCover.catch(() => null);
  rec.check('2.2', 'Photo uploaded in the New Piece modal; white-background cover generated by the server', !!wcResp && wcResp.status() === 200, wcResp ? `POST /api/media/white-cover -> ${wcResp.status()}` : 'no response');
  await page.getByRole('button', { name: 'White BG' }).waitFor({ timeout: 30_000 });
  await page.locator('input[placeholder^="e.g. Multicolour American Diamond Silver"]').fill(TITLE);
  const priceInputs = page.locator('.modal-content input[placeholder="0.00"]');
  await priceInputs.nth(0).fill(String(BUY));
  await priceInputs.nth(1).fill(String(SELL));
  await page.locator('.modal-content input[placeholder="0"]').first().fill(String(QTY));
  await page.locator('input[placeholder="Select or type artisan name / workshop"]').fill(VENDOR);
  rec.check('2.3', 'Form values entered: qty 5, buying 500, selling 1200, vendor', (await priceInputs.nth(0).inputValue()) === String(BUY) && (await priceInputs.nth(1).inputValue()) === String(SELL) && (await page.locator('.modal-content input[placeholder="0"]').first().inputValue()) === String(QTY));
  await shot(page, 'new-piece-filled');

  // ---- Media Pack Studio
  await page.getByRole('button', { name: /5-Slot Media Pack/ }).click();
  await page.getByText('Media Pack Studio', { exact: true }).first().waitFor();
  // Choose "Product Accuracy — Exact Cutout" explicitly (it is the default; we select it anyway).
  await rec.step('2.4', 'Choose Product Accuracy — Exact Cutout', async () => {
    await page.getByRole('button', { name: 'Product Accuracy', exact: true }).first().scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Product Accuracy', exact: true }).first().click();
    const sel = page.locator('select:has(option[value="exact_cutout"])').first();
    await sel.selectOption('exact_cutout');
    const v = await sel.inputValue();
    rec.check('2.4', 'Generation Method = "Product Accuracy — Exact Cutout" selected', v === 'exact_cutout', `select value=${v}`);
    await shot(page, 'studio-product-accuracy-selected');
  });
  const gen = page.waitForResponse((r) => r.url().includes('/api/media/pack/generate'), { timeout: 240_000 });
  await page.getByRole('button', { name: /Generate Media Pack/ }).click();
  const genResp = await gen.catch(() => null);
  rec.check('2.5', 'Media pack generation request succeeded', !!genResp && (genResp.status() === 200 || genResp.status() === 202), genResp ? `POST /api/media/pack/generate -> ${genResp.status()}` : 'no response / timeout');
  await page.getByText(/Recommended Shopify Gallery Pack/).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  const studioText = await page.locator('body').innerText();
  rec.check('2.6', 'Slot 1 is the white Exact Cutout hero (UI: "White Product (Exact)", "Exact Cutout", 2048×2048)', /White Product \(Exact\)/.test(studioText) && /Exact Cutout/.test(studioText) && /2048×2048/.test(studioText));
  rec.check('2.7', 'UI shows match status for slot 1 and no "needs review"/"failed"/"incomplete" warning on it', /HIGH MATCH|REVIEW RECOMMENDED/.test(studioText) && !/Jewellery incomplete|NEEDS REVIEW|generation failed/i.test(studioText), (studioText.match(/(HIGH MATCH|REVIEW RECOMMENDED|NEEDS REVIEW)[^\n]*/) || [''])[0]);
  await shot(page, 'studio-generated-gallery');

  // white image verification (pixels, not just DOM)
  const slot1Img = page.locator('img[src*="exact_cutout"]').first();
  await slot1Img.waitFor({ timeout: 30_000 });
  const slot1Src = (await slot1Img.getAttribute('src')) || '';
  const imgBuf = Buffer.from(await (await fetch(new URL(slot1Src, S.baseUrl))).arrayBuffer());
  const im = await sharp(imgBuf).metadata();
  const corners = await Promise.all([[2, 2], [im.width! - 6, 2], [2, im.height! - 6], [im.width! - 6, im.height! - 6]].map(async ([x, y]) => (await sharp(imgBuf).extract({ left: x, top: y, width: 4, height: 4 }).stats()).channels.map((c) => c.mean)));
  const whiteCorners = corners.every((c) => c.every((v) => v >= 250));
  rec.check('2.8', 'Hero image is 2048×2048 with pure-white background (all 4 corners >= 250)', im.width === 2048 && im.height === 2048 && whiteCorners, `${im.width}x${im.height}; corner means ${corners.map((c) => c.map((v) => Math.round(v)).join('/')).join(' | ')}`);

  // server-side draft = what the pack really holds (completeness gate numbers)
  await rec.step('2.9', 'Completeness gate result (from the pack saved to the server)', async () => {
    for (let i = 0; i < 40 && !clientItemId; i++) await sleep(500);
    let draft: any; for (let i = 0; i < 30; i++) { const r = await api(adminTok, 'GET', `/api/media-pack-drafts/${clientItemId}`); if (r.status === 200) { draft = r.json.draft; const slots = (draft.pack || JSON.parse(draft.pack_json || '{}')).slots; if (slots?.length) break; } await sleep(1000); }
    const pack = draft && (draft.pack || (draft.pack_json ? JSON.parse(draft.pack_json) : null));
    const slots: any[] = pack?.slots || [];
    const hero = slots.find((s) => s.slotNumber === 1);
    const c = hero?.jewelleryCompleteness;
    rec.check('2.9', 'Hero slot carries a jewellery completeness result: pass, no lost components', !!c && c.applicable !== false && c.pass === true && (c.missingComponentCount || 0) === 0 && c.retainedPercent / 100 >= (c.threshold > 1 ? c.threshold / 100 : c.threshold), c ? `status=${c.status} retained=${c.retainedPercent}% (threshold ${c.threshold > 1 ? c.threshold + '%' : c.threshold * 100 + '%'}) missingComponents=${c.missingComponentCount} issues=${JSON.stringify(c.issues || [])}` : `no jewelleryCompleteness on slot 1 (keys: ${hero ? Object.keys(hero).join(',') : 'no hero'})`);
    rec.info('2.9b', 'NOTE: the UI itself does not print the retained % number; it shows status only (a failed gate would surface as "needs review" with the reason). The % above is read from the saved pack.');
    rec.check('2.10', 'Hero slot output status is ready (not needs_review/failed) and mode is exact_cutout', hero && hero.outputStatus !== 'needs_review' && hero.outputStatus !== 'failed' && hero.generationFailed !== true && (hero.whiteProductMode || 'exact_cutout') === 'exact_cutout', `outputStatus=${hero?.outputStatus} mode=${hero?.whiteProductMode} sourceOriginal=${JSON.stringify(hero?.sourceOriginal || null)}`);
  });

  // ---- Crop editor: true original + recovery
  await rec.step('2.11', 'Crop editor opens the TRUE original', async () => {
    const editBtns = page.getByRole('button', { name: /Edit Crop/ });
    const n = await editBtns.count();
    // gallery-tab slot cards: the last slot is the real-photo fallback (a 2048 derivative of the original)
    await editBtns.nth(n - 1).scrollIntoViewIfNeeded();
    await editBtns.nth(n - 1).click();
    const hdr = page.getByText(/Original \(uploaded photo\)/).first();
    await hdr.waitFor({ timeout: 15_000 });
    const txt = (await hdr.locator('xpath=..').innerText()).replace(/\s+/g, ' ');
    rec.check('2.11', `Crop editor header says "Original (uploaded photo): ${orientedW} × ${orientedH} px"`, new RegExp(`Original \\(uploaded photo\\): ${orientedW} × ${orientedH} px`).test(txt), txt);
    rec.check('2.12', 'Crop editor shows the current 2048 output only as a derivative, never as "Original"', /\(derivative\)[^•]*2048 × 2048 px/.test(txt) && !/Derivative \(not the original\)/.test(txt), txt.slice(0, 200));
    await shot(page, 'crop-editor-true-original');

    // simulate a BAD derivative: zoom in hard so the crop lops off most of the jewellery, apply it.
    for (let i = 0; i < 9; i++) await page.locator('button[title="Zoom In"]').click();
    await page.getByRole('button', { name: /Apply/ }).last().click();
    await page.getByText(/Original \(uploaded photo\)/).first().waitFor({ state: 'detached', timeout: 60_000 });
    const badReq = cropRequests[cropRequests.length - 1];
    rec.check('2.13', 'Bad crop applied from the true original (server crop call succeeded; crop is a derivative)', !!badReq, badReq ? `crop rect ${JSON.stringify(badReq.crop && { x: badReq.crop.x, y: badReq.crop.y, w: badReq.crop.width, h: badReq.crop.height, zoom: badReq.crop.zoom })}; sourceOriginal=${badReq.sourceOriginal ? 'sent' : 'not sent (imageBase64 of the original sent instead)'}` : 'no /api/media/crop request seen');
    await shot(page, 'after-bad-crop');

    // RECOVERY: re-open the crop editor; it must again offer the TRUE original at full resolution, not the bad 2048 derivative.
    const editBtns2 = page.getByRole('button', { name: /Edit Crop/ });
    const n2 = await editBtns2.count();
    await editBtns2.nth(n2 - 1).scrollIntoViewIfNeeded();
    await editBtns2.nth(n2 - 1).click();
    const hdr2 = page.getByText(/Original \(uploaded photo\)/).first();
    await hdr2.waitFor({ timeout: 15_000 });
    const txt2 = (await hdr2.locator('xpath=..').innerText()).replace(/\s+/g, ' ');
    rec.check('2.14', 'Crop RECOVERY: after the bad 2048 derivative the editor still opens the true original at full size', new RegExp(`Original \\(uploaded photo\\): ${orientedW} × ${orientedH} px`).test(txt2), txt2.slice(0, 220));
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    const before = cropRequests.length;
    await page.getByRole('button', { name: /Apply/ }).last().click();
    await page.getByText(/Original \(uploaded photo\)/).first().waitFor({ state: 'detached', timeout: 60_000 });
    const good = cropRequests[cropRequests.length - 1];
    rec.check('2.15', 'Recovery crop applied from the true original (new /api/media/crop call after Reset)', cropRequests.length > before && !!good, good ? `crop rect ${JSON.stringify(good.crop && { x: good.crop.x, y: good.crop.y, w: good.crop.width, h: good.crop.height, zoom: good.crop.zoom })}` : '');
    await shot(page, 'after-crop-recovery');
  });

  // close studio -> back to the New Piece modal; pack must be backed up on the server
  await page.getByRole('button', { name: 'Close Studio' }).click();
  await page.getByTestId('pack-backup-status').waitFor({ timeout: 30_000 }).catch(() => {});
  await page.getByText(/Pack backed up to server/).waitFor({ timeout: 30_000 }).then(
    () => rec.pass('2.16', 'UI reports "Pack backed up to server" for the unsaved media pack'),
    async () => rec.fail('2.16', 'UI reports "Pack backed up to server"', (await page.getByTestId('pack-backup-status').allInnerTexts().catch(() => [])).join('|') || 'status element not shown'));
  rec.check('2.17', 'media_pack_drafts row exists on the server BEFORE the item is saved', clientItemId !== '' && dbq('SELECT client_item_id FROM media_pack_drafts WHERE client_item_id = ?', clientItemId).length === 1, `clientItemId=${clientItemId}`);
  if (STOP_AFTER < 3) return finish(rec.counts().FAIL ? 1 : 0);

  // =============================================================== 3. SAVE
  rec.setPhase('3. Save, server confirmation, read-back, idempotency, duplicates');
  // Hold the save request open so we can observe the UI WHILE the server has not yet confirmed.
  let postCount = 0;
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  await actx.route('**/api/inventory', async (route) => {
    if (route.request().method() === 'POST') { postCount++; await gate; }
    return route.fallback();
  });
  const saveBtn = page.getByRole('button', { name: /Approve & Mint Global SKU/ });
  await saveBtn.dblclick(); // double-click on purpose
  await page.getByRole('button', { name: /Saving to server/ }).first().waitFor({ timeout: 15_000 }).then(
    () => rec.pass('3.1', 'While the server has not confirmed, the UI shows "Saving to server..." (button busy)'),
    () => rec.fail('3.1', 'UI shows "Saving to server..." while waiting'));
  await sleep(1500);
  rec.check('3.2', 'Modal stays open and the item is NOT shown as saved before server confirmation', (await page.getByText('Register New Jewelry Piece').count()) === 1 && dbq('SELECT COUNT(*) c FROM items')[0].c === 0, `server rows=${dbq('SELECT COUNT(*) c FROM items')[0].c}`);
  await shot(page, 'saving-awaiting-server');
  release();
  await page.getByText('Register New Jewelry Piece').waitFor({ state: 'detached', timeout: 60_000 }).then(
    () => rec.pass('3.3', 'Modal closes only after the server confirmed the save'),
    () => rec.fail('3.3', 'Modal closes after server confirmation', 'still open after 60s'));
  await actx.unroute('**/api/inventory');
  rec.check('3.4', 'Double-click sent exactly ONE POST /api/inventory', postCount === 1, `POST /api/inventory count = ${postCount}`);
  await page.waitForTimeout(1500);
  await shot(page, 'saved-inventory-list');

  const rows = dbq<any>('SELECT * FROM items');
  rec.check('3.5', 'Exactly one item exists in SQLite after the double-click', rows.length === 1, `rows=${rows.length}`);
  const row = rows[0] || {};
  const itemId: string = row.id; const SKU: string = row.sku;
  rec.info('3.5b', 'Minted SKU', `${SKU} (id ${itemId})`);
  rec.check('3.6', 'SQLite: quantity 5, buying 500, selling 1200, vendor, client_item_id', row.quantity === QTY && row.buying_price === BUY && row.selling_price === SELL && row.vendor_name === VENDOR && row.client_item_id === clientItemId, `qty=${row.quantity} buy=${row.buying_price} sell=${row.selling_price} vendor=${row.vendor_name} cid=${row.client_item_id}`);
  rec.check('3.7', 'SQLite: original photo and white-background photo are stored', !!row.original_image_url && !!row.white_bg_image_url && !!row.image_url, `original=${row.original_image_url} white=${row.white_bg_image_url}`);
  const verify = await api(adminTok, 'GET', `/api/inventory/${itemId}/verify`);
  const vi = verify.json?.item || {};
  rec.check('3.8', 'Server verify view (GET /api/inventory/:id/verify): qty 5, 500, 1200', verify.status === 200 && vi.quantity === QTY && vi.buyingPrice === BUY && vi.sellingPrice === SELL, `status=${verify.status} qty=${vi.quantity} buy=${vi.buyingPrice} sell=${vi.sellingPrice}`);
  const draftRow = dbq<any>('SELECT item_id, sku FROM media_pack_drafts WHERE client_item_id = ?', clientItemId)[0];
  rec.check('3.9', 'Server verify view: original photo + white bg stored, and the media pack draft is LINKED to the saved item', !!verify.json?.counts?.hasOriginalImage && !!(verify.json?.stored?.white_bg_image_url) && draftRow?.item_id === itemId && draftRow?.sku === SKU, `hasOriginal=${verify.json?.counts?.hasOriginalImage} white=${verify.json?.stored?.white_bg_image_url} pack draft item_id=${draftRow?.item_id} sku=${draftRow?.sku}`);
  rec.info('3.9b', 'product_media_links rows for the item (media library links are created on publish, not on save)', `activeLinks=${verify.json?.counts?.activeLinks} byRole=${JSON.stringify(verify.json?.counts?.byRole)}`);
  // the stored files really exist and have the original's pixel size
  await rec.step('3.10', 'Stored original is byte-identical-size/dimension to the uploaded photo', async () => {
    const o = await fetch(new URL(row.original_image_url, S.baseUrl), { headers: { authorization: `Bearer ${adminTok}` } });
    const ob = Buffer.from(await o.arrayBuffer()); const om = await sharp(ob).metadata();
    const same = om.width === rawW && om.height === rawH;
    rec.check('3.10', `Stored original photo keeps the full ${rawW}×${rawH} resolution`, o.status === 200 && same, `GET -> ${o.status}; ${om.width}x${om.height}; sha256 ${sha256(ob).slice(0, 12)}… (uploaded ${photoSha.slice(0, 12)}…)${sha256(ob) === photoSha ? ' IDENTICAL BYTES' : ' (re-encoded)'}`);
  });

  // retries / duplicates
  const body = { ...(verify.json?.item || {}), clientItemId, id: itemId };
  const retry = await api(adminTok, 'POST', '/api/inventory', body);
  rec.check('3.11', 'Retry of the same save (same clientItemId) does not create a second item', dbq('SELECT COUNT(*) c FROM items')[0].c === 1, `retry -> HTTP ${retry.status}; rows=${dbq('SELECT COUNT(*) c FROM items')[0].c}`);
  const dup = await api(adminTok, 'POST', '/api/inventory', { ...body, id: 'it_dup_attempt', clientItemId: 'cli_dup_attempt_0001' });
  rec.check('3.12', 'Adding the SAME SKU again with a different client id is refused (409 DUPLICATE_SKU) and still one item', dup.status === 409 && dbq('SELECT COUNT(*) c FROM items')[0].c === 1, `HTTP ${dup.status} ${JSON.stringify(dup.json).slice(0, 160)}`);
  rec.info('3.12b', 'NOTE: the UI always asks the server for the next free SKU, so a same-SKU duplicate cannot be produced by clicking; the duplicate is exercised against the API with the admin token.');
  if (STOP_AFTER < 4) return finish(rec.counts().FAIL ? 1 : 0);

  // =============================================================== 4. MEDIA RECOVERY after browser-data loss
  rec.setPhase('4. Recovery after browser data loss (TEST browser context only)');
  await rec.step('4.1', 'Clear localStorage + IndexedDB in the test browser context', async () => {
    await page.evaluate(async () => {
      localStorage.clear(); sessionStorage.clear();
      const dbs = (indexedDB as any).databases ? await (indexedDB as any).databases() : [];
      await Promise.all(dbs.map((d: any) => new Promise((res) => { const r = indexedDB.deleteDatabase(d.name); r.onsuccess = r.onerror = r.onblocked = () => res(null); })));
    });
    const left = await page.evaluate(() => localStorage.length);
    rec.check('4.1', 'Browser storage cleared (localStorage empty)', left === 0, `keys left ${left}`);
    await page.reload();
    await page.waitForSelector('[data-testid=login-username]', { timeout: 30_000 });
    rec.pass('4.2', 'After data loss the app asks for login again');
    await shot(page, 'after-browser-data-loss');
    await page.fill('[data-testid=login-username]', ADMIN.username);
    await page.fill('[data-testid=login-password]', ADMIN.password);
    await page.click('[data-testid=login-submit]');
    await page.getByText(SKU, { exact: false }).first().waitFor({ timeout: 60_000 });
    rec.pass('4.3', `Item ${SKU} is restored from the server into the empty browser`);
    await shot(page, 'recovered-inventory');
  });
  rec.check('4.4', 'Server still has exactly one item and the media pack draft row', dbq('SELECT COUNT(*) c FROM items')[0].c === 1 && dbq('SELECT 1 FROM media_pack_drafts WHERE client_item_id = ?', clientItemId).length === 1);
  await rec.step('4.5', 'Unpublished media pack restored from media_pack_drafts into the browser', async () => {
    await sleep(3000);
    const stored = await page.evaluate((cid) => {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; const v = localStorage.getItem(k) || ''; if (v.includes(cid) && v.includes('galleryPack')) out.push(k); }
      return out;
    }, clientItemId);
    rec.check('4.5', 'Browser storage again holds the item WITH its gallery pack (restored from the server draft)', stored.length > 0, `keys: ${stored.join(',') || 'none'}`);
  });
  await rec.step('4.6', 'Studio shows the restored pack slots', async () => {
    await page.locator('tr', { hasText: SKU }).first().getByTitle('Edit piece').click();
    await page.getByRole('button', { name: /5-Slot Media Pack/ }).click();
    await page.getByText('Media Pack Studio', { exact: true }).first().waitFor();
    await page.getByText(/Recommended Shopify Gallery Pack/).waitFor({ timeout: 20_000 }).catch(() => {});
    const ok = (await page.getByText(/Recommended Shopify Gallery Pack/).count()) > 0 && (await page.locator('img[src*="exact_cutout"]').count()) > 0;
    rec.check('4.6', 'Restored Studio shows the generated gallery with the white Exact Cutout hero', ok);
    await shot(page, 'studio-restored-pack');
  });
  if (STOP_AFTER < 5) return finish(rec.counts().FAIL ? 1 : 0);

  // =============================================================== 5. SHOPIFY DRAFT
  await shopifyPhase({ page, S, SKU, itemId, api, adminTok, dbq, shot, dialogs, setDialogAction: (a) => { dialogAction = a; }, vctx, uiLogin, newPage, viewerTok, CATEGORY_MSG });

  // =============================================================== 6. BACKUP
  rec.setPhase('6. Admin-only backup endpoint');
  const bAdmin = await api(adminTok, 'POST', '/api/admin/backup/db', {});
  rec.check('6.1', 'Admin: POST /api/admin/backup/db -> 201 with integrity ok', bAdmin.status === 201 && bAdmin.json?.ok === true && /ok/i.test(String(bAdmin.json?.integrity ?? bAdmin.json?.integrityCheck ?? 'ok')), `HTTP ${bAdmin.status} ${JSON.stringify(bAdmin.json).slice(0, 300)}`);
  const bFile = path.join(S.dataDir, 'backups', String(bAdmin.json?.file || ''));
  rec.check('6.2', 'Backup file exists in the TEMP data dir and is a valid SQLite file', !!bAdmin.json?.file && fs.existsSync(bFile) && fs.readFileSync(bFile).subarray(0, 15).toString() === 'SQLite format 3', bFile.replace(S.tmpRoot, '<tmp>'));
  const bViewer = await api(viewerTok, 'POST', '/api/admin/backup/db', {});
  rec.check('6.3', 'Viewer: POST /api/admin/backup/db -> 403', bViewer.status === 403, `HTTP ${bViewer.status}`);
  const bAnon = await api(null, 'POST', '/api/admin/backup/db', {});
  rec.check('6.4', 'Anonymous: POST /api/admin/backup/db -> 401', bAnon.status === 401, `HTTP ${bAnon.status}`);

  // =============================================================== 7. HYGIENE
  rec.setPhase('7. Hygiene');
  rec.check('7.1', 'Repo ./data and ./uploads untouched by the run', snapshotRepoData() === repoDataBefore);
  if (consoleErrors.length) rec.info('7.2', `Browser console errors (${consoleErrors.length})`, [...new Set(consoleErrors)].slice(0, 8).join(' || '));
  else rec.pass('7.2', 'No browser console errors / page errors');
  rec.info('7.3', 'Dialogs seen by the browser', dialogs.map((d) => d.slice(0, 160)).join(' || ') || 'none');
  await browser.close();
  await finish(rec.counts().FAIL ? 1 : 0);
}

// ------------------------------------------------------------------ Shopify phase
interface Ctx2 { page: import('playwright-core').Page; S: Stack; SKU: string; itemId: string; api: any; adminTok: string; dbq: any; shot: any; dialogs: string[]; setDialogAction: (a: 'accept' | 'dismiss') => void; vctx: any; uiLogin: any; newPage: any; viewerTok: string; CATEGORY_MSG: string }
async function shopifyPhase(c: Ctx2) {
  const { page, S, SKU, api, adminTok, dbq, shot } = c;
  rec.setPhase(`5. Shopify draft (${MODE === 'fake' ? 'FAKE local store' : 'REAL TEST store ' + S.shopDomainMasked})`);
  const fake = S.fake;
  const writesNow = () => (fake ? fake.writes().length : -1);
  const levelKey = () => { const prod = fake!.draftProducts()[0]; return prod ? `${prod.variants[0].inventory_item_id}:${S.locationId}` : ''; };
  const stock = () => (fake ? fake.levels.get(levelKey()) : undefined);

  // the studio is open (restored pack) from phase 4
  const sendBtn = () => page.getByRole('button', { name: /Send to Shopify Draft/ }).last();
  const sendResp = () => page.waitForResponse((r) => r.url().includes('/api/media/pack/publish-shopify'), { timeout: 180_000 });

  await rec.step('5.1', 'Send to Shopify Draft (Media Pack Studio)', async () => {
    const rp = sendResp();
    await sendBtn().click();
    const resp = await rp; const j = await resp.json().catch(() => ({}));
    rec.check('5.1', 'Studio "Send to Shopify Draft" -> server created a draft', resp.status() === 200 && j.success === true, `HTTP ${resp.status()} ${JSON.stringify({ success: j.success, action: j.action, draftOnly: j.draftOnly, error: j.error }).slice(0, 200)}`);
    await page.waitForTimeout(1500);
    const studioOpen = (await page.getByText('Media Pack Studio', { exact: true }).count()) > 0;
    const panelCount = await page.getByTestId('shopify-draft-verification').count();
    rec.info('5.1b', 'Studio state right after a successful send', `studio still open: ${studioOpen}; verification panel visible: ${panelCount > 0}`);
    rec.check('5.2', 'UI shows the draft verification panel after sending (status/price/cost/stock/media/admin link)', panelCount > 0, panelCount ? '' : 'The Studio closed itself (AddItemModal onPackPublished) before the user could read the verification / category warning');
    if (panelCount) {
      const t = (await page.getByTestId('shopify-draft-verification').innerText()).replace(/\s+/g, ' ');
      rec.check('5.3', 'Panel: DRAFT, Status draft, Price 1200, Cost 500, Stock at location 5, media count, admin link', /DRAFT \(not live\)/.test(t) && /Status: draft/.test(t) && /Price: 1200/.test(t) && /Cost: 500/.test(t) && /Stock at location: 5/.test(t) && /Media count: [1-9]/.test(t), t.slice(0, 300));
      rec.check('5.4', `UI shows "${c.CATEGORY_MSG}" (category incomplete)`, (await page.getByTestId('shopify-category-not-set').count()) > 0 && (await page.getByTestId('shopify-category-not-set').innerText()).includes(c.CATEGORY_MSG));
      rec.check('5.5', 'Admin link to the draft is shown', (await page.getByRole('link', { name: /Open in Shopify admin/ }).count()) > 0);
      await shot(page, 'shopify-draft-verified');
    } else await shot(page, 'shopify-after-send-studio-closed');
    // server truth from the response
    const v = j.verification || {};
    rec.check('5.6', 'Server verification (read back from the store): draft, price 1200, cost 500, stock 5, media>0, admin URL', v.status === 'draft' && v.isDraft === true && v.variantPrice === SELL_ && v.cost === BUY_ && v.inventoryQuantity === QTY_ && (v.mediaCount || 0) > 0 && !!v.adminUrl, JSON.stringify({ status: v.status, price: v.variantPrice, cost: v.cost, stock: v.inventoryQuantity, media: v.mediaCount, admin: v.adminUrl && '(present)' }));
    rec.check('5.7', 'Category warning is part of the response (category_taxonomy_not_set / manual_required)', (j.warningCodes || []).includes('category_taxonomy_not_set') && j.categoryStatus === 'manual_required', JSON.stringify({ warningCodes: j.warningCodes, categoryStatus: j.categoryStatus }));
  });

  if (fake) {
    const drafts = fake.draftProducts();
    rec.check('5.8', 'Fake store: exactly one product, status draft, price/stock/cost as in SaazLedger', fake.products.size === 1 && drafts.length === 1 && drafts[0].variants[0].price.replace(/\.0+$/, '') === String(SELL_) && stock() === QTY_ && fake.invItems.get(drafts[0].variants[0].inventory_item_id)?.cost?.replace(/\.0+$/, '') === String(BUY_), `products=${fake.products.size} price=${drafts[0]?.variants[0].price} stock=${stock()} cost=${fake.invItems.get(drafts[0]?.variants[0].inventory_item_id)?.cost} media=${drafts[0]?.images.length}`);
  }
  const pid = fake ? String(fake.draftProducts()[0]?.id) : '';
  const row = dbq('SELECT shopify_product_id FROM items WHERE sku = ?', SKU)[0];
  rec.check('5.9', 'SQLite item now links to the Shopify draft product id', !!row?.shopify_product_id && (!fake || row.shopify_product_id === pid), `shopify_product_id=${row?.shopify_product_id}`);

  // ---- helper: (re)open studio for the item
  const reopenStudio = async () => {
    if ((await page.getByText('Media Pack Studio', { exact: true }).count()) > 0) return;
    if ((await page.getByText(/Register New Jewelry Piece|Edit Jewelry|Save Changes/).count()) === 0) {
      await page.locator('tr', { hasText: SKU }).first().getByTitle('Edit piece').click();
    }
    await page.getByRole('button', { name: /5-Slot Media Pack/ }).click();
    await page.getByText(/Recommended Shopify Gallery Pack/).waitFor({ timeout: 30_000 });
  };

  // ---- resend: no duplicate, zero writes
  await rec.step('5.10', 'Resend is idempotent', async () => {
    await reopenStudio();
    const w0 = writesNow();
    const rp = sendResp(); await sendBtn().click(); const resp = await rp; const j = await resp.json().catch(() => ({}));
    await page.waitForTimeout(1000);
    if (fake) {
      rec.check('5.10', 'Resend: still ONE product (no duplicate)', fake.products.size === 1 && fake.draftProducts().length === 1, `products=${fake.products.size}`);
      rec.check('5.11', 'Resend: ZERO writes to the store', writesNow() === w0, `writes before=${w0} after=${writesNow()}; HTTP ${resp.status()} action=${j.action} success=${j.success}`);
    } else rec.info('5.10', 'Resend (real store): verify in Shopify admin that exactly one draft exists for the SKU', `HTTP ${resp.status()} action=${j.action}`);
  });

  // ---- manual stock change -> confirm dialog
  const manualStock = async (n: number) => {
    if (fake) { fake.levels.set(levelKey(), n); return true; }
    if (flag('--skip-manual-stock')) return false;
    console.log(`\n>>> MANUAL STEP: in the Shopify TEST store admin open the draft for SKU ${SKU}, set the on-hand stock at your location to ${n}, then press Enter here.`);
    await new Promise<void>((r) => { const rl = readline.createInterface({ input: process.stdin }); rl.once('line', () => { rl.close(); r(); }); });
    return true;
  };
  const changed = await manualStock(7);
  if (!changed) rec.skip('5.12', 'Manual stock change flow', '--skip-manual-stock given');
  else {
    await rec.step('5.12', 'Manual stock 7 -> resend asks before overwriting', async () => {
      await reopenStudio();
      const w0 = writesNow();
      const rp = sendResp(); await sendBtn().click(); const resp = await rp;
      await page.getByTestId('shopify-overwrite-confirm').waitFor({ timeout: 15_000 }).catch(() => {});
      rec.check('5.12', 'Resend after manual stock change: confirm dialog appears (nothing written yet)', resp.status() === 409 && (await page.getByTestId('shopify-overwrite-confirm').count()) === 1, `HTTP ${resp.status()}`);
      const txt = await page.getByTestId('shopify-overwrite-confirm-text').innerText().catch(() => '');
      rec.check('5.13', 'Dialog names the Shopify value 7 and the SaazLedger value 5', /7/.test(txt) && /5/.test(txt), txt.slice(0, 240));
      await shot(page, 'shopify-overwrite-confirm');
      if (fake) rec.check('5.14', 'Nothing was written while the dialog is open', writesNow() === w0 && stock() === 7, `writes ${w0}->${writesNow()} stock=${stock()}`);
      // Keep
      const rk = page.waitForResponse((r) => r.url().includes('/api/media/pack/publish-shopify'), { timeout: 120_000 }).catch(() => null);
      await page.getByTestId('shopify-keep-value').click(); await rk; await page.waitForTimeout(1200);
      if (fake) rec.check('5.15', '"Keep Shopify value" leaves stock at 7 (no inventory write)', stock() === 7 && !fake.log.some((l) => l.path.includes('inventory_levels/set') && l.body?.available !== QTY_ ), `stock=${stock()}`);
      // Overwrite after explicit confirm
      await reopenStudio();
      const rp2 = sendResp(); await sendBtn().click(); await rp2;
      await page.getByTestId('shopify-overwrite-confirm').waitFor({ timeout: 30_000 });
      const stockBefore = stock();
      const rp3 = page.waitForResponse((r) => r.url().includes('/api/media/pack/publish-shopify'), { timeout: 120_000 });
      await page.getByTestId('shopify-overwrite-value').click(); await rp3; await page.waitForTimeout(1200);
      if (fake) rec.check('5.16', '"Overwrite" only after explicit click sets stock to 5', stockBefore === 7 && stock() === QTY_, `before=${stockBefore} after=${stock()}`);
      else rec.info('5.16', 'Real store: verify in Shopify admin the stock is now 5');
      await shot(page, 'shopify-after-overwrite');
    });
  }

  // ---- seeded LIVE product with the same SKU must block
  if (fake) {
    await rec.step('5.17', 'Live product with same SKU blocks the send', async () => {
      const liveSku = 'E2E-LIVE-SKU-0001';
      fake.seed({ id: 9001, title: 'Seeded LIVE product', status: 'active', sku: liveSku, price: '999.00', qty: 3 });
      const created = await api(adminTok, 'POST', '/api/inventory', { id: 'it_live_clash', clientItemId: 'cli_live_clash_0001', sku: liveSku, title: 'Live clash piece', typeCode: 'PD', stoneCode: 'D', colorCode: '01', serial: '99999', quantity: 2, buyingPrice: 100, sellingPrice: 300, vendor: VENDOR, status: 'active' });
      rec.info('5.17a', 'Created second item via API for the live-SKU clash', `HTTP ${created.status}`);
      const w0 = fake.writesTouching(9001).length; const all0 = writesNow(); const prodCount = fake.products.size;
      // close any open modals, reload list
      await page.reload(); await page.getByText(liveSku).first().waitFor({ timeout: 60_000 });
      const rp = page.waitForResponse((r) => r.url().includes('/api/shopify/send-draft'), { timeout: 120_000 });
      await page.locator('tr', { hasText: liveSku }).first().getByTitle(/Push piece to Shopify|Update on Shopify/).click();
      const resp = await rp; const j = await resp.json().catch(() => ({}));
      await page.waitForTimeout(800);
      rec.check('5.17', 'Send of an item whose SKU matches a LIVE product is blocked (HTTP 409, manual review) with a clear message', resp.status() === 409 && !!j.needsManualReview, `HTTP ${resp.status()} ${JSON.stringify(j).slice(0, 220)}`);
      rec.check('5.18', 'ZERO writes to the live product and no product created', fake.writesTouching(9001).length === w0 && writesNow() === all0 && fake.products.size === prodCount, `writes touching live=${fake.writesTouching(9001).length}, total writes ${all0}->${writesNow()}`);
      rec.check('5.19', 'UI told the user it failed (alert dialog)', c.dialogs.some((d) => /Failed to sync|manual review|live/i.test(d)), c.dialogs.slice(-2).join(' || ').slice(0, 200));
      await shot(page, 'shopify-live-sku-blocked');
    });
  } else rec.skip('5.17', 'Seeded LIVE product with same SKU', 'cannot seed a live product into a real store from this script (and must not)');

  // ---- viewer must not see/use Shopify send
  await rec.step('5.20', 'Viewer UI: Shopify send controls', async () => {
    const vp = c.vctx.pages()[0]; // the viewer is still signed in from phase 1
    await vp.goto(S.baseUrl);
    await vp.getByText(SKU).first().waitFor({ timeout: 60_000 });
    const push = await vp.locator('tr', { hasText: SKU }).first().getByTitle(/Push piece to Shopify|Update on Shopify/).count();
    const edit = await vp.locator('tr', { hasText: SKU }).first().getByTitle('Edit piece').count();
    rec.check('5.20', 'Viewer does NOT see the "Push to Shopify" / "Edit" row actions', push === 0 && edit === 0, `push buttons=${push}, edit buttons=${edit}`);
    await shot(vp, 'viewer-inventory-row');
  });

  if (fake) rec.check('5.21', 'Fake store recorded NO draft-only violations (no non-draft writes, no live writes)', fake.violations.length === 0, `violations=${JSON.stringify(fake.violations)}`);
  else rec.info('5.21', 'Real store: this script only ever sends drafts; confirm in Shopify admin that nothing was published');
}

const QTY_ = QTY, BUY_ = BUY, SELL_ = SELL;

function gitHead(): string { try { return execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch { return '?'; } }
function snapshotRepoData(): string {
  const parts: string[] = [];
  for (const d of ['data', 'uploads']) {
    const walk = (p: string) => { if (!fs.existsSync(p)) return; for (const f of fs.readdirSync(p, { withFileTypes: true })) { const fp = path.join(p, f.name); if (f.isDirectory()) walk(fp); else { const s = fs.statSync(fp); parts.push(`${fp}:${s.size}:${s.mtimeMs}`); } } };
    walk(path.join(REPO, d));
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

main().catch((e) => { console.error('FATAL', e); try { rec.fail('FATAL', 'Unhandled error', String(e?.stack || e).slice(0, 500)); } catch { /* ignore */ } process.exit(1); });
