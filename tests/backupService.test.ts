import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import {
  buildPhotoManifest, createDbSnapshot, listBackups, restoreDbFromSnapshot, sha256File, verifyPhotoManifest,
} from '../server/services/backupService';
import { registerBackupRoutes } from '../server/routes/backupRoutes';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-backup-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function freshDb(name: string) {
  const dataDir = path.join(root, name);
  fs.mkdirSync(path.join(dataDir, 'uploads', 'photos'), { recursive: true });
  const db = new Database(path.join(dataDir, 'saaz_ledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);
    CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT);
    CREATE TABLE photo_blobs (filename TEXT PRIMARY KEY, mime_type TEXT, data BLOB, file_size INTEGER);
  `);
  return { dataDir, db };
}

describe('createDbSnapshot (WAL correctness)', () => {
  it('captures committed rows that exist only in the -wal file; a plain file copy does not', async () => {
    const { dataDir, db } = freshDb('wal');
    db.pragma('wal_autocheckpoint = 0'); // keep everything in the WAL
    const ins = db.prepare('INSERT INTO a (v) VALUES (?)');
    for (let i = 0; i < 500; i++) ins.run('row' + i);
    expect(fs.statSync(path.join(dataDir, 'saaz_ledger.db-wal')).size).toBeGreaterThan(0);

    // naive copy of just the main file (what `cp saaz_ledger.db` does)
    const naive = path.join(root, 'naive.db');
    fs.copyFileSync(path.join(dataDir, 'saaz_ledger.db'), naive);
    const nd = new Database(naive, { readonly: true });
    let naiveCount = -1;
    try { naiveCount = (nd.prepare('SELECT COUNT(*) n FROM a').get() as any).n; } catch { naiveCount = 0; }
    nd.close();
    expect(naiveCount).toBeLessThan(500);

    const snap = await createDbSnapshot({ db, dataDir });
    expect(snap.ok).toBe(true);
    expect(snap.integrityCheck).toEqual(['ok']);
    expect(snap.journalModeOfSource).toBe('wal');
    const sd = new Database(snap.file, { readonly: true });
    expect((sd.prepare('SELECT COUNT(*) n FROM a').get() as any).n).toBe(500);
    sd.close();
    db.close();
  });

  it.each(['backup', 'vacuum'] as const)('is atomic while another process keeps writing (%s)', async (method) => {
    const { dataDir, db } = freshDb('live-' + method);
    const dbPath = path.join(dataDir, 'saaz_ledger.db');
    // writer: every transaction inserts one row into a AND one into b -> counts must always match in any consistent snapshot
    const writer = spawn(process.execPath, ['-e', `
      const D = require('better-sqlite3'); const d = new D(${JSON.stringify(dbPath)});
      d.pragma('journal_mode = WAL'); d.pragma('busy_timeout = 10000');
      const ia = d.prepare('INSERT INTO a (v) VALUES (?)'), ib = d.prepare('INSERT INTO b (v) VALUES (?)');
      const tx = d.transaction((i) => { ia.run('x'+i); ib.run('x'+i); });
      let i = 0; const end = Date.now() + 4000;
      process.stdout.write('ready\\n');
      while (Date.now() < end) { tx(i++); }
      process.stdout.write('done ' + i + '\\n');
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((res) => writer.stdout!.once('data', () => res()));
    const snaps = [];
    for (let k = 0; k < 4; k++) {
      await new Promise((r) => setTimeout(r, 200));
      snaps.push(await createDbSnapshot({ db, dataDir, method, label: `${method}${k}`, now: new Date(Date.now() + k * 1000) }));
    }
    await new Promise<void>((res) => writer.on('exit', () => res()));
    const counts: number[] = [];
    for (const s of snaps) {
      expect(s.ok).toBe(true);
      expect(s.integrityCheck).toEqual(['ok']);
      const c = new Database(s.file, { readonly: true });
      const a = (c.prepare('SELECT COUNT(*) n FROM a').get() as any).n;
      const b = (c.prepare('SELECT COUNT(*) n FROM b').get() as any).n;
      c.close();
      expect(a).toBe(b);
      counts.push(a);
    }
    expect(counts[counts.length - 1]).toBeGreaterThan(0);
    // snapshots taken later contain at least as many rows (monotone, point-in-time)
    expect([...counts].sort((x, y) => x - y)).toEqual(counts);
    const finalDb = new Database(dbPath, { readonly: true });
    const live = (finalDb.prepare('SELECT COUNT(*) n FROM a').get() as any).n;
    finalDb.close();
    expect(live).toBeGreaterThanOrEqual(counts[counts.length - 1]);
    db.close();
  }, 30000);

  it('refuses concurrent runs and honours minIntervalMs', async () => {
    const { dataDir, db } = freshDb('guards');
    const p1 = createDbSnapshot({ db, dataDir, label: 'one' });
    await expect(createDbSnapshot({ db, dataDir, label: 'two' })).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
    await p1;
    await expect(createDbSnapshot({ db, dataDir, label: 'three', minIntervalMs: 60000 })).rejects.toMatchObject({ code: 'BACKUP_TOO_SOON' });
    db.close();
  });
});

describe('photo manifest', () => {
  it('lists + hashes photos, snapshot reports blob/disk mismatches, verify detects loss and tampering', async () => {
    const { dataDir, db } = freshDb('photos');
    const up = path.join(dataDir, 'uploads', 'photos');
    fs.mkdirSync(path.join(up, 'derivatives'));
    fs.writeFileSync(path.join(up, 'a.png'), 'AAA');
    fs.writeFileSync(path.join(up, 'b.png'), 'BBB');
    fs.writeFileSync(path.join(up, 'derivatives', 'd.jpg'), 'DDD');
    db.prepare('INSERT INTO photo_blobs VALUES (?,?,?,?)').run('a.png', 'image/png', Buffer.from('AAA'), 3);
    db.prepare('INSERT INTO photo_blobs VALUES (?,?,?,?)').run('ghost.png', 'image/png', Buffer.from('G'), 1);

    const m = buildPhotoManifest(up);
    expect(m.fileCount).toBe(3);
    expect(m.files.map((f) => f.path)).toEqual(['a.png', 'b.png', 'derivatives/d.jpg']);
    expect(m.files[0].sha256).toBe('cb1ad2119d8fafb69566510ee712661f9f14b83385006ef92aec47f523a38358');

    const snap = await createDbSnapshot({ db, dataDir });
    expect(snap.photos!.fileCount).toBe(3);
    expect(snap.photos!.dbPhotoBlobCount).toBe(2);
    expect(snap.photos!.blobsMissingOnDisk).toEqual(['ghost.png']);
    expect(snap.photos!.filesWithoutBlob).toEqual(['b.png']);
    expect(sha256File(snap.photos!.manifestFile)).toBe(snap.photos!.manifestSha256);

    const stored = JSON.parse(fs.readFileSync(snap.photos!.manifestFile, 'utf8'));
    expect(verifyPhotoManifest(stored, up).ok).toBe(true);
    fs.rmSync(path.join(up, 'a.png'));
    fs.writeFileSync(path.join(up, 'b.png'), 'TAMPERED');
    fs.writeFileSync(path.join(up, 'new.png'), 'N');
    const v = verifyPhotoManifest(stored, up);
    expect(v).toMatchObject({ ok: false, missing: ['a.png'], changed: ['b.png'], added: ['new.png'] });
    db.close();
  });
});

describe('admin backup routes', () => {
  async function boot(role: string | null) {
    const { dataDir, db } = freshDb('route-' + Math.random().toString(36).slice(2, 6));
    db.prepare('INSERT INTO a (v) VALUES (?)').run('x');
    fs.writeFileSync(path.join(dataDir, 'uploads', 'photos', 'p.png'), 'P');
    const app = express();
    app.use(express.json());
    const fakeAuth: express.RequestHandler = (req, _res, next) => { if (role) (req as any).user = { id: 'u', role }; next(); };
    registerBackupRoutes(app, fakeAuth, undefined, { dataDir, database: db as any, minIntervalMs: 0 });
    const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    return { base, server, dataDir, db };
  }

  it('non-admin and anonymous callers are rejected and nothing is written', async () => {
    for (const role of ['staff', null]) {
      const t = await boot(role);
      const r = await fetch(t.base + '/api/admin/backup/db', { method: 'POST' });
      expect(r.status).toBe(403);
      expect((await fetch(t.base + '/api/admin/backup/db')).status).toBe(403);
      expect((await fetch(t.base + '/api/admin/backup/photos-manifest')).status).toBe(403);
      expect(fs.existsSync(path.join(t.dataDir, 'backups'))).toBe(false);
      t.server.close(); t.db.close();
    }
  });

  it('admin: creates a snapshot, returns metadata only (no file bytes), lists it', async () => {
    const t = await boot('admin');
    const r = await fetch(t.base + '/api/admin/backup/db', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'pre-release' }) });
    expect(r.status).toBe(201);
    expect(r.headers.get('content-type')).toMatch(/json/);
    const j: any = await r.json();
    expect(j.ok).toBe(true);
    expect(j.integrityCheck).toEqual(['ok']);
    expect(j.file).toMatch(/^saaz_ledger-.*-pre-release\.db$/);
    expect(j.file).not.toContain('/');
    expect(j.photos.fileCount).toBe(1);
    expect(j.tableCounts.a).toBeUndefined(); // only app tables are counted
    const list: any = await (await fetch(t.base + '/api/admin/backup/db')).json();
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0].hasManifest).toBe(true);
    expect(listBackups(t.dataDir)).toHaveLength(1);
    const man: any = await (await fetch(t.base + '/api/admin/backup/photos-manifest')).json();
    expect(man.fileCount).toBe(1);
    t.server.close(); t.db.close();
  });
});

describe('restoreDbFromSnapshot', () => {
  it('restores into a live WAL database while another connection stays open; takes a safety copy first', async () => {
    const { dataDir, db } = freshDb('restore');
    const ins = db.prepare('INSERT INTO a (v) VALUES (?)');
    for (let i = 0; i < 10; i++) ins.run('keep' + i);
    const snap = await createDbSnapshot({ db, dataDir });
    for (let i = 0; i < 5; i++) ins.run('after' + i); // written after the snapshot: must be lost by the restore
    expect((db.prepare('SELECT COUNT(*) n FROM a').get() as any).n).toBe(15);

    const res = await restoreDbFromSnapshot({ snapshotPath: snap.file, liveDbPath: path.join(dataDir, 'saaz_ledger.db'), dataDir, expectedSha256: snap.sha256 });
    expect(res.ok).toBe(true);
    expect(res.integrityCheck).toEqual(['ok']);
    // the still-open connection immediately sees the restored state and can keep writing
    expect((db.prepare('SELECT COUNT(*) n FROM a').get() as any).n).toBe(10);
    ins.run('post-restore');
    expect((db.prepare('SELECT COUNT(*) n FROM a').get() as any).n).toBe(11);
    // safety copy retains the 15 rows that were replaced
    const sc = new Database(res.preRestoreSafetyCopy, { readonly: true });
    expect((sc.prepare('SELECT COUNT(*) n FROM a').get() as any).n).toBe(15);
    sc.close();
    db.close();
  });

  it('refuses a wrong sha256, a missing file and a corrupt snapshot, leaving the live DB untouched', async () => {
    const { dataDir, db } = freshDb('restore-refuse');
    db.prepare('INSERT INTO a (v) VALUES (?)').run('x');
    const snap = await createDbSnapshot({ db, dataDir });
    const live = path.join(dataDir, 'saaz_ledger.db');
    await expect(restoreDbFromSnapshot({ snapshotPath: snap.file, liveDbPath: live, dataDir, expectedSha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'SNAPSHOT_SHA_MISMATCH' });
    await expect(restoreDbFromSnapshot({ snapshotPath: path.join(dataDir, 'nope.db'), liveDbPath: live, dataDir })).rejects.toMatchObject({ code: 'SNAPSHOT_MISSING' });
    const corrupt = path.join(dataDir, 'corrupt.db');
    fs.writeFileSync(corrupt, Buffer.concat([fs.readFileSync(snap.file).subarray(0, 4096), Buffer.alloc(8192, 0x41)]));
    await expect(restoreDbFromSnapshot({ snapshotPath: corrupt, liveDbPath: live, dataDir })).rejects.toBeTruthy();
    expect((db.prepare('SELECT COUNT(*) n FROM a').get() as any).n).toBe(1);
    db.close();
  });
});
