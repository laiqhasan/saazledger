/**
 * Environment classification used by the auth layer.
 *
 * "Production-like" is deliberately broader than NODE_ENV === 'production': the Railway deployment may
 * not set NODE_ENV at all (its variable list has no NODE_ENV), so ANY RAILWAY_* variable also counts.
 * Dev helpers (mock Google tokens, dev-login) and anonymous local-admin mode are refused in
 * production-like environments no matter what other flags are set.
 */
export function isProductionLike(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  return Object.keys(env).some((k) => k.startsWith('RAILWAY_') && (env[k] ?? '') !== '');
}

/**
 * Anonymous "local desktop" admin mode. Opt-in only (ALLOW_ANONYMOUS_LOCAL_ADMIN=true) and impossible in
 * production-like environments (NODE_ENV=production, or any RAILWAY_* variable present).
 */
export function anonymousLocalAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProductionLike(env)) return false;
  return (env.ALLOW_ANONYMOUS_LOCAL_ADMIN ?? '').trim().toLowerCase() === 'true';
}

/** Developer helpers (mock Google ID tokens, /api/auth/google/dev-login). Never in production-like envs. */
export function devHelpersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProductionLike(env);
}
