import React, { useState } from 'react';
import { Trash2, AlertTriangle, ShieldCheck, X, ArchiveRestore } from 'lucide-react';
import type { JewelryItem } from '../types/inventory';

interface DeleteConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  // If single item:
  item?: JewelryItem;
  // If bulk items:
  items?: JewelryItem[];
  // Actions:
  onSoftDelete: (ids: string[], reason?: string) => void;
  onHardDelete: (ids: string[]) => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  onClose,
  item,
  items,
  onSoftDelete,
  onHardDelete,
}) => {
  const [reason, setReason] = useState('');
  const [showHardConfirm, setShowHardConfirm] = useState(false);
  const [hardConfirmText, setHardConfirmText] = useState('');

  if (!isOpen) return null;

  const targetItems: JewelryItem[] = items && items.length > 0 ? items : item ? [item] : [];
  const isBulk = targetItems.length > 1;
  const targetIds = targetItems.map((i) => i.id);

  const handleSoft = () => {
    onSoftDelete(targetIds, reason.trim() || undefined);
    onClose();
  };

  const handleHard = () => {
    onHardDelete(targetIds);
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px',
      }}
    >
      <div
        style={{
          background: 'linear-gradient(145deg, #161922 0%, #0d0f15 100%)',
          border: '1px solid rgba(212, 175, 55, 0.25)',
          borderRadius: '16px',
          width: '100%',
          maxWidth: '540px',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.6), 0 0 25px rgba(212, 175, 55, 0.12)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'rgba(245, 158, 11, 0.15)',
                border: '1px solid rgba(245, 158, 11, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fbbf24',
              }}
            >
              <Trash2 size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                {isBulk ? `Delete ${targetItems.length} Selected Pieces` : 'Delete Inventory Piece'}
              </h3>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Choose safe Soft Delete or permanent removal
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: '6px',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* Item Preview */}
          {!isBulk && targetItems[0] && (
            <div
              style={{
                display: 'flex',
                gap: '14px',
                padding: '12px',
                borderRadius: '10px',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                alignItems: 'center',
              }}
            >
              {targetItems[0].imageUrl ? (
                <img
                  src={targetItems[0].imageUrl}
                  alt={targetItems[0].title}
                  style={{ width: '52px', height: '52px', borderRadius: '8px', objectFit: 'cover' }}
                />
              ) : (
                <div
                  style={{
                    width: '52px',
                    height: '52px',
                    borderRadius: '8px',
                    background: 'rgba(212, 175, 55, 0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#d4af37',
                    fontWeight: 600,
                    fontSize: '0.8rem',
                  }}
                >
                  {targetItems[0].typeCode}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontWeight: 700, color: '#fae084', fontSize: '0.88rem' }}>
                    {targetItems[0].sku}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    • Stock: {targetItems[0].quantity} pcs
                  </span>
                </div>
                <div
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    marginTop: '2px',
                  }}
                >
                  {targetItems[0].title}
                </div>
              </div>
            </div>
          )}

          {/* Bulk Summary */}
          {isBulk && (
            <div
              style={{
                padding: '12px 16px',
                borderRadius: '10px',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                fontSize: '0.85rem',
                color: 'var(--text-muted)',
              }}
            >
              You are about to delete <strong style={{ color: '#fae084' }}>{targetItems.length} pieces</strong> (Total{' '}
              {targetItems.reduce((acc, i) => acc + (i.quantity || 0), 0)} stock units).
            </div>
          )}

          {/* Option 1: Soft Delete (Recommended) */}
          <div
            style={{
              padding: '16px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(212, 175, 55, 0.06) 100%)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <ShieldCheck size={20} color="#34d399" style={{ marginTop: '2px', flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600, color: '#34d399', fontSize: '0.92rem' }}>
                  Option A: Move to Trash (Soft Delete — Recommended)
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>
                  Safely removes the piece from active inventory, valuation, and sales channels, while preserving all data,
                  photos, and SKU history in the <strong>Trash Bin</strong>. You can restore it anytime with one click!
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Optional reason (e.g. Broken sample, duplicated entry)..."
                style={{
                  flex: 1,
                  padding: '7px 10px',
                  borderRadius: '6px',
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: 'var(--text-primary)',
                  fontSize: '0.8rem',
                }}
              />
              <button
                type="button"
                onClick={handleSoft}
                style={{
                  padding: '7px 16px',
                  borderRadius: '6px',
                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  border: 'none',
                  color: '#ffffff',
                  fontWeight: 600,
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 4px 12px rgba(16, 185, 129, 0.25)',
                  whiteSpace: 'nowrap',
                }}
              >
                <ArchiveRestore size={14} />
                Move to Trash
              </button>
            </div>
          </div>

          {/* Option 2: Hard Delete (Danger Zone) */}
          <div
            style={{
              padding: '16px',
              borderRadius: '12px',
              background: 'rgba(239, 68, 68, 0.05)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <AlertTriangle size={20} color="#f87171" style={{ marginTop: '2px', flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600, color: '#f87171', fontSize: '0.92rem' }}>
                  Option B: Permanently Delete (Hard Delete — Irreversible)
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>
                  Permanently deletes the piece from the SQLite database and storage. This cannot be undone.
                </div>
              </div>
            </div>

            {!showHardConfirm ? (
              <button
                type="button"
                onClick={() => setShowHardConfirm(true)}
                style={{
                  alignSelf: 'flex-start',
                  padding: '6px 14px',
                  borderRadius: '6px',
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#f87171',
                  fontWeight: 600,
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                Show Permanent Delete Option
              </button>
            ) : (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px',
                  background: 'rgba(0, 0, 0, 0.5)',
                  borderRadius: '8px',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                }}
              >
                <span style={{ fontSize: '0.78rem', color: '#fca5a5' }}>
                  Type <strong style={{ color: '#ffffff' }}>DELETE</strong> to confirm:
                </span>
                <input
                  type="text"
                  value={hardConfirmText}
                  onChange={(e) => setHardConfirmText(e.target.value.toUpperCase())}
                  placeholder="DELETE"
                  style={{
                    width: '80px',
                    padding: '5px 8px',
                    borderRadius: '4px',
                    background: '#111',
                    border: '1px solid #ef4444',
                    color: '#ffffff',
                    fontSize: '0.78rem',
                    textAlign: 'center',
                    fontWeight: 700,
                  }}
                />
                <button
                  type="button"
                  disabled={hardConfirmText !== 'DELETE'}
                  onClick={handleHard}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '6px',
                    background: hardConfirmText === 'DELETE' ? '#dc2626' : 'rgba(239, 68, 68, 0.2)',
                    border: 'none',
                    color: hardConfirmText === 'DELETE' ? '#ffffff' : '#fca5a5',
                    fontWeight: 600,
                    fontSize: '0.8rem',
                    cursor: hardConfirmText === 'DELETE' ? 'pointer' : 'not-allowed',
                  }}
                >
                  Confirm Hard Delete
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '10px',
            background: 'rgba(0, 0, 0, 0.2)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: 'var(--text-muted)',
              fontSize: '0.82rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
