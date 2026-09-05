import React from 'react';
import { Gem, Plus, Sliders, Download, Sparkles, BookOpen, Printer, Store, Layers, Users, Cloud, AlertTriangle, Key } from 'lucide-react';

interface HeaderProps {
  onOpenAddItem: () => void;
  onOpenCodeRef: () => void;
  onOpenExport: () => void;
  onOpenAiSettings: () => void;
  onOpenSalesLedger: () => void;
  onOpenPrintTags: () => void;
  onOpenShopify: () => void;
  onOpenMarketplaces: () => void;
  onOpenVendors: () => void;
  onOpenMediaLibrary: () => void;
  onOpenNeedsAttention?: () => void;
  onOpenGlobalSkuInit?: () => void;
  isShopifyConnected?: boolean;
  totalItemsCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenAddItem,
  onOpenCodeRef,
  onOpenExport,
  onOpenAiSettings,
  onOpenSalesLedger,
  onOpenPrintTags,
  onOpenShopify,
  onOpenMarketplaces,
  onOpenVendors,
  onOpenMediaLibrary,
  onOpenNeedsAttention,
  onOpenGlobalSkuInit,
  isShopifyConnected = false,
  totalItemsCount,
}) => {
  return (
    <header
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        background: 'rgba(10, 11, 14, 0.85)',
        backdropFilter: 'blur(16px)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}
    >
      <div
        style={{
          maxWidth: '1360px',
          margin: '0 auto',
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '20px',
          flexWrap: 'wrap',
        }}
      >
        {/* Brand & Identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #262112 0%, #12141a 100%)',
              border: '1px solid #d4af37',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 16px rgba(212, 175, 55, 0.2)',
            }}
          >
            <Gem size={22} color="#fae084" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.45rem',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  background: 'linear-gradient(135deg, #ffffff 0%, #fae084 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  margin: 0,
                }}
              >
                SAAZ LEDGER
              </h1>
              <span
                style={{
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  background: 'rgba(212, 175, 55, 0.15)',
                  color: '#fae084',
                  padding: '2px 7px',
                  borderRadius: '4px',
                  border: '1px solid rgba(212, 175, 55, 0.3)',
                }}
              >
                ATELIER OS
              </span>
            </div>
            <p
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-muted)',
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>Bespoke Fashion Jewelry SKU & Profit Suite</span>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>•</span>
              <span style={{ color: '#d4af37' }}>{totalItemsCount} Active SKUs</span>
            </p>
          </div>
        </div>

        {/* Global Quick Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenSalesLedger}
            title="View sales transactions and stock movement audit log"
          >
            <BookOpen size={16} color="#34d399" />
            <span>Sales Ledger</span>
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenPrintTags}
            title="Open Jewelry Barcode & Tag Printing Studio"
          >
            <Printer size={16} color="#fae084" />
            <span>Tag Studio</span>
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenAiSettings}
            title="Configure Google Gemini Vision or OpenAI API Key"
          >
            <Sparkles size={16} color="#fae084" />
            <span>AI Vision Key</span>
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenVendors}
            title="Artisans & Vendor Master Data, Reorder PO Sheets & Wholesale Margins"
          >
            <Users size={16} color="#38bdf8" />
            <span>Artisans</span>
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenCodeRef}
            title="Manage Product Types, Stones, and Color codes"
          >
            <Sliders size={16} color="#d4af37" />
            <span>Code Reference</span>
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenExport}
            title="CSV Bulk Ingest, Shopify Export & Full Ledger Backup"
          >
            <Download size={16} />
            <span>Data Hub</span>
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenShopify}
            title={isShopifyConnected ? 'Shopify Store Connected & Ready' : 'Configure Shopify Store Connection'}
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <Store size={16} color="#10b981" />
            <span>Shopify</span>
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: isShopifyConnected ? '#34d399' : '#f59e0b',
                boxShadow: isShopifyConnected ? '0 0 6px #34d399' : 'none',
              }}
              title={isShopifyConnected ? 'Connected' : 'Not Connected'}
            />
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenMarketplaces}
            title="Multi-Channel Stock Hub (Amazon, Myntra, SaazAura.com & Buffer)"
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <Layers size={16} color="#fbbf24" />
            <span>Marketplaces</span>
          </button>

          <button
            type="button"
            className="btn-secondary"
            onClick={onOpenMediaLibrary}
            title="Cloud Media Library (Amazon S3 & Google Drive Vault)"
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <Cloud size={16} color="#c084fc" />
            <span>Media Library</span>
          </button>

          {onOpenNeedsAttention && (
            <button
              type="button"
              className="btn-secondary"
              onClick={onOpenNeedsAttention}
              title="Operational Exceptions & Needs Attention Desk"
              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <AlertTriangle size={16} color="#f59e0b" />
              <span>Exceptions</span>
            </button>
          )}

          {onOpenGlobalSkuInit && (
            <button
              type="button"
              className="btn-secondary"
              onClick={onOpenGlobalSkuInit}
              title="Global 5-Digit SKU System & Sequence Calibration"
              style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <Key size={16} color="#fae084" />
              <span>Global SKU</span>
            </button>
          )}

          <button
            type="button"
            className="btn-primary"
            onClick={onOpenAddItem}
            title="Add a new jewelry piece and generate next free SKU"
          >
            <Plus size={18} />
            <span>New Piece</span>
          </button>
        </div>
      </div>
    </header>
  );
};
