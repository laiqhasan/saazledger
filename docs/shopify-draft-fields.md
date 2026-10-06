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
  category that **differ** are re-applied, only to that draft's own variant and inventory item, and only after
  the draft status and `SaazLedger` tag are re-verified in the same call.
* The extra writes are authorised by a per-call scope (`DraftWriteScope`) listing the exact product, variant and
  inventory item ids of the draft this app created or re-verified. A write for any other id throws before any
  network request. Allowed scoped writes: `PUT /inventory_items/{id}.json` (cost/tracked only),
  `POST /inventory_levels/set.json` (available only, configured location), `PUT /variants/{id}.json` (price only,
  used to reconcile a reused draft), GraphQL `productUpdate` (id + category only).
* After writing, the product is re-read and the result returns
  `{ productId, status, variantPrice, cost, inventoryQuantity, mediaCount, adminUrl }`
  (`verification` in `/api/shopify/send-draft` and `/api/media/pack/publish-shopify`), plus `warnings` / `warningCodes`.

## Category

Shopify's standard "category" is a Taxonomy GID that can only be set through GraphQL and must be a real ID from
Shopify's taxonomy. SaazLedger never invents GIDs. Optionally set
`SHOPIFY_CATEGORY_TAXONOMY_MAP='{"PD":"gid://shopify/TaxonomyCategory/<id>","EAR":"gid://shopify/TaxonomyCategory/<id>"}'`
(jewellery type code -> GID; default empty; malformed entries are ignored). With a mapping the category is sent
to the new draft only. Without one the result has warning `category_taxonomy_not_set`: pick the category
manually in Shopify admin during draft review.

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
