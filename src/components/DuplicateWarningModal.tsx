import React from 'react';
import type { JewelryItem } from '../types/inventory';
import { SkuTagBadge } from './SkuTagBadge';
import { AlertCircle, PlusCircle, Sparkles, X } from 'lucide-react';
import { formatCurrency } from '../services/skuEngine';

interface DuplicateWarningModalProps {
  conflictingItem: JewelryItem;
  suggestedSerial: string;
  suggestedSku: string;
  incomingQty: number;
  onAddQuantityToExisting: (existingItem: JewelryItem, addedQty: number) => void;
  onProceedAsNewVariation: (newSerial: string, newSku: string) => void;
  onCancel: () => void;
}

export const DuplicateWarningModal: React.FC<DuplicateWarningModalProps> = ({
  conflictingItem,
  suggestedSerial,
  suggestedSku,
  incomingQty,
  onAddQuantityToExisting,
  onProceedAsNewVariation,
  onCancel,
}) => {
  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '560px' }}>
        <div
          style={{
            padding: '24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '10px',
                background: 'rgba(245, 158, 11, 0.15)',
                border: '1px solid rgba(245, 158, 11, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <AlertCircle size={22} color="#fbbf24" />
            </div>
            <div>
              <h3
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.25rem',
                  color: '#ffffff',
                  margin: 0,
                }}
              >
                Similar Design Combo Detected
              </h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                Stock already exists with this Type, Stone, and Color code combination.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
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

        <div style={{ padding: '24px' }}>
          {/* Conflicting Existing Item Card */}
          <div
            style={{
              padding: '16px',
              borderRadius: '12px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(212, 175, 55, 0.25)',
              marginBottom: '20px',
            }}
          >
            <div style={{ fontSize: '0.75rem', color: '#fae084', fontWeight: 600, textTransform: 'uppercase', marginBottom: '8px' }}>
              Existing Item in Catalog
            </div>
            <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
              {conflictingItem.imageUrl && (
                <img
                  src={conflictingItem.imageUrl}
                  alt={conflictingItem.title}
                  style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '8px',
                    objectFit: 'cover',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                  }}
                />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                  <SkuTagBadge sku={conflictingItem.sku} size="sm" />
                  <span style={{ fontWeight: 600, fontSize: '0.95rem', color: '#ffffff' }}>
                    {conflictingItem.title}
                  </span>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Current Stock: <strong>{conflictingItem.quantity} units</strong> • Retail:{' '}
                  <strong>{formatCurrency(conflictingItem.sellingPrice)}</strong>
                </div>
              </div>
            </div>
          </div>

          <p style={{ fontSize: '0.9rem', color: 'var(--text-main)', marginBottom: '20px', lineHeight: 1.6 }}>
            Is this incoming inventory a <strong>restock batch of the same piece</strong>, or a{' '}
            <strong>completely new design variation</strong>?
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Action Option A: Add quantity to existing */}
            <button
              type="button"
              onClick={() => onAddQuantityToExisting(conflictingItem, incomingQty)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 18px',
                background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.15) 0%, rgba(212, 175, 55, 0.05) 100%)',
                border: '1px solid rgba(212, 175, 55, 0.4)',
                borderRadius: '10px',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = '#d4af37';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(212, 175, 55, 0.4)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <PlusCircle size={20} color="#fae084" />
                <div>
                  <div style={{ fontWeight: 600, color: '#fae084', fontSize: '0.92rem' }}>
                    Restock Existing SKU ({conflictingItem.sku})
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    Add +{incomingQty} units to current stock (new total:{' '}
                    {conflictingItem.quantity + incomingQty} units).
                  </div>
                </div>
              </div>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#fae084', background: 'rgba(212, 175, 55, 0.2)', padding: '4px 8px', borderRadius: '4px' }}>
                Recommended
              </span>
            </button>

            {/* Action Option B: Proceed as new variation with next serial */}
            <button
              type="button"
              onClick={() => onProceedAsNewVariation(suggestedSerial, suggestedSku)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '14px 18px',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '10px',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
              }}
            >
              <Sparkles size={20} color="#60a5fa" />
              <div>
                <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.92rem' }}>
                  Create as New Design Variation (SKU: {suggestedSku})
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  Distinct jewelry design with sequential serial #{suggestedSerial}.
                </div>
              </div>
            </button>
          </div>
        </div>

        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel & Back to Form
          </button>
        </div>
      </div>
    </div>
  );
};
