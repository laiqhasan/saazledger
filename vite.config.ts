import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Lightweight Vite plugin to proxy Shopify Admin API requests,
 * bypassing browser CORS restrictions during development.
 */
function shopifyProxyPlugin(): Plugin {
  return {
    name: 'shopify-api-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/shopify-proxy')) {
          return next();
        }

        try {
          const urlObj = new URL(req.url, 'http://localhost');
          let shop = urlObj.searchParams.get('shop') || '';
          const targetPath = urlObj.searchParams.get('path') || '';

          if (!shop || !targetPath) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing "shop" or "path" parameter in proxy request.' }));
            return;
          }

          // Clean shop domain (e.g. remove http:// or trailing slash)
          shop = shop.replace(/^https?:\/\//, '').replace(/\/+$/, '');
          if (!shop.includes('.')) {
            shop = `${shop}.myshopify.com`;
          }

          const targetUrl = `https://${shop}${targetPath.startsWith('/') ? targetPath : `/${targetPath}`}`;
          const token = req.headers['x-shopify-access-token'] as string || '';

          // Read body if POST/PUT
          let requestBody: string | undefined = undefined;
          if (req.method === 'POST' || req.method === 'PUT') {
            const chunks: Uint8Array[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            if (chunks.length > 0) {
              requestBody = Buffer.concat(chunks).toString('utf-8');
            }
          }

          const response = await fetch(targetUrl, {
            method: req.method || 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'X-Shopify-Access-Token': token,
            },
            body: requestBody,
          });

          const responseText = await response.text();

          res.statusCode = response.status;
          res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shopify-Access-Token');
          res.end(responseText);
        } catch (err: any) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Proxy request to Shopify failed: ' + err.message }));
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), shopifyProxyPlugin()],
});
