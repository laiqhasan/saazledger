import React from 'react';
import type { JewelryItem } from '../types/inventory';
import type { SimilarProductMatch } from '../services/skuEngine';
import { SkuTagBadge } from './SkuTagBadge';
import { AlertTriangle, PlusCircle, Sparkles, X, Clock } from 'lucide-react';
import { formatCurrency } from '../services/skuEngine';

interface SimilarProductAlertModalProps {
  matches: SimilarProductMatch[];
  incomingQty: number;
  onRestockItem: (existingItem: JewelryItem, addedQty: number) => void;
  onProceedAsNew: () => void;
  onClose: () => void;
}

export const SimilarProductAlertModal: React.FC<SimilarProductAlertModalProps> = ({
  matches,
  incomingQty,
  onRestockItem,
  onProceedAsNew,
  onClose,
}) => {
  if (!matches || matches.length === 0) return null;

  const getBadgeColor = (type: SimilarProductMatch['matchType']) => {
    switch (type) {
      case 'visual_hash':
        return { bg: 'rgba(236, 72, 153, 0.15)', text: '#f472b6', border: 'rgba(236, 72, 153, 0.4)', label: 'Visual Photo Match' };
      case 'recent_upload':
        return { bg: 'rgba(245, 158, 11, 0.15)', text: '#fbbf24', border: 'rgba(245, 158, 11, 0.4)', label: 'Recently Uploaded' };
      case 'combo':
        return { bg: 'rgba(99, 102, 241, 0.15)', text: '#a5b4fc', border: 'rgba(99, 102, 241, 0.4)', label: 'Identical Design Combo' };
      case 'title':
        return { bg: 'rgba(16, 185, 129, 0.15)', text: '#6ee7b7', border: 'rgba(16, 185, 129, 0.4)', label: 'Matching Title' };
      default:
        return { bg: 'rgba(255, 255, 255, 0.1)', text: '#ffffff', border: 'rgba(255, 255, 255, 0.2)', label: 'Similar Item' };
    }
  };

  const formatTimeAgo = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const added = new Date(dateStr).getTime();
      const diffMin = Math.round((Date.now() - added) / 60000);
      if (diffMin < 1) return 'Just now';
      if (diffMin < 60) return `${diffMin} min${diffMin === 1 ? '' : 's'} ago`;
      const hours = Math.round(diffMin / 60);
      if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
      return new Date(dateStr).toLocaleDateString();
    } catch {
      return '';
    }
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 1200 }}>
      <div className="modal-content" style={{ maxWidth: '680px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header Banner */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.12) 0%, rgba(15, 17, 23, 0.95) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '46px',
                height: '46px',
                borderRadius: '12px',
                background: 'rgba(245, 158, 11, 0.2)',
                border: '1px solid rgba(245, 158, 11, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <AlertTriangle size={24} color="#fbbf24" />
            </div>
            <div>
              <h3
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.28rem',
                  color: '#ffffff',
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <span>Similar Product Detected in Catalog</span>
                <span
                  style={{
                    fontSize: '0.72rem',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: 'rgba(245, 158, 11, 0.25)',
                    color: '#fef08a',
                    fontWeight: 600,
                  }}
                >
                  {matches.length} Match{matches.length === 1 ? '' : 'es'}
                </span>
              </h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '4px 0 0 0', lineHeight: 1.4 }}>
                You recently uploaded a piece matching this photo or design. Check below before creating a duplicate SKU:
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

        {/* Scrollable Matches List */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {matches.map(({ item, matchType, confidence, reason }) => {
            const badge = getBadgeColor(matchType);
            const timeAgo = formatTimeAgo(item.dateAdded);

            return (
              <div
                key={item.id}
                style={{
                  padding: '16px',
                  borderRadius: '12px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(212, 175, 55, 0.3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                {/* Match Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: badge.bg,
                        color: badge.text,
                        border: `1px solid ${badge.border}`,
                      }}
                    >
                      {badge.label} &bull; {confidence}%
                    </span>
                    {timeAgo && (
                      <span style={{ fontSize: '0.74rem', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Clock size={12} />
                        {timeAgo}
                      </span>
                    )}
                  </div>

                  <span style={{ fontSize: '0.74rem', color: '#fae084', fontWeight: 600 }}>
                    In Stock: {item.quantity} units
                  </span>
                </div>

                {/* Item Details Card */}
                <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      style={{
                        width: '74px',
                        height: '74px',
                        borderRadius: '8px',
                        objectFit: 'contain',
                        background: '#ffffff',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                        padding: '2px',
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '74px',
                        height: '74px',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.05)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#6b7280',
                        fontSize: '0.72rem',
                        flexShrink: 0,
                      }}
                    >
                      No Photo
                    </div>
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                      <SkuTagBadge sku={item.sku} size="sm" />
                      <span style={{ fontWeight: 600, fontSize: '0.94rem', color: '#ffffff', wordBreak: 'break-word' }}>
                        {item.title}
                      </span>
                    </div>

                    <div style={{ fontSize: '0.78rem', color: '#d1d5db', marginBottom: '4px' }}>
                      {reason}
                    </div>

                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                      Cost: <strong>{formatCurrency(item.buyingPrice)}</strong> &bull; Retail:{' '}
                      <strong>{formatCurrency(item.sellingPrice)}</strong>
                    </div>
                  </div>
                </div>

                {/* Action for this item */}
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', paddingTop: '4px' }}>
                  <button
                    type="button"
                    onClick={() => onRestockItem(item, incomingQty)}
                    style={{
                      background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.25) 0%, rgba(212, 175, 55, 0.12) 100%)',
                      border: '1px solid rgba(212, 175, 55, 0.5)',
                      borderRadius: '8px',
                      color: '#fae084',
                      padding: '8px 14px',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <PlusCircle size={15} />
                    <span>Restock This Existing SKU (+{incomingQty} units)</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'rgba(0, 0, 0, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            If this piece is distinct (different stone, size, or colorway), continue as a new design.
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              style={{ fontSize: '0.82rem', padding: '8px 14px' }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onProceedAsNew}
              style={{
                fontSize: '0.82rem',
                padding: '8px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Sparkles size={14} />
              <span>It's a New Distinct Piece (Continue)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
