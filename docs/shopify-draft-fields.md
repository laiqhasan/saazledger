# Shopify draft fields

SaazLedger only ever creates Shopify products as **drafts**. Nothing is published, activated or archived,
and no existing live / archived / ambiguous / unverified / non-app-owned product, variant, inventory item
or inventory level is written. See `server/services/shopifyDraftGuard.ts`.

## How each field is saved

Values come from the inventory item (the local DB row wins over client-sent values):

| Shopify | SaazLedger field | How |
|---|---|---|
| Variant `price` | `sellingPrice` (`selling_price`) | `POST /products.json` variant price, 2 decimals. No `compare_at_price`. |
| Inventory item `cost` | `buyingPrice` (`buying_price`) | `PUT /inventory_items/{id}.json` `{cost}` (and `tracked: true` if needed). |
| Stock | `quantity` | `POST /inventory_levels/set.json` `{location_id, inventory_item_id, available}` at `SHOPIFY_PRIMARY_LOCATION_ID`. Variant is created with `inventory_management: "shopify"` and `inventory_policy: "deny"`. |
| `product_type` | type code -> label from the code tables (e.g. `PD` -> Pendant Set) | `POST /products.json` |
| Tags | `SaazLedger` (ownership marker), `SKU:<sku>`, type, stone and colour labels | `POST /products.json` |
| Category | optional taxonomy mapping, see below | GraphQL `productUpdate(product: {id, category})` |

If `SHOPIFY_PRIMARY_LOCATION_ID` is not configured the draft is still created with price and cost, stock is
**not** set (no location is guessed) and the result carries the warning `inventory_not_set`.

## Sync / idempotency

* Lookup by linked id, exact SKU and exact title first. Active, archived, ambiguous, non-app-owned or
  unverifiable matches block with "needs manual review" and write nothing.
* Retrying the same SKU reuses the app-owned draft (no second product). Only price / cost / tracking / stock /
  category that **differ** are re-applied (but see "Manual Shopify edits" below: a value someone changed in
  Shopify is never overwritten without explicit confirmation), only to that draft's own variant and inventory item, and only after
  the draft status and `SaazLedger` tag are re-verified in the same call.
* The extra writes are authorised by a per-call scope (`DraftWriteScope`) listing the exact product, variant and
  inventory item ids of the draft this app created or re-verified. A write for any other id throws before any
  network request. Allowed scoped writes: `PUT /inventory_items/{id}.json` (cost/tracked only),
  `POST /inventory_levels/set.json` (available only, configured location), `PUT /variants/{id}.json` (price only,
  used to reconcile a reused draft), GraphQL `productUpdate` (id + category only).
* After writing, the product is re-read and the result returns
  `{ productId, status, variantPrice, cost, inventoryQuantity, mediaCount, adminUrl }`
  (`verification` in `/api/shopify/send-draft` and `/api/media/pack/publish-shopify`), plus `warnings` / `warningCodes`.

## Manual Shopify edits are never overwritten silently

SaazLedger stores, per Shopify product, what it last wrote (table `shopify_sync_state`: `shopify_product_id`,
`item_id`, `sku`, `variant_id`, `inventory_item_id`, `location_id`, `last_synced_quantity`, `last_synced_price`,
`last_synced_cost`, `category_status`, `synced_at`; created with `CREATE TABLE IF NOT EXISTS`, additive only).

* **First create** sets stock / price / cost with no confirmation (nothing can have been edited yet).
* **Resend of an existing app-owned draft**, per field (stock at the configured location, price, cost):
  * Shopify value == SaazLedger value: nothing is written (state is refreshed).
  * Shopify value == what we last wrote (untouched in Shopify) and SaazLedger changed: written normally.
  * Otherwise (changed manually in Shopify, or no sync state and values differ): **no write at all** (not even
    for the other fields) and the request returns **HTTP 409**:

    ```json
    { "success": false, "draftOnly": true, "needsConfirmation": true, "action": "needs_confirmation",
      "code": "stock_overwrite_requires_confirmation",
      "currentQuantity": 7, "desiredQuantity": 5, "lastSyncedQuantity": 5,
      "productId": "...", "adminUrl": "...",
      "confirmation": { "code": "...", "conflicts": [{ "field": "stock", "currentValue": 7, "desiredValue": 5, "lastSyncedValue": 5 }], "productId": "...", "adminUrl": "..." } }
    ```
    `code` is `price_overwrite_requires_confirmation` / `cost_overwrite_requires_confirmation` when only those
    conflict. Both `/api/shopify/send-draft` and `/api/media/pack/publish-shopify` use this same 409 shape (the
    pack route also uploads no media in that case).
* **Second request** (same body plus one of):
  * `confirmStockOverwrite: true` + `expectedCurrentQuantity: <value from the 409>` (likewise
    `confirmPriceOverwrite`/`expectedCurrentPrice`, `confirmCostOverwrite`/`expectedCurrentCost`). The write
    happens only if the expected value still equals Shopify's current value (stale or missing expected value =>
    409 again, `staleConfirmation: true`). Confirmed overwrites are logged (`[Shopify Draft] CONFIRMED ...`).
  * `keepShopifyValues: true` ("Keep Shopify value"): the rest of the request proceeds, conflicting fields are
    skipped with warning `stock_kept_shopify_value` (etc.). They are not recorded as synced, so the next send
    asks again.
* UI: Studio Shopify panel, Shopify modal sync and the single push show "Shopify draft stock is 7 but SaazLedger
  says 5 - overwrite?" with **Keep Shopify value** (default) / **Overwrite with SaazLedger value**.
* Live / archived / ambiguous / non-app-owned / unverified products are still blocked before any of this and
  ignore the confirmation flags.

## Category

Shopify's standard "category" is a Taxonomy GID that can only be set through GraphQL and must be a real ID from
Shopify's taxonomy. SaazLedger never invents GIDs. Optionally set
`SHOPIFY_CATEGORY_TAXONOMY_MAP='{"PD":"gid://shopify/TaxonomyCategory/<id>","EAR":"gid://shopify/TaxonomyCategory/<id>"}'`
(jewellery type code -> GID; default empty; malformed entries are ignored). With a mapping the category is sent
to the draft only. Without one the result has warning `category_taxonomy_not_set` and
`categoryStatus: 'manual_required'` (otherwise `'mapped'`); the Studio panel / Shopify modal show
"Category: NOT SET - assign in Shopify admin before publishing". It is **not** added as a tag (no store
pollution); `category_status` is persisted in `shopify_sync_state` and exposed by `GET /api/shopify/sync-state`
so the register can show an "incomplete" badge for items sent as draft with a manual category.

### Known incomplete

* The Shopify standard taxonomy category must be set by the user in Shopify admin, or via
  `SHOPIFY_CATEGORY_TAXONOMY_MAP` with valid `gid://shopify/TaxonomyCategory/...` IDs that the user supplies.
  We do not invent IDs.
* The register "incomplete" badge itself is not wired yet; the data (`category_status`) is available from
  `GET /api/shopify/sync-state` / `fetchShopifySyncState()`.
* API version: all calls use `config.apiVersion` (env `SHOPIFY_API_VERSION` or the stored/ request config,
  default `2026-07`; see `getShopifyConfig`). The category call is
  `productUpdate(product: ProductUpdateInput!)` with `{ id, category }` and the read is `product(id){ category{ id } }`,
  which is the current (>= 2024-10) shape; on older versions `category` is not on `ProductUpdateInput`. This has
  **not been tested against the real Shopify API**, only against the local fake store.

## Check in Shopify admin before publishing

1. Status is **Draft**; open the `adminUrl` from the result.
2. Price = selling price; Cost per item = buying price; "Track quantity" on; "Continue selling when out of
   stock" off.
3. Quantity at your location matches stock (if you saw `inventory_not_set`, set it by hand).
4. Category (if `category_taxonomy_not_set`), product type and tags look right; media count and cover image.
5. Then publish from Shopify admin yourself; SaazLedger never does.

## Tests

`tests/shopifyDraftFields.test.ts` (guard + service) and `tests/shopifyDraftFields.e2e.test.ts` (real Express
routes over HTTP against `tests/helpers/fakeShopifyServer.ts`, a local fake store). The test-only base URL
override `SHOPIFY_TEST_BASE_URL` is honoured only when `NODE_ENV === 'test'` and only for loopback http URLs.
