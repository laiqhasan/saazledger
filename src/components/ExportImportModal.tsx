import React, { useState, useRef } from 'react';
import type { JewelryItem, CodeTables } from '../types/inventory';
import {
  exportToShopifyCSV,
  downloadFile,
  clearInventoryPreservingCodes,
  restoreDemoData,
  parseJewelryCSV,
  saveStoredInventory,
} from '../services/storage';
import { SkuTagBadge } from './SkuTagBadge';
import { formatCurrency } from '../services/skuEngine';
import {
  X,
  FileSpreadsheet,
  Download,
  Upload,
  RotateCcw,
  AlertOctagon,
  Check,
  AlertCircle,
} from 'lucide-react';

interface ExportImportModalProps {
  items: JewelryItem[];
  codeTables: CodeTables;
  onRefreshData: () => void;
  onClose: () => void;
}

export const ExportImportModal: React.FC<ExportImportModalProps> = ({
  items,
  codeTables,
  onRefreshData,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'export' | 'csv_import' | 'backup_reset'>('export');
  const [confirmClear, setConfirmClear] = useState(false);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  // CSV Import State
  const [csvPreviewItems, setCsvPreviewItems] = useState<JewelryItem[] | null>(null);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);

  const jsonFileInputRef = useRef<HTMLInputElement>(null);
  const csvFileInputRef = useRef<HTMLInputElement>(null);

  const handleExportShopify = () => {
    const csvContent = exportToShopifyCSV(items);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(csvContent, `saaz_ledger_shopify_export_${dateStr}.csv`, 'text/csv');
    setSuccessNotice('Shopify-compatible CSV downloaded successfully!');
  };

  const handleExportJsonBackup = () => {
    const backupData = {
      exportedAt: new Date().toISOString(),
      inventory: items,
      codeTables,
    };
    const jsonStr = JSON.stringify(backupData, null, 2);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(jsonStr, `saaz_ledger_full_backup_${dateStr}.json`, 'application/json');
    setSuccessNotice('Complete JSON Ledger backup downloaded!');
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const parsed = JSON.parse(content);

        if (Array.isArray(parsed.inventory)) {
          localStorage.setItem('saaz_ledger_inventory_v1', JSON.stringify(parsed.inventory));
        }
        if (parsed.codeTables && typeof parsed.codeTables === 'object') {
          localStorage.setItem('saaz_ledger_codes_v1', JSON.stringify(parsed.codeTables));
        }

        onRefreshData();
        setSuccessNotice('Backup imported and ledger restored!');
      } catch (err) {
        alert('Invalid JSON backup file format.');
      }
    };
    reader.readAsText(file);
  };

  const handleSelectCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const result = parseJewelryCSV(text, codeTables, items);
        setCsvPreviewItems(result.validItems);
        setCsvErrors(result.errors);
      } catch (err) {
        setCsvErrors(['Failed parsing CSV file: ' + String(err)]);
      }
    };
    reader.readAsText(file);
  };

  const handleCommitCsvImport = () => {
    if (!csvPreviewItems || csvPreviewItems.length === 0) return;
    const merged = [...csvPreviewItems, ...items];
    saveStoredInventory(merged);
    onRefreshData();
    setSuccessNotice(`Successfully imported ${csvPreviewItems.length} pieces into inventory!`);
    setCsvPreviewItems(null);
    setCsvFileName(null);
  };

  const handleExecuteClear = () => {
    clearInventoryPreservingCodes();
    onRefreshData();
    setConfirmClear(false);
    setSuccessNotice('Inventory cleared. Code schemes remain 100% intact.');
  };

  const handleRestoreDemo = () => {
    restoreDemoData();
    onRefreshData();
    setSuccessNotice('Starter demo jewelry items loaded!');
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '720px' }}>
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                background: 'rgba(59, 130, 246, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Download size={18} color="#60a5fa" />
            </div>
            <div>
              <h2
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.25rem',
                  color: '#ffffff',
                  margin: 0,
                }}
              >
                Data Hub: CSV Import, Shopify & Backups
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                Bulk CSV ingest, Shopify product sync, and database backups
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
              padding: '4px',
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
            background: 'rgba(0, 0, 0, 0.2)',
            padding: '0 24px',
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('export')}
            style={{
              padding: '12px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'export' ? '2px solid var(--gold-500)' : '2px solid transparent',
              color: activeTab === 'export' ? '#fae084' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Export & Integrations
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('csv_import')}
            style={{
              padding: '12px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'csv_import' ? '2px solid var(--gold-500)' : '2px solid transparent',
              color: activeTab === 'csv_import' ? '#fae084' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Bulk CSV Ingest
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('backup_reset')}
            style={{
              padding: '12px 16px',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'backup_reset' ? '2px solid var(--gold-500)' : '2px solid transparent',
              color: activeTab === 'backup_reset' ? '#fae084' : 'var(--text-muted)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Backups & Reset
          </button>
        </div>

        <div style={{ padding: '24px' }}>
          {successNotice && (
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
              <Check size={16} />
              <span>{successNotice}</span>
            </div>
          )}

          {/* TAB 1: EXPORT */}
          {activeTab === 'export' && (
            <div>
              <div
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: '#fae084',
                  textTransform: 'uppercase',
                  marginBottom: '12px',
                }}
              >
                Export Inventory
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleExportShopify}
                  style={{
                    padding: '16px',
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    height: 'auto',
                  }}
                >
                  <FileSpreadsheet size={24} color="#10b981" style={{ flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#ffffff' }}>
                      Shopify CSV Export
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                      Standard Shopify products & variant SKU import format
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleExportJsonBackup}
                  style={{
                    padding: '16px',
                    justifyContent: 'flex-start',
                    textAlign: 'left',
                    height: 'auto',
                  }}
                >
                  <Download size={24} color="#60a5fa" style={{ flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#ffffff' }}>
                      Full JSON Backup
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                      All stock items + customized code tables
                    </div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: BULK CSV INGEST */}
          {activeTab === 'csv_import' && (
            <div>
              <div style={{ marginBottom: '16px' }}>
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.95rem' }}>
                  Bulk Import Jewelry via CSV
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                  Upload Excel CSV or vendor manifest. Auto-maps Title, Type, Stone, Color, Cost, Retail, and assigns next sequential serial numbers.
                </p>
              </div>

              {/* Upload Drop Zone */}
              <div
                onClick={() => csvFileInputRef.current?.click()}
                style={{
                  border: '2px dashed var(--border-subtle)',
                  borderRadius: '10px',
                  padding: '24px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: 'rgba(255, 255, 255, 0.02)',
                  marginBottom: '16px',
                  transition: 'border-color 0.2s',
                }}
              >
                <Upload size={32} color="#d4af37" style={{ marginBottom: '8px' }} />
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.9rem' }}>
                  {csvFileName ? `Selected: ${csvFileName}` : 'Click to browse or drop CSV file'}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                  Accepts .csv with headers: Title, Type, Stone, Color, Cost, Retail, Quantity
                </div>
                <input
                  type="file"
                  ref={csvFileInputRef}
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={handleSelectCsvFile}
                />
              </div>

              {/* Warnings / Errors */}
              {csvErrors.length > 0 && (
                <div
                  style={{
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    color: '#f59e0b',
                    fontSize: '0.78rem',
                    marginBottom: '16px',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AlertCircle size={14} />
                    <span>CSV Notices / Skipped Rows:</span>
                  </div>
                  {csvErrors.map((err, i) => (
                    <div key={i}>• {err}</div>
                  ))}
                </div>
              )}

              {/* Preview Table */}
              {csvPreviewItems && csvPreviewItems.length > 0 && (
                <div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: '10px',
                    }}
                  >
                    <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#34d399' }}>
                      Ready to Import: {csvPreviewItems.length} Valid Items
                    </span>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleCommitCsvImport}
                      style={{ padding: '6px 14px', fontSize: '0.82rem' }}
                    >
                      Confirm & Ingest Items
                    </button>
                  </div>

                  <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: '8px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                      <thead style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-dim)' }}>
                        <tr>
                          <th style={{ padding: '8px 10px' }}>Generated SKU</th>
                          <th style={{ padding: '8px 10px' }}>Title</th>
                          <th style={{ padding: '8px 10px' }}>Type/Codes</th>
                          <th style={{ padding: '8px 10px' }}>Units</th>
                          <th style={{ padding: '8px 10px' }}>Cost</th>
                          <th style={{ padding: '8px 10px' }}>Retail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {csvPreviewItems.map((item, idx) => (
                          <tr key={idx} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                            <td style={{ padding: '8px 10px' }}>
                              <SkuTagBadge sku={item.sku} size="sm" />
                            </td>
                            <td style={{ padding: '8px 10px', fontWeight: 600, color: '#ffffff' }}>
                              {item.title}
                            </td>
                            <td style={{ padding: '8px 10px', color: 'var(--text-dim)' }}>
                              {item.typeCode}/{item.stoneCode}/{item.colorCode}
                            </td>
                            <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)' }}>
                              {item.quantity}
                            </td>
                            <td style={{ padding: '8px 10px', color: 'var(--text-dim)' }}>
                              {formatCurrency(item.buyingPrice)}
                            </td>
                            <td style={{ padding: '8px 10px', color: '#34d399', fontWeight: 600 }}>
                              {formatCurrency(item.sellingPrice)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: BACKUP & RESET */}
          {activeTab === 'backup_reset' && (
            <div>
              {/* Restore JSON Backup */}
              <div style={{ marginBottom: '24px' }}>
                <div
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    color: '#fae084',
                    textTransform: 'uppercase',
                    marginBottom: '12px',
                  }}
                >
                  Restore JSON Backup
                </div>

                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => jsonFileInputRef.current?.click()}
                    style={{ padding: '10px 16px' }}
                  >
                    <Upload size={16} />
                    <span>Upload JSON Backup File</span>
                  </button>
                  <input
                    type="file"
                    ref={jsonFileInputRef}
                    accept=".json"
                    style={{ display: 'none' }}
                    onChange={handleImportJson}
                  />

                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleRestoreDemo}
                    style={{ padding: '10px 16px' }}
                    title="Reload the 6 starter jewelry pieces"
                  >
                    <RotateCcw size={16} />
                    <span>Reload Demo Items</span>
                  </button>
                </div>
              </div>

              {/* Reset Inventory (Scheme Preservation) */}
              <div
                style={{
                  padding: '16px',
                  borderRadius: '10px',
                  background: 'rgba(244, 63, 94, 0.05)',
                  border: '1px solid rgba(244, 63, 94, 0.25)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <AlertOctagon size={22} color="#f43f5e" style={{ flexShrink: 0, marginTop: '2px' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, color: '#f43f5e', fontSize: '0.92rem' }}>
                      Clear Stock Inventory (Zero Stock Start)
                    </div>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '4px 0 10px 0' }}>
                      Wipes all inventory records back to 0 stock items. Your customized code tables
                      (Types, Stones, Colors) are kept completely separate and will <strong>survive</strong> this wipe intact.
                    </p>

                    {confirmClear ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={handleExecuteClear}
                          style={{ padding: '6px 12px', fontSize: '0.82rem' }}
                        >
                          Yes, Wipe All Stock Items
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setConfirmClear(false)}
                          style={{ padding: '6px 12px', fontSize: '0.82rem' }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmClear(true)}
                        style={{
                          background: 'none',
                          border: '1px solid rgba(244, 63, 94, 0.3)',
                          color: '#f87171',
                          padding: '5px 12px',
                          borderRadius: '6px',
                          fontSize: '0.8rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Clear Inventory...
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
