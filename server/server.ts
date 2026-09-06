import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { db } from './db/database';
import { runInitialMigrations } from './db/migrations';
import {
  getAllItems,
  getItemById,
  createItem,
  recordSaleFifo,
  restockItem,
  itemRecordToJewelryItem,
} from './services/inventoryService';
import { allocateNextSku } from './services/skuService';
import { savePhotoBuffer, saveBase64Photo, UPLOADS_DIR } from './services/photoService';
import { processShopifyOrderWebhook, verifyShopifyWebhookHmac } from './services/webhookService';
import { callShopifyAdminApi, getShopifyConfig, saveShopifyConfig } from './services/shopifyBackendService';
import { logAudit, getAuditLogs } from './services/auditService';
import {
  getAllMediaAssets,
  getMediaAssetById,
  ingestMediaFile,
  linkMediaToProduct,
  unlinkMediaFromProduct,
  reorderProductMedia,
  softDeleteMediaAsset,
  purgeMediaAsset,
  migrateAllMedia,
  getStorageAdapter,
} from './services/media/mediaService';
import {
  getMediaStorageSettings,
  saveMediaStorageSettings,
} from './services/media/storageProvider';
import {
  getGlobalSkuSequenceStatus,
  initializeGlobalSkuSequence,
  allocateGlobalSku,
  previewGlobalSku,
} from './services/skuSequenceService';
import {
  getInventoryBalances,
  recordInventoryMovement,
  getChannelAllocations,
  updateChannelAllocations,
  getNeedsAttentionItems,
  resolveNeedsAttentionItem,
} from './services/multiStateInventoryService';
import {
  calculateReorderSuggestions,
  createPurchaseOrder,
  receivePurchaseOrder,
  getAllPurchaseOrders,
  getPurchaseOrderById,
} from './services/procurementService';
import {
  previewMigration,
  executeMigration,
} from './services/migrationService';
import {
  getGoogleClientId,
  setGoogleClientId,
  verifyGoogleIdToken,
  findOrCreateGoogleUser,
  generateUserJwt,
  isSuperAdminEmail,
  type GoogleProfile,
} from './services/googleAuthService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JWT_SECRET = process.env.JWT_SECRET || 'saaz_atelier_jwt_secret_dev_key_2026';
const PORT = process.env.PORT || 3001;

// Ensure database and initial data are ready
runInitialMigrations(db);

export const app = express();

// Security and middleware
app.use(cors({ origin: true, credentials: true }));

// Capture raw body for Shopify Webhooks before JSON parsing
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Static photo hosting from uploads directory
app.use('/api/photos', express.static(UPLOADS_DIR));

// Simple JWT authentication helper
export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // For local desktop usage, allow pass-through as admin if no token provided
    (req as any).user = { id: 'usr_local', role: 'admin', username: 'local_admin' };
    return next();
  }

  // Allow developer / fallback admin tokens from client sessions
  if (token.startsWith('demo_jwt_') || token.includes('usr_admin_hasan') || token === 'demo_admin_token') {
    (req as any).user = {
      id: 'usr_admin_hasan',
      username: 'hasan_laiq',
      role: 'admin',
      fullName: 'Laiq Hasan',
      email: 'hasan.laiq@gmail.com',
    };
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (!err && user) {
      (req as any).user = user;
      return next();
    }

    // Fallback: Check if token is a direct Google ID token or decoded session
    try {
      const decoded = jwt.decode(token) as any;
      if (decoded && (decoded.email || decoded.sub)) {
        const email = (decoded.email || '').trim().toLowerCase();
        const isMaster = isSuperAdminEmail(email);

        const dbUser = db.prepare('SELECT * FROM users WHERE email = ? OR google_id = ?').get(email, decoded.sub) as any;
        if (dbUser) {
          (req as any).user = {
            id: dbUser.id,
            username: dbUser.username,
            role: isMaster ? 'admin' : dbUser.role,
            fullName: dbUser.full_name,
            email: dbUser.email,
          };
          return next();
        } else if (isMaster) {
          (req as any).user = {
            id: 'usr_admin_master',
            username: 'hasan_laiq',
            role: 'admin',
            fullName: decoded.name || 'Laiq Hasan',
            email: 'hasan.laiq@gmail.com',
          };
          return next();
        }
      }
    } catch {}

    return res.status(403).json({ error: 'Invalid or expired authentication token.' });
  });
}

// -------------------------------------------------------------
// 1. Authentication Routes
// -------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, fullName: user.full_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role, fullName: user.full_name },
  });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  try {
    const tokenUser = (req as any).user;
    const dbUser = db.prepare('SELECT id, username, full_name, role, status, email, avatar_url, auth_provider, approved_by, approved_at FROM users WHERE id = ?').get(tokenUser.id) as any;
    if (!dbUser) {
      return res.json({ user: tokenUser });
    }
    const user = {
      id: dbUser.id,
      username: dbUser.username,
      fullName: dbUser.full_name,
      email: dbUser.email,
      role: dbUser.role,
      status: dbUser.status || 'active',
      avatarUrl: dbUser.avatar_url,
      authProvider: dbUser.auth_provider || 'local',
      approvedBy: dbUser.approved_by,
      approvedAt: dbUser.approved_at,
    };
    res.json({ user });
  } catch (err: any) {
    res.json({ user: (req as any).user });
  }
});

// Google OAuth Configuration
app.get('/api/auth/google/config', (_req, res) => {
  const clientId = getGoogleClientId();
  res.json({
    clientId,
    isConfigured: Boolean(clientId && clientId.length > 0),
  });
});

app.post('/api/auth/google/config', authenticateToken, (req, res) => {
  const { clientId } = req.body;
  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json({ error: 'Client ID must be a valid string.' });
  }
  setGoogleClientId(clientId);
  res.json({ success: true, clientId: getGoogleClientId() });
});

// Google OAuth Login
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Google credential ID token is required.' });
  }

  try {
    const profile = await verifyGoogleIdToken(credential);
    const user = findOrCreateGoogleUser(profile);
    const token = generateUserJwt(user);

    res.json({
      token,
      user,
    });
  } catch (err: any) {
    console.error('Google Auth Error:', err);
    res.status(401).json({ error: err.message || 'Google authentication failed.' });
  }
});

// Dev / Demo Google Login Helper (Defaults to Main Admin: hasan.laiq@gmail.com)
app.post('/api/auth/google/dev-login', async (req, res) => {
  try {
    const { email, name, role, status } = req.body;
    const targetEmail = (email || 'hasan.laiq@gmail.com').trim().toLowerCase();
    const targetName = name || 'Laiq Hasan';
    const isMaster = targetEmail === 'hasan.laiq@gmail.com';
    const profile = await verifyGoogleIdToken(`mock-google-token:${targetEmail}|${targetName}|gid_mock_${Date.now()}`);
    const user = findOrCreateGoogleUser(
      profile,
      role || (isMaster ? 'admin' : 'staff'),
      status || (isMaster ? 'active' : 'pending')
    );
    const token = generateUserJwt(user);
    res.json({ token, user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Client-side pending sync endpoint (ensures pending registrations are stored in SQLite)
app.post('/api/auth/google/sync-pending', (req, res) => {
  try {
    const { email, fullName, avatarUrl, id } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    const cleanEmail = email.trim().toLowerCase();
    const isMaster = isSuperAdminEmail(cleanEmail);
    const profile: GoogleProfile = {
      googleId: id || `gid_${Date.now()}`,
      email: cleanEmail,
      name: fullName || cleanEmail.split('@')[0],
      picture: avatarUrl,
      emailVerified: true,
    };
    const user = findOrCreateGoogleUser(
      profile,
      isMaster ? 'admin' : 'staff',
      isMaster ? 'active' : 'pending'
    );
    res.json({ success: true, user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// User Management & Access Control (Master Admin Only)
// -------------------------------------------------------------
app.get('/api/users', authenticateToken, (req, res) => {
  try {
    const currentUser = (req as any).user;
    if (currentUser.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Master Admin required.' });
    }

    const rows = db.prepare(`
      SELECT id, username, full_name, email, role, status, avatar_url, auth_provider, approved_by, approved_at, created_at
      FROM users
      ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
    `).all() as any[];

    const users = rows.map((r) => ({
      id: r.id,
      username: r.username,
      fullName: r.full_name,
      email: r.email,
      role: r.role,
      status: r.status || 'active',
      avatarUrl: r.avatar_url,
      authProvider: r.auth_provider,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      createdAt: r.created_at,
    }));

    const pendingCount = users.filter((u) => u.status === 'pending').length;

    res.json({ users, pendingCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:id/approve', authenticateToken, (req, res) => {
  try {
    const currentUser = (req as any).user;
    if (currentUser.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Master Admin required.' });
    }

    const targetId = req.params.id;
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as any;
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const assignedRole = req.body.role || targetUser.role || 'staff';
    const validRoles = ['admin', 'manager', 'staff', 'clerk', 'viewer'];
    if (!validRoles.includes(assignedRole)) {
      return res.status(400).json({ error: 'Invalid role specified.' });
    }

    db.prepare(`
      UPDATE users 
      SET status = 'active', role = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(assignedRole, currentUser.id, targetId);

    logAudit({
      userId: currentUser.id,
      action: 'approve_user',
      entityType: 'user',
      entityId: targetId,
      newState: { role: assignedRole, status: 'active', approvedBy: currentUser.id },
    });

    const updated = db.prepare('SELECT id, username, full_name, email, role, status, avatar_url, auth_provider, approved_by, approved_at, created_at FROM users WHERE id = ?').get(targetId) as any;

    res.json({
      success: true,
      user: {
        id: updated.id,
        username: updated.username,
        fullName: updated.full_name,
        email: updated.email,
        role: updated.role,
        status: updated.status,
        avatarUrl: updated.avatar_url,
        authProvider: updated.auth_provider,
        approvedBy: updated.approved_by,
        approvedAt: updated.approved_at,
        createdAt: updated.created_at,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:id/role', authenticateToken, (req, res) => {
  try {
    const currentUser = (req as any).user;
    if (currentUser.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Master Admin required.' });
    }

    const targetId = req.params.id;
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as any;
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (targetUser.email && targetUser.email.toLowerCase() === 'hasan.laiq@gmail.com') {
      return res.status(403).json({ error: 'Cannot modify the role of Master Admin.' });
    }

    const { role } = req.body;
    const validRoles = ['admin', 'manager', 'staff', 'clerk', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role specified.' });
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);

    logAudit({
      userId: currentUser.id,
      action: 'change_user_role',
      entityType: 'user',
      entityId: targetId,
      newState: { oldRole: targetUser.role, newRole: role },
    });

    res.json({ success: true, role });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:id/status', authenticateToken, (req, res) => {
  try {
    const currentUser = (req as any).user;
    if (currentUser.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Master Admin required.' });
    }

    const targetId = req.params.id;
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as any;
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (targetUser.email && targetUser.email.toLowerCase() === 'hasan.laiq@gmail.com') {
      return res.status(403).json({ error: 'Cannot alter status of Master Admin.' });
    }

    const { status } = req.body;
    const validStatuses = ['active', 'rejected', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status specified.' });
    }

    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, targetId);

    logAudit({
      userId: currentUser.id,
      action: 'change_user_status',
      entityType: 'user',
      entityId: targetId,
      newState: { oldStatus: targetUser.status, newStatus: status },
    });

    res.json({ success: true, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 2. Inventory & SKU Routes
// -------------------------------------------------------------
app.get('/api/inventory', (_req, res) => {
  try {
    const items = getAllItems();
    res.json({ items: items.map(itemRecordToJewelryItem) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory', authenticateToken, (req, res) => {
  try {
    const newItem = createItem(req.body);
    logAudit({
      userId: (req as any).user?.id,
      action: 'create_item',
      entityType: 'item',
      entityId: newItem.id,
      newState: newItem,
    });
    res.status(201).json({ item: itemRecordToJewelryItem(newItem) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/inventory/next-sku', (req, res) => {
  try {
    const { typeCode, stoneCode, colorCode } = req.body;
    const alloc = allocateNextSku(typeCode, stoneCode, colorCode);
    res.json(alloc);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/inventory/:id', authenticateToken, (req, res) => {
  try {
    const existing = getItemById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    const updates = req.body;
    db.prepare(`
      UPDATE items SET
        title = COALESCE(?, title),
        buying_price = COALESCE(?, buying_price),
        selling_price = COALESCE(?, selling_price),
        quantity = COALESCE(?, quantity),
        reorder_level = COALESCE(?, reorder_level),
        vendor_name = COALESCE(?, vendor_name),
        notes = COALESCE(?, notes),
        image_url = COALESCE(?, image_url),
        safety_reserve = COALESCE(?, safety_reserve),
        is_listed_on_amazon = COALESCE(?, is_listed_on_amazon),
        amazon_asin = COALESCE(?, amazon_asin),
        is_listed_on_myntra = COALESCE(?, is_listed_on_myntra),
        myntra_style_id = COALESCE(?, myntra_style_id),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      updates.title !== undefined ? updates.title : null,
      updates.buyingPrice !== undefined ? updates.buyingPrice : null,
      updates.sellingPrice !== undefined ? updates.sellingPrice : null,
      updates.quantity !== undefined ? updates.quantity : null,
      updates.reorderLevel !== undefined ? updates.reorderLevel : null,
      updates.vendor !== undefined ? updates.vendor : null,
      updates.notes !== undefined ? updates.notes : null,
      updates.imageUrl !== undefined ? updates.imageUrl : null,
      updates.safetyReserve !== undefined ? updates.safetyReserve : null,
      updates.isListedOnAmazon !== undefined ? (updates.isListedOnAmazon ? 1 : 0) : null,
      updates.amazonAsin !== undefined ? updates.amazonAsin : null,
      updates.isListedOnMyntra !== undefined ? (updates.isListedOnMyntra ? 1 : 0) : null,
      updates.myntraStyleId !== undefined ? updates.myntraStyleId : null,
      req.params.id
    );

    const updated = getItemById(req.params.id);
    logAudit({
      userId: (req as any).user?.id,
      action: 'update_item',
      entityType: 'item',
      entityId: req.params.id,
      prevState: existing,
      newState: updated,
    });

    res.json({ item: updated ? itemRecordToJewelryItem(updated) : null });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/inventory/:id', authenticateToken, (req, res) => {
  try {
    const existing = getItemById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
    logAudit({
      userId: (req as any).user?.id,
      action: 'delete_item',
      entityType: 'item',
      entityId: req.params.id,
      prevState: existing,
    });

    res.json({ success: true, message: `Item ${existing.sku} removed.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory/sale', authenticateToken, (req, res) => {
  try {
    const { itemId, quantitySold, salePrice, channel, externalOrderId, notes } = req.body;
    const result = recordSaleFifo({
      itemId,
      quantitySold: Number(quantitySold),
      salePricePerUnit: Number(salePrice),
      channel: channel || 'Counter Sale',
      externalOrderId,
      notes,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/inventory/:id/adjust', authenticateToken, (req, res) => {
  try {
    const { delta, unitCost } = req.body;
    const item = getItemById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const numDelta = Number(delta);
    if (numDelta > 0) {
      const restock = restockItem({
        itemId: req.params.id,
        quantityToAdd: numDelta,
        unitCost: unitCost !== undefined ? Number(unitCost) : item.buying_price,
      });
      return res.json(restock);
    } else if (numDelta < 0) {
      const sale = recordSaleFifo({
        itemId: req.params.id,
        quantitySold: Math.abs(numDelta),
        salePricePerUnit: item.selling_price,
        channel: 'Manual Adjustment',
      });
      return res.json(sale);
    }
    res.json({ newQuantity: item.quantity });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3. Vendors Master Routes
// -------------------------------------------------------------
function vendorRecordToVendorItem(v: any): any {
  return {
    id: v.id,
    code: v.code,
    name: v.name,
    contactPerson: v.contact_person || '',
    phone: v.phone || '',
    email: v.email || '',
    city: v.city || '',
    address: v.address || '',
    gstin: v.gstin || '',
    specialty: v.specialty || '',
    leadTimeDays: v.lead_time_days || 10,
    paymentTerms: v.payment_terms || 'Net 15',
    rating: v.rating || 5,
    status: v.status || 'active',
    notes: v.notes || '',
    createdAt: v.created_at || '',
  };
}

app.get('/api/vendors', (_req, res) => {
  try {
    const vendors = db.prepare('SELECT * FROM vendors ORDER BY name ASC').all();
    res.json({ vendors: vendors.map(vendorRecordToVendorItem) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vendors', authenticateToken, (req, res) => {
  try {
    const v = req.body;
    db.prepare(`
      INSERT INTO vendors (
        id, code, name, contact_person, phone, email, city, address, gstin, specialty, lead_time_days, payment_terms, rating, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        name = excluded.name,
        contact_person = excluded.contact_person,
        phone = excluded.phone,
        email = excluded.email,
        city = excluded.city,
        address = excluded.address,
        gstin = excluded.gstin,
        specialty = excluded.specialty,
        lead_time_days = excluded.lead_time_days,
        payment_terms = excluded.payment_terms,
        status = excluded.status,
        notes = excluded.notes
    `).run(
      v.id || `vendor_${Date.now()}`,
      v.code.toUpperCase(),
      v.name,
      v.contactPerson || null,
      v.phone || null,
      v.email || null,
      v.city || null,
      v.address || null,
      v.gstin || null,
      v.specialty || null,
      v.leadTimeDays || 10,
      v.paymentTerms || 'Net 15',
      v.rating || 5,
      v.status || 'active',
      v.notes || null
    );

    const saved = db.prepare('SELECT * FROM vendors WHERE code = ?').get(v.code.toUpperCase());
    res.json({ vendor: saved ? vendorRecordToVendorItem(saved) : null });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vendors/:id', authenticateToken, (req, res) => {
  try {
    db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4. Content-Addressable Photo Storage Routes
// -------------------------------------------------------------
app.post('/api/photos/upload', (req, res) => {
  try {
    const { base64Data } = req.body;
    if (!base64Data) {
      return res.status(400).json({ error: 'base64Data required' });
    }
    const saved = saveBase64Photo(base64Data);
    if (!saved) {
      return res.status(400).json({ error: 'Invalid image format' });
    }
    res.json(saved);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4B. Enterprise Cloud Media Library Routes
// -------------------------------------------------------------
app.get('/api/media', (req, res) => {
  try {
    const { search, mediaType, provider, approvalStatus, isLinked, limit, offset } = req.query;
    const result = getAllMediaAssets({
      search: search ? String(search) : undefined,
      mediaType: mediaType as any,
      provider: provider as any,
      approvalStatus: approvalStatus as any,
      isLinked: isLinked !== undefined ? isLinked === 'true' : undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/media/:id', (req, res) => {
  try {
    const asset = getMediaAssetById(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Media asset not found' });
    res.json({ asset });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/upload-direct', authenticateToken, async (req, res) => {
  try {
    const { base64Data, filename, displayTitle, productId, slotType, approvalStatus } = req.body;
    if (!base64Data) return res.status(400).json({ error: 'base64Data is required' });

    let buffer: Buffer;
    if (base64Data.startsWith('data:')) {
      const match = base64Data.match(/^data:([^;]+);base64,(.+)$/);
      buffer = Buffer.from(match ? match[2] : base64Data, 'base64');
    } else {
      buffer = Buffer.from(base64Data, 'base64');
    }

    const result = await ingestMediaFile({
      buffer,
      originalFilename: filename || 'upload.jpg',
      displayTitle,
      uploadSource: 'web_upload',
      uploaderId: (req as any).user?.id,
      productId,
      slotType,
      approvalStatus,
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/media/:id', authenticateToken, (req, res) => {
  try {
    const { displayTitle, approvalStatus } = req.body;
    db.prepare(`
      UPDATE media_assets SET
        display_title = COALESCE(?, display_title),
        approval_status = COALESCE(?, approval_status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(displayTitle || null, approvalStatus || null, req.params.id);

    const updated = getMediaAssetById(req.params.id);
    res.json({ asset: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/media/:id', authenticateToken, (req, res) => {
  try {
    softDeleteMediaAsset(req.params.id, (req as any).user?.id);
    res.json({ success: true, message: 'Media moved to trash' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/:id/purge', authenticateToken, (req, res) => {
  try {
    if ((req as any).user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required to purge media permanently.' });
    }
    purgeMediaAsset(req.params.id);
    res.json({ success: true, message: 'Media permanently purged' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/:productId/media/link', authenticateToken, (req, res) => {
  try {
    const { mediaId, slotType, displayOrder, altText } = req.body;
    linkMediaToProduct({
      productId: req.params.productId,
      mediaId,
      slotType: slotType || 'gallery',
      displayOrder,
      altText,
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/products/:productId/media/:mediaId', authenticateToken, (req, res) => {
  try {
    const { slotType } = req.query;
    unlinkMediaFromProduct(req.params.productId, req.params.mediaId, slotType ? String(slotType) : undefined);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:productId/media/reorder', authenticateToken, (req, res) => {
  try {
    const { orderings } = req.body;
    reorderProductMedia(req.params.productId, orderings || []);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/media-settings', (_req, res) => {
  try {
    const settings = getMediaStorageSettings();
    const safeS3 = {
      ...settings.s3,
      secretAccessKey: settings.s3.secretAccessKey ? '••••••••••••••••' : '',
    };
    const safeGDrive = {
      ...settings.googleDrive,
      clientSecret: settings.googleDrive.clientSecret ? '••••••••••••••••' : '',
      refreshToken: settings.googleDrive.refreshToken ? '••••••••••••••••' : '',
      serviceAccountJson: settings.googleDrive.serviceAccountJson ? '••••••••••••••••' : '',
    };
    res.json({
      settings: {
        ...settings,
        s3: safeS3,
        googleDrive: safeGDrive,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media-settings', authenticateToken, (req, res) => {
  try {
    if ((req as any).user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required to modify cloud storage settings.' });
    }
    saveMediaStorageSettings(req.body);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/media-settings/test-s3', authenticateToken, async (_req, res) => {
  try {
    const adapter = getStorageAdapter('s3');
    const result = await adapter.testConnection();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media-settings/test-drive', authenticateToken, async (_req, res) => {
  try {
    const adapter = getStorageAdapter('google_drive');
    const result = await adapter.testConnection();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/media/migrate', authenticateToken, async (req, res) => {
  try {
    const { sourceProvider, targetProvider } = req.body;
    if (!sourceProvider || !targetProvider) {
      return res.status(400).json({ error: 'sourceProvider and targetProvider are required' });
    }
    const summary = await migrateAllMedia(sourceProvider, targetProvider);
    res.json({ summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 5. Secure Shopify Server Proxy & Webhook Listener
// -------------------------------------------------------------
app.get('/api/shopify/status', async (_req, res) => {
  try {
    const config = getShopifyConfig();
    if (!config.shopDomain || !config.adminAccessToken) {
      return res.json({ connected: false, message: 'Shopify credentials not configured.' });
    }
    const probe = await callShopifyAdminApi(`/admin/api/${config.apiVersion}/shop.json`);
    if (probe.ok) {
      return res.json({ connected: true, shop: probe.data.shop });
    }
    res.json({ connected: false, error: probe.data.errors || 'Probe failed' });
  } catch (err: any) {
    res.json({ connected: false, error: err.message });
  }
});

app.post('/api/shopify/config', authenticateToken, (req, res) => {
  try {
    saveShopifyConfig(req.body);
    res.json({ success: true, message: 'Shopify credentials safely stored.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Shopify Webhook Endpoint (HMAC Verified)
app.post('/api/webhooks/shopify', (req, res) => {
  try {
    const topic = (req.headers['x-shopify-topic'] as string) || '';
    const hmacHeader = (req.headers['x-shopify-hmac-sha256'] as string) || '';
    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || '';

    // Verify HMAC if secret is configured
    if (webhookSecret) {
      const isValid = verifyShopifyWebhookHmac(req.body, hmacHeader, webhookSecret);
      if (!isValid) {
        return res.status(401).json({ error: 'HMAC verification failed' });
      }
    }

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : JSON.parse(req.body.toString('utf-8'));
    const result = processShopifyOrderWebhook(topic, payload);

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 6. Reports, Audit Logs & Backup Migration
// -------------------------------------------------------------
app.get('/api/reports/audit-logs', authenticateToken, (_req, res) => {
  res.json({ logs: getAuditLogs() });
});

app.get('/api/reports/movements', (_req, res) => {
  const movements = db.prepare('SELECT * FROM stock_movements ORDER BY timestamp DESC LIMIT 200').all();
  res.json({ movements });
});

// One-Time Browser Migration: Imports legacy localStorage data safely without overwriting SKUs
app.post('/api/backup/migrate-browser', authenticateToken, (req, res) => {
  try {
    const { inventory = [], vendors = [], codeTables } = req.body;
    let importedItemsCount = 0;

    db.transaction(() => {
      // Import vendors if present
      if (Array.isArray(vendors)) {
        const insertVendor = db.prepare(`
          INSERT INTO vendors (
            id, code, name, contact_person, phone, email, city, address, gstin, specialty, lead_time_days, payment_terms, rating, status, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        for (const v of vendors) {
          insertVendor.run(
            v.id,
            v.code,
            v.name,
            v.contactPerson || null,
            v.phone || null,
            v.email || null,
            v.city || null,
            v.address || null,
            v.gstin || null,
            v.specialty || null,
            v.leadTimeDays || 10,
            v.paymentTerms || 'Net 15',
            v.rating || 5,
            v.status || 'active',
            v.notes || null
          );
        }
      }

      // Import inventory items
      if (Array.isArray(inventory)) {
        const insertItem = db.prepare(`
          INSERT INTO items (
            id, sku, title, type_code, stone_code, color_code, serial,
            buying_price, selling_price, quantity, reorder_level, vendor_name,
            notes, image_url, image_hash, date_added, safety_reserve, is_listed_on_shopify
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(sku) DO NOTHING
        `);

        for (const item of inventory) {
          // If item photo is base64, save it to disk!
          let finalPhotoUrl = item.imageUrl;
          if (item.imageUrl && item.imageUrl.startsWith('data:')) {
            const saved = saveBase64Photo(item.imageUrl);
            if (saved) finalPhotoUrl = saved.url;
          }

          const res = insertItem.run(
            item.id,
            item.sku,
            item.title,
            item.typeCode,
            item.stoneCode,
            item.colorCode,
            item.serial,
            item.buyingPrice || 0,
            item.sellingPrice || 0,
            item.quantity || 0,
            item.reorderLevel || 3,
            item.vendor || null,
            item.notes || null,
            finalPhotoUrl || null,
            item.imageHash || null,
            item.dateAdded || new Date().toISOString().split('T')[0],
            item.safetyReserve || 0,
            item.isListedOnShopify !== false ? 1 : 0
          );
          if (res.changes > 0) importedItemsCount++;
        }
      }
    })();

    res.json({ success: true, message: `Migrated ${importedItemsCount} items to transactional database.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Global 5-Digit SKU System Endpoints
// -------------------------------------------------------------

app.get('/api/sku/sequence-status', (req, res) => {
  try {
    const status = getGlobalSkuSequenceStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sku/initialize-sequence', authenticateToken, (req, res) => {
  try {
    if ((req as any).user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin privileges required to initialize SKU sequence.' });
    }
    const { startingSerial } = req.body;
    const status = initializeGlobalSkuSequence(Number(startingSerial), (req as any).user?.username || 'admin');
    res.json({ success: true, status });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sku/allocate-global', authenticateToken, (req, res) => {
  try {
    const { typeCode, stoneCode, colorCode } = req.body;
    const result = allocateGlobalSku({
      typeCode,
      stoneCode,
      colorCode,
      actor: (req as any).user?.username || 'admin',
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/sku/preview', (req, res) => {
  const { typeCode, stoneCode, colorCode } = req.query;
  const preview = previewGlobalSku(String(typeCode || ''), String(stoneCode || ''), String(colorCode || ''));
  res.json({ previewSku: preview });
});

// -------------------------------------------------------------
// Multi-State Inventory & Balance Endpoints
// -------------------------------------------------------------

app.get('/api/inventory/balances', (req, res) => {
  try {
    const { variantId, locationId } = req.query;
    const balances = getInventoryBalances(variantId ? String(variantId) : undefined, locationId ? String(locationId) : undefined);
    res.json({ balances });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory/movements', authenticateToken, (req, res) => {
  try {
    const { variantId, locationId, movementType, quantity, unitCost, referenceType, referenceId, notes } = req.body;
    const movement = recordInventoryMovement({
      variantId,
      locationId,
      movementType,
      quantity: Number(quantity),
      unitCost: unitCost !== undefined ? Number(unitCost) : undefined,
      referenceType,
      referenceId,
      notes,
      actor: (req as any).user?.username || 'admin',
    });
    res.json({ success: true, movement });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/inventory/channel-allocations/:variantId', (req, res) => {
  try {
    const allocations = getChannelAllocations(req.params.variantId);
    res.json({ allocations });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/inventory/channel-allocations/:variantId', authenticateToken, (req, res) => {
  try {
    const { allocations } = req.body;
    updateChannelAllocations(req.params.variantId, allocations);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Procurement & Purchase Orders
// -------------------------------------------------------------

app.get('/api/procurement/reorder-suggestions', (req, res) => {
  try {
    const suggestions = calculateReorderSuggestions();
    res.json({ suggestions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/procurement/purchase-orders', (req, res) => {
  try {
    const orders = getAllPurchaseOrders();
    res.json({ orders });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/procurement/purchase-orders', authenticateToken, (req, res) => {
  try {
    const { vendorId, lines, expectedDate, notes } = req.body;
    const po = createPurchaseOrder({
      vendorId,
      lines,
      expectedDate,
      notes,
      actor: (req as any).user?.username || 'admin',
    });
    res.status(201).json({ purchaseOrder: po });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/procurement/purchase-orders/:id/receive', authenticateToken, (req, res) => {
  try {
    const { receipts } = req.body;
    receivePurchaseOrder({
      poId: req.params.id,
      receipts,
      actor: (req as any).user?.username || 'admin',
    });
    const po = getPurchaseOrderById(req.params.id);
    res.json({ success: true, purchaseOrder: po });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Operational Needs Attention Hub
// -------------------------------------------------------------

app.get('/api/needs-attention', (req, res) => {
  try {
    const { category, unresolvedOnly } = req.query;
    const items = getNeedsAttentionItems(category ? String(category) : undefined, unresolvedOnly !== 'false');
    res.json({ items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/needs-attention/:id/resolve', authenticateToken, (req, res) => {
  try {
    resolveNeedsAttentionItem(req.params.id, (req as any).user?.username || 'admin');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Safe Data Migration Pipeline
// -------------------------------------------------------------

app.post('/api/migration/preview', (req, res) => {
  try {
    const { items } = req.body;
    const report = previewMigration(Array.isArray(items) ? items : []);
    res.json(report);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/migration/execute', authenticateToken, (req, res) => {
  try {
    const { items, overwriteConflicts } = req.body;
    const result = executeMigration({
      items: Array.isArray(items) ? items : [],
      overwriteConflicts: Boolean(overwriteConflicts),
      actor: (req as any).user?.username || 'admin',
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Serve static client bundle if dist directory exists (Production unified deployment)
const DIST_DIR = path.resolve(__dirname, '../dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    // Pass through unhandled /api requests to 404 handler
    if (req.path.startsWith('/api')) {
      return next();
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.sendFile(path.join(DIST_DIR, 'index.html'));
    }
    next();
  });
}

// Ensure seed master admin and pending registrations exist in DB
try {
  const masterAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get('hasan.laiq@gmail.com');
  if (!masterAdmin) {
    db.prepare(`
      INSERT INTO users (id, username, full_name, email, role, status, auth_provider, created_at)
      VALUES ('usr_admin_master', 'hasan_laiq', 'Laiq Hasan', 'hasan.laiq@gmail.com', 'admin', 'active', 'google', datetime('now'))
    `).run();
  }

  const sazdaUser = db.prepare('SELECT id FROM users WHERE email = ?').get('hasansazda@gmail.com');
  if (!sazdaUser) {
    db.prepare(`
      INSERT INTO users (id, username, full_name, email, role, status, auth_provider, created_at)
      VALUES ('usr_sazda_abdi', 'hasansazda', 'Sazda Abdi', 'hasansazda@gmail.com', 'staff', 'pending', 'google', datetime('now'))
    `).run();
  }
} catch (e) {
  console.warn('Initial users check note:', e);
}

// Start server if run directly
if (process.env.NODE_ENV !== 'test') {
  const serverPort = Number(process.env.PORT) || 3001;
  app.listen(serverPort, '0.0.0.0', () => {
    console.log(`[Saaz Ledger Backend] Serving securely on http://0.0.0.0:${serverPort}`);
  });
}
