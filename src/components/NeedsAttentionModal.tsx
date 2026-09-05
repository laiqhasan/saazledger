import React, { useState, useEffect } from 'react';
import {
  X,
  AlertTriangle,
  CheckCircle2,
  Filter,
  RefreshCw,
  ShoppingBag,
  Package,
  Key,
  Image as ImageIcon,
  Check,
  Truck,
} from 'lucide-react';
import { fetchNeedsAttention, resolveNeedsAttention } from '../services/apiService';

interface NeedsAttentionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NeedsAttentionModal: React.FC<NeedsAttentionModalProps> = ({ isOpen, onClose }) => {
  const [items, setItems] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const loadItems = async () => {
    setIsLoading(true);
    try {
      const data = await fetchNeedsAttention(selectedCategory !== 'all' ? selectedCategory : undefined);
      setItems(data);
    } catch (err) {
      console.warn('Failed loading needs attention items:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadItems();
    }
  }, [isOpen, selectedCategory]);

  if (!isOpen) return null;

  const handleResolve = async (id: string) => {
    setResolvingId(id);
    try {
      const success = await resolveNeedsAttention(id);
      if (success) {
        setItems((prev) => prev.filter((it) => it.id !== id));
      }
    } finally {
      setResolvingId(null);
    }
  };

  const criticalCount = items.filter((it) => it.severity === 'critical').length;

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '960px',
          height: '85vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          background: 'var(--bg-card)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--bg-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: criticalCount > 0 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: criticalCount > 0 ? '#ef4444' : '#f59e0b',
              }}
            >
              <AlertTriangle size={22} />
            </div>
            <div>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Operational Exception Desk (Needs Attention)
              </h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                Automated error tracking for orders, inventory sync, SKU conflicts, and unverified claims
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={loadItems}
              disabled={isLoading}
              style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer' }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div
          style={{
            padding: '12px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Filter size={14} color="var(--text-dim)" />
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Filter Category:</span>
            <select
              className="input-field"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              style={{ height: '32px', fontSize: '0.8rem', width: 'auto', padding: '0 10px' }}
            >
              <option value="all">All Exceptions</option>
              <option value="order">Orders & Line Item Matching</option>
              <option value="inventory">Inventory & Stock Sync</option>
              <option value="sku">SKU Conflicts</option>
              <option value="media">Media Ingestion & Backup</option>
              <option value="attribute">Unverified AI Attributes</option>
              <option value="supplier">Supplier & Overdue POs</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem' }}>
            <span style={{ color: 'var(--text-dim)' }}>Active Issues:</span>
            <span style={{ fontWeight: 700, color: items.length > 0 ? '#f59e0b' : '#10b981' }}>{items.length}</span>
            {criticalCount > 0 && (
              <span style={{ color: '#ef4444', fontWeight: 600, background: 'rgba(239, 68, 68, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>
                {criticalCount} Critical
              </span>
            )}
          </div>
        </div>

        {/* Issues List Area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--text-dim)',
                gap: '12px',
              }}
            >
              <CheckCircle2 size={48} color="#10b981" />
              <div style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                All Systems Operational
              </div>
              <p style={{ fontSize: '0.85rem', maxWidth: '420px', textAlign: 'center', margin: 0 }}>
                No unmatched orders, inventory discrepancies, or unverified attribute exceptions detected in the atelier.
              </p>
            </div>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: `1px solid ${it.severity === 'critical' ? 'rgba(239, 68, 68, 0.4)' : 'var(--border-subtle)'}`,
                  borderRadius: '10px',
                  padding: '16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: '16px',
                }}
              >
                <div style={{ display: 'flex', gap: '12px' }}>
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: it.severity === 'critical' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: it.severity === 'critical' ? '#ef4444' : '#f59e0b',
                      flexShrink: 0,
                    }}
                  >
                    {it.category === 'order' && <ShoppingBag size={16} />}
                    {it.category === 'inventory' && <Package size={16} />}
                    {it.category === 'sku' && <Key size={16} />}
                    {it.category === 'media' && <ImageIcon size={16} />}
                    {it.category === 'supplier' && <Truck size={16} />}
                    {!['order', 'inventory', 'sku', 'media', 'supplier'].includes(it.category) && <AlertTriangle size={16} />}
                  </div>

                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span
                        style={{
                          fontSize: '0.68rem',
                          textTransform: 'uppercase',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: it.severity === 'critical' ? '#ef4444' : '#f59e0b',
                          color: '#000',
                        }}
                      >
                        {it.severity}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                        Category: {it.category}
                      </span>
                      {it.reference_id && (
                        <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--gold)' }}>
                          [{it.reference_id}]
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
                      {it.title}
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                      {it.message}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className="btn-secondary"
                  disabled={resolvingId === it.id}
                  onClick={() => handleResolve(it.id)}
                  style={{
                    padding: '6px 12px',
                    fontSize: '0.78rem',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <Check size={13} />
                  <span>Mark Resolved</span>
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'flex-end',
            background: 'var(--bg-surface)',
          }}
        >
          <button type="button" className="btn-secondary" onClick={onClose} style={{ padding: '8px 18px', fontSize: '0.85rem' }}>
            Close Exception Desk
          </button>
        </div>
      </div>
    </div>
  );
};
