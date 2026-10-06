/**
 * Re-runnable rollback drill: deployed code (68398e6) <-> this branch's code, real SQLite files, real HTTP servers.
 *
 *   npx tsx scripts/rollback-drill/run.ts            (writes docs/evidence/rollback-drill-output.txt; override with OUT=)
 *
 * Both code versions are extracted with `git archive` into temp dirs (no worktree needed). Everything runs against
 * temp DATA_DIRs. Never touches ./data, Railway, Shopify or the network.
 *
 *  A  create DB with OLD code, snapshot + sha256
 *  B  run NEW code on a COPY (additive migrations), exercise new features
 *  C  run OLD code on the migrated DB (code-only rollback), exercise it, check new-code data intact; then roll forward again
 *  D  restore the pre-migration snapshot over the migrated DB, run OLD code, prove row-wise equality, quantify data-loss window
 *  E  photos: nothing orphaned/deleted by rollback; pack-draft references
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  api, check, ONE_LINER_BACKUP, ONE_LINER_RESTORE, closeOutput, copyDir, DEPLOYED_COMMIT, diffDumps, dumpAll, extractCommit, listFilesWithHash, log, makePng, mkTmp,
  referencedPhotoNames, REPO_ROOT, results, schemaObjects, setOutputFile, sha256File, snapshotDb, startServer, openDb, type Srv,
} from './lib';
import { seedDeployed } from './seed';

const NEW_ONLY_COLS = ['client_item_id', 'original_image_url', 'white_bg_image_url'];
const NEW_ONLY_TABLES = ['media_pack_drafts'];

function dropNewOnly(dump: Record<string, any[]>) {
  const out: Record<string, any[]> = {};
  for (const [t, rows] of Object.entries(dump)) {
    if (NEW_ONLY_TABLES.includes(t)) continue;
    out[t] = rows.map((r) => (t === 'items' ? Object.fromEntries(Object.entries(r).filter(([k]) => !NEW_ONLY_COLS.includes(k))) : r));
  }
  return out;
}
/** system_settings.updated_at is rewritten on every boot (google client id upsert): not data. */
function norm(dump: Record<string, any[]>) {
  return { ...dump, system_settings: (dump.system_settings || []).map(({ updated_at: _u, ...r }) => r) };
}
const integrity = (p: string) => { const d = openDb(p); const r = (d.pragma('integrity_check') as any[]).map((x) => x.integrity_check).join(','); const fk = (d.pragma('foreign_key_check') as any[]).length; d.close(); return { integrity: r, fk }; };
const errorsIn = (s: Srv) => s.log().split('\n').filter((l) => /error|uncaught|SQLITE_|constraint failed/i.test(l) && !/^\s*$/.test(l));

async function main() {
  setOutputFile(process.env.OUT || path.join(REPO_ROOT, 'docs/evidence/rollback-drill-output.txt'));
  const newHead = (await import('node:child_process')).execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  log(`# Rollback drill. OLD = deployed ${DEPLOYED_COMMIT}; NEW = this branch HEAD ${newHead} (git archive of committed tree)`);
  const oldCode = extractCommit(DEPLOYED_COMMIT, 'old');
  const newCode = extractCommit('HEAD', 'new');
  const root = mkTmp('drill');
  const dir = (n: string) => path.join(root, n);
  const dbOf = (d: string) => path.join(d, 'saaz_ledger.db');

  // ============================================================ A
  log('\n## A. Create DB with OLD (deployed) code; snapshot + sha256');
  const dataA = dir('A');
  let srv = await startServer(oldCode, dataA);
  const m = await seedDeployed(srv);
  // extra: a soft-deleted item and a global sku allocation so those paths exist in the data
  const soft = await api(srv, 'POST', '/api/inventory', { title: 'Soft Deleted Bangle', typeCode: 'BG', stoneCode: 'ZZ', colorCode: 'GD', quantity: 2, buyingPrice: 500, sellingPrice: 1200 });
  await api(srv, 'DELETE', `/api/inventory/${soft.json.item.id}`, {});
  const alloc = await api(srv, 'POST', '/api/sku/allocate-global', { typeCode: 'NK', stoneCode: 'KU', colorCode: 'GD' });
  log('seed manifest:', { items: m.items.map((i) => `${i.sku} q${i.quantity} buy${i.buyingPrice} sell${i.sellingPrice}`), vendors: m.vendors.map((v) => v.code), mediaIds: m.mediaIds, users: m.users, globalSkuAllocated: alloc.json?.sku || alloc.status });
  await srv.stop();
  const snapA = path.join(root, 'snapshots', 'pre-migration.db');
  await snapshotDb(dbOf(dataA), snapA);
  const shaA = sha256File(snapA);
  const photosA = listFilesWithHash(path.join(dataA, 'uploads/photos'));
  const dumpA = dumpAll(snapA);
  const schemaA = schemaObjects(snapA);
  fs.writeFileSync(path.join(root, 'snapshots', 'pre-migration.sha256'), `${shaA}  pre-migration.db\n`);
  log('snapshot sha256:', shaA, '| photo files in uploads:', Object.keys(photosA).length, '| tables:', schemaA.tables.length, '| triggers:', schemaA.triggers);
  log('row counts A:', Object.fromEntries(Object.entries(dumpA).filter(([, r]) => r.length).map(([t, r]) => [t, r.length])));
  check('A1 snapshot integrity_check ok', integrity(snapA).integrity === 'ok');
  check('A2 old schema has none of the new columns/tables', !NEW_ONLY_COLS.some((c) => schemaA.itemsColumns.includes(c)) && !schemaA.tables.includes('media_pack_drafts'));

  // ============================================================ B
  log('\n## B. NEW code on a COPY of the snapshot (additive migrations run) + exercise new features');
  const dataB = dir('B');
  fs.mkdirSync(dataB, { recursive: true });
  fs.copyFileSync(snapA, dbOf(dataB));
  copyDir(path.join(dataA, 'uploads'), path.join(dataB, 'uploads'));
  srv = await startServer(newCode, dataB);
  const schemaB = schemaObjects(dbOf(dataB));
  log('new columns present:', NEW_ONLY_COLS.filter((c) => schemaB.itemsColumns.includes(c)), '| new tables:', schemaB.tables.filter((t) => !schemaA.tables.includes(t)), '| new indexes:', schemaB.indexes.filter((t) => !schemaA.indexes.includes(t)));
  check('B1 NEW code starts on migrated copy and adds client_item_id/original_image_url/white_bg_image_url + media_pack_drafts', NEW_ONLY_COLS.every((c) => schemaB.itemsColumns.includes(c)) && schemaB.tables.includes('media_pack_drafts'));
  const invB0 = (await api(srv, 'GET', '/api/inventory?include_deleted=true')).json.items;
  check('B2 NEW code reads all pre-existing items with identical qty/prices', m.items.every((mi) => { const x = invB0.find((i: any) => i.sku === mi.sku); return x && x.quantity === mi.quantity && x.buyingPrice === 500 && x.sellingPrice === 1200; }), `${invB0.length} items listed incl. soft-deleted`);

  const photoOrig = await api(srv, 'POST', '/api/photos/upload', { base64Data: `data:image/png;base64,${(await makePng([5, 5, 5], 90)).toString('base64')}` });
  const photoWhite = await api(srv, 'POST', '/api/photos/upload', { base64Data: `data:image/png;base64,${(await makePng([250, 250, 250], 90)).toString('base64')}` });
  const body = { clientItemId: 'drill-cid-1', title: 'New-Code Choker', typeCode: 'NK', stoneCode: 'PR', colorCode: 'WH', quantity: 5, buyingPrice: 500, sellingPrice: 1200, imageUrl: photoWhite.json.url, originalImageUrl: photoOrig.json.url, whiteBgImageUrl: photoWhite.json.url };
  const c1 = await api(srv, 'POST', '/api/inventory', body);
  const c2 = await api(srv, 'POST', '/api/inventory', body);
  log('idempotent create:', { first: [c1.status, c1.json.created, c1.json.item.sku], second: [c2.status, c2.json.created, c2.json.item.id === c1.json.item.id] });
  check('B3 idempotent create: same clientItemId twice -> 1 item (201 then 200)', c1.status === 201 && c2.status === 200 && c2.json.item.id === c1.json.item.id);
  const noKey1 = await api(srv, 'POST', '/api/inventory', { title: 'NoKey One', typeCode: 'ER', stoneCode: 'PR', colorCode: 'WH', quantity: 3, buyingPrice: 500, sellingPrice: 1200 });
  const noKey2 = await api(srv, 'POST', '/api/inventory', { title: 'NoKey Two', typeCode: 'ER', stoneCode: 'PR', colorCode: 'WH', quantity: 3, buyingPrice: 500, sellingPrice: 1200 });
  check('B4 two NEW-code items without clientItemId (NULLs) both insert', noKey1.status === 201 && noKey2.status === 201);
  const pack = { productId: c1.json.item.id, sku: c1.json.item.sku, originalAssets: [{ url: photoOrig.json.url }], slots: [{ slot: 'hero', url: photoWhite.json.url, productId: c1.json.item.id }] };
  const pd = await api(srv, 'PUT', '/api/media-pack-drafts/drill-cid-1', { pack, sku: c1.json.item.sku, itemId: c1.json.item.id });
  const pdGet = await api(srv, 'GET', '/api/media-pack-drafts/drill-cid-1');
  check('B5 pack draft saved + read back', pd.status < 300 && pdGet.json.draft?.originalRefs?.includes(photoOrig.json.url), `status ${pd.status}`);
  const edit = await api(srv, 'PUT', `/api/inventory/${m.items[1].id}`, { quantity: 7, sellingPrice: 1300 });
  const sale = await api(srv, 'POST', '/api/inventory/sale', { itemId: m.items[2].id, quantitySold: 2, salePrice: 1200 });
  check('B6 NEW code edits an old item and records a sale', edit.status === 200 && sale.status === 200);
  await srv.stop();
  const dumpB = dumpAll(dbOf(dataB));
  const imgsB = listFilesWithHash(path.join(dataB, 'uploads/photos'));
  log('row counts B:', Object.fromEntries(Object.entries(dumpB).filter(([, r]) => r.length).map(([t, r]) => [t, r.length])));
  const sumB = integrity(dbOf(dataB));
  check('B7 migrated DB integrity_check ok, foreign_key_check clean', sumB.integrity === 'ok' && sumB.fk === 0, JSON.stringify(sumB));
  const newItemRow = dumpB.items.find((r) => r.client_item_id === 'drill-cid-1');

  // ============================================================ C
  log('\n## C. OLD code against the MIGRATED DB (code-only rollback; no data restore)');
  const dataC = dir('C');
  fs.mkdirSync(dataC, { recursive: true });
  await snapshotDb(dbOf(dataB), dbOf(dataC)); // consistent copy of B (keeps B pristine for D)
  copyDir(path.join(dataB, 'uploads'), path.join(dataC, 'uploads'));
  const preC = dumpAll(dbOf(dataC));
  srv = await startServer(oldCode, dataC);
  check('C1 OLD code starts on migrated DB, no error lines in its log', errorsIn(srv).length === 0, errorsIn(srv).slice(0, 3).join(' | '));
  const invC = (await api(srv, 'GET', '/api/inventory?include_deleted=true')).json;
  const invCItems: any[] = invC.items;
  check('C2 OLD code lists every item incl. those created by NEW code', invCItems.length === preC.items.length && ['New-Code Choker', 'NoKey One', 'NoKey Two'].every((t) => invCItems.some((i) => i.title === t)), `${invCItems.length} listed vs ${preC.items.length} rows`);
  const choker = invCItems.find((i) => i.title === 'New-Code Choker');
  check('C3 new-code item shows correct qty/buy/sell/main image in OLD code', choker.quantity === 5 && choker.buyingPrice === 500 && choker.sellingPrice === 1200 && choker.imageUrl === photoWhite.json.url, JSON.stringify({ q: choker.quantity, b: choker.buyingPrice, s: choker.sellingPrice, img: choker.imageUrl }));
  const editedC = invCItems.find((i) => i.sku === m.items[1].sku);
  check('C4 NEW-code edit (qty 7, sell 1300) visible in OLD code', editedC.quantity === 7 && editedC.sellingPrice === 1300);
  log('NOT visible to OLD code (documented limitation): originalImageUrl/whiteBgImageUrl/clientItemId =>', { originalImageUrl: String(choker.originalImageUrl), whiteBgImageUrl: String(choker.whiteBgImageUrl), clientItemId: String(choker.clientItemId) }, '(values exist in the DB row, see C19)');
  check('C5 OLD API does not expose originalImageUrl/whiteBgImageUrl/clientItemId (data present in DB but invisible)', choker.originalImageUrl === undefined && choker.whiteBgImageUrl === undefined && choker.clientItemId === undefined);

  // old-code writes
  const oc = await api(srv, 'POST', '/api/inventory', { title: 'Old-Code Anklet', typeCode: 'AN', stoneCode: 'ZZ', colorCode: 'SL', quantity: 5, buyingPrice: 500, sellingPrice: 1200 });
  const oc2 = await api(srv, 'POST', '/api/inventory', { title: 'Old-Code Anklet 2', typeCode: 'AN', stoneCode: 'ZZ', colorCode: 'SL', quantity: 1, buyingPrice: 500, sellingPrice: 1200 });
  check('C6 OLD code creates items on migrated schema (INSERT leaves client_item_id NULL; partial UNIQUE index OK for 2 rows)', oc.status === 201 && oc2.status === 201, `${oc.status}/${oc2.status} ${oc.json.error || ''}`);
  const up = await api(srv, 'PUT', `/api/inventory/${choker.id}`, { quantity: 6, notes: 'edited by old code', imageUrl: photoWhite.json.url });
  check('C7 OLD code updates a new-code item', up.status === 200 && up.json.item.quantity === 6);
  const adj = await api(srv, 'POST', `/api/inventory/${choker.id}/adjust`, { delta: -1 });
  check('C8 OLD code stock adjust/sale on new-code item', adj.status === 200, JSON.stringify(adj.json).slice(0, 120));
  const vend = await api(srv, 'POST', '/api/vendors', { id: 'vendor_C', code: 'CCC', name: 'Old-Code Vendor' });
  check('C9 OLD code vendor create', vend.status === 200);
  const ptoken = (await api(srv, 'POST', '/api/auth/google/dev-login', { email: 'hasan.laiq@gmail.com', name: 'Laiq Hasan', role: 'admin', status: 'active' })).json.token;
  const mp = await makePng([90, 10, 10], 70);
  const mup = await api(srv, 'POST', '/api/media/upload-direct', { base64Data: `data:image/png;base64,${mp.toString('base64')}`, filename: 'old_code_media.png' }, ptoken);
  const mid = mup.json.asset?.id || mup.json.id;
  const lnk = await api(srv, 'POST', `/api/products/${choker.id}/media/link`, { mediaId: mid, slotType: 'gallery' });
  check('C10 OLD code media upload + link to a new-code item', mup.status === 200 && lnk.status === 200, `${mup.status}/${lnk.status}`);
  const del1 = await api(srv, 'DELETE', `/api/inventory/${oc2.json.item.id}`, {});
  const del2 = await api(srv, 'DELETE', `/api/inventory/${oc2.json.item.id}?hard=true`, {});
  check('C11 OLD code soft + hard delete', del1.status === 200 && del2.status === 200);
  const bm = await api(srv, 'POST', '/api/backup/migrate-browser', { inventory: [{ id: 'browser_1', sku: 'ZZZZZZ777', title: 'Browser Import', typeCode: 'ZZ', stoneCode: 'ZZ', colorCode: 'ZZ', serial: '777', buyingPrice: 500, sellingPrice: 1200, quantity: 5 }], vendors: [] });
  check('C12 OLD code browser-migration import (INSERT ... ON CONFLICT) works', bm.status === 200, JSON.stringify(bm.json));
  // hard delete the NEW-code item: confirm photo files survive and the pack draft row is simply orphaned (no FK)
  const hdel = await api(srv, 'DELETE', `/api/inventory/${choker.id}?hard=true`);
  check('C13 OLD code hard-deletes a NEW-code item without error', hdel.status === 200, JSON.stringify(hdel.json).slice(0, 100));
  const errsC = errorsIn(srv);
  check('C14 no server errors in OLD code log during the whole rollback session', errsC.length === 0, errsC.slice(0, 5).join(' | '));
  await srv.stop();
  const postC = dumpAll(dbOf(dataC));
  const schemaC = schemaObjects(dbOf(dataC));
  check('C15 migrated columns/tables/indexes still present after OLD code ran (nothing dropped/renamed)', NEW_ONLY_COLS.every((c) => schemaC.itemsColumns.includes(c)) && schemaC.tables.includes('media_pack_drafts') && schemaC.indexes.includes('idx_items_client_item_id'));
  check('C16 same triggers as snapshot A (none lost)', JSON.stringify(schemaC.triggers) === JSON.stringify(schemaA.triggers), JSON.stringify(schemaC.triggers));
  const chkC = integrity(dbOf(dataC));
  check('C17 integrity_check ok and foreign_key_check clean after rollback session', chkC.integrity === 'ok' && chkC.fk === 0, JSON.stringify(chkC));
  const draftC = postC.media_pack_drafts;
  check('C18 pack-draft rows (new-code data) untouched by OLD code, including the draft of the hard-deleted item', draftC.length === dumpB.media_pack_drafts.length && JSON.stringify(draftC) === JSON.stringify(dumpB.media_pack_drafts), `${draftC.length} draft row(s); item_id now dangling: ${draftC[0]?.item_id}`);
  const survivors = postC.items.filter((r) => r.client_item_id === null || r.client_item_id === undefined).length;
  const kept = dumpB.items.filter((r) => r.id !== choker.id).every((rb) => { const rc = postC.items.find((r) => r.id === rb.id); return rc && NEW_ONLY_COLS.every((c) => rc[c] === rb[c]); });
  check('C19 new-code column values (client_item_id/original/white_bg) of surviving items unchanged by OLD code', kept, `${survivors} items with NULL client_item_id`);
  const nonItemDiff = diffDumps(dropNewOnly(dumpB), dropNewOnly(postC), ['items', 'stock_movements', 'purchase_lots', 'audit_logs', 'media_assets', 'product_media_links', 'media_storage_locations', 'photo_blobs', 'vendors', 'sku_sequences', 'deleted_skus', 'users', 'system_settings']);
  log('tables whose rows changed B->C beyond the deliberate OLD-code writes (OLD-code boot-time backfill of derived multi-state tables, expected):', nonItemDiff.map((d) => d.table));

  // ---- roll forward again (NEW code over the DB that OLD code just wrote to)
  log('\n### C-roll-forward: NEW code again on the DB the OLD code wrote to');
  const dataC2 = dir('C2');
  fs.mkdirSync(dataC2, { recursive: true });
  await snapshotDb(dbOf(dataC), dbOf(dataC2));
  copyDir(path.join(dataC, 'uploads'), path.join(dataC2, 'uploads'));
  srv = await startServer(newCode, dataC2);
  const invC2 = (await api(srv, 'GET', '/api/inventory?include_deleted=true')).json.items;
  const reuse = await api(srv, 'POST', '/api/inventory', { ...body, clientItemId: 'drill-cid-1' });
  const reuse2 = await api(srv, 'POST', '/api/inventory', { ...body, title: 'Choker re-created', clientItemId: 'drill-cid-1' });
  check('C20 NEW code boots again on OLD-code-written DB and lists Old-Code Anklet', srv.proc.exitCode === null && invC2.some((i: any) => i.title === 'Old-Code Anklet'), `${invC2.length} items`);
  check('C21 re-submitting clientItemId of the item OLD code hard-deleted creates it fresh (idempotency key freed with the row)', reuse.status === 201 && reuse2.status === 200);
  await srv.stop();

  // ============================================================ D
  log('\n## D. Restore drill: pre-migration snapshot restored OVER the migrated DB, then OLD code');
  const dataD = dir('D');
  fs.mkdirSync(dataD, { recursive: true });
  await snapshotDb(dbOf(dataB), dbOf(dataD)); // D starts as the migrated, post-release DB (B)
  copyDir(path.join(dataB, 'uploads'), path.join(dataD, 'uploads'));
  const shaMigrated = sha256File(dbOf(dataD));
  log('migrated DB sha256 (before restore):', shaMigrated, ' | differs from snapshot:', shaMigrated !== shaA);
  // ---- the restore procedure itself (exactly what the doc tells the operator to do)
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbOf(dataD) + ext, { force: true });
  fs.copyFileSync(snapA, dbOf(dataD));
  const shaRestored = sha256File(dbOf(dataD));
  check('D1 restored DB file sha256 == snapshot sha256 (byte-identical before start)', shaRestored === shaA, shaRestored);
  srv = await startServer(oldCode, dataD);
  check('D2 OLD code starts on restored snapshot without errors', errorsIn(srv).length === 0, errorsIn(srv).slice(0, 3).join(' | '));
  const invD = (await api(srv, 'GET', '/api/inventory?include_deleted=true')).json.items;
  const dRows = await srv.stop();
  void dRows; void invD;
  const dumpD = dumpAll(dbOf(dataD));
  const BUSINESS = ['items', 'purchase_lots', 'stock_movements', 'vendors', 'users', 'sku_sequences', 'global_sku_sequence', 'deleted_skus', 'audit_logs', 'photo_blobs', 'system_settings', 'order_events', 'sku_aliases', 'code_reference'];
  const diffAD = diffDumps(norm(dumpA), norm(dumpD));
  log('row-wise diff snapshot A (raw, never booted) vs restored+booted D:', diffAD.length ? diffAD.map((d) => ({ table: d.table, onlyInSnapshot: d.onlyInA.length, onlyInRestored: d.onlyInB.length })) : 'IDENTICAL (all tables)');
  const bizDiff = diffAD.filter((d) => BUSINESS.includes(d.table));
  check('D3a every BUSINESS table (items, lots, movements, vendors, users, sku sequences, photo_blobs, settings, audit) row-wise identical to snapshot', bizDiff.length === 0, bizDiff.map((d) => d.table).join(','));
  // control: boot OLD code on a pristine copy of the snapshot; boot-time backfill (balances, allocations, bundled demo media) must be identical to restored D
  const dataA2 = dir('A2');
  fs.mkdirSync(dataA2, { recursive: true });
  fs.copyFileSync(snapA, dbOf(dataA2));
  const ctl = await startServer(oldCode, dataA2);
  await ctl.stop();
  const ctlDump = dumpAll(dbOf(dataA2));
  const countsOf = (d: Record<string, any[]>) => Object.fromEntries(Object.entries(d).map(([t, r]) => [t, r.length]));
  const cCtl = countsOf(ctlDump); const cD = countsOf(dumpD);
  const diffCtl = Object.keys({ ...cCtl, ...cD }).filter((t) => cCtl[t] !== cD[t]);
  const bizCtl = diffDumps(norm(ctlDump), norm(dumpD)).filter((d) => BUSINESS.includes(d.table));
  log('control (OLD code booted on pristine snapshot copy) vs restored D: tables with different ROW COUNT:', diffCtl.length ? diffCtl : 'none', '| business-table row diffs:', bizCtl.length ? bizCtl.map((d) => d.table) : 'none');
  log('boot-time derived rows OLD code adds on first boot of the snapshot (not data loss):', diffAD.filter((d) => !BUSINESS.includes(d.table)).map((d) => `${d.table}+${d.onlyInB.length}`));
  check('D3b restored+booted DB has the same per-table row counts as a pristine-snapshot boot, business rows identical', diffCtl.length === 0 && bizCtl.length === 0, diffCtl.join(','));
  check('D4 restored items == original seed (qty/prices)', m.items.every((mi) => { const r = dumpD.items.find((x) => x.sku === mi.sku); return r && r.quantity === mi.quantity && r.buying_price === 500 && r.selling_price === 1200; }));
  const lostItems = dumpB.items.filter((r) => !dumpD.items.some((x) => x.id === r.id)).map((r) => `${r.sku} "${r.title}" qty${r.quantity}`);
  const lostMoves = dumpB.stock_movements.filter((r) => !dumpD.stock_movements.some((x) => x.id === r.id)).length;
  const revertedItems = dumpB.items.filter((r) => dumpD.items.some((x) => x.id === r.id && (x.quantity !== r.quantity || x.selling_price !== r.selling_price))).map((r) => r.sku);
  log('DATA-LOSS WINDOW (everything written after the snapshot is gone):', { itemsCreatedAfterSnapshot: lostItems, stockMovementsLost: lostMoves, itemsWhoseQtyOrPriceReverted: revertedItems, packDraftsLost: dumpB.media_pack_drafts.length });
  check('D5 data-loss window demonstrated: post-snapshot writes are NOT in the restored DB', lostItems.length >= 3 && lostMoves >= 1);

  // ---- D6: ONLINE restore with the script (service keeps running; OLD code is the running code = rollback done first)
  log('\n### D6. Online restore via scripts/restore-db.ts while the OLD code is running');
  const { spawnSync } = await import('node:child_process');
  const runRestore = (data: string, extra: string[] = []) => spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/restore-db.ts', '--snapshot', snapA, '--data-dir', data, ...extra], { cwd: REPO_ROOT, encoding: 'utf8' });
  const dataD6 = dir('D6');
  fs.mkdirSync(dataD6, { recursive: true });
  await snapshotDb(dbOf(dataB), dbOf(dataD6));
  copyDir(path.join(dataB, 'uploads'), path.join(dataD6, 'uploads'));
  srv = await startServer(oldCode, dataD6);
  const before6 = (await api(srv, 'GET', '/api/inventory?include_deleted=true')).json.items.map((i: any) => i.title);
  const dry = runRestore(dataD6);
  check('D6a restore script refuses without --yes (dry run, exit 3)', dry.status === 3);
  const bad = runRestore(dataD6, ['--yes', '--sha256', '0'.repeat(64)]);
  check('D6b restore script refuses a wrong sha256 (nothing changed)', bad.status === 1 && /sha256 mismatch/.test(bad.stderr), bad.stderr.trim().slice(0, 120));
  const rr = runRestore(dataD6, ['--yes', '--sha256', shaA]);
  log('restore-db.ts output:', rr.stdout.trim().slice(0, 900));
  check('D6c restore script succeeds while server is running (integrity ok)', rr.status === 0, rr.stderr.trim().slice(0, 200));
  const after6 = (await api(srv, 'GET', '/api/inventory?include_deleted=true')).json.items.map((i: any) => i.title);
  log('items visible through the running server before/after restore:', { before: before6, after: after6 });
  check('D6d running OLD server immediately serves the restored data (new-code items gone, seed items present)', before6.includes('New-Code Choker') && !after6.includes('New-Code Choker') && m.items.every((mi) => after6.includes(mi.title)));
  const w6 = await api(srv, 'POST', '/api/inventory', { title: 'Post-restore Item', typeCode: 'BR', stoneCode: 'ZZ', colorCode: 'GD', quantity: 1, buyingPrice: 500, sellingPrice: 1200 });
  check('D6e running server keeps accepting writes after online restore', w6.status === 201, String(w6.json?.error || ''));
  await srv.stop();
  const safetyCopies = fs.readdirSync(path.join(dataD6, 'backups')).filter((f) => f.includes('PRE-RESTORE'));
  check('D6f a PRE-RESTORE safety copy of the replaced DB was written to <dataDir>/backups', safetyCopies.length === 1, safetyCopies.join(','));
  const sd = new Database(path.join(dataD6, 'backups', safetyCopies[0]), { readonly: true });
  const safetyHasChoker = (sd.prepare("SELECT COUNT(*) n FROM items WHERE title='New-Code Choker'").get() as any).n;
  sd.close();
  check('D6g the safety copy still contains the post-release data that the restore replaced (undo is possible)', safetyHasChoker === 1);
  const dumpD6 = dumpAll(dbOf(dataD6));
  const bizD6 = diffDumps(norm(dumpA), norm(dumpD6)).filter((d) => ['items', 'purchase_lots', 'stock_movements', 'vendors', 'users', 'photo_blobs'].includes(d.table));
  log('business tables vs snapshot after online restore + one post-restore write (only the post-restore item expected):', bizD6.map((d) => ({ table: d.table, onlyInSnapshot: d.onlyInA.length, onlyInRestored: d.onlyInB.length })));
  check('D6h after online restore only the deliberate post-restore write differs from the snapshot', bizD6.every((d) => d.onlyInA.length === 0) && bizD6.find((d) => d.table === 'items')?.onlyInB.length === 1);

  // ---- D8: the SAME restore with the plain node one-liners from the doc (works on ANY release incl. the old one, no repo scripts needed)
  log('\n### D8. Operator one-liners (docs/backup-and-rollback.md): backup + restore using only node + better-sqlite3 against the OLD deployed code');
  const sh = (cmd: string, env: Record<string, string>) => spawnSync('bash', ['-c', cmd], { cwd: oldCode, env: { ...process.env, ...env }, encoding: 'utf8' });
  const dataD8 = dir('D8');
  fs.mkdirSync(path.join(dataD8, 'backups'), { recursive: true });
  await snapshotDb(dbOf(dataB), dbOf(dataD8));
  copyDir(path.join(dataB, 'uploads'), path.join(dataD8, 'uploads'));
  srv = await startServer(oldCode, dataD8);
  const pre8 = (await api(srv, 'GET', '/api/inventory?include_deleted=true')).json.items.length;
  const bk = sh(ONE_LINER_BACKUP, { DB: dbOf(dataD8), OUT: path.join(dataD8, 'backups', 'pre-restore-safety.db') });
  log('one-liner backup output:', bk.stdout.trim(), bk.stderr.trim());
  check('D8a one-liner BACKUP of the live (running) DB works with old code\'s node_modules; integrity ok', bk.status === 0 && /integrity_check: ok/.test(bk.stdout));
  const rs = sh(ONE_LINER_RESTORE, { SNAP: snapA, DB: dbOf(dataD8) });
  log('one-liner restore output:', rs.stdout.trim(), rs.stderr.trim());
  const post8 = (await api(srv, 'GET', '/api/inventory?include_deleted=true')).json.items;
  check('D8b one-liner RESTORE onto the live DB: running OLD server serves snapshot data', rs.status === 0 && /integrity_check: ok/.test(rs.stdout) && post8.length === dumpA.items.length && pre8 > post8.length, `items ${pre8} -> ${post8.length}`);
  await srv.stop();
  const bad8 = (() => { const f = path.join(dataD8, 'garbage.db'); fs.writeFileSync(f, Buffer.alloc(8192, 0x41)); return sh(ONE_LINER_RESTORE, { SNAP: f, DB: dbOf(dataD8) }); })();
  check('D8c one-liner restore refuses a corrupt snapshot (non-zero exit, live DB untouched)', bad8.status !== 0);
  const live8 = openDb(dbOf(dataD8)); const n8 = (live8.prepare('SELECT COUNT(*) n FROM items').get() as any).n; live8.close();
  check('D8d live DB still holds the restored data after the refused restore', n8 === dumpA.items.length);

  // ---- D7: what if the NEW code is the one running while a pre-migration snapshot is restored? (wrong order)
  log('\n### D7. Wrong order: restore pre-migration snapshot while NEW code is still running');
  const dataD7 = dir('D7');
  fs.mkdirSync(dataD7, { recursive: true });
  await snapshotDb(dbOf(dataB), dbOf(dataD7));
  copyDir(path.join(dataB, 'uploads'), path.join(dataD7, 'uploads'));
  srv = await startServer(newCode, dataD7);
  await api(srv, 'GET', '/api/inventory');
  const rr7 = runRestore(dataD7, ['--yes', '--sha256', shaA]);
  const w7 = await api(srv, 'POST', '/api/inventory', { clientItemId: 'd7-cid', title: 'D7 Item', typeCode: 'BR', stoneCode: 'ZZ', colorCode: 'GD', quantity: 1, buyingPrice: 500, sellingPrice: 1200 });
  const r7 = await api(srv, 'GET', '/api/inventory');
  log('observed with NEW code running over a restored pre-migration DB (no restart):', { restoreExit: rr7.status, createStatus: w7.status, createError: w7.json?.error, listStatus: r7.status, listError: r7.json?.error });
  await srv.stop();
  srv = await startServer(newCode, dataD7);
  const w7b = await api(srv, 'POST', '/api/inventory', { clientItemId: 'd7-cid-2', title: 'D7 Item after restart', typeCode: 'BR', stoneCode: 'ZZ', colorCode: 'GD', quantity: 1, buyingPrice: 500, sellingPrice: 1200 });
  await srv.stop();
  check('D7 OBSERVATION recorded; after RESTARTING the new code on the restored DB its migrations re-apply and writes work', w7b.status === 201, `without restart: create=${w7.status} (${w7.json?.error || 'ok'}); after restart: create=${w7b.status}`);

  // ============================================================ E
  log('\n## E. Photos');
  const photosC = listFilesWithHash(path.join(dataC, 'uploads/photos'));
  const lostFilesC = Object.keys(imgsB).filter((f) => !(f in photosC));
  const changedFilesC = Object.keys(imgsB).filter((f) => f in photosC && photosC[f] !== imgsB[f]);
  check('E1 code-only rollback (C) deleted/changed NO photo file, even after hard-deleting a new-code item', lostFilesC.length === 0 && changedFilesC.length === 0, `files B=${Object.keys(imgsB).length} C=${Object.keys(photosC).length}`);
  const origName = photoOrig.json.url.split('/').pop();
  check('E2 original/white-bg photos of new-code items still on disk after rollback + hard delete (kept as orphans, never lost)', origName in photosC && photoWhite.json.url.split('/').pop() in photosC);
  const photosD = listFilesWithHash(path.join(dataD, 'uploads/photos'));
  const refsD = referencedPhotoNames(dbOf(dataD));
  const orphansD = Object.keys(photosD).filter((f) => !f.includes('/') && !refsD.has(f));
  const newPhotoNames = [photoOrig.json.url, photoWhite.json.url].map((u: string) => u.split('/').pop()!);
  log('after DB restore (D): photo files on disk:', Object.keys(photosD).length, '| files not referenced by any restored row:', orphansD);
  check('E3 DB restore does not delete photos: post-snapshot photos remain on disk as unreferenced orphans', newPhotoNames.every((n) => n in photosD) && newPhotoNames.every((n) => orphansD.includes(n)));
  const dBlobs = openDb(dbOf(dataD)); const blobNames = (dBlobs.prepare('SELECT filename FROM photo_blobs').all() as any[]).map((r) => r.filename); dBlobs.close();
  log('photo_blobs rows (bytes inside the DB) after restore:', blobNames.length, '| post-snapshot photos present as blob in DB:', newPhotoNames.map((n) => blobNames.includes(n)));
  check('E4 restored DB does not know the post-snapshot photos (no photo_blobs row) => disk copy is their ONLY copy; they would be lost on a volume wipe', newPhotoNames.every((n) => !blobNames.includes(n)));
  check('E5 pack drafts: restored pre-migration DB has no media_pack_drafts table (drafts live only in the migrated DB / browser)', !schemaObjects(dbOf(dataD)).tables.includes('media_pack_drafts'));
  const draftRefsExist = JSON.parse(dumpB.media_pack_drafts[0].original_refs).every((u: string) => u.split('/').pop()! in photosC);
  check('E6 after code-only rollback every original photo referenced by a pack draft still exists on disk', draftRefsExist);
  void newItemRow;

  log('\n## SUMMARY');
  for (const r of results) log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.step}`);
  log(`\n${results.filter((r) => r.pass).length}/${results.length} steps passed`);
  closeOutput();
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
