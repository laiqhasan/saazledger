# Security & Access Review: authentication and authorization

Branch: `wp2/auth-hardening` (proposal only; nothing here has been deployed or pushed).
Scope: `server/server.ts` (middleware and route registration), `server/services/googleAuthService.ts`, new `server/auth/*`, client auth plumbing (`src/context/AuthContext.tsx`, `src/services/authFetch.ts`).
Method: static reading of the code at the base commit `c9e909c`, plus HTTP-level tests of the fix on an isolated temp database. **Nothing was tested against production, Staging, Shopify, Google or the internet.** All "exploitability" statements below are derived from code reading and local tests, not from probing the live service. Line numbers refer to the base commit (`git show c9e909c:server/server.ts`).

## 1. Summary

At the base commit the API has **no effective access control**. Anyone who can reach the public Railway domain can, with no credentials, read and modify inventory, upload files, spend AI credits, create Shopify draft products, **read and overwrite the Shopify Admin credentials**, read the AI provider API keys in clear text, and mint an admin session for themselves in several independent ways. Fixing one hole does not help while the others stay open, so the fix is a single coherent change (a verified-JWT gate, a database-backed role check on every route, and one route-to-role table that a test keeps complete).

Severity ordering (all are exploitable from the internet, assuming the service is on a public Railway domain):

| # | Finding | Severity |
|---|---|---|
| F1 | No token => synthetic admin (`usr_local`) | Critical |
| F2 | Hard-coded backdoor tokens (`demo_admin_token`, `demo_jwt_*`, anything containing `usr_admin_hasan`) | Critical |
| F3 | Unverified `jwt.decode` fallback trusts `email` (master-admin email is public in source) | Critical |
| F4 | Google ID-token verification falls back to unverified `jwt.decode` (`POST /api/auth/google` mints a real session for any email) | Critical |
| F5 | `mock-google-token:` accepted in all environments (`POST /api/auth/google` mints a session for any email) | Critical |
| F6 | Known default JWT secrets in source, and they differ between files | High |
| F7 | `/api/auth/google/dev-login` mints a master-admin session, unauthenticated | Critical |
| F8 | Unauthenticated Shopify-writing endpoints and Shopify credential overwrite | Critical |
| F9 | `GET /api/settings/ai-config` returns AI provider API keys unauthenticated | Critical |
| F10 | `GET /api/shopify/config` returns the Shopify Admin access token unauthenticated | Critical |
| F11 | `/api/shopify-proxy` sends the stored Admin token to any host named in `?shop=` | Critical |
| F12 | Shopify OAuth callback accepts any `shop` and no HMAC, sends the app client secret to it | High |
| F13 | Webhook HMAC verified only if a secret happens to be configured | High |
| F14 | Seeded default accounts `admin/admin123` and `salesclerk/clerk123` | High (conditional) |
| F15 | `POST /api/auth/google/sync-pending` creates/links accounts from an unauthenticated body | Medium |
| F16 | No role checks on any route (44 of 95 routes only check "has a token"); suspended users keep access | High |

## 2. Findings with evidence

### F1. Anonymous requests are admin (`server/server.ts:253-258`)
```ts
if (!token) {
  // For local desktop usage, allow pass-through as admin if no token provided
  (req as any).user = { id: 'usr_local', role: 'admin', username: 'local_admin' };
  return next();
}
```
Exploitability: trivial; `curl` with no header. Every route that uses `authenticateToken` (44 of them) is therefore open, and the admin-only handlers (`/api/users`, `/api/admin/clear-demo-data`, `/api/media-settings`, ...) that check `user.role !== 'admin'` pass, because the synthetic user *is* admin. Blast radius: user approval/role changes, wiping all inventory (`/api/admin/clear-demo-data`), changing storage settings, hard-deleting items, emptying trash.

### F2. Hard-coded backdoor tokens (`server.ts:262-270`)
`token.startsWith('demo_jwt_') || token.includes('usr_admin_hasan') || token === 'demo_admin_token'` grants the master admin identity (`hasan.laiq@gmail.com`). The client even generated `demo_jwt_<timestamp>` sessions itself (`AuthContext.devLogin` fallback). Exploitability: trivial, `Authorization: Bearer demo_admin_token`.

### F3. Unverified decode fallback (`server.ts:272-309`)
If `jwt.verify` fails, the code runs `jwt.decode(token)` (no signature check) and trusts `decoded.email`: the master-admin email (`hasan.laiq@gmail.com`, public in `googleAuthService.ts` and `migrations.ts`) yields admin; any email matching a DB user yields that user's role (and the master-admin email forces `role: 'admin'` even for an existing DB user). Exploitability: build an unsigned JWT (`alg: none`, or signed with any key) containing `{"email":"hasan.laiq@gmail.com"}`. User emails are guessable. Blast radius: full impersonation of any account.

### F4. Google ID-token verification falls back to unverified decode (`googleAuthService.ts:~79-117`)
`verifyGoogleIdToken` tries `OAuth2Client.verifyIdToken`; on **any failure** it logs a warning and then does `jwt.decode(idToken)` and returns the decoded email as the profile. `POST /api/auth/google` (unauthenticated by design) then calls `findOrCreateGoogleUser` and `generateUserJwt`, so an attacker posting a forged ID token with `email: hasan.laiq@gmail.com` receives a genuine, correctly signed admin session. Exploitability: trivial. This was the most important thing to remove for the Google flow, because it defeats Google's verification entirely.

### F5. Mock Google tokens accepted everywhere (`googleAuthService.ts:64-75`)
Any string `mock-google-token:<email>|<name>|<id>` is accepted as a verified Google identity, in every environment. `POST /api/auth/google` with `mock-google-token:hasan.laiq@gmail.com|x|y` returns an admin session. Exploitability: trivial.

### F6. Public default JWT secrets, and they disagree
`server.ts:145`: `'saaz_atelier_jwt_secret_dev_key_2026'`; `googleAuthService.ts:6`: `'saaz-ledger-enterprise-secure-jwt-key-2026'`. Both are used when `JWT_SECRET` is unset, and the Railway variable list has no `JWT_SECRET`. Anyone who has read the source (or this repository) can sign valid session JWTs. Exploitability: needs the source; trivial after that. (The repository is the obvious place the secret is documented.)

### F7. Dev login (`server.ts:405-422`)
`POST /api/auth/google/dev-login` defaults to the master-admin email and role, builds a mock Google profile and returns a signed session. No auth, no environment guard. Exploitability: trivial.

### F8. Unauthenticated writes and credential overwrite
At the base commit these had no `authenticateToken` at all: `POST /api/photos/upload` (1549), `/api/photos/restore` (172), `/api/media/{crop,white-cover,precision-edit,fidelity-check,auto-crop,detail-crop,pack/generate,regenerate-slot,rebuild-isolation,accuracy/analyze,extract-measurements,publish-shopify,upload-supporting}`, `POST /api/shopify/send-draft` (2478), `POST /api/shopify/config` (2900, overwrites the stored Shopify domain and Admin token), `POST /api/shopify/exchange-token` (2922), `POST /api/inventory/next-sku` (1251, consumes SKU numbers), `POST /api/migration/preview` (3319), `POST /api/auth/google/sync-pending` (425), `POST /api/auth/google/dev-login` (405). `GET /api/inventory` (1205) and many other reads (`/api/vendors`, `/api/reports/movements`, procurement, SKU, needs-attention) were unauthenticated too.

Blast radius:
* **Shopify:** create draft products in the connected store (`send-draft`, `pack/publish-shopify`); **replace the stored credentials** with an attacker's store/token (`POST /api/shopify/config`), which silently redirects every later draft/publish to a store the attacker controls, or disconnects the real store.
* **AI credits:** `pack/generate`, `precision-edit`, `rebuild-isolation`, `accuracy/analyze`, `extract-measurements`, `clean-background` call paid providers (Gemini/OpenAI/PhotoRoom) using the server's keys. A loop of requests burns the budget.
* **Data:** read the whole inventory including buying prices and vendors; modify via the (also anonymous-admin) write routes.
* **Storage / availability:** unbounded file uploads (`express.json({limit:'100mb'})`, parsed before any auth), disk/volume exhaustion, SKU sequence burn.

### F9. AI provider keys served in clear text (`server.ts:675-720`)
`GET /api/settings/ai-config` returns `geminiApiKey`, `openaiApiKey`, `removeBgApiKey`, `clipdropApiKey`, `photoroomApiKey` to anyone. Exploitability: one GET. The keys can then be used directly against the providers, off our server entirely. **If this service has been publicly reachable, treat these keys as compromised and rotate them** (this is independent of the code fix; see section 7).

### F10. Shopify Admin token served in clear text (`server.ts:2882-2896`)
`GET /api/shopify/config` returns `adminAccessToken`. Same remediation: **rotate the Shopify Admin token** if the service was ever public.

### F11. `/api/shopify-proxy` credential exfiltration / SSRF (`server.ts:2936-2988`)
The target is `https://${req.query.shop}${path}` and, when the caller sends no `X-Shopify-Access-Token`, the **stored Admin token is attached**. `?shop=attacker.example.com` makes the server send the real token to the attacker's host. Unauthenticated, all HTTP methods. Also usable as an arbitrary Shopify Admin API client (orders, customers, product deletion).

### F12. Shopify OAuth callback (`server.ts:2991-3007`)
`GET /api/auth/shopify/callback?code=..&shop=..` calls `exchangeAuthCode(shop, code, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)`, which POSTs the **client secret** to `https://<shop>/admin/oauth/access_token` for an attacker-chosen `shop`, with no HMAC check. Exploitability: when `SHOPIFY_CLIENT_ID/SECRET` are set (they are in the Railway variable list as `SHOPIFY_*`, names only verified), one GET sends the app secret to the attacker's server.

### F13. Webhook HMAC is optional (`server.ts:3010-3033`)
`if (webhookSecret) { verify }`: without `SHOPIFY_WEBHOOK_SECRET` set, unsigned webhooks are accepted and processed (inventory deductions). The Railway variable names list `SHOPIFY_*` but I could not confirm that `SHOPIFY_WEBHOOK_SECRET` specifically is set. Exploitability: forged order webhook => fake sales / stock deductions.

### F14. Seeded default passwords (`server/db/migrations.ts:9-22`)
When the `users` table is empty at first boot, `admin / admin123` (admin) and `salesclerk / clerk123` are created and `POST /api/auth/login` accepts them. Whether these rows still exist in the production database is **unknown** (it depends on whether the first boot ran with an empty users table). The fix refuses these two seeded accounts while they still have the default passwords in production-like environments.

### F15. `sync-pending` (`server.ts:425-447`)
Unauthenticated `POST` with `{email,...}` runs `findOrCreateGoogleUser`, creating pending accounts for arbitrary emails (account-table pollution) and, for the master email, ensuring an active admin row. It returned the user record. Now it requires a verified session and ignores the body.

### F16. No authorization model
`authenticateToken` only established identity. No route enforced a role except eight handlers that check `role !== 'admin'` themselves (users x4, clear-demo-data, initialize-sequence, media purge, media-settings). A `viewer` or `clerk` could write; a `suspended` or `pending` user kept working as long as their (7-day) token was valid, because status was never re-read.

## 3. Why Google login currently depends on the bypass

Facts from the code and from the production variable list (names only; values not read):
1. Production has no `JWT_SECRET`, so `server.ts` signs/verifies with `'saaz_atelier_jwt_secret_dev_key_2026'`.
2. `POST /api/auth/google` -> `generateUserJwt()` in `googleAuthService.ts`, which signs with the *other* default, `'saaz-ledger-enterprise-secure-jwt-key-2026'`.
3. Every later request is checked by `authenticateToken` in `server.ts`, whose `jwt.verify(token, 'saaz_atelier_...')` therefore **fails** for every Google-login token (different key).
4. The failure falls into the unverified-decode fallback (F3), which looks the user up by the email inside the token. That is the only reason Google-login sessions work today; "works" here means "is accepted via the hole".

Consequence for the fix: the two files must share one secret (done: `server/auth/jwtSecret.ts`), and once the fallback is removed, Google sessions work only because they are now genuinely verifiable. This is the main rollout risk: **all existing browser sessions become invalid at deploy** (their tokens were signed with a key the server never verified with), and users must sign in again once. The login path itself (`POST /api/auth/google`) is unchanged except that Google's verification is now mandatory (F4/F5 removed). If real Google verification does not succeed in some environment (for example `GOOGLE_CLIENT_ID` on the server differs from the client ID the browser used, or the server clock is far off), login previously "worked" through the unverified fallback and **will now fail**. That is why the Staging checklist (section 8) requires a real Google sign-in on Staging first.

## 4. What the fix does

* `server/auth/jwtSecret.ts`: one resolver used by `server.ts` (password login) and `googleAuthService.ts` (Google login). Order: `JWT_SECRET` env (>=16 chars) else a random 48-byte secret generated once and persisted at `DATA_DIR/.jwt_secret` (mode 0600; `DATA_DIR` follows `RAILWAY_VOLUME_MOUNT_PATH` when mounted). No hard-coded default exists anywhere (a test greps the server tree). Tokens are signed and verified as HS256 only. **Rotating the secret (changing `JWT_SECRET`, or deleting the file) invalidates every session; users sign in again once.** If the service has no persistent volume and no `JWT_SECRET`, each redeploy generates a new secret and signs everyone out: set `JWT_SECRET` in Railway to avoid that.
* `authenticateToken` (`server/auth/middleware.ts`): no token => 401; verified JWT only; the user is loaded from the database by `id` on every request; `status` must be `active` (suspended/pending/rejected => 403 with a machine-readable `ACCOUNT_*` code); the role is taken from the database, never from the token; the master-admin email grants nothing at request time (it only elevates at Google login in `findOrCreateGoogleUser`, which now only runs on a Google-verified identity with a verified email). The demo/backdoor tokens and the unverified decode are deleted.
* `ALLOW_ANONYMOUS_LOCAL_ADMIN=true` restores the old anonymous local-desktop admin **only when `NODE_ENV !== 'production'` and no `RAILWAY_*` variable exists** (`server/auth/environment.ts`, tested). It cannot be enabled in production or on any Railway environment (including Staging).
* Global gate (`policyGate`) mounted on `/api` before body parsing: every request is looked up in the single `ROUTE_POLICY` table (`server/auth/routePolicy.ts`); a request that matches nothing still requires a session (anonymous probes get 401, not a route-existence oracle). `tests/authHardening.test.ts` enumerates every route registered on the express app and fails when one lacks a policy row (or a row is stale).
* Webhook: `POST /api/webhooks/shopify` needs no session but **must** carry a valid `X-Shopify-Hmac-Sha256` computed with `SHOPIFY_WEBHOOK_SECRET` (falling back to `SHOPIFY_CLIENT_SECRET`, the app secret Shopify signs with). No secret configured => 503, unsigned/invalid => 401.
* OAuth callback requires Shopify's query HMAC and a genuine `*.myshopify.com` shop; the proxy only talks to `*.myshopify.com` and only attaches the stored token to the configured store.
* Dev helpers: `dev-login` returns 404 and mock Google tokens are refused when `NODE_ENV=production` or any `RAILWAY_*` variable exists (this includes Staging, which sign in with real Google).
* `GET /api/settings/ai-config` now needs `staff` (the browser calls the AI providers directly with these keys, so staff must still receive them; see residual risks); `GET /api/shopify/config` returns the raw token only to admins (others get `hasAdminAccessToken: true`, and the Shopify proxy attaches the stored token server-side).
* Seeded default-password accounts are refused in production-like environments; suspended/non-active accounts cannot password-login.
* Client: `src/services/authFetch.ts` patches `window.fetch` once (installed in `main.tsx`) so **every** same-origin `/api` call (all service calls and the ~60 direct `fetch(` calls in components) sends `Authorization: Bearer <token>` from storage; a 401 for a request that carried a token clears the stored session and broadcasts an event that returns the user to the login screen; a 403 `ACCOUNT_*` makes the app re-read `/api/auth/me` (which still works for pending/suspended users) so the pending-approval screen appears. Third-party URLs are never touched. The offline "demo_jwt" and client-side fake-Google-session fallbacks were removed; dev-login buttons are hidden unless the Vite dev build is running.

## 5. Route -> minimum role table (code: `server/auth/routePolicy.ts`)

Roles are ordered viewer < staff < manager < admin (legacy `clerk` = staff). Definitions: **viewer** read-only (GET); **staff** add/edit items, sales, photo upload, media generation; **manager** staff + Shopify send-draft/publish/proxy, vendors, bulk operations, purchasing, audit log; **admin** user management, Shopify/AI/storage credentials, backups and destructive/dev tools. `identity` = any verified session regardless of status (so pending users can poll their approval state). Media files under `/api/photos/*` with an image/video extension (`jpg jpeg png webp gif avif heic heif mp4 mov webm`) stay public for `<img>`/`<video>` (the table lists those routes as `viewer` for any other file type, and `/api/photos/status` is `viewer`). Hard delete (`DELETE /api/inventory/:id?hard=true`) additionally requires manager inside the handler.

| Minimum access | Method | Route |
|---|---|---|
| public | GET | `/api/health` |
| public | POST | `/api/auth/login` |
| public | GET | `/api/auth/google/config` |
| public | POST | `/api/auth/google` |
| dev | POST | `/api/auth/google/dev-login` |
| webhook | POST | `/api/webhooks/shopify` |
| oauth | GET | `/api/auth/shopify/callback` |
| identity | GET | `/api/auth/me` |
| identity | POST | `/api/auth/google/sync-pending` |
| viewer | GET | `/api/photos/derivatives/:filename` |
| viewer | GET | `/api/photos/:filename` |
| viewer | GET | `/api/photos/status` |
| viewer | GET | `/api/inventory` |
| viewer | GET | `/api/inventory/:id/verify` |
| viewer | GET | `/api/inventory/balances` |
| viewer | GET | `/api/inventory/channel-allocations/:variantId` |
| viewer | GET | `/api/vendors` |
| viewer | GET | `/api/media` |
| viewer | GET | `/api/media/presets` |
| viewer | GET | `/api/media/jobs/:id` |
| viewer | GET | `/api/media/:id` |
| viewer | GET | `/api/media/measurements/:productId` |
| viewer | GET | `/api/media-pack-drafts` |
| viewer | GET | `/api/media-pack-drafts/:clientItemId` |
| viewer | GET | `/api/shopify/status` |
| viewer | GET | `/api/shopify/config` |
| viewer | GET | `/api/shopify/published-media/:productId` |
| viewer | GET | `/api/reports/movements` |
| viewer | GET | `/api/sku/sequence-status` |
| viewer | GET | `/api/sku/preview` |
| viewer | GET | `/api/procurement/reorder-suggestions` |
| viewer | GET | `/api/procurement/purchase-orders` |
| viewer | GET | `/api/needs-attention` |
| staff | POST | `/api/inventory` |
| staff | PUT | `/api/inventory/:id` |
| staff | DELETE | `/api/inventory/:id` |
| staff | POST | `/api/inventory/:id/restore` |
| staff | POST | `/api/inventory/sale` |
| staff | POST | `/api/inventory/:id/adjust` |
| staff | POST | `/api/inventory/movements` |
| staff | POST | `/api/inventory/next-sku` |
| staff | POST | `/api/sku/allocate-global` |
| staff | POST | `/api/needs-attention/:id/resolve` |
| staff | POST | `/api/backup/migrate-browser` |
| staff | PUT | `/api/media-pack-drafts/:clientItemId` |
| staff | POST | `/api/photos/upload` |
| staff | POST | `/api/photos/restore` |
| staff | GET | `/api/settings/ai-config` |
| staff | POST | `/api/media/clean-background` |
| staff | POST | `/api/media/crop` |
| staff | POST | `/api/media/white-cover` |
| staff | POST | `/api/media/precision-edit` |
| staff | POST | `/api/media/fidelity-check` |
| staff | POST | `/api/media/auto-crop` |
| staff | POST | `/api/media/detail-crop` |
| staff | POST | `/api/media/pack/generate` |
| staff | POST | `/api/media/pack/regenerate-slot` |
| staff | POST | `/api/media/rebuild-isolation` |
| staff | POST | `/api/media/accuracy/analyze` |
| staff | POST | `/api/media/extract-measurements` |
| staff | POST | `/api/media/measurements/:productId/apply-to-item` |
| staff | POST | `/api/media/upload-supporting` |
| staff | POST | `/api/media/upload-direct` |
| staff | PATCH | `/api/media/:id` |
| staff | DELETE | `/api/media/:id` |
| staff | POST | `/api/products/:productId/media/link` |
| staff | DELETE | `/api/products/:productId/media/:mediaId` |
| staff | PUT | `/api/products/:productId/media/reorder` |
| manager | POST | `/api/shopify/send-draft` |
| manager | POST | `/api/media/pack/publish-shopify` |
| manager | ALL | `/api/shopify-proxy` |
| manager | GET | `/api/reports/audit-logs` |
| manager | POST | `/api/inventory/bulk-delete` |
| manager | POST | `/api/inventory/bulk-restore` |
| manager | POST | `/api/inventory/empty-trash` |
| manager | POST | `/api/vendors` |
| manager | DELETE | `/api/vendors/:id` |
| manager | PUT | `/api/inventory/channel-allocations/:variantId` |
| manager | POST | `/api/procurement/purchase-orders` |
| manager | POST | `/api/procurement/purchase-orders/:id/receive` |
| manager | POST | `/api/migration/preview` |
| manager | POST | `/api/migration/execute` |
| admin | POST | `/api/auth/google/config` |
| admin | GET | `/api/users` |
| admin | POST | `/api/users/:id/approve` |
| admin | POST | `/api/users/:id/role` |
| admin | POST | `/api/users/:id/status` |
| admin | POST | `/api/admin/clear-demo-data` |
| admin | POST | `/api/settings/ai-config` |
| admin | GET | `/api/media-settings` |
| admin | POST | `/api/media-settings` |
| admin | POST | `/api/media-settings/test-s3` |
| admin | POST | `/api/media-settings/sync-all-to-s3` |
| admin | POST | `/api/media-settings/backup-db-to-s3` |
| admin | POST | `/api/media-settings/test-drive` |
| admin | POST | `/api/media/migrate` |
| admin | POST | `/api/media/:id/purge` |
| admin | POST | `/api/sku/initialize-sequence` |
| admin | POST | `/api/shopify/config` |
| admin | POST | `/api/shopify/exchange-token` |

## 6. External access control (Railway) and external verification

### What an external gate can and cannot do
Railway public domains (`*.up.railway.app` and custom domains) have **no built-in authentication**. Anything in front of the service (Cloudflare Access, an authenticating reverse proxy, IP allowlisting, or removing the public domain and using private networking) can:
* hide *everything*, including the static photo URLs and the HTML bundle, from the open internet;
* stop opportunistic scanning and bot traffic regardless of application bugs;
* be put in place without a code deploy (an immediate stop-gap).

It cannot:
* fix application-level problems for users who *are* let through: any allowed visitor still got anonymous admin, the AI/Shopify keys, and so on, so it does not replace this change;
* protect a second route to the same service: if the `*.up.railway.app` domain stays enabled while only a custom domain is gated, the service is still reachable directly;
* work unmodified with Shopify webhooks (`POST /api/webhooks/shopify`) and the Shopify OAuth redirect (`GET /api/auth/shopify/callback`): Shopify cannot pass an interactive gate, so those two paths need an explicit bypass (they are HMAC-protected after this change; before it, they are not);
* give per-user roles, suspension or an audit trail (that is the application's job);
* protect `<img>` tags unless the browser already holds the gate's cookie (usually fine for a logged-in staff browser).

### Read-only checks to run from your own machine
Use the **public URL of the service** (replace `$BASE`). All commands are `GET`s, send no data, and print only the HTTP status code (`-o /dev/null`), so that if something is wide open you do not dump secrets into your terminal or shell history. Do not run any POST/PUT/DELETE against production.

```bash
BASE=https://YOUR-SERVICE.up.railway.app
code() { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }

# 1. Anonymous admin (F1).  Old code: 200.  Fixed code: 401.
code "$BASE/api/auth/me"
code "$BASE/api/inventory"
code "$BASE/api/users"

# 2. Credentials/keys exposed to anonymous callers (F9, F10).  Old: 200.  Fixed: 401.
code "$BASE/api/settings/ai-config"
code "$BASE/api/shopify/config"

# 3. Backdoor tokens (F2).  Old: 200.  Fixed: 401.
code -H 'Authorization: Bearer demo_admin_token' "$BASE/api/auth/me"
code -H 'Authorization: Bearer demo_jwt_1' "$BASE/api/auth/me"
code -H 'Authorization: Bearer usr_admin_hasan' "$BASE/api/auth/me"

# 4. Unverified-decode forgery (F3): an UNSIGNED token carrying the master email.  Old: 200.  Fixed: 401.
b64() { printf '%s' "$1" | openssl base64 -A | tr '+/' '-_' | tr -d '='; }
FORGED="$(b64 '{"alg":"none","typ":"JWT"}').$(b64 '{"email":"hasan.laiq@gmail.com","id":"usr_admin_hasan"}')."
code -H "Authorization: Bearer $FORGED" "$BASE/api/auth/me"

# 5. Public allowlist still works on the fixed build.  Expect 200 (fixed) / 404 (old, no such route).
code "$BASE/api/health"
code "$BASE/api/auth/google/config"            # 200 both (public bootstrap, only the Client ID)

# 6. Images still load without headers (needed for <img>).  Use a real filename from the app; 200 expected both.
code "$BASE/api/photos/<an-existing-photo-filename>.jpg"
code "$BASE/api/photos/status"                 # old: 200 (storage stats).  Fixed: 401
```

How to read the results:
* `200` on 1 to 4 means the corresponding bypass is live (the service is open). `401` means closed. `403` also means closed (a gate in front, or an inactive account).
* `302/401/403` from *every* path including `/api/health` and the `.jpg` means an external gate (Cloudflare Access etc.) is in front: you are not seeing the application's behaviour; verify from inside the gate, or against the service's internal address.
* `404` on `/api/health` identifies the **old build** (the route was added by this change), a handy "is the fix deployed" probe.
* A fixed build must still answer `200` for the media file and `/api/auth/google/config`; if those fail, public media/bootstrap is broken.
* You can also check from the Railway side (read-only): `list-variables` should show `JWT_SECRET` after you set it, `list-domains` shows every public hostname (each one must be gated or covered by the fix), and the service must have a volume if you rely on the persisted secret file.

To test an *authenticated* path on the fixed build you need a real session token: sign in with Google in the browser, then copy `localStorage['saaz_auth_token']` (DevTools > Application) and call e.g. `code -H "Authorization: Bearer $TOKEN" $BASE/api/auth/me` (expect 200) and `.../api/users` (200 for admin, 403 for others).

## 7. Immediate actions independent of the code change

1. If the service has been on a public domain, assume exposure of what F9/F10/F11/F12 return: **rotate** the Shopify Admin access token, the Gemini/OpenAI/PhotoRoom (and remove.bg/ClipDrop if used) keys, and the Shopify app client secret, after the fixed build is live (rotating first is pointless while the endpoints still leak). Review the Shopify store for unexpected draft products and check Admin API / app credentials for an attacker's store domain.
2. Review the `users` table and audit log for unexpected admin/active accounts (`GET /api/users` as admin; also `usr_local`/`usr_admin_master` rows).
3. Optionally put an external gate in front (section 6) as a stop-gap until the fix is deployed, remembering the webhook/OAuth bypass.

## 8. Rollout, migration and Staging checklist

### Deploy order
1. **Decide the secret.** Preferred: set `JWT_SECRET` (a random 48+ character string) in the Railway service variables **before** deploying. Alternative: rely on the auto-generated secret persisted at `DATA_DIR/.jwt_secret`; this requires that `RAILWAY_VOLUME_MOUNT_PATH` (a Railway volume) is mounted, otherwise every redeploy creates a new secret and signs everyone out. Check the service's volume configuration first.
2. Set `SHOPIFY_WEBHOOK_SECRET` (or confirm `SHOPIFY_CLIENT_SECRET` is the app secret that signs the webhooks) **before** deploying, or webhook deliveries will get 503 until you do (inventory stops syncing from Shopify orders; nothing is lost, Shopify retries). Confirm `GOOGLE_CLIENT_ID` on the server equals the client ID the browser uses.
3. Deploy to **Staging first**. Run the checklist below. Only then deploy to production.
4. **Existing sessions are invalidated** (their tokens were never verifiable with the server's key, see section 3). **Every user must sign in again once.** Tell them beforehand. The seeded master admin (`hasan.laiq@gmail.com`) is elevated/activated automatically on Google sign-in as before.
5. After production is verified, rotate the credentials in section 7.1 and clear any external stop-gap gate.

### Rollback
Rollback is "redeploy the previous commit". **That restores the old, insecure behaviour in full** (anonymous admin, backdoor tokens, forgeable sessions, exposed keys). Use it only as an emergency measure for a lock-out that cannot be fixed another way, and put an external gate (section 6) in front while it is active. The persisted `.jwt_secret` file is simply ignored by the old code. Because no database schema changes were made, nothing needs to be migrated back.

### Staging verification checklist
Run on Staging (Railway), with real Google sign-in (dev-login and mock tokens are intentionally disabled there):
1. `GET /api/health` = 200; the section 6 curl block gives 401 for checks 1 to 4 where expected.
2. Sign in with Google as the master admin: lands in the app, inventory loads, Users modal lists users.
3. Sign in with a second Google account that is not yet approved: sees the pending-approval screen; as admin approve it as `viewer`: within ~6 seconds the pending screen is replaced by the app (no re-login needed) and write actions return a 403 message (staff-and-above actions disabled).
4. Change that user to `staff`: can add an item, upload photos, generate media; **cannot** use "Send to Shopify" (needs manager) or Shopify settings. Change to `manager`: can send a draft; still cannot save Shopify credentials. Admin: can.
5. Suspend a signed-in user from the admin screen: that user's next action returns them to the pending/suspended screen, without waiting for token expiry.
6. Images in the grid and detail views (including supporting images/videos) display (public media files).
7. `AI config`, `Shopify config sync`, vendors list, SKU preview/sequence, media settings page all load for the roles that should see them (admin: all; staff: AI config yes, media settings no).
8. Webhook: send a test notification from the Shopify admin (Notifications > Webhooks > Send test) and confirm 200 in the logs; an unsigned `curl -X POST` to the staging webhook (Staging only, never production) returns 401.
9. Redeploy Staging once and confirm you are **not** signed out (proves the secret persists via the volume or `JWT_SECRET`).
10. Confirm no `demo`/`dev-login` UI is shown and that `POST /api/auth/google/dev-login` on Staging returns 404.
Do not proceed to production until 2, 3 and 9 pass: they cover the lock-out risks.

## 9. Residual risks and known limitations (candid)

* **Lock-out risk:** if real Google token verification fails in production (client-ID mismatch, clock skew, `GOOGLE_CLIENT_ID` env pointing at another project), nobody can sign in, because the unverified fallback that used to paper over such problems is gone. Mitigations: Staging test; admin password login still works for any non-default admin account that has a password (the seeded `admin` account is deliberately refused in production-like environments while it still has `admin123`). There is no built-in "break-glass" account; if you want one, create it deliberately with a strong password before deploying.
* AI provider keys are still delivered to the browser of every `staff`+ user (the client calls Gemini/OpenAI directly with them). Moving those calls server-side would remove that; not done here (outside auth plumbing).
* The Shopify Admin token still lives in clear text in `system_settings`/localStorage for admins (existing design).
* Tokens are not revocable individually (JWT), but because status/role are re-read from the database on every request, suspending or deleting a user takes effect immediately; rotating the secret is the "log everybody out" switch.
* There is no rate limiting or login throttling; `/api/auth/login` could be brute-forced against password accounts. Not addressed here.
* The `/api/photos` media class is intentionally public (file names are random, unguessable hashes, but anyone holding a URL can fetch it).
* CORS is `origin: true` with credentials (unchanged). Because the SPA authenticates with a bearer header (not cookies), CSRF is not a concern for the API, but this should be tightened when convenient.
* Not verified in this sandbox: a real Google sign-in with a real Google-issued ID token, a real browser run of the SPA, any Railway behaviour, and real Shopify delivery of signed webhooks. The Google verification library is exercised only through a mocked `verifyIdToken`.

## 10. Test coverage added

`tests/authHardening.test.ts` (HTTP level, isolated temp `DATA_DIR`): policy completeness (every registered route has a row; no stale rows; the open list is exactly the nine allowlisted rows); every protected row answers 401 anonymously; forged/backdoor/unsigned/old-default-secret/HS512/expired/ghost-user tokens are rejected; master-admin email inside a valid token does not elevate; suspended/pending/rejected users are 403 and suspension is immediate; viewer cannot write; every table row enforced for viewer/staff/clerk/manager/admin; staff/manager/admin Shopify matrix; hard delete needs manager; webhook HMAC (unsigned, wrong secret, tampered body, valid, no-secret 503, app-secret fallback); OAuth callback HMAC; proxy host guard; dev-login and mock Google tokens 404/401 under `NODE_ENV=production` or any `RAILWAY_*`; `ALLOW_ANONYMOUS_LOCAL_ADMIN` honoured only off-production/off-Railway; Google login round trip with the shared secret, pending-approval flow, rejection of failed or unverified-email Google tokens; seeded default passwords refused in production; secret persistence (mode 0600, reused across a simulated restart, env override, rotation invalidates sessions, short env ignored, no hard-coded defaults left).
