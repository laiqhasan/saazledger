/** Seeds realistic data through the DEPLOYED app's own HTTP API (no direct SQL except where noted). */
import { api, makePng, type Srv } from './lib';

export interface SeedManifest {
  items: { id: string; sku: string; title: string; quantity: number; buyingPrice: number; sellingPrice: number; imageUrl: string }[];
  vendors: { id: string; code: string; name: string }[];
  mediaIds: string[];
  users: string[];
  photoUrls: string[];
}

export async function seedDeployed(srv: Srv): Promise<SeedManifest> {
  const m: SeedManifest = { items: [], vendors: [], mediaIds: [], users: [], photoUrls: [] };

  // a non-admin user + admin user via the app's dev-login (writes `users`)
  let adminToken = '';
  for (const [email, name, role, status] of [['staff1@example.test', 'Staff One', 'staff', 'active'], ['hasan.laiq@gmail.com', 'Laiq Hasan', 'admin', 'active']]) {
    const r = await api(srv, 'POST', '/api/auth/google/dev-login', { email, name, role, status });
    if (r.status !== 200) throw new Error('dev-login: ' + JSON.stringify(r));
    m.users.push(email);
    if (role === 'admin') adminToken = r.json.token;
  }

  // vendors
  for (const [code, name] of [['JAI', 'Jaipur Artisans'], ['MUM', 'Mumbai Beads Co']] as const) {
    const r = await api(srv, 'POST', '/api/vendors', { id: `vendor_${code}`, code, name, city: 'India', phone: '+91-0000', leadTimeDays: 7 });
    if (r.status !== 200) throw new Error('vendor: ' + JSON.stringify(r));
    m.vendors.push({ id: r.json.vendor.id, code, name });
  }

  // global SKU sequence (admin pass-through: no token => local admin)
  const init = await api(srv, 'POST', '/api/sku/initialize-sequence', { startingSerial: 1000 });
  if (init.status !== 200) throw new Error('init seq: ' + JSON.stringify(init));

  // items with real photos: qty 5 / buying 500 / selling 1200 is the headline item
  const specs: [string, string, string, string, [number, number, number]][] = [
    ['Kundan Pendant Set', 'NK', 'KU', 'GD', [200, 160, 40]],
    ['Pearl Drop Earrings', 'ER', 'PR', 'WH', [240, 240, 235]],
    ['Ruby Ring', 'RG', 'RB', 'RD', [160, 20, 30]],
  ];
  for (const [title, typeCode, stoneCode, colorCode, rgb] of specs) {
    const png = await makePng(rgb, 96);
    const up = await api(srv, 'POST', '/api/photos/upload', { base64Data: `data:image/png;base64,${png.toString('base64')}` });
    if (up.status !== 200) throw new Error('photo upload: ' + JSON.stringify(up));
    m.photoUrls.push(up.json.url);
    const r = await api(srv, 'POST', '/api/inventory', {
      title, typeCode, stoneCode, colorCode, quantity: 5, buyingPrice: 500, sellingPrice: 1200,
      vendor: 'Jaipur Artisans', imageUrl: up.json.url, notes: `seed ${title}`,
    });
    if (r.status !== 201) throw new Error('item: ' + JSON.stringify(r));
    const it = r.json.item;
    m.items.push({ id: it.id, sku: it.sku, title: it.title, quantity: it.quantity, buyingPrice: it.buyingPrice, sellingPrice: it.sellingPrice, imageUrl: it.imageUrl });
  }

  // media asset + product link for first two items
  for (const it of m.items.slice(0, 2)) {
    const png = await makePng([10 + m.mediaIds.length * 60, 90, 200], 80);
    const up = await api(srv, 'POST', '/api/media/upload-direct', {
      base64Data: `data:image/png;base64,${png.toString('base64')}`, filename: `${it.sku}_gallery.png`, displayTitle: `${it.sku} gallery`,
    }, adminToken);
    if (up.status !== 200) throw new Error('media upload: ' + JSON.stringify(up).slice(0, 400));
    const mediaId = up.json.asset?.id || up.json.id || up.json.mediaId;
    if (!mediaId) throw new Error('no media id in ' + JSON.stringify(up.json).slice(0, 300));
    m.mediaIds.push(mediaId);
    const l = await api(srv, 'POST', `/api/products/${it.id}/media/link`, { mediaId, slotType: 'gallery', displayOrder: 0, altText: 'seed alt' });
    if (l.status !== 200) throw new Error('link: ' + JSON.stringify(l));
  }

  // a sale (stock movement + FIFO lot depletion) on item 1: 5 -> 4
  const sale = await api(srv, 'POST', '/api/inventory/sale', { itemId: m.items[0].id, quantitySold: 1, salePrice: 1200 });
  if (sale.status !== 200) throw new Error('sale: ' + JSON.stringify(sale));
  m.items[0].quantity = 4;

  return m;
}
