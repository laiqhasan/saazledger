/**
 * THE route -> minimum-access table. Every route registered on the express app MUST appear here
 * (tests/authHardening.test.ts iterates app.router and fails on any route without an entry), and the
 * global gate in middleware.ts enforces exactly this table, so a new route cannot ship unprotected.
 *
 * Access levels:
 *   public    no credentials (login, bootstrap config, health). Media files under /api/photos are also
 *             public via isPublicMediaPath() (extension allowlist), but are listed as 'viewer' below.
 *   dev       public but 404 in production-like environments (dev helpers)
 *   webhook   no session; the handler MUST verify the Shopify HMAC signature and reject unsigned requests
 *   oauth     no session; the handler MUST verify Shopify's OAuth query HMAC
 *   identity  any verified session whose user row exists, regardless of status (pending/rejected can poll
 *             their own approval state); grants nothing else
 *   viewer    read-only (GET)
 *   staff     add/edit items, sales, upload photos, media generation (legacy 'clerk' = staff)
 *   manager   staff + Shopify send-draft/publish/proxy, vendors, bulk ops, purchasing, audit/report data
 *   admin     user management, Shopify credentials, AI/storage credentials, backups, dev/danger tools
 */
import type { Role } from './roles';

export type Access = 'public' | 'dev' | 'webhook' | 'oauth' | 'identity' | Role;
export type PolicyMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';

export interface RoutePolicy {
  method: PolicyMethod;
  path: string; // exactly as registered with express
  access: Access;
}

const P = (method: PolicyMethod, path: string, access: Access): RoutePolicy => ({ method, path, access });

export const ROUTE_POLICY: RoutePolicy[] = [
  // ---- public / bootstrap ----
  P('GET', '/api/health', 'public'),
  P('POST', '/api/auth/login', 'public'),
  P('GET', '/api/auth/google/config', 'public'),
  P('POST', '/api/auth/google', 'public'),
  P('POST', '/api/auth/google/dev-login', 'dev'),
  P('POST', '/api/webhooks/shopify', 'webhook'),
  P('GET', '/api/auth/shopify/callback', 'oauth'),

  // ---- identity (any account status) ----
  P('GET', '/api/auth/me', 'identity'),
  P('POST', '/api/auth/google/sync-pending', 'identity'),

  // ---- admin ----
  P('POST', '/api/auth/google/config', 'admin'),
  P('GET', '/api/users', 'admin'),
  P('POST', '/api/users/:id/approve', 'admin'),
  P('POST', '/api/users/:id/role', 'admin'),
  P('POST', '/api/users/:id/status', 'admin'),
  P('POST', '/api/admin/clear-demo-data', 'admin'),
  // Database/photo backups (server/routes/backupRoutes.ts): admin only; creation is POST so it cannot be triggered by a link prefetch.
  P('GET', '/api/admin/backup/db', 'admin'),
  P('POST', '/api/admin/backup/db', 'admin'),
  P('GET', '/api/admin/backup/photos-manifest', 'admin'),
  P('POST', '/api/settings/ai-config', 'admin'),
  P('GET', '/api/media-settings', 'admin'),
  P('POST', '/api/media-settings', 'admin'),
  P('POST', '/api/media-settings/test-s3', 'admin'),
  P('POST', '/api/media-settings/sync-all-to-s3', 'admin'),
  P('POST', '/api/media-settings/backup-db-to-s3', 'admin'),
  P('POST', '/api/media-settings/test-drive', 'admin'),
  P('POST', '/api/media/migrate', 'admin'),
  P('POST', '/api/media/:id/purge', 'admin'), // handler already required admin
  P('POST', '/api/sku/initialize-sequence', 'admin'), // handler already required admin
  P('POST', '/api/shopify/config', 'admin'),
  P('POST', '/api/shopify/exchange-token', 'admin'),

  // ---- manager ----
  P('POST', '/api/shopify/send-draft', 'manager'),
  // Read-only view of what SaazLedger last synced to each Shopify draft (stock/price/cost/category status).
  P('GET', '/api/shopify/sync-state', 'manager'),
  P('POST', '/api/media/pack/publish-shopify', 'manager'),
  P('ALL', '/api/shopify-proxy', 'manager'),
  P('GET', '/api/reports/audit-logs', 'manager'),
  P('POST', '/api/inventory/bulk-delete', 'manager'),
  P('POST', '/api/inventory/bulk-restore', 'manager'),
  P('POST', '/api/inventory/empty-trash', 'manager'),
  P('POST', '/api/vendors', 'manager'),
  P('DELETE', '/api/vendors/:id', 'manager'),
  P('PUT', '/api/inventory/channel-allocations/:variantId', 'manager'),
  P('POST', '/api/procurement/purchase-orders', 'manager'),
  P('POST', '/api/procurement/purchase-orders/:id/receive', 'manager'),
  P('POST', '/api/migration/preview', 'manager'),
  P('POST', '/api/migration/execute', 'manager'),

  // ---- staff ----
  P('POST', '/api/inventory', 'staff'),
  P('PUT', '/api/inventory/:id', 'staff'),
  P('DELETE', '/api/inventory/:id', 'staff'), // hard delete (?hard=true) additionally requires manager in the handler
  P('POST', '/api/inventory/:id/restore', 'staff'),
  P('POST', '/api/inventory/sale', 'staff'),
  P('POST', '/api/inventory/:id/adjust', 'staff'),
  P('POST', '/api/inventory/movements', 'staff'),
  P('POST', '/api/inventory/next-sku', 'staff'),
  P('POST', '/api/sku/allocate-global', 'staff'),
  P('POST', '/api/needs-attention/:id/resolve', 'staff'),
  P('POST', '/api/backup/migrate-browser', 'staff'),
  P('PUT', '/api/media-pack-drafts/:clientItemId', 'staff'),
  P('POST', '/api/photos/upload', 'staff'),
  P('POST', '/api/photos/restore', 'staff'),
  P('GET', '/api/settings/ai-config', 'staff'), // returns provider API keys; the browser calls AI providers with them
  P('POST', '/api/media/clean-background', 'staff'),
  P('POST', '/api/media/crop', 'staff'),
  P('POST', '/api/media/white-cover', 'staff'),
  P('POST', '/api/media/precision-edit', 'staff'),
  P('POST', '/api/media/fidelity-check', 'staff'),
  P('POST', '/api/media/auto-crop', 'staff'),
  P('POST', '/api/media/detail-crop', 'staff'),
  P('POST', '/api/media/pack/generate', 'staff'),
  P('POST', '/api/media/pack/regenerate-slot', 'staff'),
  P('POST', '/api/media/rebuild-isolation', 'staff'),
  P('POST', '/api/media/accuracy/analyze', 'staff'),
  P('POST', '/api/media/extract-measurements', 'staff'),
  P('POST', '/api/media/measurements/:productId/apply-to-item', 'staff'),
  P('POST', '/api/media/upload-supporting', 'staff'),
  P('POST', '/api/media/upload-direct', 'staff'),
  P('PATCH', '/api/media/:id', 'staff'),
  P('DELETE', '/api/media/:id', 'staff'),
  P('POST', '/api/products/:productId/media/link', 'staff'),
  P('DELETE', '/api/products/:productId/media/:mediaId', 'staff'),
  P('PUT', '/api/products/:productId/media/reorder', 'staff'),

  // ---- viewer (read-only) ----
  // Media files (jpg/png/webp/gif/avif/heic/mp4/mov/webm) under /api/photos are served WITHOUT a session
  // by isPublicMediaPath() because <img>/<video> tags cannot send headers; any other file needs a viewer.
  P('GET', '/api/photos/derivatives/:filename', 'viewer'),
  P('GET', '/api/photos/:filename', 'viewer'),
  P('GET', '/api/photos/status', 'viewer'),
  P('GET', '/api/inventory', 'viewer'),
  P('GET', '/api/inventory/:id/verify', 'viewer'),
  P('GET', '/api/inventory/balances', 'viewer'),
  P('GET', '/api/inventory/channel-allocations/:variantId', 'viewer'),
  P('GET', '/api/vendors', 'viewer'),
  P('GET', '/api/media', 'viewer'),
  P('GET', '/api/media/presets', 'viewer'),
  P('GET', '/api/media/jobs/:id', 'viewer'),
  P('GET', '/api/media/:id', 'viewer'),
  P('GET', '/api/media/measurements/:productId', 'viewer'),
  P('GET', '/api/media-pack-drafts', 'viewer'),
  P('GET', '/api/media-pack-drafts/:clientItemId', 'viewer'),
  P('GET', '/api/shopify/status', 'viewer'),
  P('GET', '/api/shopify/config', 'viewer'), // access token only included for admins (handler)
  P('GET', '/api/shopify/published-media/:productId', 'viewer'),
  P('GET', '/api/reports/movements', 'viewer'),
  P('GET', '/api/sku/sequence-status', 'viewer'),
  P('GET', '/api/sku/preview', 'viewer'),
  P('GET', '/api/procurement/reorder-suggestions', 'viewer'),
  P('GET', '/api/procurement/purchase-orders', 'viewer'),
  P('GET', '/api/needs-attention', 'viewer'),
];

// ---------------------------------------------------------------------------------------------
// Matching (used by the gate). Most specific (most static segments) entry wins.
// ---------------------------------------------------------------------------------------------
interface Compiled extends RoutePolicy {
  regex: RegExp;
  staticSegments: number;
}

function compile(p: RoutePolicy): Compiled {
  const segs = p.path.split('/').filter(Boolean);
  const re = '^/' + segs.map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '/?$';
  // 'i': a path that differs only by case must still find its policy (defence in depth with case-sensitive routing).
  return { ...p, regex: new RegExp(re, 'i'), staticSegments: segs.filter((s) => !s.startsWith(':')).length };
}

const COMPILED: Compiled[] = ROUTE_POLICY.map(compile).sort((a, b) => b.staticSegments - a.staticSegments);

export function findPolicy(method: string, urlPath: string): RoutePolicy | undefined {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return COMPILED.find((c) => (c.method === 'ALL' || c.method === m) && c.regex.test(urlPath));
}

/** Files that <img>/<video> tags fetch without headers. Anything else under /api/photos needs a session. */
export const PUBLIC_MEDIA_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.heic', '.heif', '.mp4', '.mov', '.webm'];

export function isPublicMediaPath(method: string, urlPath: string): boolean {
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  if (!urlPath.startsWith('/api/photos/')) return false; // exact, lower-case prefix (routing is case-sensitive)
  // Anything that could smuggle a traversal / alternate separator past a raw-string check is NOT public:
  // dot segments, percent-encoded dots/slashes/backslashes/NUL, backslashes, control chars, doubled slashes.
  if (urlPath.includes('..') || /%(2e|2f|5c|00)/i.test(urlPath) || /[\\\u0000-\u001f]/.test(urlPath) || urlPath.includes('//')) return false;
  const lower = urlPath.toLowerCase();
  return PUBLIC_MEDIA_EXTENSIONS.some((e) => lower.endsWith(e));
}
