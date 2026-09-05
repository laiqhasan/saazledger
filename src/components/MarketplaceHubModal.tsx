import React, { useState } from 'react';
import type { JewelryItem, CodeTables } from '../types/inventory';
import {
  generateAmazonInventoryCsv,
  generateMyntraStockManifestCsv,
  calculateMarketplaceDistribution,
} from '../services/marketplaceService';
import { downloadFile } from '../services/storage';
import { SkuTagBadge } from './SkuTagBadge';
import {
  X,
  Layers,
  Store,
  ShoppingBag,
  Download,
  Shield,
  CheckCircle2,
  Package,
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface MarketplaceHubModalProps {
  items: JewelryItem[];
  codeTables?: CodeTables;
  onUpdateInventory: (items: JewelryItem[]) => void;
  onOpenShopifyModal?: () => void;
  onClose: () => void;
}

export const MarketplaceHubModal: React.FC<MarketplaceHubModalProps> = ({
  items,
  onUpdateInventory,
  onOpenShopifyModal,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'amazon' | 'myntra' | 'reserves'>('overview');
  const [safetyBufferInput, setSafetyBufferInput] = useState<number>(1);
  const [notice, setNotice] = useState<string | null>(null);

  const stats = calculateMarketplaceDistribution(items);

  const handleExportAmazon = () => {
    const csv = generateAmazonInventoryCsv(items);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(csv, `saaz_amazon_inventory_${dateStr}.csv`, 'text/csv');
    setNotice('Amazon Seller Central inventory flat file downloaded successfully!');
    try {
      confetti({ particleCount: 30, spread: 50, origin: { y: 0.6 } });
    } catch {}
  };

  const handleExportMyntra = () => {
    const csv = generateMyntraStockManifestCsv(items);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(csv, `saaz_myntra_manifest_${dateStr}.csv`, 'text/csv');
    setNotice('Myntra Partner Portal stock manifest CSV downloaded successfully!');
    try {
      confetti({ particleCount: 30, spread: 50, origin: { y: 0.6 } });
    } catch {}
  };

  const handleApplyGlobalSafetyReserve = () => {
    const updated = items.map((item) => ({
      ...item,
      safetyReserve: Math.max(0, safetyBufferInput),
    }));
    onUpdateInventory(updated);
    setNotice(`Applied ${safetyBufferInput} unit safety reserve buffer across all ${items.length} designs.`);
    try {
      confetti({ particleCount: 40, spread: 60, origin: { y: 0.6 } });
    } catch {}
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '840px', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
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
                background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.25) 0%, rgba(212, 175, 55, 0.15) 100%)',
                border: '1px solid rgba(245, 158, 11, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Layers size={22} color="#f59e0b" />
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
                Multi-Channel Stock Hub
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontFamily: 'var(--font-sans)',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: 'rgba(212, 175, 55, 0.15)',
                    color: '#fae084',
                    border: '1px solid rgba(212, 175, 55, 0.3)',
                  }}
                >
                  SaazAura.com • Amazon • Myntra
                </span>
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                Central master stock pool allocation, safety reserve buffers, and marketplace inventory manifests
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

        {/* Navigation Tabs */}
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
            onClick={() => setActiveTab('overview')}
            style={{
              padding: '12px 18px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'overview' ? '2px solid var(--gold-500)' : '2px solid transparent',
              color: activeTab === 'overview' ? '#fae084' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Master Pool Overview
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('amazon')}
            style={{
              padding: '12px 18px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'amazon' ? '2px solid #f59e0b' : '2px solid transparent',
              color: activeTab === 'amazon' ? '#f59e0b' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Amazon India Feed
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('myntra')}
            style={{
              padding: '12px 18px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'myntra' ? '2px solid #ec4899' : '2px solid transparent',
              color: activeTab === 'myntra' ? '#f472b6' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Myntra Manifest
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('reserves')}
            style={{
              padding: '12px 18px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'reserves' ? '2px solid var(--gold-500)' : '2px solid transparent',
              color: activeTab === 'reserves' ? '#fae084' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Safety Buffers & Reserves
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {notice && (
            <div
              style={{
                marginBottom: '18px',
                padding: '10px 14px',
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
              <CheckCircle2 size={16} />
              <span>{notice}</span>
            </div>
          )}

          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Channel Stats Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
                {/* SaazAura.com (Shopify) */}
                <div
                  className="glass-panel"
                  style={{
                    padding: '16px',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    background: 'rgba(16, 185, 129, 0.05)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.74rem', color: '#34d399', fontWeight: 700 }}>SAAZAURA.COM</span>
                    <Store size={16} color="#34d399" />
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#ffffff' }}>
                    {stats.shopifyCount} <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}>SKUs</span>
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                    Shopify Auto-Sync Active
                  </div>
                </div>

                {/* Amazon India */}
                <div
                  className="glass-panel"
                  style={{
                    padding: '16px',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    background: 'rgba(245, 158, 11, 0.05)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.74rem', color: '#f59e0b', fontWeight: 700 }}>AMAZON INDIA</span>
                    <ShoppingBag size={16} color="#f59e0b" />
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#ffffff' }}>
                    {stats.amazonCount} <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}>SKUs</span>
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                    Seller Central Ready
                  </div>
                </div>

                {/* Myntra */}
                <div
                  className="glass-panel"
                  style={{
                    padding: '16px',
                    border: '1px solid rgba(236, 72, 153, 0.3)',
                    background: 'rgba(236, 72, 153, 0.05)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.74rem', color: '#f472b6', fontWeight: 700 }}>MYNTRA FASHION</span>
                    <Package size={16} color="#f472b6" />
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#ffffff' }}>
                    {stats.myntraCount} <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}>SKUs</span>
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                    Partner Portal Format
                  </div>
                </div>

                {/* Safety Reserve */}
                <div
                  className="glass-panel"
                  style={{
                    padding: '16px',
                    border: '1px solid rgba(212, 175, 55, 0.3)',
                    background: 'rgba(212, 175, 55, 0.05)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.74rem', color: '#fae084', fontWeight: 700 }}>SAFETY BUFFER</span>
                    <Shield size={16} color="#fae084" />
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#ffffff' }}>
                    {stats.totalReserveUnits} <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}>units</span>
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                    Reserved from Marketplace
                  </div>
                </div>
              </div>

              {/* Strategy Explanation Card */}
              <div
                style={{
                  padding: '18px 20px',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.95rem', marginBottom: '8px' }}>
                  How Multi-Channel Stock Management Works in Saaz Ledger:
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', fontSize: '0.8rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                  <div>
                    <strong style={{ color: '#34d399' }}>1. Single Master Pool:</strong> Your physical jewelry stock (Total: {stats.totalInventoryUnits} units) is shared centrally. When an order sells on <strong>SaazAura.com (Shopify)</strong>, Saaz Ledger automatically deducts the units and logs realized profit.
                  </div>
                  <div>
                    <strong style={{ color: '#fae084' }}>2. Safety Reserves:</strong> You can hold back a buffer (e.g. 1 unit per design) so that marketplace listings automatically cap available stock at <code>Physical - Buffer</code> to prevent accidental overselling.
                  </div>
                </div>

                <div style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={onOpenShopifyModal}
                    style={{ fontSize: '0.82rem', padding: '8px 16px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <Store size={15} />
                    <span>Manage Shopify (SaazAura.com) Auto-Sync &rarr;</span>
                  </button>
                </div>
              </div>

              {/* Design Matrix Table */}
              <div>
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.9rem', marginBottom: '10px' }}>
                  Design Marketplace Allocation Matrix
                </div>
                <div style={{ maxHeight: '240px', overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: '8px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                    <thead style={{ background: 'rgba(255, 255, 255, 0.04)', color: 'var(--text-dim)' }}>
                      <tr>
                        <th style={{ padding: '8px 10px' }}>Item & SKU</th>
                        <th style={{ padding: '8px 10px' }}>Total Units</th>
                        <th style={{ padding: '8px 10px' }}>Safety Buffer</th>
                        <th style={{ padding: '8px 10px' }}>Available for Sale</th>
                        <th style={{ padding: '8px 10px' }}>Active Channels</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => {
                        const buffer = item.safetyReserve || 0;
                        const available = Math.max(0, item.quantity - buffer);
                        return (
                          <tr key={item.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                            <td style={{ padding: '8px 10px' }}>
                              <div style={{ fontWeight: 600, color: '#ffffff' }}>{item.title}</div>
                              <SkuTagBadge sku={item.sku} size="sm" />
                            </td>
                            <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                              {item.quantity}
                            </td>
                            <td style={{ padding: '8px 10px', color: '#fae084', fontFamily: 'var(--font-mono)' }}>
                              {buffer}
                            </td>
                            <td style={{ padding: '8px 10px', color: available > 0 ? '#34d399' : '#f43f5e', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                              {available}
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '0.65rem', background: 'rgba(16, 185, 129, 0.15)', color: '#34d399', padding: '1px 5px', borderRadius: '3px' }}>
                                  Shopify
                                </span>
                                {item.isListedOnAmazon && (
                                  <span style={{ fontSize: '0.65rem', background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', padding: '1px 5px', borderRadius: '3px' }}>
                                    Amazon
                                  </span>
                                )}
                                {item.isListedOnMyntra && (
                                  <span style={{ fontSize: '0.65rem', background: 'rgba(236, 72, 153, 0.15)', color: '#f472b6', padding: '1px 5px', borderRadius: '3px' }}>
                                    Myntra
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: AMAZON */}
          {activeTab === 'amazon' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              <div>
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.95rem' }}>
                  Amazon India Seller Central: Inventory Loader Flat-File
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                  Download the official Amazon Seller Central tab-separated/CSV feed format.
                  Upload in <strong>Inventory &gt; Add Products via Upload &gt; Upload your inventory file</strong>.
                </p>
              </div>

              <div
                style={{
                  padding: '16px',
                  borderRadius: '10px',
                  background: 'rgba(245, 158, 11, 0.05)',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, color: '#f59e0b', fontSize: '0.9rem' }}>
                    Generate Amazon Feed ({items.length} Designs)
                  </div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                    Includes SKU, Selling Price, Min/Max pricing rules, and safety buffer-adjusted stock
                  </div>
                </div>

                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleExportAmazon}
                  style={{
                    padding: '10px 18px',
                    fontSize: '0.85rem',
                    background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                    borderColor: '#f59e0b',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <Download size={16} />
                  <span>Download Amazon Feed CSV</span>
                </button>
              </div>

              <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                <strong>Field Mapping:</strong>
                <ul style={{ paddingLeft: '20px', marginTop: '6px' }}>
                  <li><code>sku</code>: Assigned Jewelry SKU (e.g. <code>PDJ12001</code>)</li>
                  <li><code>price</code>: Retail Price (INR)</li>
                  <li><code>quantity</code>: Current Physical Stock minus Safety Buffer</li>
                  <li><code>leadtime-to-ship</code>: Standard 2-day dispatch</li>
                </ul>
              </div>
            </div>
          )}

          {/* TAB 3: MYNTRA */}
          {activeTab === 'myntra' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              <div>
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.95rem' }}>
                  Myntra Partner Portal: Stock & Price Manifest
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                  Download the official stock update format for Myntra PP (Partner Portal).
                  Upload in <strong>Inventory Management &gt; Bulk Inventory Upload</strong>.
                </p>
              </div>

              <div
                style={{
                  padding: '16px',
                  borderRadius: '10px',
                  background: 'rgba(236, 72, 153, 0.05)',
                  border: '1px solid rgba(236, 72, 153, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, color: '#f472b6', fontSize: '0.9rem' }}>
                    Generate Myntra Manifest ({items.length} Designs)
                  </div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                    Includes Style ID, Seller SKU, Free Size, MRP, and allocated stock
                  </div>
                </div>

                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleExportMyntra}
                  style={{
                    padding: '10px 18px',
                    fontSize: '0.85rem',
                    background: 'linear-gradient(135deg, #ec4899 0%, #be185d 100%)',
                    borderColor: '#ec4899',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <Download size={16} />
                  <span>Download Myntra Manifest CSV</span>
                </button>
              </div>

              <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                <strong>Field Mapping:</strong>
                <ul style={{ paddingLeft: '20px', marginTop: '6px' }}>
                  <li><code>Style ID</code>: Myntra Style Code or Atelier Reference</li>
                  <li><code>Seller SKU</code>: Saaz Ledger unique SKU</li>
                  <li><code>Allocated for Myntra</code>: Available units after buffer</li>
                  <li><code>MRP</code>: Calculated at standard 1.35x retail listing price</li>
                </ul>
              </div>
            </div>
          )}

          {/* TAB 4: RESERVES */}
          {activeTab === 'reserves' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div>
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.95rem' }}>
                  Safety Buffer Reserve Configuration
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                  Safety buffers prevent stockouts and negative marketplace reviews. If an item has 5 units and 1 safety reserve,
                  marketplaces (Amazon, Myntra, Shopify) are instructed that only 4 units are available.
                </p>
              </div>

              <div
                style={{
                  padding: '18px 20px',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '16px',
                }}
              >
                <div>
                  <label style={{ display: 'block', fontSize: '0.82rem', color: '#ffffff', fontWeight: 600, marginBottom: '4px' }}>
                    Set Global Safety Reserve Buffer
                  </label>
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-dim)' }}>
                    Applies buffer units to all designs currently in stock
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    value={safetyBufferInput}
                    onChange={(e) => setSafetyBufferInput(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="input-field"
                    style={{ width: '80px', textAlign: 'center', fontWeight: 700 }}
                  />
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleApplyGlobalSafetyReserve}
                    style={{ padding: '8px 16px', fontSize: '0.82rem' }}
                  >
                    Apply Buffer to All
                  </button>
                </div>
              </div>
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
            Total Inventory: {stats.totalInventoryUnits} Units • Available: {stats.availableForSale} Units
          </span>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
