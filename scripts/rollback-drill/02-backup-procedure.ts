/**
 * Tests the operational backup commands against a DB created by the DEPLOYED code (68398e6) while a writer is
 * actively hammering the live server (WAL mode, -wal/-shm present).
 *
 *   npx tsx scripts/rollback-drill/02-backup-procedure.ts
 *
 * Invariant used to prove point-in-time consistency: the deployed createItem() inserts one `items` row and one
 * `purchase_lots` row in ONE transaction, so in any consistent copy COUNT(items) == COUNT(purchase_lots).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { api, check, closeOutput, DEPLOYED_COMMIT, extractCommit, log, mkTmp, results, setOutputFile, sha256File, startServer, REPO_ROOT } from './lib';
import { seedDeployed } from './seed';

function inspect(file: string) {
  const d = new Database(file, { readonly: true });
  try {
    const integ = (d.pragma('integrity_check') as any[]).map((r) => r.integrity_check);
    const items = (d.prepare('SELECT COUNT(*) n FROM items').get() as any).n;
    const lots = (d.prepare('SELECT COUNT(*) n FROM purchase_lots').get() as any).n;
    return { integ: integ.join(','), items, lots, consistent: items === lots };
  } catch (e: any) {
    return { integ: 'ERROR ' + e.message, items: -1, lots: -2, consistent: false };
  } finally { d.close(); }
}

async function main() {
  setOutputFile(process.env.OUT || path.join(REPO_ROOT, 'docs/evidence/backup-procedure-output.txt'));
  log(`# Backup procedure test, DB created by deployed code ${DEPLOYED_COMMIT}, live writer active`);
  const code = extractCommit(DEPLOYED_COMMIT, 'deployed');
  const data = mkTmp('data');
  const srv = await startServer(code, data);
  await seedDeployed(srv);
  const dbPath = path.join(data, 'saaz_ledger.db');
  log('journal_mode of live DB:', (() => { const d = new Database(dbPath, { readonly: true }); const m = d.pragma('journal_mode', { simple: true }); d.close(); return m; })());

  // background writer through the real API
  let stop = false; let written = 0;
  const writer = (async () => {
    while (!stop) {
      const r = await api(srv, 'POST', '/api/inventory', { title: `Load ${written}`, typeCode: 'BR', stoneCode: 'ZZ', colorCode: 'BK', quantity: 5, buyingPrice: 500, sellingPrice: 1200 });
      if (r.status === 201) written++;
    }
  })();
  await new Promise((r) => setTimeout(r, 800));
  log('files next to live DB while writer active:', fs.readdirSync(data).filter((f) => f.startsWith('saaz_ledger')));
  log('items written by background writer so far:', written);

  const out = mkTmp('backups');
  const N = 6;
  const methods: Record<string, (i: number) => string> = {
    'naive cp of saaz_ledger.db only': (i) => { const f = path.join(out, `cp-${i}.db`); fs.copyFileSync(dbPath, f); return f; },
    'python3 sqlite3 Connection.backup (same API as sqlite3 CLI .backup)': (i) => {
      const f = path.join(out, `py-${i}.db`);
      execFileSync('python3', ['-c', `import sqlite3,sys; s=sqlite3.connect(sys.argv[1], timeout=30); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()`, dbPath, f]);
      return f;
    },
    'node + better-sqlite3 db.backup() one-liner': (i) => {
      const f = path.join(out, `node-${i}.db`);
      execFileSync(process.execPath, ['-e', `const D=require('better-sqlite3');const d=new D(process.argv[1]);d.backup(process.argv[2]).then(()=>d.close())`, dbPath, f], { cwd: code });
      return f;
    },
    'node + better-sqlite3 VACUUM INTO': (i) => {
      const f = path.join(out, `vac-${i}.db`);
      execFileSync(process.execPath, ['-e', `const D=require('better-sqlite3');const d=new D(process.argv[1]);d.prepare('VACUUM INTO ?').run(process.argv[2]);d.close()`, dbPath, f], { cwd: code });
      return f;
    },
    'NEW scripts/backup-db.ts (this branch)': (i) => {
      const r = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), ['scripts/backup-db.ts', '--data-dir', data, '--label', `drill${i}`], { cwd: REPO_ROOT, encoding: 'utf8' });
      if (r.status !== 0) throw new Error('backup-db.ts failed: ' + r.stdout + r.stderr);
      return JSON.parse(r.stdout).file;
    },
  };

  const summary: Record<string, { ok: number; inconsistent: number }> = {};
  for (const [name, fn] of Object.entries(methods)) {
    let ok = 0; let bad = 0; const rows: any[] = [];
    for (let i = 0; i < N; i++) {
      const w0 = written;
      const f = fn(i);
      const w1 = written;
      const ins = inspect(f);
      rows.push({ writerInsertedBeforeAfterCopy: `${w0}->${w1}`, file: path.basename(f), integrity: ins.integ, items: ins.items, lots: ins.lots, consistent: ins.consistent, hasWalSidecar: fs.existsSync(f + '-wal') });
      if (ins.integ === 'ok' && ins.consistent) ok++; else bad++;
    }
    summary[name] = { ok, inconsistent: bad };
    log(`\n### ${name}`);
    log(rows);
  }
  stop = true; await writer;
  log(`\nbackground writer finished: ${written} items inserted during the test`);
  log('\n### Summary (copies passing integrity_check AND items==lots invariant, of ' + N + ' each)');
  log(summary);
  for (const [name, s] of Object.entries(summary)) {
    if (name.startsWith('naive')) check(`${name}: NOT guaranteed (informational; ${s.ok}/${N} happened to pass)`, true, 'cp is unsafe by design: ignores -wal');
    else check(`${name}: ${N}/${N} consistent + integrity ok while writer active`, s.ok === N);
  }

  // restore from a snapshot works with the app
  await srv.stop();
  const snap = path.join(out, 'node-0.db');
  const restoreDir = mkTmp('restore');
  fs.copyFileSync(snap, path.join(restoreDir, 'saaz_ledger.db'));
  const s2 = await startServer(code, restoreDir);
  const inv = await api(s2, 'GET', '/api/inventory');
  log('\nApp booted from a restored snapshot; /api/inventory items =', inv.json.items.length, '; sha256 of snapshot file =', sha256File(snap));
  check('deployed app boots and serves data from a restored .backup() snapshot (copied WITHOUT -wal/-shm)', inv.status === 200 && inv.json.items.length >= 3);
  await s2.stop();

  // transfer step: base64 pipe + sha256 check (what you would do over `railway ssh`)
  const b64 = execFileSync('base64', [snap], { maxBuffer: 1 << 28 });
  const back = path.join(out, 'roundtrip.db');
  fs.writeFileSync(back, execFileSync('base64', ['-d'], { input: b64, maxBuffer: 1 << 28 }));
  check('base64 transfer round trip preserves sha256 (local simulation only; real `railway ssh` pipe UNVERIFIED)', sha256File(back) === sha256File(snap));

  log('\n## SUMMARY');
  for (const r of results) log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.step}`);
  closeOutput();
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
