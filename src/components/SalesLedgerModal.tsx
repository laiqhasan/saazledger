import React, { useState, useMemo } from 'react';
import type { StockMovement } from '../types/inventory';
import { SkuTagBadge } from './SkuTagBadge';
import { formatCurrency } from '../services/skuEngine';
import { downloadFile } from '../services/storage';
import {
  X,
  BookOpen,
  ArrowDownRight,
  ArrowUpRight,
  Search,
  Download,
  Layers,
} from 'lucide-react';

interface SalesLedgerModalProps {
  transactions: StockMovement[];
  onClose: () => void;
}

export const SalesLedgerModal: React.FC<SalesLedgerModalProps> = ({
  transactions,
  onClose,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'sale' | 'restock' | 'adjustment'>('all');

  // KPI Calculations
  const stats = useMemo(() => {
    let totalRevenue = 0;
    let totalProfit = 0;
    let unitsSold = 0;
    let totalSalesCount = 0;

    for (const t of transactions) {
      if (t.type === 'sale') {
        totalRevenue += t.totalPrice;
        totalProfit += t.realizedProfit;
        unitsSold += Math.abs(t.quantityDelta);
        totalSalesCount++;
      }
    }

    return {
      totalRevenue,
      totalProfit,
      unitsSold,
      totalSalesCount,
    };
  }, [transactions]);

  // Filtered transactions
  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      if (filterType !== 'all' && t.type !== filterType) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchSku = t.sku.toLowerCase().includes(q);
        const matchTitle = t.itemTitle.toLowerCase().includes(q);
        const matchNotes = (t.notes || '').toLowerCase().includes(q);
        const matchChannel = (t.channel || '').toLowerCase().includes(q);
        if (!matchSku && !matchTitle && !matchNotes && !matchChannel) return false;
      }
      return true;
    });
  }, [transactions, filterType, searchQuery]);

  const handleExportCSV = () => {
    const headers = [
      'Transaction ID',
      'Date & Time',
      'Type',
      'SKU',
      'Item Title',
      'Quantity Delta',
      'Unit Price',
      'Total Amount',
      'Cost Price',
      'Realized Profit',
      'Channel',
      'Notes',
    ];

    const rows = transactions.map((t) => [
      `"${t.id}"`,
      `"${t.timestamp}"`,
      `"${t.type.toUpperCase()}"`,
      `"${t.sku}"`,
      `"${t.itemTitle.replace(/"/g, '""')}"`,
      t.quantityDelta,
      t.unitPrice,
      t.totalPrice,
      t.costPrice,
      t.realizedProfit,
      `"${(t.channel || '').replace(/"/g, '""')}"`,
      `"${(t.notes || '').replace(/"/g, '""')}"`,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(csvContent, `saaz_ledger_sales_transactions_${dateStr}.csv`, 'text/csv');
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '880px', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
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
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(212, 175, 55, 0.15) 100%)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <BookOpen size={20} color="#34d399" />
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
                Sales & Stock Movement Ledger
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-sans)',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                  }}
                >
                  {transactions.length} Records
                </span>
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                Full audit trail of sales transactions, restocks, realized profit & margin realizations
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

        {/* Realized Profit KPI Bar */}
        <div
          style={{
            padding: '16px 24px',
            background: 'rgba(20, 22, 30, 0.8)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '16px',
          }}
        >
          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
              Realized Cash Profit
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#34d399', marginTop: '2px' }}>
              {formatCurrency(stats.totalProfit)}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
              Total Sales Volume
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#ffffff', marginTop: '2px' }}>
              {formatCurrency(stats.totalRevenue)}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
              Units Sold
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#fae084', marginTop: '2px' }}>
              {stats.unitsSold} pcs
            </div>
          </div>

          <div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
              Transactions Logged
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#60a5fa', marginTop: '2px' }}>
              {stats.totalSalesCount}
            </div>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div
          style={{
            padding: '14px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1', maxWidth: '340px' }}>
            <div style={{ position: 'relative', width: '100%' }}>
              <Search
                size={16}
                color="var(--text-dim)"
                style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
              />
              <input
                type="text"
                placeholder="Search SKU, piece, customer, channel..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input-field"
                style={{ paddingLeft: '32px', fontSize: '0.82rem', padding: '6px 10px 6px 32px' }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '6px' }}>
              {(['all', 'sale', 'restock'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setFilterType(type)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '6px',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    border: '1px solid',
                    borderColor: filterType === type ? 'var(--gold-500)' : 'var(--border-subtle)',
                    background: filterType === type ? 'rgba(212, 175, 55, 0.2)' : 'rgba(255, 255, 255, 0.03)',
                    color: filterType === type ? '#fae084' : 'var(--text-muted)',
                    cursor: 'pointer',
                    textTransform: 'capitalize',
                  }}
                >
                  {type === 'all' ? 'All Activities' : type === 'sale' ? 'Sales Only' : 'Restocks'}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn-secondary"
              onClick={handleExportCSV}
              disabled={transactions.length === 0}
              style={{ padding: '5px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Download size={14} />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Transaction Table / List */}
        <div style={{ padding: '0 24px', overflowY: 'auto', flex: 1 }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-dim)' }}>
              <Layers size={36} style={{ opacity: 0.3, marginBottom: '8px' }} />
              <p style={{ margin: 0, fontSize: '0.9rem' }}>No transaction history found.</p>
              <span style={{ fontSize: '0.76rem' }}>
                Sales and inventory adjustments will automatically appear here.
              </span>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    color: 'var(--text-dim)',
                    fontSize: '0.72rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  <th style={{ padding: '12px 10px' }}>Date & Time</th>
                  <th style={{ padding: '12px 10px' }}>Type</th>
                  <th style={{ padding: '12px 10px' }}>Item & SKU</th>
                  <th style={{ padding: '12px 10px' }}>Units</th>
                  <th style={{ padding: '12px 10px' }}>Sale Price</th>
                  <th style={{ padding: '12px 10px' }}>Realized Profit</th>
                  <th style={{ padding: '12px 10px' }}>Channel / Note</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const isSale = t.type === 'sale';
                  const dateFormatted = new Date(t.timestamp).toLocaleDateString('en-IN', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  });

                  return (
                    <tr
                      key={t.id}
                      style={{
                        borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                        transition: 'background-color 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      {/* Date */}
                      <td style={{ padding: '12px 10px', color: 'var(--text-dim)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                        {dateFormatted}
                      </td>

                      {/* Type */}
                      <td style={{ padding: '12px 10px' }}>
                        {isSale ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              background: 'rgba(16, 185, 129, 0.15)',
                              color: '#34d399',
                              border: '1px solid rgba(16, 185, 129, 0.3)',
                            }}
                          >
                            <ArrowUpRight size={12} />
                            SALE
                          </span>
                        ) : (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              background: 'rgba(59, 130, 246, 0.15)',
                              color: '#60a5fa',
                              border: '1px solid rgba(59, 130, 246, 0.3)',
                            }}
                          >
                            <ArrowDownRight size={12} />
                            RESTOCK
                          </span>
                        )}
                      </td>

                      {/* Piece & SKU */}
                      <td style={{ padding: '12px 10px' }}>
                        <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.85rem' }}>{t.itemTitle}</div>
                        <div style={{ marginTop: '2px' }}>
                          <SkuTagBadge sku={t.sku} size="sm" />
                        </div>
                      </td>

                      {/* Units */}
                      <td style={{ padding: '12px 10px', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                        <span style={{ color: isSale ? '#f43f5e' : '#34d399' }}>
                          {isSale ? '-' : '+'}{Math.abs(t.quantityDelta)} pcs
                        </span>
                      </td>

                      {/* Sale Value */}
                      <td style={{ padding: '12px 10px', fontWeight: 600, color: '#ffffff' }}>
                        {formatCurrency(t.totalPrice)}
                      </td>

                      {/* Profit */}
                      <td style={{ padding: '12px 10px' }}>
                        {isSale ? (
                          <span style={{ fontWeight: 700, color: '#34d399' }}>
                            +{formatCurrency(t.realizedProfit)}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-dim)' }}>—</span>
                        )}
                      </td>

                      {/* Channel & Note */}
                      <td style={{ padding: '12px 10px' }}>
                        {t.channel && (
                          <div
                            style={{
                              fontSize: '0.7rem',
                              color: '#fae084',
                              fontWeight: 600,
                              marginBottom: '2px',
                            }}
                          >
                            {t.channel}
                          </div>
                        )}
                        {t.notes && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                            {t.notes}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'flex-end',
            background: 'rgba(15, 17, 23, 0.95)',
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
