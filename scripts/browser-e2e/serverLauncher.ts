/**
 * Tiny launcher used ONLY by the browser E2E. server/server.ts skips app.listen() when NODE_ENV === 'test'
 * (so tests can bind their own port); in fake-Shopify mode we need NODE_ENV=test (it is what enables the
 * Shopify base-URL override and the deterministic background-removal stub), so this file listens for it.
 * In real mode NODE_ENV is NOT 'test' and server.ts listens by itself. Production code is untouched.
 */
const { app } = await import('../../server/server');
if (process.env.NODE_ENV === 'test') {
  const port = Number(process.env.PORT);
  app.listen(port, '127.0.0.1', () => console.log(`[browser-e2e] app listening on 127.0.0.1:${port}`));
}
