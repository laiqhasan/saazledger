import { useState, useEffect, useMemo, useRef } from 'react';
import type { JewelryItem, CodeTables, InventoryFilter, StockMovement, ShopifyConfig, VendorItem } from './types/inventory';
import {
  getStoredInventory,
  saveStoredInventory,
  getStoredCodeTables,
  saveStoredCodeTables,
  getStoredTransactions,
  recordStockMovement,
} from './services/storage';
import {
  getStoredShopifyConfig,
  syncShopifyConfigWithServer,
  pushItemToShopify,
  describeOverwriteConfirmation,
  buildOverwriteRequestFields,
  CATEGORY_NOT_SET_MESSAGE,
  syncShopifyOrdersToInventory,
} from './services/shopifyService';
import {
  getStoredVendors,
  saveStoredVendors,
} from './services/vendorService';
import {
  fetchInventory,
  getAuthHeaders,
  isServerInventoryEmpty,
  persistItemToServer,
  deleteItem,
  restoreItem,
  bulkDeleteItems,
  bulkRestoreItems,
  emptyTrash,
  fetchVendors,
  saveVendor,
  recordSaleOnBackend,
  syncBrowserDataToBackend,
} from './services/apiService';
import {
  shouldSyncBrowserData,
  decideSaveIntent,
  mergeSavedItem,
  newClientItemId,
  toLocalOnlyItem,
  upsertLocalItem,
  type PersistResult,
  type SaveIntent,
  type SaveMeta,
} from './services/inventoryPersistence';
import { Header } from './components/Header';
import {
  downloadLocalBackup,
  parseLocalBackup,
  planImport,
  applyImport,
  readPackDrafts,
} from './services/localBackup';
import { restoreMissingPacks } from './services/mediaPackBackup';
import { Dashboard } from './components/Dashboard';
import { InventoryRegister } from './components/InventoryRegister';
import { AddItemModal } from './components/AddItemModal';
import { CodeReferenceModal } from './components/CodeReferenceModal';
import { ExportImportModal } from './components/ExportImportModal';
import { AiSettingsModal } from './components/AiSettingsModal';
import { TagPrintModal } from './components/TagPrintModal';
import { RecordSaleModal } from './components/RecordSaleModal';
import { SalesLedgerModal } from './components/SalesLedgerModal';
import { ShopifyModal } from './components/ShopifyModal';
import { MarketplaceHubModal } from './components/MarketplaceHubModal';
import { VendorMasterModal } from './components/VendorMasterModal';
import { MediaLibraryModal } from './components/MediaLibraryModal';
import { MediaStorageSettingsModal } from './components/MediaStorageSettingsModal';
import { NeedsAttentionModal } from './components/NeedsAttentionModal';
import { GlobalSkuInitModal } from './components/GlobalSkuInitModal';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AuthModal } from './components/AuthModal';
import { LoginScreen } from './components/LoginScreen';
import { PendingApprovalScreen } from './components/PendingApprovalScreen';
import { UserManagementModal } from './components/UserManagementModal';
import { syncAiConfigWithServer } from './services/aiVisionService';

function AppInner() {
  const { isAuthenticated, isLoading, user, token } = useAuth();
  const [inventory, setInventory] = useState<JewelryItem[]>([]);
  const [codeTables, setCodeTables] = useState<CodeTables>(getStoredCodeTables());
  const [transactions, setTransactions] = useState<StockMovement[]>([]);
  const [shopifyConfig, setShopifyConfig] = useState<ShopifyConfig>(getStoredShopifyConfig());
  const [vendors, setVendors] = useState<VendorItem[]>(getStoredVendors());

  // Modal visibility states
  const [isAddItemOpen, setIsAddItemOpen] = useState(false);
  const [itemToEdit, setItemToEdit] = useState<JewelryItem | null>(null);
  const [isCodeRefOpen, setIsCodeRefOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState(false);
  const [isShopifyOpen, setIsShopifyOpen] = useState(false);
  const [selectedShopifyItems, setSelectedShopifyItems] = useState<JewelryItem[] | undefined>(undefined);
  const [isMarketplaceOpen, setIsMarketplaceOpen] = useState(false);
  const [isVendorMasterOpen, setIsVendorMasterOpen] = useState(false);
  const [isMediaLibraryOpen, setIsMediaLibraryOpen] = useState(false);
  const [isMediaSettingsOpen, setIsMediaSettingsOpen] = useState(false);
  const [isNeedsAttentionOpen, setIsNeedsAttentionOpen] = useState(false);
  const [isGlobalSkuInitOpen, setIsGlobalSkuInitOpen] = useState(false);
  const [isUserManagementOpen, setIsUserManagementOpen] = useState(false);
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState(0);
  const [isAuthOpen, setIsAuthOpen] = useState(false);

  // Background auto-sync notification toast
  const [autoSyncStatus, setAutoSyncStatus] = useState<string | null>(null);

  // New Modals: Tag Studio, Record Sale, Sales Ledger
  const [isTagPrintOpen, setIsTagPrintOpen] = useState(false);
  const [itemsToPrint, setItemsToPrint] = useState<JewelryItem[]>([]);
  const [isSalesLedgerOpen, setIsSalesLedgerOpen] = useState(false);
  const [itemToSell, setItemToSell] = useState<JewelryItem | null>(null);

  // Filter state for inventory register
  const [filterStatus, setFilterStatus] = useState<InventoryFilter>('all');

  // Undo Toast Notification
  const [toastNotice, setToastNotice] = useState<{ message: string; undoAction?: () => void } | null>(null);

  useEffect(() => {
    if (!toastNotice) return;
    const t = setTimeout(() => setToastNotice(null), 6000);
    return () => clearTimeout(t);
  }, [toastNotice]);

  // Active inventory pieces (excluding soft-deleted pieces in Trash Bin)
  const activeInventory = useMemo(() => inventory.filter((i) => !i.isDeleted), [inventory]);

  // Initial load
  useEffect(() => {
    const loadedItems = getStoredInventory();
    const loadedCodes = getStoredCodeTables();
    const loadedTxs = getStoredTransactions();
    const loadedShopify = getStoredShopifyConfig();
    const loadedVendors = getStoredVendors();
    setInventory(loadedItems);
    setCodeTables(loadedCodes);
    setTransactions(loadedTxs);
    setShopifyConfig(loadedShopify);
    setVendors(loadedVendors);

    // Asynchronously synchronize with backend SQLite database
    fetchInventory().then((items) => {
      if (items && items.length > 0) setInventory(items);
      // Fill ONLY missing media packs from the server backup (cache cleared / other device). Add-only.
      if (items && items.length > 0) {
        restoreMissingPacks(items, {
          fetchImpl: (u, i) => fetch(u, i),
          getHeaders: getAuthHeaders,
        }).then(({ items: withPacks, restored }) => {
          if (restored.length > 0) {
            setInventory((prev) => {
              const byId = new Map(withPacks.map((w) => [w.id, w]));
              const next = prev.map((p) => (restored.includes(p.id) && !p.galleryPack ? (byId.get(p.id) as JewelryItem) : p));
              saveStoredInventory(next);
              return next;
            });
          }
        }).catch(() => {});
      }
    });
    fetchVendors().then((v) => {
      if (v && v.length > 0) setVendors(v);
    });

    // Safely migrate existing browser items into SQLite if not yet recorded - gated to run once
    // per browser via a persisted flag. Without this, it ran unconditionally on every app load,
    // replaying this browser's (possibly stale) cached inventory back to the server every time;
    // combined with the backend's upsert-by-SKU (which can't tell "deleted" apart from "never
    // existed" once a row is hard-deleted), a stale cache would silently resurrect deleted items
    // on every load. The backend also now tombstones deleted SKUs as defense in depth, but this
    // flag stops the replay itself rather than relying only on that safety net.
    // The flag is bypassed when the server inventory is completely empty while this browser still
    // holds active items (e.g. the server database was wiped by a redeploy without a persistent
    // volume): that is the only state where re-uploading cannot resurrect anything deleted, since
    // tombstones live in the same database.
    const BROWSER_MIGRATION_FLAG = 'saaz_browser_data_migrated_v1';
    const migrationPending = !localStorage.getItem(BROWSER_MIGRATION_FLAG);
    const hasLocalItems = loadedItems.some((i) => !i.isDeleted);
    isServerInventoryEmpty().then(async (serverEmpty) => {
      if (!shouldSyncBrowserData(migrationPending, serverEmpty, hasLocalItems)) return;
      try {
        await syncBrowserDataToBackend(loadedItems, loadedVendors, loadedCodes);
      } finally {
        try {
          localStorage.setItem(BROWSER_MIGRATION_FLAG, new Date().toISOString());
        } catch {}
      }
      if (serverEmpty && hasLocalItems) {
        fetchInventory().then((items) => {
          if (items && items.length > 0) setInventory(items);
        });
      }
    });

    // Sync AI API keys (Gemini & OpenAI) from server database
    syncAiConfigWithServer();

    // Sync Shopify credentials from server database
    syncShopifyConfigWithServer().then((cfg) => {
      if (cfg && cfg.isConnected) {
        setShopifyConfig(cfg);
      }
    });
  }, []);

  // Automated background polling for Shopify orders (every 60 seconds)
  useEffect(() => {
    if (!shopifyConfig.isConnected || !shopifyConfig.adminAccessToken || !shopifyConfig.shopDomain) {
      return;
    }

    const checkShopifyOrders = async () => {
      try {
        const latestInventory = getStoredInventory();
        const res = await syncShopifyOrdersToInventory(latestInventory, shopifyConfig);
        if (res.newTransactions && res.newTransactions.length > 0) {
          setInventory(res.updatedInventory);
          setTransactions((prev) => [...res.newTransactions, ...prev]);
          setAutoSyncStatus(
            `Automated Sync: Reconciled ${res.summary.itemsDeductedCount} item(s) from Shopify order! Local stock maintained.`
          );
          setTimeout(() => setAutoSyncStatus(null), 8000);
        }
      } catch (err) {
        console.warn('Background Shopify auto-sync check note:', err);
      }
    };

    // Initial check 5s after mount/connection
    const initialTimer = setTimeout(checkShopifyOrders, 5000);
    // Recurring interval every 60s
    const interval = setInterval(checkShopifyOrders, 60000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [shopifyConfig]);

  // Automated background polling for pending user access requests (for Master Admin)
  useEffect(() => {
    if (user?.role === 'admin' && token) {
      const checkPendingUsers = async () => {
        try {
          const res = await fetch('/api/users', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const data = await res.json();
            setPendingApprovalsCount(data.pendingCount || 0);
          }
        } catch {}
      };

      checkPendingUsers();
      const interval = setInterval(checkPendingUsers, 12000);
      return () => clearInterval(interval);
    }
  }, [user?.role, token]);

  // Save changes to storage whenever inventory changes
  const updateInventory = (newItems: JewelryItem[]) => {
    setInventory(newItems);
    saveStoredInventory(newItems);
  };

  // Save changes to code tables
  const updateCodeTables = (newTables: CodeTables) => {
    setCodeTables(newTables);
    saveStoredCodeTables(newTables);
  };

  // Vendor Master Management Handlers
  const updateVendors = (newVendors: VendorItem[]) => {
    setVendors(newVendors);
    saveStoredVendors(newVendors);
  };

  const handleSaveVendor = (vendor: VendorItem) => {
    const exists = vendors.some((v) => v.id === vendor.id);
    const updated = exists
      ? vendors.map((v) => (v.id === vendor.id ? vendor : v))
      : [vendor, ...vendors];
    updateVendors(updated);
    saveVendor(vendor);
  };

  const handleDeleteVendor = (vendorId: string) => {
    const updated = vendors.filter((v) => v.id !== vendorId);
    updateVendors(updated);
  };

  const handleImportVendors = (imported: VendorItem[]) => {
    const existingIds = new Set(vendors.map((v) => v.id));
    const combined = [...vendors];
    for (const v of imported) {
      if (!existingIds.has(v.id)) {
        combined.push(v);
        saveVendor(v);
      }
    }
    updateVendors(combined);
  };

  const handleQuickAddVendor = (vendor: VendorItem) => {
    handleSaveVendor(vendor);
  };

  // Apply a change to inventory state + cache using the latest state (safe across awaits)
  const applyInventory = (fn: (prev: JewelryItem[]) => JewelryItem[]) => {
    setInventory((prev) => {
      const next = fn(prev);
      saveStoredInventory(next);
      return next;
    });
  };

  // Local data backup (download) and add-only import
  const importFileRef = useRef<HTMLInputElement>(null);
  const handleDownloadLocalBackup = () => {
    try {
      const { fileName, summary } = downloadLocalBackup(localStorage);
      setToastNotice({
        message: `Saved ${fileName}: ${summary.items} items (${summary.localOnlyItems} local-only), ${summary.itemsWithPacks} with media packs, ${summary.packDrafts} pack drafts.`,
      });
    } catch (err: any) {
      setToastNotice({ message: `Backup download failed: ${err?.message || err}` });
    }
  };
  const handleImportBackupFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseLocalBackup(await file.text());
      if (!parsed.ok) {
        setToastNotice({ message: `Import failed: ${parsed.error}` });
        return;
      }
      const plan = planImport(parsed.backup, {
        inventory: getStoredInventory(),
        vendors: getStoredVendors(),
        packDraftKeys: Object.keys(readPackDrafts(localStorage)),
      });
      const applied = applyImport(localStorage, plan);
      setInventory(applied.inventory);
      setVendors(applied.vendors);
      setToastNotice({
        message: `Import added ${plan.addItems.length} missing item(s), ${plan.addVendors.length} vendor(s), ${Object.keys(plan.addPackDrafts).length} pack draft(s); skipped ${plan.skippedItems} already present. Nothing was overwritten or deleted.`,
      });
    } catch (err: any) {
      setToastNotice({ message: `Import failed: ${err?.message || err}` });
    } finally {
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  // Handler: Save or edit item. Resolves only after the server confirmed (or definitively rejected) the write.
  // Create -> POST, update -> PUT; never decided from whether localStorage already holds the item.
  const handleSaveItem = async (item: JewelryItem, meta?: SaveMeta): Promise<PersistResult> => {
    const known = inventory.find((i) => i.id === item.id);
    const intent: SaveIntent = meta?.intent ?? decideSaveIntent(known);
    const draft: JewelryItem = {
      ...item,
      clientItemId: meta?.clientItemId || item.clientItemId || (intent === 'create' ? newClientItemId() : item.clientItemId),
    };
    const result = await persistItemToServer(intent, draft);
    if (!result.ok) {
      setToastNotice({ message: `Not saved to server: ${result.error}` });
      return result;
    }
    const saved = result.item;
    applyInventory((prev) => mergeSavedItem(prev, draft, saved));
    if (intent === 'create' && !result.idempotentReplay) {
      // Record initial inventory addition in ledger using the authoritative server item
      const tx = recordStockMovement({
        itemId: saved.id,
        sku: saved.sku,
        itemTitle: saved.title,
        type: 'restock',
        quantityDelta: saved.quantity,
        unitPrice: saved.buyingPrice,
        totalPrice: saved.buyingPrice * saved.quantity,
        costPrice: saved.buyingPrice,
        realizedProfit: 0,
        channel: 'Initial Intake',
        notes: `New piece cataloged: ${saved.vendor || 'Atelier'}`,
      });
      setTransactions((prev) => [tx, ...prev]);
    }
    return result;
  };

  // Handler: user chose to keep an unsaved piece as a clearly-labelled local draft
  const handleKeepLocalDraft = (item: JewelryItem, meta: SaveMeta, reason: string, reserved?: { sku?: string; serial?: string }) => {
    const local = toLocalOnlyItem(
      { ...item, clientItemId: meta.clientItemId },
      meta.clientItemId || newClientItemId(),
      reason,
      reserved?.sku,
      reserved?.serial
    );
    applyInventory((prev) => upsertLocalItem(prev, local));
    setToastNotice({ message: 'Kept as LOCAL ONLY draft. It is not saved to the server; use Retry sync on the row.' });
  };

  // Handler: retry syncing a local-only item (same idempotency key, so never creates a duplicate)
  const handleRetrySync = async (item: JewelryItem) => {
    const result = await persistItemToServer('create', item);
    if (result.ok) {
      applyInventory((prev) => mergeSavedItem(prev, item, result.item));
      setToastNotice({ message: `Saved to server as ${result.item.sku}.` });
    } else {
      applyInventory((prev) =>
        upsertLocalItem(prev, toLocalOnlyItem(item, item.clientItemId || newClientItemId(), result.error, result.reservedSku, result.reservedSerial))
      );
      setToastNotice({ message: `Retry failed: ${result.error}` });
    }
  };

  // Handler: Restock existing SKU (Layer 2 resolution)
  const handleRestockExisting = (existingItem: JewelryItem, addedQty: number) => {
    const updated = inventory.map((i) =>
      i.id === existingItem.id
        ? {
            ...i,
            quantity: i.quantity + addedQty,
            lastRestocked: new Date().toISOString().split('T')[0],
          }
        : i
    );
    updateInventory(updated);

    // Record restock in ledger
    const tx = recordStockMovement({
      itemId: existingItem.id,
      sku: existingItem.sku,
      itemTitle: existingItem.title,
      type: 'restock',
      quantityDelta: addedQty,
      unitPrice: existingItem.buyingPrice,
      totalPrice: existingItem.buyingPrice * addedQty,
      costPrice: existingItem.buyingPrice,
      realizedProfit: 0,
      channel: 'Batch Restock',
      notes: `Restocked ${addedQty} units`,
    });
    setTransactions((prev) => [tx, ...prev]);
  };

  // Handler: Quick +/- quantity in table
  const handleAdjustQuantity = (itemId: string, delta: number) => {
    const target = inventory.find((i) => i.id === itemId);
    if (!target) return;

    const updated = inventory.map((item) => {
      if (item.id === itemId) {
        const newQty = Math.max(0, item.quantity + delta);
        return {
          ...item,
          quantity: newQty,
          lastRestocked: delta > 0 ? new Date().toISOString().split('T')[0] : item.lastRestocked,
        };
      }
      return item;
    });
    updateInventory(updated);

    // Record adjustment / quick change in ledger
    const tx = recordStockMovement({
      itemId: target.id,
      sku: target.sku,
      itemTitle: target.title,
      type: delta > 0 ? 'restock' : 'adjustment',
      quantityDelta: delta,
      unitPrice: delta > 0 ? target.buyingPrice : target.sellingPrice,
      totalPrice: Math.abs(delta) * target.sellingPrice,
      costPrice: target.buyingPrice,
      realizedProfit: delta < 0 ? (target.sellingPrice - target.buyingPrice) * Math.abs(delta) : 0,
      channel: delta > 0 ? 'Stock Adjustment (+)' : 'Stock Adjustment (-)',
      notes: `Quick adjust ${delta > 0 ? '+' : ''}${delta} units`,
    });
    setTransactions((prev) => [tx, ...prev]);
  };

  // Handler: Record Sale (Realized Margin)
  const handleConfirmSale = (params: {
    itemId: string;
    quantitySold: number;
    unitPrice: number;
    channel: string;
    notes: string;
  }) => {
    const target = inventory.find((i) => i.id === params.itemId);
    if (!target) return;

    // Deduct stock locally for instant UI responsiveness
    const updated = inventory.map((item) =>
      item.id === params.itemId
        ? {
            ...item,
            quantity: Math.max(0, item.quantity - params.quantitySold),
          }
        : item
    );
    updateInventory(updated);

    // Record sale in ledger
    const totalRev = params.quantitySold * params.unitPrice;
    const totalCost = params.quantitySold * target.buyingPrice;
    const profit = totalRev - totalCost;

    const tx = recordStockMovement({
      itemId: target.id,
      sku: target.sku,
      itemTitle: target.title,
      type: 'sale',
      quantityDelta: -params.quantitySold,
      unitPrice: params.unitPrice,
      totalPrice: totalRev,
      costPrice: target.buyingPrice,
      realizedProfit: profit,
      channel: params.channel,
      notes: params.notes,
    });
    setTransactions((prev) => [tx, ...prev]);

    // Asynchronously record sale with FIFO purchase lot depletion on backend
    recordSaleOnBackend({
      itemId: params.itemId,
      quantitySold: params.quantitySold,
      salePrice: params.unitPrice,
      channel: params.channel,
      notes: params.notes,
    });
  };

  // Handler: Soft Delete Single Item (Move to Trash)
  const handleSoftDeleteItem = (itemId: string, reason?: string) => {
    const target = inventory.find((i) => i.id === itemId);
    if (!target) return;
    const now = new Date().toISOString();
    const updated = inventory.map((i) =>
      i.id === itemId ? { ...i, isDeleted: true, deletedAt: now, deletedReason: reason || 'User moved to trash' } : i
    );
    updateInventory(updated);
    deleteItem(itemId, false, reason);

    setToastNotice({
      message: `"${target.title}" moved to Trash Bin.`,
      undoAction: () => handleRestoreItem(itemId),
    });
  };

  // Handler: Hard Delete Single Item (Permanently Erase)
  const handleHardDeleteItem = (itemId: string) => {
    const target = inventory.find((i) => i.id === itemId);
    if (!target) return;
    const updated = inventory.filter((i) => i.id !== itemId);
    updateInventory(updated);
    deleteItem(itemId, true);
    setToastNotice({
      message: `"${target.title}" (${target.sku}) permanently erased.`,
    });
  };

  // Handler: Restore Single Item from Trash
  const handleRestoreItem = (itemId: string) => {
    const target = inventory.find((i) => i.id === itemId);
    if (!target) return;
    const updated = inventory.map((i) =>
      i.id === itemId ? { ...i, isDeleted: false, deletedAt: undefined, deletedReason: undefined } : i
    );
    updateInventory(updated);
    restoreItem(itemId);
    setToastNotice({
      message: `"${target.title}" (${target.sku}) restored to active stock.`,
    });
  };

  // Handler: Bulk Soft Delete
  const handleBulkSoftDelete = (itemIds: string[], reason?: string) => {
    const now = new Date().toISOString();
    const updated = inventory.map((i) =>
      itemIds.includes(i.id) ? { ...i, isDeleted: true, deletedAt: now, deletedReason: reason || 'Bulk moved to trash' } : i
    );
    updateInventory(updated);
    bulkDeleteItems(itemIds, false, reason);

    setToastNotice({
      message: `${itemIds.length} pieces moved to Trash Bin.`,
      undoAction: () => handleBulkRestore(itemIds),
    });
  };

  // Handler: Bulk Hard Delete
  const handleBulkHardDelete = (itemIds: string[]) => {
    const updated = inventory.filter((i) => !itemIds.includes(i.id));
    updateInventory(updated);
    bulkDeleteItems(itemIds, true);
    setToastNotice({
      message: `${itemIds.length} pieces permanently erased.`,
    });
  };

  // Handler: Bulk Restore
  const handleBulkRestore = (itemIds: string[]) => {
    const updated = inventory.map((i) =>
      itemIds.includes(i.id) ? { ...i, isDeleted: false, deletedAt: undefined, deletedReason: undefined } : i
    );
    updateInventory(updated);
    bulkRestoreItems(itemIds);
    setToastNotice({
      message: `${itemIds.length} pieces restored to active stock.`,
    });
  };

  // Handler: Empty Entire Trash
  const handleEmptyTrash = () => {
    const trashCount = inventory.filter((i) => i.isDeleted).length;
    const updated = inventory.filter((i) => !i.isDeleted);
    updateInventory(updated);
    emptyTrash();
    setToastNotice({
      message: `Trash emptied. ${trashCount} piece(s) permanently erased.`,
    });
  };

  // Handler: Bulk Adjust Quantity
  const handleBulkAdjustQuantity = (itemIds: string[], delta: number) => {
    const updated = inventory.map((item) => {
      if (itemIds.includes(item.id)) {
        return {
          ...item,
          quantity: Math.max(0, item.quantity + delta),
          lastRestocked: delta > 0 ? new Date().toISOString().split('T')[0] : item.lastRestocked,
        };
      }
      return item;
    });
    updateInventory(updated);
  };

  // Handler: Single Push to Shopify
  const handlePushItemToShopify = async (item: JewelryItem) => {
    const config = getStoredShopifyConfig();
    if (!config.isConnected && !config.adminAccessToken) {
      alert('Please connect your Shopify store credentials first in the Shopify Integration Hub.');
      setIsShopifyOpen(true);
      return;
    }

    let res = await pushItemToShopify(item, config);
    if (res.needsConfirmation) {
      // Manual Shopify edit detected; nothing written. Cancel (default) keeps the Shopify value.
      const overwrite = window.confirm(`${item.sku}: ${describeOverwriteConfirmation(res.needsConfirmation)}\n\nOK = Overwrite with SaazLedger value\nCancel = Keep Shopify value`);
      res = await pushItemToShopify(item, config, undefined, buildOverwriteRequestFields(res.needsConfirmation, overwrite ? 'overwrite' : 'keep'));
    }
    if (res.success && res.shopifyProductId) {
      const updated = inventory.map((i) =>
        i.id === item.id
          ? {
              ...i,
              shopifyProductId: res.shopifyProductId,
              shopifyVariantId: res.shopifyVariantId || i.shopifyVariantId,
              shopifySyncedAt: new Date().toISOString(),
            }
          : i
      );
      updateInventory(updated);
      alert(`"${item.title}" (${item.sku}) successfully synced to Shopify!${res.categoryStatus === 'manual_required' ? `\n\n${CATEGORY_NOT_SET_MESSAGE}` : ''}`);
    } else {
      alert(`Failed to sync with Shopify: ${res.error || 'Unknown error'}`);
    }
  };

  // Handler: Bulk Push to Shopify (opens Shopify Sync Hub with selected items)
  const handleBulkPushToShopify = (itemsToPush: JewelryItem[]) => {
    setSelectedShopifyItems(itemsToPush && itemsToPush.length > 0 ? itemsToPush : undefined);
    setIsShopifyOpen(true);
  };

  // Default delete fallback (soft delete)
  const handleDeleteItem = (itemId: string) => {
    handleSoftDeleteItem(itemId);
  };

  const handleBulkDelete = (itemIds: string[]) => {
    handleBulkSoftDelete(itemIds);
  };

  // Handler: Open edit modal
  const handleEditItem = (item: JewelryItem) => {
    setItemToEdit(item);
    setIsAddItemOpen(true);
  };

  // Handler: Open Tag Print Studio
  const handleOpenPrintStudio = (items: JewelryItem[]) => {
    setItemsToPrint(items.length > 0 ? items : inventory);
    setIsTagPrintOpen(true);
  };

  // Refresh data from storage (used after clear or backup import)
  const handleRefreshData = () => {
    setInventory(getStoredInventory());
    setCodeTables(getStoredCodeTables());
    setTransactions(getStoredTransactions());
    setShopifyConfig(getStoredShopifyConfig());
  };

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          width: '100vw',
          background: '#090c10',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fae084',
          gap: '16px',
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '3px solid rgba(212, 175, 55, 0.2)',
            borderTopColor: '#fae084',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <span style={{ fontSize: '0.9rem', letterSpacing: '0.05em', color: '#9ca3af' }}>
          Authenticating Atelier OS...
        </span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  if (user?.status === 'pending' || user?.status === 'rejected' || user?.status === 'suspended') {
    return <PendingApprovalScreen />;
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* App Header */}
      <Header
        onOpenAddItem={() => {
          setItemToEdit(null);
          setIsAddItemOpen(true);
        }}
        onOpenCodeRef={() => setIsCodeRefOpen(true)}
        onOpenExport={() => setIsExportOpen(true)}
        onDownloadLocalBackup={handleDownloadLocalBackup}
        onImportLocalBackup={() => importFileRef.current?.click()}
        onOpenAiSettings={() => setIsAiSettingsOpen(true)}
        onOpenSalesLedger={() => setIsSalesLedgerOpen(true)}
        onOpenPrintTags={() => handleOpenPrintStudio(activeInventory)}
        onOpenShopify={() => setIsShopifyOpen(true)}
        onOpenMarketplaces={() => setIsMarketplaceOpen(true)}
        onOpenVendors={() => setIsVendorMasterOpen(true)}
        onOpenMediaLibrary={() => setIsMediaLibraryOpen(true)}
        onOpenNeedsAttention={() => setIsNeedsAttentionOpen(true)}
        onOpenGlobalSkuInit={() => setIsGlobalSkuInitOpen(true)}
        onOpenUserManagement={() => setIsUserManagementOpen(true)}
        pendingApprovalsCount={pendingApprovalsCount}
        onOpenAuth={() => setIsAuthOpen(true)}
        isShopifyConnected={shopifyConfig.isConnected}
        totalItemsCount={activeInventory.length}
      />

      <input
        ref={importFileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => handleImportBackupFile(e.target.files?.[0])}
      />

      {/* Main Content Area */}
      <main
        style={{
          maxWidth: '1360px',
          width: '100%',
          margin: '0 auto',
          padding: '24px 20px 60px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '28px',
          flex: 1,
        }}
      >
        {/* Reporting Dashboard */}
        <Dashboard
          items={activeInventory}
          codeTables={codeTables}
          transactions={transactions}
          onQuickRestock={(itemId, addQty) => handleAdjustQuantity(itemId, addQty)}
          onFilterLowStock={() => setFilterStatus('low_stock')}
          onOpenSalesLedger={() => setIsSalesLedgerOpen(true)}
        />

        {/* Inventory Register */}
        <InventoryRegister
          items={inventory}
          codeTables={codeTables}
          onEditItem={handleEditItem}
          onDeleteItem={handleDeleteItem}
          onAdjustQuantity={handleAdjustQuantity}
          filterStatus={filterStatus}
          setFilterStatus={setFilterStatus}
          onOpenPrintStudio={handleOpenPrintStudio}
          onOpenRecordSale={(item) => setItemToSell(item)}
          onBulkDelete={handleBulkDelete}
          onBulkAdjustQuantity={handleBulkAdjustQuantity}
          onPushItemToShopify={handlePushItemToShopify}
          onBulkPushToShopify={handleBulkPushToShopify}
          onUpdateItem={(item) => { void handleSaveItem(item); }}
          onRetrySync={handleRetrySync}
          onSoftDeleteItem={handleSoftDeleteItem}
          onHardDeleteItem={handleHardDeleteItem}
          onRestoreItem={handleRestoreItem}
          onBulkSoftDelete={handleBulkSoftDelete}
          onBulkHardDelete={handleBulkHardDelete}
          onBulkRestore={handleBulkRestore}
          onEmptyTrash={handleEmptyTrash}
        />
      </main>

      {/* Footer */}
      <footer
        style={{
          borderTop: '1px solid var(--border-subtle)',
          padding: '20px',
          textAlign: 'center',
          color: 'var(--text-dim)',
          fontSize: '0.8rem',
          background: 'rgba(10, 11, 14, 0.95)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span>Saaz Ledger</span>
          <span>•</span>
          <span>Jewelry Coding Scheme: Type + Stone + Color + Serial</span>
          <span>•</span>
          <span style={{ color: '#d4af37' }}>Zero-Stock Safe</span>
          <span>•</span>
          <span style={{ color: '#34d399' }}>Real-time Audit Trail</span>
          <span>•</span>
          <span style={{ color: '#10b981' }}>Shopify REST & GraphQL Ready</span>
        </div>
      </footer>

      {/* Modals */}
      {isAddItemOpen && (
        <AddItemModal
          codeTables={codeTables}
          inventory={inventory}
          vendors={vendors}
          itemToEdit={itemToEdit}
          onSaveItem={handleSaveItem}
          onKeepLocalDraft={handleKeepLocalDraft}
          onSaveAndPrint={(savedItem) => {
            // savedItem is already server-confirmed (authoritative SKU/id)
            setItemsToPrint([savedItem]);
            setIsTagPrintOpen(true);
            setIsAddItemOpen(false);
            setItemToEdit(null);
          }}
          onRestockExisting={handleRestockExisting}
          onQuickAddVendor={handleQuickAddVendor}
          onClose={() => {
            setIsAddItemOpen(false);
            setItemToEdit(null);
          }}
        />
      )}

      {isCodeRefOpen && (
        <CodeReferenceModal
          codeTables={codeTables}
          onSaveCodeTables={updateCodeTables}
          onClose={() => setIsCodeRefOpen(false)}
        />
      )}

      {isExportOpen && (
        <ExportImportModal
          items={inventory}
          codeTables={codeTables}
          onRefreshData={handleRefreshData}
          onClose={() => setIsExportOpen(false)}
        />
      )}

      {isAiSettingsOpen && (
        <AiSettingsModal
          onClose={() => setIsAiSettingsOpen(false)}
        />
      )}

      {/* Barcode Tag Print Studio */}
      {isTagPrintOpen && (
        <TagPrintModal
          items={itemsToPrint}
          codeTables={codeTables}
          onClose={() => setIsTagPrintOpen(false)}
        />
      )}

      {/* Record Sale Modal */}
      {itemToSell && (
        <RecordSaleModal
          item={itemToSell}
          onConfirmSale={handleConfirmSale}
          onClose={() => setItemToSell(null)}
        />
      )}

      {/* Sales & Stock Movement Ledger */}
      {isSalesLedgerOpen && (
        <SalesLedgerModal
          transactions={transactions}
          onClose={() => setIsSalesLedgerOpen(false)}
        />
      )}

      {/* Shopify Integration Modal */}
      {isShopifyOpen && (
        <ShopifyModal
          items={inventory}
          selectedItemsToPush={selectedShopifyItems}
          codeTables={codeTables}
          onUpdateInventory={(newInv) => {
            updateInventory(newInv);
            setShopifyConfig(getStoredShopifyConfig());
          }}
          onRecordTransactions={(newTxs) => {
            setTransactions((prev) => [...newTxs, ...prev]);
          }}
          onClose={() => {
            setIsShopifyOpen(false);
            setSelectedShopifyItems(undefined);
            setShopifyConfig(getStoredShopifyConfig());
          }}
        />
      )}

      {/* Multi-Channel Marketplace Hub Modal (Amazon, Myntra, SaazAura & Buffer) */}
      {isMarketplaceOpen && (
        <MarketplaceHubModal
          items={inventory}
          codeTables={codeTables}
          onUpdateInventory={(updated) => updateInventory(updated)}
          onOpenShopifyModal={() => {
            setIsMarketplaceOpen(false);
            setIsShopifyOpen(true);
          }}
          onClose={() => setIsMarketplaceOpen(false)}
        />
      )}

      {/* Artisans & Vendor Master Modal */}
      {isVendorMasterOpen && (
        <VendorMasterModal
          vendors={vendors}
          inventory={inventory}
          transactions={transactions}
          onSaveVendor={handleSaveVendor}
          onDeleteVendor={handleDeleteVendor}
          onImportVendors={handleImportVendors}
          onClose={() => setIsVendorMasterOpen(false)}
        />
      )}

      {/* Cloud Media Library Modal */}
      <MediaLibraryModal
        isOpen={isMediaLibraryOpen}
        onClose={() => setIsMediaLibraryOpen(false)}
        inventory={inventory}
        onOpenStorageSettings={() => setIsMediaSettingsOpen(true)}
      />

      {/* Cloud Media Storage Settings Modal */}
      <MediaStorageSettingsModal
        isOpen={isMediaSettingsOpen}
        onClose={() => setIsMediaSettingsOpen(false)}
      />

      {/* Operational Exception Desk (Needs Attention) */}
      <NeedsAttentionModal
        isOpen={isNeedsAttentionOpen}
        onClose={() => setIsNeedsAttentionOpen(false)}
      />

      {/* Global 5-Digit SKU Initialization Modal */}
      <GlobalSkuInitModal
        isOpen={isGlobalSkuInitOpen}
        onClose={() => setIsGlobalSkuInitOpen(false)}
        onSuccess={() => {
          fetchInventory().then((items) => setInventory(items));
        }}
      />

      {/* Google & Atelier Authentication Modal */}
      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
      />

      {/* Master Admin Team & Role Access Modal */}
      <UserManagementModal
        isOpen={isUserManagementOpen}
        onClose={() => {
          setIsUserManagementOpen(false);
          if (token && user?.role === 'admin') {
            fetch('/api/users', { headers: { Authorization: `Bearer ${token}` } })
              .then((r) => r.json())
              .then((d) => setPendingApprovalsCount(d.pendingCount || 0))
              .catch(() => {});
          }
        }}
      />

      {/* Automatic Background Order Sync Toast */}
      {autoSyncStatus && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 9999,
            background: 'linear-gradient(135deg, #065f46 0%, #047857 100%)',
            border: '1px solid #10b981',
            color: '#ecfdf5',
            padding: '12px 18px',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4), 0 0 12px rgba(16, 185, 129, 0.3)',
            fontSize: '0.84rem',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            animation: 'fadeIn 0.25s ease-out',
          }}
        >
          <span style={{ fontSize: '1.1rem' }}>🛍️</span>
          <span>{autoSyncStatus}</span>
        </div>
      )}

      {/* Soft-Delete Undo Toast Notification */}
      {toastNotice && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 99999,
            background: 'linear-gradient(135deg, #1e2230 0%, #11131a 100%)',
            border: '1px solid rgba(212, 175, 55, 0.45)',
            borderRadius: '12px',
            padding: '12px 20px',
            boxShadow: '0 12px 35px rgba(0, 0, 0, 0.65), 0 0 15px rgba(212, 175, 55, 0.2)',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            animation: 'fadeIn 0.2s ease',
          }}
        >
          <span style={{ fontSize: '0.88rem', color: '#ffffff', fontWeight: 500 }}>{toastNotice.message}</span>
          {toastNotice.undoAction && (
            <button
              type="button"
              onClick={() => {
                toastNotice.undoAction?.();
                setToastNotice(null);
              }}
              style={{
                padding: '4px 12px',
                borderRadius: '6px',
                background: 'rgba(212, 175, 55, 0.2)',
                border: '1px solid #d4af37',
                color: '#fae084',
                fontSize: '0.8rem',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={() => setToastNotice(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '2px',
              fontSize: '1.1rem',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}

export default App;
