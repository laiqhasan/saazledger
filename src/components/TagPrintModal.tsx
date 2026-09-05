import React, { useState } from 'react';
import type { JewelryItem, CodeTables, TagPrintLayout } from '../types/inventory';
import { generateBarcodeSvg } from '../services/barcodeService';
import { formatCurrency } from '../services/skuEngine';
import {
  X,
  Printer,
  Tag,
  Grid,
  Sliders,
  Package,
} from 'lucide-react';

interface TagPrintModalProps {
  items: JewelryItem[];
  codeTables: CodeTables;
  onClose: () => void;
}

export const TagPrintModal: React.FC<TagPrintModalProps> = ({
  items,
  codeTables,
  onClose,
}) => {
  const [layout, setLayout] = useState<TagPrintLayout>('dumbbell');
  const [showPrice, setShowPrice] = useState(true);
  const [showBarcode, setShowBarcode] = useState(true);
  const [showTypeStone, setShowTypeStone] = useState(true);
  const [useStockQuantity, setUseStockQuantity] = useState(false);

  // Calculate items to print based on quantity mode
  const printItemsList = items.flatMap((item) => {
    const count = useStockQuantity ? Math.max(1, item.quantity) : 1;
    return Array.from({ length: count }, () => item);
  });

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="modal-overlay">
      {/* Container - adds print-container class for CSS print media rules */}
      <div
        className="modal-content print-studio-modal"
        style={{
          maxWidth: '920px',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Modal Header */}
        <div
          className="no-print"
          style={{
            padding: '18px 24px',
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
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.25) 0%, rgba(212, 175, 55, 0.08) 100%)',
                border: '1px solid rgba(212, 175, 55, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Printer size={20} color="#d4af37" />
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
                Jewelry Barcode & Hangtag Studio
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-sans)',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: 'rgba(212, 175, 55, 0.15)',
                    color: '#fae084',
                    border: '1px solid rgba(212, 175, 55, 0.3)',
                  }}
                >
                  {printItemsList.length} {printItemsList.length === 1 ? 'Tag' : 'Tags'} Ready
                </span>
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                Print high-density vector barcode tags for jewelry dumbbell hangtags or price sticker sheets
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

        {/* Toolbar Controls (Screen Only) */}
        <div
          className="no-print"
          style={{
            padding: '16px 24px',
            background: 'rgba(20, 22, 30, 0.7)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '16px',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          {/* Layout Mode Selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontWeight: 600 }}>Format:</span>
            <div
              style={{
                display: 'inline-flex',
                background: 'rgba(0, 0, 0, 0.3)',
                padding: '3px',
                borderRadius: '8px',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <button
                type="button"
                onClick={() => setLayout('dumbbell')}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  border: 'none',
                  background: layout === 'dumbbell' ? 'var(--gold-500)' : 'transparent',
                  color: layout === 'dumbbell' ? '#0c0d10' : 'var(--text-muted)',
                  fontWeight: layout === 'dumbbell' ? 700 : 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Tag size={13} />
                <span>Jewelry Dumbbell Tag</span>
              </button>

              <button
                type="button"
                onClick={() => setLayout('price_sticker')}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  border: 'none',
                  background: layout === 'price_sticker' ? 'var(--gold-500)' : 'transparent',
                  color: layout === 'price_sticker' ? '#0c0d10' : 'var(--text-muted)',
                  fontWeight: layout === 'price_sticker' ? 700 : 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Sliders size={13} />
                <span>Retail Price Sticker</span>
              </button>

              <button
                type="button"
                onClick={() => setLayout('sheet_grid')}
                style={{
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  border: 'none',
                  background: layout === 'sheet_grid' ? 'var(--gold-500)' : 'transparent',
                  color: layout === 'sheet_grid' ? '#0c0d10' : 'var(--text-muted)',
                  fontWeight: layout === 'sheet_grid' ? 700 : 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Grid size={13} />
                <span>A4 Sheet Grid</span>
              </button>
            </div>
          </div>

          {/* Toggle Switches */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', color: 'var(--text-main)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showPrice}
                onChange={(e) => setShowPrice(e.target.checked)}
                style={{ accentColor: 'var(--gold-500)' }}
              />
              <span>Retail Price</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', color: 'var(--text-main)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showBarcode}
                onChange={(e) => setShowBarcode(e.target.checked)}
                style={{ accentColor: 'var(--gold-500)' }}
              />
              <span>Barcode (Code 128)</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', color: 'var(--text-main)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showTypeStone}
                onChange={(e) => setShowTypeStone(e.target.checked)}
                style={{ accentColor: 'var(--gold-500)' }}
              />
              <span>Type & Stone Badges</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', color: '#fae084', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useStockQuantity}
                onChange={(e) => setUseStockQuantity(e.target.checked)}
                style={{ accentColor: 'var(--gold-500)' }}
              />
              <span>Print {items.reduce((acc, i) => acc + i.quantity, 0)} (Match Units On-Hand)</span>
            </label>
          </div>
        </div>

        {/* Tag Preview Area */}
        <div
          className="print-area-container"
          style={{
            padding: '24px',
            overflowY: 'auto',
            flex: 1,
            background: 'rgba(8, 9, 12, 0.7)',
          }}
        >
          {items.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-dim)' }}>
              <Package size={40} style={{ opacity: 0.4, marginBottom: '10px' }} />
              <p>No items selected for tag printing.</p>
            </div>
          ) : (
            <div
              className={`tag-grid-container layout-${layout}`}
              style={{
                display: 'grid',
                gap: layout === 'dumbbell' ? '20px' : '12px',
                gridTemplateColumns:
                  layout === 'sheet_grid'
                    ? 'repeat(auto-fill, minmax(200px, 1fr))'
                    : layout === 'dumbbell'
                    ? 'repeat(auto-fill, minmax(280px, 1fr))'
                    : 'repeat(auto-fill, minmax(240px, 1fr))',
              }}
            >
              {printItemsList.map((item, idx) => {
                const typeObj = codeTables.types.find((t) => t.code === item.typeCode);
                const stoneObj = codeTables.stones.find((s) => s.code === item.stoneCode);
                const colorObj = codeTables.colors.find((c) => c.code === item.colorCode);

                const barcodeSvg = showBarcode
                  ? generateBarcodeSvg(item.sku, { height: 28, moduleWidth: 1.1, color: '#111827' })
                  : '';

                if (layout === 'dumbbell') {
                  // Jewelry Dumbbell / Fold-Over Tag style
                  return (
                    <div
                      key={`${item.id}-${idx}`}
                      className="printable-jewelry-tag tag-dumbbell"
                      style={{
                        background: '#ffffff',
                        color: '#111827',
                        borderRadius: '10px',
                        border: '1px solid #d1d5db',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                        minHeight: '130px',
                        position: 'relative',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                      }}
                    >
                      {/* Top Wing / Brand Header */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderBottom: '1px dashed #e5e7eb',
                          paddingBottom: '6px',
                          marginBottom: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span
                            style={{
                              fontFamily: 'serif',
                              fontWeight: 800,
                              fontSize: '0.78rem',
                              letterSpacing: '1px',
                              color: '#92400e',
                              textTransform: 'uppercase',
                            }}
                          >
                            SAAZ AURA
                          </span>
                          <span style={{ fontSize: '0.65rem', color: '#6b7280' }}>• ATELIER</span>
                        </div>
                        {showTypeStone && (
                          <div
                            style={{
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              background: '#f3f4f6',
                              color: '#374151',
                              padding: '1px 6px',
                              borderRadius: '4px',
                            }}
                          >
                            {item.typeCode}/{item.stoneCode}
                          </div>
                        )}
                      </div>

                      {/* Middle: Title & Barcode */}
                      <div style={{ textAlign: 'center', margin: '4px 0' }}>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: '0.82rem',
                            color: '#1f2937',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            marginBottom: '4px',
                          }}
                          title={item.title}
                        >
                          {item.title}
                        </div>

                        {showBarcode && (
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'center',
                              margin: '4px 0',
                            }}
                            dangerouslySetInnerHTML={{ __html: barcodeSvg }}
                          />
                        )}

                        <div
                          style={{
                            fontFamily: 'monospace',
                            fontWeight: 800,
                            fontSize: '0.88rem',
                            letterSpacing: '1.5px',
                            color: '#111827',
                          }}
                        >
                          {item.sku}
                        </div>
                      </div>

                      {/* Bottom Wing / Price & String Bridge */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderTop: '1px dashed #e5e7eb',
                          paddingTop: '6px',
                          marginTop: '4px',
                        }}
                      >
                        <div style={{ fontSize: '0.65rem', color: '#4b5563' }}>
                          {colorObj?.label || item.colorCode}
                        </div>
                        {showPrice && (
                          <div
                            style={{
                              fontWeight: 800,
                              fontSize: '0.95rem',
                              color: '#047857',
                            }}
                          >
                            {formatCurrency(item.sellingPrice)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                // Retail Price Sticker or A4 Sheet Grid style
                return (
                  <div
                    key={`${item.id}-${idx}`}
                    className="printable-jewelry-tag tag-price-sticker"
                    style={{
                      background: '#ffffff',
                      color: '#111827',
                      borderRadius: '8px',
                      border: '1px solid #d1d5db',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                      padding: '10px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      fontFamily: 'system-ui, -apple-system, sans-serif',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ maxWidth: '75%' }}>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: '0.8rem',
                            color: '#111827',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {item.title}
                        </div>
                        <div style={{ fontSize: '0.66rem', color: '#6b7280', marginTop: '1px' }}>
                          {typeObj?.label || item.typeCode} • {stoneObj?.label || item.stoneCode}
                        </div>
                      </div>
                      {showPrice && (
                        <div style={{ fontWeight: 800, fontSize: '0.88rem', color: '#047857' }}>
                          {formatCurrency(item.sellingPrice)}
                        </div>
                      )}
                    </div>

                    {showBarcode && (
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'center',
                          margin: '8px 0 4px 0',
                        }}
                        dangerouslySetInnerHTML={{ __html: barcodeSvg }}
                      />
                    )}

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginTop: '2px',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'monospace',
                          fontWeight: 700,
                          fontSize: '0.82rem',
                          letterSpacing: '1px',
                          color: '#111827',
                        }}
                      >
                        {item.sku}
                      </span>
                      <span style={{ fontSize: '0.62rem', color: '#9ca3af', fontWeight: 600 }}>
                        SAAZ LEDGER
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer / Actions */}
        <div
          className="no-print"
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(15, 17, 23, 0.95)',
          }}
        >
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            💡 Tip: Choose "Save as PDF" or select your thermal label printer in the print dialog.
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handlePrint}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 20px' }}
            >
              <Printer size={16} />
              <span>Print {printItemsList.length} {printItemsList.length === 1 ? 'Tag' : 'Tags'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
