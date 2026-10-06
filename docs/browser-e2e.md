# Browser end-to-end workflow (Playwright, real UI, real server, real SQLite)

`scripts/browser-e2e/run.ts` drives the **real built SPA** in Chromium against the **real Express app** and the **real
SQLite engine**, in a throw-away temp data directory. It is re-runnable unchanged: today it is a **DRY RUN**
(synthetic photo + a fake Shopify on localhost); you re-run it with your **genuine photo** and a **real Shopify TEST
store** just by changing flags and environment variables.

> Every report line carries the banner. A dry run says
> `DRY RUN — synthetic photo, fake Shopify — NOT the genuine photo / NOT a real store`.
> A dry run proves the workflow and the integration between UI, auth, server and database. It says nothing about the
> real photo's cutout quality or about a real store.

## What it checks

1. **Login / roles**: anonymous is rejected (401); wrong password is rejected in the UI; viewer has no "New Piece" and
   no Edit/Push-to-Shopify row actions and the server refuses its writes (403).
2. **New piece**: upload the photo, qty 5, buying 500, selling 1200, vendor; Media Pack Studio with *Product Accuracy -
   Exact Cutout*; white 2048x2048 hero (pixel-checked), completeness gate result (retained %, no lost components),
   crop editor shows `Original (uploaded photo): <W> x <H> px`, crop **recovery** from the true original after a bad crop.
3. **Save**: UI shows "Saving to server..." and the modal stays open until the server confirms; double-click sends one
   request; read back via `GET /api/inventory/:id/verify` and straight from the SQLite file; retry and same-SKU
   duplicate leave exactly one item (409 DUPLICATE_SKU).
4. **Media recovery**: localStorage + IndexedDB of the *test* browser context are wiped; after login the item and the
   unpublished media pack are restored from the server (`media_pack_drafts`).
5. **Shopify (DRAFT only)**: send draft; draft status, price 1200, cost 500, stock 5, media count, admin link; the
   `Category: NOT SET - assign in Shopify admin before publishing` warning; resend = no duplicate and zero writes;
   manual stock change to 7 then resend = confirm dialog, *Keep Shopify value* leaves 7, *Overwrite* sets 5 only after the
   explicit click; a seeded LIVE product with the same SKU is blocked with zero writes to it (fake store only); the fake
   store recorded no non-draft writes.
6. **Backup**: `POST /api/admin/backup/db` as admin = 201 + integrity ok, as viewer = 403, anonymous = 401.
7. `report.txt` / `report.json` with every assertion PASS/FAIL, versions, photo sha256 and the banner. Exit code is
   non-zero if anything failed.

Sign-in uses the real **username/password** form with two users seeded into the *temp* database (an admin and a
viewer). **Google sign-in cannot be automated and is not exercised.**

## One-time setup (outside the repo; nothing is added to package.json)

```bash
# 1. Playwright's library (NOT a repo dependency). Pick any folder outside the repo:
mkdir -p ~/pw && cd ~/pw && npm init -y && npm i playwright-core
export PW_CORE=~/pw                       # folder that contains node_modules/playwright-core

# 2. A Chromium. Either let Playwright download one ...
cd ~/pw && npx playwright-core install chromium
#    ... or point at an installed Chrome/Chromium binary:
# export CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
#    (the sandbox uses PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers, found automatically)

# 3. Repo dependencies as usual
cd /path/to/saazledger && npm ci
```

## Dry run (what was run in the sandbox)

```bash
cd /path/to/saazledger
PW_CORE=~/pw npx tsx scripts/browser-e2e/run.ts
# output: ./browser-e2e-output/report.txt, report.json, screenshots/  (git-ignored)
```

Options: `--out DIR`, `--headed` (watch it), `--skip-build` (reuse `dist/`), `--keep-temp` (keep the temp data dir),
`--stop-after N` (stop after phase N).

## Run with your GENUINE photo (still the local fake Shopify)

```bash
PW_CORE=~/pw npx tsx scripts/browser-e2e/run.ts \
  --photo /abs/path/IMG_20261001_120958.jpg \
  --require-original-dims 2276x4048
```

`--require-original-dims` refuses to run if the file is not exactly that size (raw or EXIF-oriented), so you cannot
accidentally test a resized copy. The report records the file's sha256 and reports whether the stored original on the server
is byte-identical to it (and checks its full pixel size).

## Run against a REAL Shopify TEST store

Use a **development / test store only** - never the production store. The script refuses to run if the domain is not an
explicit `<name>.myshopify.com`, or equals/contains a production domain (`saazaura`, `saaz-jewels`, anything in
`PRODUCTION_SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_STORE_DOMAIN`). Name your test store accordingly.
Secrets are read from the environment only, are never printed, and are redacted from the captured server log.

```bash
export TEST_SHOPIFY_SHOP_DOMAIN="my-e2e-test-store.myshopify.com"
export TEST_SHOPIFY_ADMIN_TOKEN="shpat_..."        # Admin API token with products + inventory scopes (test store)
export TEST_SHOPIFY_LOCATION_ID="1234567890"       # numeric location id of the test store
export TEST_PHOTOROOM_API_KEY="..."                # optional: real PhotoRoom cutout instead of the deterministic local stub

PW_CORE=~/pw npx tsx scripts/browser-e2e/run.ts \
  --photo /abs/path/IMG_20261001_120958.jpg --require-original-dims 2276x4048 \
  --shopify-mode real
```

Differences in `real` mode:

* The app runs with `NODE_ENV=development` (the Shopify base-URL override and the cutout stub are `NODE_ENV=test` only),
  so it talks to the real `*.myshopify.com` host; PhotoRoom is used only if `TEST_PHOTOROOM_API_KEY` is set.
* The script pauses at the "manual stock change" step and prints an instruction: open the draft in the test store admin,
  set the stock to 7, press Enter. Use `--skip-manual-stock` to skip that step.
* Not possible against a real store (and skipped, reported as SKIP): the seeded LIVE-product block test and the
  "fake store recorded no violations" assertion. Look in Shopify admin: the only thing created must be one **draft**.
* Remove the test product from the store afterwards.

### Network note for the Claude sandbox

The sandbox network policy currently blocks `*.myshopify.com` and `sdk.photoroom.com`, so the real-store and real-PhotoRoom
modes cannot run there. Run them on your Mac, or allow those two hosts in the sandbox network policy.
In `fake` mode the browser is additionally locked to the local app (every other host is aborted).

## What to send back

* `browser-e2e-output/report.txt` (and `report.json`)
* `browser-e2e-output/screenshots/` (all PNGs) - or at least `crop-editor-true-original`, `studio-generated-gallery`,
  `shopify-draft-verified`, `shopify-overwrite-confirm`
* the exact command line you used and whether it printed `ALL PASS`
* for a real-store run: a screenshot of the Shopify admin draft (title, price, cost, stock, media, category empty)
* if anything FAILed: `browser-e2e-output/server-log-tail.txt` (written only on failure; secrets redacted)

## Files

* `scripts/browser-e2e/run.ts` - the workflow and assertions
* `scripts/browser-e2e/serverLauncher.ts` - listens for the app under `NODE_ENV=test` (production code is untouched)
* `scripts/browser-e2e/lib/{stack,browser,fixtures,report}.ts` - temp stack, Playwright loader, synthetic photo, reporting
* `tests/browserE2eGuards.test.ts` - unit test of the production-domain refusal
