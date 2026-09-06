import React, { useState } from 'react';
import type { JewelryItem, CodeTables, ShopifyConfig } from '../types/inventory';
import {
  getStoredShopifyConfig,
  saveStoredShopifyConfig,
  testShopifyConnection,
  bulkPushToShopify,
  pullProductsFromShopify,
  syncShopifyOrdersToInventory,
  normalizeShopDomain,
} from '../services/shopifyService';
import { exportToShopifyCSV, downloadFile } from '../services/storage';
import {
  X,
  Store,
  CheckCircle2,
  AlertCircle,
  Loader2,
  UploadCloud,
  DownloadCloud,
  FileSpreadsheet,
  Eye,
  EyeOff,
  ShieldCheck,
  Sparkles,
  ShoppingBag,
  RefreshCw,
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface ShopifyModalProps {
  items: JewelryItem[];
  codeTables: CodeTables;
  onUpdateInventory: (items: JewelryItem[]) => void;
  onRecordTransactions?: (txs: import('../types/inventory').StockMovement[]) => void;
  onClose: () => void;
}

export const ShopifyModal: React.FC<ShopifyModalProps> = ({
  items,
  codeTables,
  onUpdateInventory,
  onRecordTransactions,
  onClose,
}) => {
  const [config, setConfig] = useState<ShopifyConfig>(getStoredShopifyConfig());
  const [activeTab, setActiveTab] = useState<'connection' | 'sync' | 'csv'>('connection');
  const [showToken, setShowToken] = useState(false);

  // Connection Test State
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    details?: string;
  } | null>(null);

  // Sync State
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number; title: string } | null>(null);
  const [syncLog, setSyncLog] = useState<string[]>([]);
  const [syncDoneSummary, setSyncDoneSummary] = useState<string | null>(null);

  // Stats
  const syncedCount = items.filter((i) => i.shopifyProductId).length;
  const unsyncedCount = items.length - syncedCount;

  // Handle Save Credentials & Test
  const handleTestConnection = async () => {
    if (!config.shopDomain.trim()) {
      setTestResult({ success: false, message: 'Please enter your Shopify store domain.' });
      return;
    }
    if (!config.adminAccessToken.trim()) {
      setTestResult({ success: false, message: 'Please enter your Admin API Access Token (shpat_...).' });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    const cleanDomain = normalizeShopDomain(config.shopDomain);
    const updatedConfig: ShopifyConfig = {
      ...config,
      shopDomain: cleanDomain,
    };

    const res = await testShopifyConnection(updatedConfig);
    setIsTesting(false);

    if (res.success) {
      const finalConfig: ShopifyConfig = {
        ...updatedConfig,
        isConnected: true,
        shopName: res.shopName,
        email: res.email,
        currency: res.currency,
        lastSyncTimestamp: new Date().toISOString(),
      };
      setConfig(finalConfig);
      saveStoredShopifyConfig(finalConfig);

      setTestResult({
        success: true,
        message: `Successfully connected to "${res.shopName}"!`,
        details: `Currency: ${res.currency || 'INR'} • Admin: ${res.email || 'Verified'}`,
      });

      try {
        confetti({ particleCount: 40, spread: 60, origin: { y: 0.6 } });
      } catch {}
    } else {
      const failedConfig: ShopifyConfig = { ...updatedConfig, isConnected: false };
      setConfig(failedConfig);
      saveStoredShopifyConfig(failedConfig);
      setTestResult({
        success: false,
        message: 'Connection Failed',
        details: res.error,
      });
    }
  };

  // Handle Push All Unsynced to Shopify
  const handlePushToShopify = async (targetItems: JewelryItem[]) => {
    if (!config.isConnected && !config.adminAccessToken) {
      alert('Please connect and verify your Shopify store credentials first.');
      setActiveTab('connection');
      return;
    }

    setIsSyncing(true);
    setSyncLog([]);
    setSyncDoneSummary(null);

    const { result, updatedItems } = await bulkPushToShopify(
      targetItems,
      config,
      { status: config.defaultStatus },
      (current, total, item) => {
        setSyncProgress({ current, total, title: item.title });
        setSyncLog((prev) => [`[${current}/${total}] Pushing "${item.title}" (${item.sku})...`, ...prev.slice(0, 15)]);
      }
    );

    setIsSyncing(false);
    setSyncProgress(null);

    // Merge updated items back into full inventory
    const updatedMap = new Map(updatedItems.map((i) => [i.id, i]));
    const mergedInventory = items.map((i) => updatedMap.get(i.id) || i);
    onUpdateInventory(mergedInventory);

    setSyncDoneSummary(
      `Sync Complete! Created: ${result.createdCount} • Updated: ${result.updatedCount} • Failed: ${result.failedCount}`
    );

    if (result.success) {
      try {
        confetti({ particleCount: 50, spread: 70, origin: { y: 0.6 } });
      } catch {}
    }
  };

  // Handle Pull Catalog from Shopify
  const handlePullFromShopify = async () => {
    if (!config.isConnected && !config.adminAccessToken) {
      alert('Please connect and verify your Shopify store credentials first.');
      setActiveTab('connection');
      return;
    }

    setIsSyncing(true);
    setSyncLog(['Contacting Shopify Admin API to fetch products...']);
    setSyncDoneSummary(null);

    const res = await pullProductsFromShopify(config, codeTables, items);
    setIsSyncing(false);

    if (res.error) {
      setSyncLog((prev) => [`Error: ${res.error}`, ...prev]);
      return;
    }

    onUpdateInventory(res.updatedInventory);
    setSyncDoneSummary(
      `Catalog Pull Complete! Imported: ${res.importedCount} new pieces • Linked: ${res.updatedCount} existing pieces`
    );

    try {
      confetti({ particleCount: 40, spread: 60, origin: { y: 0.6 } });
    } catch {}
  };

  // Handle Automated Order Sync & Stock Maintenance
  const handleSyncOrders = async () => {
    if (!config.isConnected && !config.adminAccessToken) {
      alert('Please connect and verify your Shopify store credentials first.');
      setActiveTab('connection');
      return;
    }

    setIsSyncing(true);
    setSyncLog(['Contacting Shopify Orders API to reconcile orders on saazaura.com...']);
    setSyncDoneSummary(null);

    const res = await syncShopifyOrdersToInventory(items, config);
    setIsSyncing(false);

    if (res.error) {
      setSyncLog((prev) => [`Order Sync Error: ${res.error}`, ...prev]);
      return;
    }

    if (res.newTransactions.length > 0) {
      onUpdateInventory(res.updatedInventory);
      if (onRecordTransactions) {
        onRecordTransactions(res.newTransactions);
      }
      setSyncDoneSummary(
        `Auto-Reconciliation Complete! Processed ${res.summary.newOrdersProcessed} new orders, deducted ${res.summary.itemsDeductedCount} units from stock, and logged sales in ledger.`
      );
      setSyncLog(res.summary.details);
      try {
        confetti({ particleCount: 50, spread: 70, origin: { y: 0.6 } });
      } catch {}
    } else {
      setSyncDoneSummary(
        `All caught up! Inspected ${res.summary.ordersFetched} orders on saazaura.com. Master stock is 100% reconciled with no new unfulfilled line items.`
      );
    }
  };

  const handleExportShopifyCsv = () => {
    const csvContent = exportToShopifyCSV(items);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(csvContent, `saaz_ledger_shopify_${dateStr}.csv`, 'text/csv');
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '780px', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(15, 17, 23, 0.95)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(212, 175, 55, 0.15) 100%)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Store size={22} color="#10b981" />
            </div>
            <div>
              <h2
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.25rem',
                  color: '#ffffff',
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                Shopify Integration Hub
                {config.isConnected ? (
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontFamily: 'var(--font-sans)',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      background: 'rgba(16, 185, 129, 0.18)',
                      color: '#34d399',
                      border: '1px solid rgba(16, 185, 129, 0.4)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#34d399' }} />
                    Connected: {config.shopName || config.shopDomain}
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontFamily: 'var(--font-sans)',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      background: 'rgba(245, 158, 11, 0.15)',
                      color: '#f59e0b',
                      border: '1px solid rgba(245, 158, 11, 0.3)',
                    }}
                  >
                    Not Connected
                  </span>
                )}
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                Direct bidirectional sync for jewelry catalog, variant SKUs, pricing & inventory levels
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              padding: '6px',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'rgba(0, 0, 0, 0.25)',
            padding: '0 24px',
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('connection')}
            style={{
              padding: '12px 18px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'connection' ? '2px solid var(--gold-500)' : '2px solid transparent',
              color: activeTab === 'connection' ? '#fae084' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Store Connection
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('sync')}
            style={{
              padding: '12px 18px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'sync' ? '2px solid var(--gold-500)' : '2px solid transparent',
              color: activeTab === 'sync' ? '#fae084' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Catalog Sync Hub
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('csv')}
            style={{
              padding: '12px 18px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'csv' ? '2px solid var(--gold-500)' : '2px solid transparent',
              color: activeTab === 'csv' ? '#fae084' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Offline CSV Bridge
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {/* TAB 1: CONNECTION */}
          {activeTab === 'connection' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Credentials Form */}
              <div
                style={{
                  padding: '20px',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.95rem', marginBottom: '14px' }}>
                  Shopify Store Credentials
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                      Shop Domain
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. saaz-jewels.myshopify.com"
                      value={config.shopDomain}
                      onChange={(e) => setConfig({ ...config, shopDomain: e.target.value })}
                      className="input-field"
                    />
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px', display: 'block' }}>
                      Enter your .myshopify.com store address
                    </span>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                      Admin API Version
                    </label>
                    <select
                      className="select-field"
                      value={config.apiVersion}
                      onChange={(e) => setConfig({ ...config, apiVersion: e.target.value })}
                    >
                      <option value="2026-07">2026-07 (Latest / Recommended)</option>
                      <option value="2026-04">2026-04</option>
                      <option value="2026-01">2026-01</option>
                      <option value="2025-10">2025-10</option>
                      <option value="2025-01">2025-01</option>
                      <option value="2024-10">2024-10</option>
                      <option value="2024-07">2024-07</option>
                    </select>
                  </div>
                </div>

                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    Admin API Access Token (Custom App)
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showToken ? 'text' : 'password'}
                      placeholder="shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      value={config.adminAccessToken}
                      onChange={(e) => setConfig({ ...config, adminAccessToken: e.target.value })}
                      className="input-field"
                      style={{ paddingRight: '40px', fontFamily: 'var(--font-mono)' }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      style={{
                        position: 'absolute',
                        right: '12px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-dim)',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                      title={showToken ? 'Hide token' : 'Show token'}
                    >
                      {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px', display: 'block' }}>
                    Token starts with "shpat_". Stored privately in your local browser sandbox.
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                      Default New Product Status
                    </label>
                    <select
                      className="select-field"
                      value={config.defaultStatus}
                      onChange={(e) => setConfig({ ...config, defaultStatus: e.target.value as 'draft' | 'active' })}
                    >
                      <option value="draft">Draft (Review before making live)</option>
                      <option value="active">Active (Immediately published in storefront)</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleTestConnection}
                    disabled={isTesting}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 20px',
                      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                      borderColor: '#10b981',
                    }}
                  >
                    {isTesting ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                    <span>{isTesting ? 'Verifying with Shopify...' : 'Test & Save Connection'}</span>
                  </button>
                </div>
              </div>

              {/* Test Result Message */}
              {testResult && (
                <div
                  style={{
                    padding: '14px 18px',
                    borderRadius: '10px',
                    background: testResult.success ? 'rgba(16, 185, 129, 0.12)' : 'rgba(244, 63, 94, 0.12)',
                    border: `1px solid ${testResult.success ? 'rgba(16, 185, 129, 0.3)' : 'rgba(244, 63, 94, 0.3)'}`,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                  }}
                >
                  {testResult.success ? (
                    <CheckCircle2 size={20} color="#34d399" style={{ flexShrink: 0, marginTop: '2px' }} />
                  ) : (
                    <AlertCircle size={20} color="#f43f5e" style={{ flexShrink: 0, marginTop: '2px' }} />
                  )}
                  <div>
                    <div
                      style={{
                        fontWeight: 700,
                        color: testResult.success ? '#34d399' : '#f87171',
                        fontSize: '0.9rem',
                      }}
                    >
                      {testResult.message}
                    </div>
                    {testResult.details && (
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {testResult.details}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Guide: How to generate token */}
              <div
                style={{
                  padding: '16px 20px',
                  borderRadius: '10px',
                  background: 'rgba(212, 175, 55, 0.04)',
                  border: '1px solid rgba(212, 175, 55, 0.15)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', color: '#fae084', fontWeight: 600, fontSize: '0.85rem' }}>
                  <Sparkles size={16} />
                  <span>How to get your Shopify Admin Access Token in 2 minutes:</span>
                </div>
                <ol style={{ fontSize: '0.78rem', color: 'var(--text-dim)', paddingLeft: '20px', margin: 0, lineHeight: 1.6 }}>
                  <li>Open your <strong>Shopify Admin</strong> &gt; <strong>Settings</strong> &gt; <strong>Apps and sales channels</strong>.</li>
                  <li>Click <strong>Develop apps</strong>, then click <strong>Create an app</strong> (Name: "Saaz Ledger").</li>
                  <li>Under <strong>Configuration</strong> &gt; <strong>Admin API integration</strong>, enable:
                    <span style={{ color: '#34d399', fontWeight: 600 }}> write_products, read_products, write_inventory, read_inventory</span>.
                  </li>
                  <li>Click <strong>Install app</strong> under <strong>API credentials</strong>, then copy the generated <strong>Admin API access token</strong>.</li>
                </ol>
              </div>
            </div>
          )}

          {/* TAB 2: CATALOG SYNC HUB */}
          {activeTab === 'sync' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Status Banner */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '16px',
                }}
              >
                <div
                  className="glass-panel"
                  style={{
                    padding: '18px',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    background: 'rgba(16, 185, 129, 0.05)',
                  }}
                >
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                    Synced with Shopify
                  </div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#34d399', marginTop: '4px' }}>
                    {syncedCount} <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 400 }}>pieces</span>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                    Live on {config.shopName || config.shopDomain || 'Shopify Store'}
                  </div>
                </div>

                <div
                  className="glass-panel"
                  style={{
                    padding: '18px',
                    border: '1px solid rgba(212, 175, 55, 0.3)',
                    background: 'rgba(212, 175, 55, 0.05)',
                  }}
                >
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                    Pending Sync (Local Only)
                  </div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: '#fae084', marginTop: '4px' }}>
                    {unsyncedCount} <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 400 }}>pieces</span>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                    Ready to publish with SKU & pricing
                  </div>
                </div>
              </div>

              {/* Automated Order Reconciliation & Stock Maintenance Card */}
              <div
                style={{
                  padding: '18px 20px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(212, 175, 55, 0.06) 100%)',
                  border: '1px solid rgba(16, 185, 129, 0.35)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '16px',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, color: '#34d399', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ShoppingBag size={18} />
                    <span>Automated Stock Maintenance (Shopify Orders)</span>
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px', maxWidth: '460px', lineHeight: 1.5 }}>
                    When customers buy on <strong>saazaura.com</strong>, Saaz Ledger identifies the sold SKUs, automatically decrements stock in your central vault, and credits realized profit to your Sales Ledger.
                  </div>
                </div>

                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSyncOrders}
                  disabled={isSyncing}
                  style={{
                    padding: '10px 18px',
                    fontSize: '0.85rem',
                    background: 'linear-gradient(135deg, #10b981 0%, #047857 100%)',
                    borderColor: '#10b981',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isSyncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                  <span>Check & Sync Orders Now</span>
                </button>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handlePushToShopify(items)}
                  disabled={isSyncing}
                  style={{
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '4px',
                    height: 'auto',
                    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                    borderColor: '#10b981',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '0.95rem' }}>
                    {isSyncing ? <Loader2 size={18} className="animate-spin" /> : <UploadCloud size={18} />}
                    <span>Push All Pieces to Shopify</span>
                  </div>
                  <span style={{ fontSize: '0.74rem', opacity: 0.9, fontWeight: 400 }}>
                    Creates or updates products with exact SKUs, tags, and prices
                  </span>
                </button>

                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handlePullFromShopify}
                  disabled={isSyncing}
                  style={{
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '4px',
                    height: 'auto',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '0.95rem', color: '#ffffff' }}>
                    {isSyncing ? <Loader2 size={18} className="animate-spin" /> : <DownloadCloud size={18} />}
                    <span>Pull Catalog from Shopify</span>
                  </div>
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-dim)', fontWeight: 400 }}>
                    Fetch products from store and import missing SKUs into Saaz Ledger
                  </span>
                </button>
              </div>

              {/* Progress Bar & Status */}
              {syncProgress && (
                <div
                  style={{
                    padding: '16px',
                    borderRadius: '10px',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '8px' }}>
                    <span style={{ color: '#fae084', fontWeight: 600 }}>Syncing: {syncProgress.title}</span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {syncProgress.current} of {syncProgress.total} ({Math.round((syncProgress.current / syncProgress.total) * 100)}%)
                    </span>
                  </div>
                  <div style={{ width: '100%', height: '6px', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${(syncProgress.current / syncProgress.total) * 100}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #10b981, #d4af37)',
                        transition: 'width 0.2s',
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Sync Summary Notice */}
              {syncDoneSummary && (
                <div
                  style={{
                    padding: '12px 16px',
                    borderRadius: '8px',
                    background: 'rgba(16, 185, 129, 0.15)',
                    border: '1px solid rgba(16, 185, 129, 0.4)',
                    color: '#34d399',
                    fontSize: '0.85rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <CheckCircle2 size={18} />
                  <span>{syncDoneSummary}</span>
                </div>
              )}

              {/* Live Log Stream */}
              {syncLog.length > 0 && (
                <div
                  style={{
                    padding: '12px 16px',
                    borderRadius: '8px',
                    background: '#090a0d',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.74rem',
                    color: '#9ca3af',
                    maxHeight: '140px',
                    overflowY: 'auto',
                    lineHeight: 1.5,
                  }}
                >
                  {syncLog.map((log, i) => (
                    <div key={i}>{log}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: OFFLINE CSV */}
          {activeTab === 'csv' && (
            <div>
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.95rem' }}>
                  Shopify Product CSV Export
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                  If you prefer manual upload or don't want to create an API token, download this pre-formatted CSV file.
                  In Shopify Admin, navigate to <strong>Products &gt; Import</strong> and upload this file.
                </p>
              </div>

              <button
                type="button"
                className="btn-secondary"
                onClick={handleExportShopifyCsv}
                style={{
                  padding: '16px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                <FileSpreadsheet size={24} color="#10b981" />
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.92rem' }}>
                    Download Shopify Product Matrix CSV ({items.length} Pieces)
                  </div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                    Contains Handles, Titles, Variant SKUs, Prices, Cost per Item, and Barcode tags
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(15, 17, 23, 0.95)',
          }}
        >
          <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
            Official Shopify REST / GraphQL Admin API compatible
          </span>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
