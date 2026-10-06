/**
 * Drives the REAL UI of the deployed commit (68398e6) with Playwright against an isolated server
 * (temp DATA_DIR) and shows exactly what its Data Hub export / restore captures and recovers.
 *
 * Run: PW_CORE=/path/to/node_modules/playwright-core npx tsx scripts/rollback-drill/01-deployed-backup-coverage.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { api, buildClient, check, closeOutput, extractCommit, fingerprint, log, mkTmp, results, setOutputFile, startServer, DEPLOYED_COMMIT, REPO_ROOT, type Srv } from './lib';
import { seedDeployed } from './seed';

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';

async function loadPlaywright(): Promise<any> {
  const cands = [process.env.PW_CORE, 'playwright-core'].filter(Boolean) as string[];
  for (const c of cands) {
    try { return await import(c.startsWith('/') ? pathToFileURL(path.join(c, 'index.mjs')).href : c); } catch { /* try next */ }
  }
  throw new Error('playwright-core not found. Set PW_CORE=/abs/path/to/node_modules/playwright-core');
}

const AUTH_INIT = `
  if (!localStorage.getItem('saaz_auth_token')) {
    localStorage.setItem('saaz_auth_token', 'demo_admin_token');
    localStorage.setItem('saaz_auth_user', JSON.stringify({ id: 'usr_admin_hasan', username: 'hasan_laiq', fullName: 'Laiq Hasan', email: 'hasan.laiq@gmail.com', role: 'admin', status: 'active' }));
  }`;

async function main() {
  const outFile = process.env.OUT || path.join(REPO_ROOT, 'docs/evidence/deployed-backup-coverage-output.txt');
  setOutputFile(outFile);
  const pw = await loadPlaywright();
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const code = extractCommit(DEPLOYED_COMMIT, 'deployed');
  buildClient(code);
  log(`# Deployed-app backup coverage (commit ${DEPLOYED_COMMIT}) -- real UI, isolated server, temp DATA_DIR`);
  const dl = mkTmp('downloads');

  const openDataHub = async (page: any, base: string) => {
    await page.goto(base);
    await page.getByText('Master Data').first().click();
    await page.getByText('Data Hub').first().click();
    await page.getByText('Data Hub: CSV Import, Shopify & Backups').waitFor();
  };
  const waitForLocalItems = (page: any, n: number) =>
    page.waitForFunction((k: number) => JSON.parse(localStorage.getItem('saaz_ledger_inventory_v1') || '[]').length >= k, n, { timeout: 20000 });

  // ------------------------------------------------------------------ S1: what does the export contain?
  log('\n## S1. Seed production-like data, then use Data Hub exports');
  const dataA = mkTmp('dataA');
  const srvA: Srv = await startServer(code, dataA);
  const manifest = await seedDeployed(srvA);
  const fpOriginal = fingerprint(dataA);
  log('Seeded server fingerprint (what a full backup SHOULD be able to restore):');
  log(fpOriginal);

  const ctx1 = await browser.newContext({ acceptDownloads: true });
  await ctx1.addInitScript(AUTH_INIT);
  const page1 = await ctx1.newPage();
  await openDataHub(page1, srvA.base);
  await waitForLocalItems(page1, 3);
  await page1.getByRole('button', { name: /Full JSON Backup/ }).click().catch(() => {});
  const [d1] = await Promise.all([page1.waitForEvent('download'), page1.getByText('Full JSON Backup').first().click()]);
  const jsonPath = path.join(dl, d1.suggestedFilename());
  await d1.saveAs(jsonPath);
  const backup = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  log(`Downloaded: ${d1.suggestedFilename()} (${fs.statSync(jsonPath).size} bytes)`);
  log('Top-level keys in JSON backup:', Object.keys(backup));
  log('Item count in backup:', backup.inventory.length, '| first item keys:', Object.keys(backup.inventory[0]).join(','));
  const b0 = backup.inventory.find((i: any) => i.title === 'Kundan Pendant Set');
  log('Headline item as exported:', { sku: b0.sku, quantity: b0.quantity, buyingPrice: b0.buyingPrice, sellingPrice: b0.sellingPrice, imageUrl: b0.imageUrl && String(b0.imageUrl).slice(0, 60) });
  const raw = JSON.stringify(backup);
  check('S1 backup contains inventory items', backup.inventory.length === 3);
  check('S1 backup contains NO vendors key', !('vendors' in backup), 'vendors are not exported');
  check('S1 backup contains NO stock movements/lots', !/purchase_lots|stock_movements|movements/.test(raw));
  check('S1 backup contains NO users', !/staff1@example.test/.test(raw));
  check('S1 backup contains NO media links/assets', !/med_|product_media/.test(raw));
  check('S1 backup contains NO SKU sequence counters', !/currentSerial|last_serial|startingSerial/.test(raw));
  check('S1 backup holds photo URLs only, no image bytes', !/data:image/.test(raw) && /\/api\/photos\//.test(raw), 'photo bytes live only in server disk/photo_blobs');
  check('S1 headline item qty/buy/sell correct in export (qty reflects the sale: 4)', b0.quantity === 4 && b0.buyingPrice === 500 && b0.sellingPrice === 1200);

  // CSV export
  await page1.getByText('Export & Integrations').click();
  const [d2] = await Promise.all([page1.waitForEvent('download'), page1.getByText('Shopify CSV Export').first().click()]);
  const csvPath = path.join(dl, d2.suggestedFilename());
  await d2.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  log(`Shopify CSV: ${d2.suggestedFilename()} header: ${csv.split('\n')[0]}`);
  log('Shopify CSV lines (rows):', csv.trim().split('\n').length - 1);
  check('S1 Shopify CSV is a Shopify product import file (no restore path in app)', /Handle/.test(csv.split('\n')[0]));
  await ctx1.close();

  // ------------------------------------------------------------------ S4: server-side "Backup Database to S3" endpoint
  log('\n## S4. Server-side "Backup Database to S3 Now" (MediaStorageSettingsModal) -- needs S3; the route builds the JSON first');
  await srvA.stop();
  const srvA2 = await startServer(code, dataA, { AWS_S3_BUCKET: 'drill-fake-bucket', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', AWS_REGION: 'us-east-1' });
  const s3 = await api(srvA2, 'POST', '/api/media-settings/backup-db-to-s3');
  log('POST /api/media-settings/backup-db-to-s3 ->', s3);
  check('S4 S3 DB-backup route is broken in deployed code (queries non-existent table jewelry_items)', s3.status === 500 && /no such table: jewelry_items/.test(JSON.stringify(s3.json)), 'actual: ' + JSON.stringify(s3.json));
  const ph = await api(srvA2, 'GET', '/api/photos/status');
  log('GET /api/photos/status ->', ph.json);
  await srvA2.stop();

  // ------------------------------------------------------------------ S3: restore over a LIVE (non-empty) server
  log('\n## S3. Restore the JSON over a LIVE server that has since changed (item deleted, qty altered)');
  const srvB = await startServer(code, dataA);
  const itemsNow = (await api(srvB, 'GET', '/api/inventory?include_deleted=true')).json.items;
  const victim = itemsNow.find((i: any) => i.title === 'Ruby Ring');
  const other = itemsNow.find((i: any) => i.title === 'Pearl Drop Earrings');
  await api(srvB, 'DELETE', `/api/inventory/${victim.id}?hard=true`);
  await api(srvB, 'PUT', `/api/inventory/${other.id}`, { quantity: 99, sellingPrice: 1 });
  const before = fingerprint(dataA);
  log('Server after damage: items =', before.items.map((i: any) => `${i.sku} q${i.quantity} sell${i.sell}`));
  const ctx3 = await browser.newContext({ acceptDownloads: true });
  await ctx3.addInitScript(AUTH_INIT);
  const page3 = await ctx3.newPage();
  await openDataHub(page3, srvB.base);
  await waitForLocalItems(page3, 2);
  await page3.getByText('Backups & Reset').click();
  await page3.locator('input[type=file][accept=".json"]').setInputFiles(jsonPath);
  await page3.getByText('Backup imported and ledger restored!').waitFor();
  const lsAfterRestore = await page3.evaluate(() => JSON.parse(localStorage.getItem('saaz_ledger_inventory_v1') || '[]').map((i: any) => `${i.sku} q${i.quantity}`));
  log('UI shows "Backup imported and ledger restored!"  localStorage now:', lsAfterRestore);
  await page3.waitForTimeout(1500);
  await page3.reload();
  await page3.waitForTimeout(3000);
  const lsAfterReload = await page3.evaluate(() => JSON.parse(localStorage.getItem('saaz_ledger_inventory_v1') || '[]').map((i: any) => `${i.sku} q${i.quantity} sell${i.sellingPrice}`));
  const after = fingerprint(dataA);
  log('After page reload localStorage:', lsAfterReload);
  log('Server after restore + reload: items =', after.items.map((i: any) => `${i.sku} q${i.quantity} sell${i.sell}`));
  check('S3 restore did NOT write anything to the server DB', JSON.stringify(before.items) === JSON.stringify(after.items), 'server rows unchanged');
  check('S3 deleted item NOT recovered on server', !after.items.some((i: any) => i.title === 'Ruby Ring'));
  check('S3 altered item NOT reverted on server (qty 99 / sell 1 remain)', after.items.some((i: any) => i.quantity === 99 && i.sell === 1));
  check('S3 after reload the browser view reverts to server data (restore silently discarded)', lsAfterReload.some((s: string) => s.includes('q99')));
  await ctx3.close();
  await srvB.stop();

  // ------------------------------------------------------------------ S2: disaster: new empty volume
  log('\n## S2a. Disaster: server DB + volume lost (empty DATA_DIR) AND a fresh browser (new device). Restore the JSON via Data Hub');
  const dataC = mkTmp('dataC');
  const srvC = await startServer(code, dataC);
  const ctx2 = await browser.newContext({ acceptDownloads: true });
  await ctx2.addInitScript(AUTH_INIT);
  const page2 = await ctx2.newPage();
  await openDataHub(page2, srvC.base);
  await page2.waitForTimeout(2500);
  const lsFresh = await page2.evaluate(() => JSON.parse(localStorage.getItem('saaz_ledger_inventory_v1') || '[]').map((i: any) => i.sku));
  log('Fresh browser first-load localStorage inventory (auto demo seed):', lsFresh);
  log('Server inventory after first load of fresh browser:', (await api(srvC, 'GET', '/api/inventory')).json.items.map((i: any) => i.sku));
  await page2.getByText('Backups & Reset').click();
  await page2.locator('input[type=file][accept=".json"]').setInputFiles(jsonPath);
  await page2.getByText('Backup imported and ledger restored!').waitFor();
  await page2.reload();
  await page2.waitForTimeout(4000);
  const fpC = fingerprint(dataC);
  log('Server fingerprint after restore + reload (fresh volume):');
  log(fpC);
  const restoredSkus = fpC.items.map((i: any) => i.sku);
  const origSkus = fpOriginal.items.map((i: any) => i.sku);
  check('S2a original SKUs present on server after restore', origSkus.every((s: string) => restoredSkus.includes(s)), `server has ${JSON.stringify(restoredSkus)}`);

  const photoStatus = async (srv: Srv, urls: string[]) => Promise.all(urls.map(async (u) => `${u.split('/').pop()}=${(await fetch(srv.base + u)).status}`));
  const origPhotoUrls = manifest.photoUrls;
  log('S2a photo URLs of the 3 seeded items on the NEW server:', await photoStatus(srvC, origPhotoUrls));
  check('S2a photo bytes NOT recovered by JSON restore (fresh browser/volume)', (await photoStatus(srvC, origPhotoUrls)).every((x) => x.endsWith('=404')), 'JSON holds URLs only');
  await ctx2.close();
  await srvC.stop();

  // S2b: same browser (same port => same origin => localStorage AND IndexedDB photo cache survive), server volume replaced by an empty one
  log('\n## S2b. Disaster: server volume lost but SAME browser profile still has localStorage + IndexedDB (the only auto-recovery the app has)');
  const dataD = mkTmp('dataD');
  const portD = 4900 + Math.floor(Math.random() * 90);
  const srvD0 = await startServer(code, dataD, {}, portD);
  const m2 = await seedDeployed(srvD0);
  const fpD0 = fingerprint(dataD);
  const ctx4 = await browser.newContext();
  await ctx4.addInitScript(AUTH_INIT);
  const page4 = await ctx4.newPage();
  await page4.goto(srvD0.base);
  await waitForLocalItems(page4, 3);
  await page4.waitForTimeout(2500); // let photos load so the client cache is primed
  const lsState = await page4.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  await srvD0.stop();
  const dataD2 = mkTmp('dataD2'); // brand-new empty volume
  const srvD = await startServer(code, dataD2, {}, portD);
  await page4.reload();
  await page4.waitForTimeout(6000);
  const fpD = fingerprint(dataD2);
  log('Original (before loss):', { items: fpD0.items.map((i: any) => `${i.sku} q${i.quantity}`), lots: fpD0.purchase_lots, movements: fpD0.stock_movements, vendors: fpD0.vendors, media_assets: fpD0.media_assets, media_links: fpD0.product_media_links, users: fpD0.users, sku_sequences: fpD0.sku_sequences, global_sku_sequence: fpD0.global_sku_sequence });
  log('Recovered (auto re-upload from browser):', { items: fpD.items.map((i: any) => `${i.sku} q${i.quantity} buy${i.buy} sell${i.sell} vendor=${i.vendor_name} img=${i.image_url}`), lots: fpD.purchase_lots, movements: fpD.stock_movements, vendors: fpD.vendors, media_assets: fpD.media_assets, media_links: fpD.product_media_links, users: fpD.users, sku_sequences: fpD.sku_sequences, global_sku_sequence: fpD.global_sku_sequence, photo_blobs: fpD.photo_names_blob });
  const ps = await photoStatus(srvD, m2.photoUrls);
  log('Photo URL status on new server (same browser profile; NOTE its IndexedDB photo cache was never primed because the photos were seeded via API, not uploaded through this browser, so the IndexedDB self-heal path (photoCacheService) is NOT exercised here):', ps);
  check('S2b items re-uploaded from browser when server empty', fpD.items.length === 3);
  check('S2b movement history NOT recovered', fpD.stock_movements === 0 && fpD0.stock_movements > 0, `${fpD0.stock_movements} -> ${fpD.stock_movements}`);
  check('S2b purchase lots (FIFO cost layers) NOT recovered', fpD.purchase_lots === 0 && fpD0.purchase_lots > 0, `${fpD0.purchase_lots} -> ${fpD.purchase_lots}`);
  check('S2b media assets/links NOT recovered', fpD.product_media_links === 0 && fpD0.product_media_links > 0);
  check('S2b global SKU sequence NOT recovered (reset to 0 -> risk of SKU reuse)', fpD.global_sku_sequence[0]?.current_serial === 0 && fpD0.global_sku_sequence[0]?.current_serial >= 999, JSON.stringify(fpD.global_sku_sequence));
  check('S2b per-combination sku_sequences NOT recovered (counters restart at 0 -> duplicate SKU risk)', fpD.sku_sequences.length === 0 && fpD0.sku_sequences.length > 0);
  check('S2b non-default user (staff1) NOT recovered', !fpD.users.includes('staff1@example.test'));
  check('S2b photos NOT recovered (IndexedDB self-heal unexercised: cache unprimed)', ps.every((x) => x.endsWith('=404')));
  await ctx4.close();

  // S2b': the same localStorage but NO IndexedDB (browser storage partially cleared / another browser profile with only localStorage)
  log('\n## S2b-prime. Same, but the browser has no IndexedDB photo cache');
  const dataE = mkTmp('dataE');
  const srvE = await startServer(code, dataE);
  const ctx6 = await browser.newContext();
  await ctx6.addInitScript((s: any) => { if (!localStorage.getItem('saaz_ledger_inventory_v1')) for (const k of Object.keys(s)) localStorage.setItem(k, s[k]); }, lsState);
  await ctx6.addInitScript(AUTH_INIT);
  const page6 = await ctx6.newPage();
  await page6.goto(srvE.base);
  await page6.waitForTimeout(5000);
  const psE = await photoStatus(srvE, m2.photoUrls);
  log('Photo URL status on new server (no IndexedDB):', psE, ' items:', fingerprint(dataE).items.length);
  check('S2b-prime photos NOT recovered when browser has no IndexedDB cache', psE.every((x) => x.endsWith('=404')));
  await ctx6.close();
  await srvE.stop();
  await srvD.stop();

  await browser.close();

  log('\n## SUMMARY');
  for (const r of results) log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.step}`);
  closeOutput();
}
main().catch((e) => { console.error(e); process.exit(1); });
