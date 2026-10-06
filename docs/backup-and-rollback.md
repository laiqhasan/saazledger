# Saaz Ledger: Backup and Rollback

Written for a non-technical Mac user. Every command marked **[tested]** was run for real against isolated SQLite
files created by the currently deployed code (commit `68398e6`); the raw output is in `docs/evidence/`. Anything
that depends on Railway itself (dashboard buttons, `railway ssh`) is marked **[UNVERIFIED]** because it was not
possible to run it from the test environment (no Railway access, by design).

## 0. The short version

1. The app's built-in "Full JSON Backup" is **not** a real backup (section 1). Do not rely on it.
2. Before every release, take a **database snapshot on the server** (section 3) and copy it to your Mac (section 4).
3. Freeze data entry during the release (section 5).
4. If the release misbehaves, first try a **code-only rollback** (redeploy the previous deployment). This was tested
   and is safe: the old code runs fine on the migrated database and loses no data (section 6, Level 1).
5. Restore the snapshot only if the database itself is damaged. Everything written after the snapshot is lost
   (section 6, Level 2).

## 1. What the app's own backup features really do (deployed commit 68398e6)

Tested by driving the real UI (Playwright) against an isolated server. Output: `docs/evidence/deployed-backup-coverage-output.txt`.

| Feature (Data Hub) | What it captures | What it does NOT capture | Restore behaviour |
|---|---|---|---|
| Full JSON Backup (download) | Inventory items as the browser holds them (sku, title, qty, prices, photo URL, notes, flags) and the code tables | Vendors, purchase lots (cost layers), stock movements / sales history, users, media assets and gallery links, SKU sequence counters, **photo files (URLs only)**, settings | "Upload JSON Backup File" writes to the **browser's localStorage only**; it never calls the server |
| Shopify CSV Export | A Shopify product-import CSV | Everything else | No restore path at all (import is a different, additive tool) |
| Bulk CSV Ingest | n/a (import only) | n/a | Additive: adds new rows to the list |
| "Backup Database to S3 Now" (Media storage settings) | Intended: items + movements as JSON in S3 | **Broken in the deployed code**: it queries a table `jewelry_items` that does not exist, so it answers `500 no such table: jewelry_items` | none |
| Automatic re-upload | When the server has zero items and the same browser still has data, the app re-uploads that browser's items, vendors | Lots, movements, media links, users, SKU counters, global SKU sequence (reset to 0), photo files (unless that same browser still has its IndexedDB photo cache; not exercised in the test) | Additive only (`INSERT ... ON CONFLICT DO NOTHING`) |

Measured results (all from the evidence file):

* A restore of the JSON **over a live server did nothing**: the server rows stayed as they were (a deleted item stayed
  deleted, an edited quantity stayed edited) and after a page reload the browser view reverted to the server data.
  The green "Backup imported and ledger restored!" message is misleading in that case.
* Restoring the JSON into a **brand-new empty server** brought back the three items (SKU, qty, prices, photo URL) but
  not: the 3 purchase lots, 4 stock movements, the media links, the non-default user, the SKU counters, the photos.
  The items' vendor field came back as the app default ("Aura Creations"), whereas the server had none stored.
* Conclusion: the deployed app has **no backup of the server database**. Production data is only as safe as the
  Railway volume at `/data` (plus whatever S3 holds for images). That is why the procedure below exists.

Note: photos are also stored as blobs **inside** the database (`photo_blobs`) for photos saved through the app's photo
service, so a database snapshot carries those photo bytes too. Files that are only on disk are not covered by the
database snapshot; section 7 handles them.

## 2. Pre-release checklist

* [ ] You can open the Railway project and reach the service (`railway login`, `railway link`).
* [ ] Enough volume space: `df -h /data` shows free space of at least 2x the size of `saaz_ledger.db`.
* [ ] Staff told that data entry stops at an agreed time (section 5).
* [ ] You know the name of the currently healthy deployment (Railway dashboard, Deployments tab). That is your
      rollback target. Write down its commit id.

## 3. Take the backup

### Option A: Railway volume backup [UNVERIFIED]

If your Railway plan offers volume backups: Railway dashboard, open the project, click the service (or the volume
card), open **Volume** settings, find **Backups**, click **Create backup**, wait for it to finish. Whether your plan
includes this was not verifiable here. Treat it as an extra layer, not a replacement for option B, because a volume
backup of a live SQLite file taken by copying files is only crash-consistent.

### Option B: consistent snapshot with `railway ssh` (works with the deployed app today)

`railway run` executes on **your Mac** with Railway's variables; it cannot see the `/data` volume. Do not use it for
this. Use `railway ssh` so the commands run inside the server container [UNVERIFIED: platform behaviour].

On your Mac, in Terminal (one time: `brew install railway`, then `railway login`, then `railway link`):

```bash
railway ssh
```

Inside the server shell, paste (the commands themselves were tested; `cd /app` is the usual Nixpacks app folder, adjust
if `ls` there does not show `node_modules`):

```bash
cd /app
df -h /data
mkdir -p /data/backups
DB=/data/saaz_ledger.db
OUT=/data/backups/pre-release-$(date -u +%Y%m%d-%H%M%S).db
node -e "const D=require('better-sqlite3');const d=new D(process.argv[1]);d.backup(process.argv[2]).then(()=>{d.close();const c=new D(process.argv[2],{readonly:true});console.log('integrity_check:',c.pragma('integrity_check',{simple:true}),'items:',c.prepare('select count(*) n from items').get().n);c.close()})" "$DB" "$OUT"
sha256sum "$OUT"
ls -la /data/backups
```

Expected: `integrity_check: ok items: <your item count>` and a sha256 line. Write the sha256 down.

Why not just copy the file? The database runs in WAL mode, so recent writes can live only in `saaz_ledger.db-wal`.
In the test, a plain `cp saaz_ledger.db` taken while the app was writing held 244 items while 272 had already been
committed (it silently lost 28 rows). SQLite's online backup API (used above) produced an exact, internally consistent
copy every time (6 out of 6 runs per method, `PRAGMA integrity_check` = ok, and a one-transaction invariant held), with
a writer hammering the live app. Methods tested the same way: python3 `Connection.backup` (same API as the
`sqlite3` CLI's `.backup`), the node one-liner above, `VACUUM INTO`, and `scripts/backup-db.ts`. Output: `docs/evidence/backup-procedure-output.txt`.

The `sqlite3` command-line program is **not** in the Nixpacks package list in this repo (`nixpacks.toml` lists only
node, python3, gcc, make), so do not count on `sqlite3 /data/saaz_ledger.db ".backup ..."`; use the node command.

### Option C: after the new release is deployed (this branch adds these)

* On the server: `cd /app && npx tsx scripts/backup-db.ts --label pre-release` prints JSON with `ok`, the file, sha256,
  `integrityCheck`, table row counts and a photo manifest (file list + sha256 + a warning for photos that exist
  only on disk or only inside the database). Exit code 0 only when integrity is ok.
* Over HTTP (admin only): `POST /api/admin/backup/db` (body `{"label":"pre-release"}`) returns the same metadata and
  `GET /api/admin/backup/db` lists snapshots. It never returns the file. It is protected by the app's login plus an
  admin check, but see the warning in `server/routes/backupRoutes.ts`: until the auth hardening lands, a request with
  no token is treated as a local admin by `authenticateToken`.

### Option D: the app's own export (extra, not a backup)

Data Hub, Export: download the Shopify CSV and the Full JSON. Useful as a human-readable record of items and prices.
It cannot restore the ledger (section 1).

## 4. Copy the snapshot to your Mac and verify it

Candidate method [UNVERIFIED over a real `railway ssh` pipe; the base64 encode/decode round trip itself was tested]:

```bash
mkdir -p ~/saaz-backups && cd ~/saaz-backups
railway ssh -- "base64 /data/backups/pre-release-YYYYMMDD-HHMMSS.db" | base64 -D > pre-release-YYYYMMDD-HHMMSS.db
shasum -a 256 pre-release-YYYYMMDD-HHMMSS.db
```

The sha256 printed on your Mac **must equal** the one printed on the server. If it differs (terminals sometimes add
characters), do not trust the copy; try again. A backup that lives only on the same volume is not protected against
losing the volume, so this step matters.

## 5. Release sequence with a write freeze

SQLite plus a single running server means anything written between the snapshot and a rollback is lost on restore.
So:

1. Announce a window (for example 15 minutes). Staff stop adding, editing, selling and uploading. Shopify order
   syncing keeps running in the background and is the one writer you cannot silence from the app; note the time.
2. Take the snapshot (section 3) **after** the freeze starts. Verify the sha256 and copy it to your Mac.
3. Deploy the release.
4. Smoke test as admin: log in, open the inventory, check the item count and one item (quantity 5, buying 500,
   selling 1200 style spot check), open a photo, add and delete a test item.
5. Only after the smoke test passes, tell staff to resume. Until then a rollback by snapshot restore loses nothing.
6. After you resume, treat the release as live: prefer Level 1 rollback (below), which keeps newer data.

## 6. Rollback

### Level 1: code-only rollback (preferred, tested)

Railway dashboard, service, **Deployments**, find the last healthy deployment, open its menu and choose
**Redeploy / Rollback** [UNVERIFIED: button label]. No data is touched.

Why this is safe, from `docs/evidence/rollback-drill-output.txt` (55/55 steps passed): the new code only adds
columns (`client_item_id`, `original_image_url`, `white_bg_image_url`), one partial unique index and one table
(`media_pack_drafts`). The old code, run against the migrated database:

* starts without errors and lists every item, including items created by the new code;
* creates, edits, soft/hard deletes, sells, restocks, imports vendors, uploads media and links it, without any
  constraint failure (its inserts leave `client_item_id` NULL, and NULLs do not collide in the partial unique index);
* drops, renames or changes nothing it does not know about (the extra columns, the index and the draft table are
  still there afterwards, `integrity_check` ok, `foreign_key_check` clean, no triggers exist);
* can be followed by the new code again (roll forward) without trouble.

What the old code cannot see or do (documented, not data loss): `originalImageUrl`, `whiteBgImageUrl` and
`clientItemId` are invisible to it (the data stays in the database); it does not use unpublished media-pack drafts
(the rows stay); deleting a new-code item with the old code leaves its draft row orphaned (no foreign key), harmless.

### Level 2: restore the snapshot (database damaged, or you must discard post-release data)

Order matters: **roll the code back first (Level 1)**, then restore. A pre-migration snapshot restored under the
*new* code makes its saves fail with `no such column: client_item_id` until the service is restarted (observed in
the drill, step D7; after a restart the migrations re-apply and everything works).

Inside `railway ssh` (the restore needs only node, so it works on the old release too; tested while the old app was
running and serving traffic, which is fine because SQLite's backup API swaps the pages atomically):

```bash
cd /app
DB=/data/saaz_ledger.db
SNAP=/data/backups/pre-release-YYYYMMDD-HHMMSS.db      # the file you took in section 3
sha256sum "$SNAP"                                      # must equal the number you wrote down
# 1) safety copy of what is live right now (so the restore itself can be undone)
OUT=/data/backups/PRE-RESTORE-$(date -u +%Y%m%d-%H%M%S).db
node -e "const D=require('better-sqlite3');const d=new D(process.argv[1]);d.backup(process.argv[2]).then(()=>{d.close();console.log('safety copy written')})" "$DB" "$OUT"
# 2) restore (refuses a corrupt snapshot, prints integrity_check afterwards)
node -e "const D=require('better-sqlite3');const s=new D(process.argv[1],{readonly:true});const ok=s.pragma('integrity_check',{simple:true});if(ok!=='ok'){console.error('SNAPSHOT CORRUPT',ok);process.exit(1)}s.backup(process.argv[2]).then(()=>{s.close();const c=new D(process.argv[2]);console.log('restored. integrity_check:',c.pragma('integrity_check',{simple:true}),'items:',c.prepare('select count(*) n from items').get().n);c.close()})" "$SNAP" "$DB"
```

Then reload the app and compare the item count with what you noted before the release. The drill proved the restored
database equals the snapshot row by row for every business table (items, lots, movements, vendors, users, SKU
counters, photo blobs, settings, audit log) and that the byte hash of a file-copy restore equals the snapshot's
sha256. After the new release is deployed, `scripts/restore-db.ts --snapshot ... --sha256 ... --yes` does the same
with a dry-run default and an automatic safety copy.

If the snapshot is on your Mac, copy it back first (reverse of section 4, for example
`base64 file | railway ssh -- "base64 -d > /data/backups/file.db"` [UNVERIFIED]) and check the sha256 on the server.

**Data-loss window:** every item, sale, edit, upload and draft made after the snapshot is gone. The drill showed
exactly that: 3 items created after the snapshot, 4 stock movements, 2 edited quantities/prices and 1 media-pack draft
were absent after the restore. The safety copy written in step 1 still contains them, so they can be recovered by
hand if needed.

## 7. Photos

* Rollback (code or database) never deletes photo files. Tested: after a code-only rollback and after a hard delete
  of a new-code item, every file in `uploads/photos` was still present with the same hash, including the original and
  white-background images referenced by media-pack drafts.
* After restoring a snapshot, photos uploaded after it stay on disk as unreferenced files (harmless). They are **not
  inside the restored database** (no `photo_blobs` row), so the disk copy is their only copy.
* To protect files that exist only on disk, add a photo archive to the pre-release routine (inside `railway ssh`):

```bash
tar czf /data/backups/photos-$(date -u +%Y%m%d-%H%M%S).tgz -C /data uploads/photos
ls -la /data/backups
```

  (`tar` itself was not run against Railway; it is a standard command.) The new snapshot script/endpoint additionally
  writes a manifest (name, size, sha256 of every photo) so loss can be detected later by comparing manifests.
* S3, if configured in the media settings, holds replicas of generated images; it is not a database backup.

## 8. Restore drill (practice before you need it)

Run on a developer machine; it uses temporary folders only (never `./data`, never production):

```bash
git fetch origin 68398e6          # make sure the deployed commit exists locally
npx tsx scripts/rollback-drill/run.ts            # old code -> new code -> old code, snapshot restore, photos; writes docs/evidence/rollback-drill-output.txt
npx tsx scripts/rollback-drill/02-backup-procedure.ts     # backup commands under a live writer
RUN_ROLLBACK_DRILL=1 npx vitest run tests/rollbackDrill.test.ts   # same drill as a test
```

To rehearse on Railway [UNVERIFIED]: clone the service into a staging environment with its own empty volume, run
section 3 and section 6 Level 2 there, and check that the item count returns to the snapshot's count.

## 9. What was verified and what was not

Verified locally with real SQLite files and real server processes (evidence files in `docs/evidence/`):

* What the deployed app's backup covers and does not cover (UI-driven).
* Snapshot consistency under a live writer, WAL behaviour, `integrity_check`.
* Old code on new schema, new code on old schema, snapshot restore (offline file copy, online script, online node
  one-liner), data-loss window, photo files.

Not verified (needs Railway access): `railway ssh` behaviour and the `/app` path, binary transfer through
`railway ssh`, Railway volume-backup availability on your plan, dashboard button names, and the Shopify order sync
writing during the freeze window.

Known remaining limitations: a restore cannot recover writes made after the snapshot; Shopify is not rolled back (a
rollback does not undo products or stock already pushed to Shopify); the S3 database-backup button is still broken on this branch too
(`server/server.ts` queries `jewelry_items`; the table is `items`; left untouched here because other work edits that file); the admin backup endpoint's safety depends on the auth
middleware that another change is hardening.
