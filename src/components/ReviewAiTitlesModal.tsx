import React, { useState, useMemo } from 'react';
import type { JewelryItem } from '../types/inventory';
import { auditAndCleanTitle } from '../services/titleGenerationService';
import {
  X,
  Sparkles,
  Check,
  Edit3,
  ShieldCheck,
  ArrowRight,
  AlertCircle,
  Lock,
  Search,
} from 'lucide-react';

interface ReviewAiTitlesModalProps {
  inventory: JewelryItem[];
  onUpdateItem: (updatedItem: JewelryItem) => void;
  onClose: () => void;
}

interface ItemReviewState {
  item: JewelryItem;
  currentTitle: string;
  suggestedTitle: string;
  changes: string[];
  isEditing: boolean;
  editedTitle: string;
  status: 'pending' | 'accepted' | 'kept';
}

export const ReviewAiTitlesModal: React.FC<ReviewAiTitlesModalProps> = ({
  inventory,
  onUpdateItem,
  onClose,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  // Analyze all unlocked catalogue items for title improvements
  const [reviewItems, setReviewItems] = useState<ItemReviewState[]>(() => {
    const itemsWithFixes: ItemReviewState[] = [];

    for (const item of inventory) {
      if (item.isTitleLocked) continue;

      const audit = auditAndCleanTitle(item.title);
      if (audit.hasImprovements) {
        itemsWithFixes.push({
          item,
          currentTitle: item.title,
          suggestedTitle: audit.suggestedTitle,
          changes: audit.changes,
          isEditing: false,
          editedTitle: audit.suggestedTitle,
          status: 'pending',
        });
      }
    }

    return itemsWithFixes;
  });

  const pendingCount = useMemo(
    () => reviewItems.filter((r) => r.status === 'pending').length,
    [reviewItems]
  );

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return reviewItems;
    const q = searchQuery.toLowerCase();
    return reviewItems.filter(
      (r) =>
        r.item.sku.toLowerCase().includes(q) ||
        r.currentTitle.toLowerCase().includes(q) ||
        r.suggestedTitle.toLowerCase().includes(q)
    );
  }, [reviewItems, searchQuery]);

  // Handle Accept
  const handleAccept = (index: number) => {
    const target = reviewItems[index];
    if (!target) return;

    const titleToSave = target.isEditing ? target.editedTitle.trim() : target.suggestedTitle;
    if (!titleToSave) return;

    const updatedItem: JewelryItem = {
      ...target.item,
      title: titleToSave,
      titleSource: 'AI Generated',
      // Permanent SKU is strictly preserved
      sku: target.item.sku,
    };

    onUpdateItem(updatedItem);

    setReviewItems((prev) =>
      prev.map((r, i) =>
        i === index
          ? { ...r, status: 'accepted', isEditing: false, currentTitle: titleToSave }
          : r
      )
    );
  };

  // Handle Edit Toggle
  const handleToggleEdit = (index: number) => {
    setReviewItems((prev) =>
      prev.map((r, i) =>
        i === index ? { ...r, isEditing: !r.isEditing } : r
      )
    );
  };

  // Handle Keep Current (Locks title to prevent future suggestions)
  const handleKeepCurrent = (index: number) => {
    const target = reviewItems[index];
    if (!target) return;

    const updatedItem: JewelryItem = {
      ...target.item,
      isTitleLocked: true,
      titleSource: 'Manually Locked',
      sku: target.item.sku,
    };

    onUpdateItem(updatedItem);

    setReviewItems((prev) =>
      prev.map((r, i) =>
        i === index ? { ...r, status: 'kept', isEditing: false } : r
      )
    );
  };

  // Bulk Accept All Pending
  const handleAcceptAllPending = () => {
    if (!window.confirm(`Accept all ${pendingCount} suggested title improvements? Permanent SKUs will remain unchanged.`)) {
      return;
    }

    reviewItems.forEach((r) => {
      if (r.status === 'pending') {
        const titleToSave = r.isEditing ? r.editedTitle.trim() : r.suggestedTitle;
        if (titleToSave) {
          onUpdateItem({
            ...r.item,
            title: titleToSave,
            titleSource: 'AI Generated',
            sku: r.item.sku,
          });
        }
      }
    });

    setReviewItems((prev) =>
      prev.map((r) =>
        r.status === 'pending'
          ? { ...r, status: 'accepted', currentTitle: r.suggestedTitle }
          : r
      )
    );
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }}>
      <div
        className="modal-content"
        style={{
          maxWidth: '920px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(15, 18, 26, 0.95)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.25) 0%, rgba(96, 165, 250, 0.25) 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(212, 175, 55, 0.3)',
              }}
            >
              <Sparkles size={18} color="#fae084" />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.15rem', color: '#ffffff', fontWeight: 600 }}>
                Review AI Jewellery Titles
              </h3>
              <p style={{ margin: '2px 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Clean commercial titles for SAAZ AURA &bull; Standardizes Silver &bull; Replaces CZ with American Diamond &bull; Strips promotional fluff
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="btn-icon"
            style={{ color: 'var(--text-muted)' }}
            title="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Toolbar Bar */}
        <div
          style={{
            padding: '12px 24px',
            background: 'rgba(255, 255, 255, 0.02)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: '240px' }}>
            <div style={{ position: 'relative', width: '100%', maxWidth: '340px' }}>
              <Search
                size={14}
                color="var(--text-dim)"
                style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
              />
              <input
                type="text"
                placeholder="Search by SKU or title..."
                className="input-field"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  fontSize: '0.78rem',
                  paddingLeft: '30px',
                  paddingTop: '6px',
                  paddingBottom: '6px',
                  borderRadius: '6px',
                }}
              />
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
              {pendingCount} pieces pending review
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {pendingCount > 0 && (
              <button
                type="button"
                className="btn-primary"
                onClick={handleAcceptAllPending}
                style={{
                  padding: '6px 14px',
                  fontSize: '0.78rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Check size={14} />
                <span>Accept All ({pendingCount})</span>
              </button>
            )}
          </div>
        </div>

        {/* Item List */}
        <div style={{ overflowY: 'auto', padding: '16px 24px', flex: 1 }}>
          {filteredItems.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '60px 20px',
                color: 'var(--text-muted)',
              }}
            >
              <ShieldCheck size={42} color="#10b981" style={{ margin: '0 auto 12px', opacity: 0.8 }} />
              <h4 style={{ color: '#fff', margin: '0 0 6px', fontSize: '1rem' }}>
                All Catalogue Titles Look Great!
              </h4>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                No titles contain prohibited terms (Rhodium guesses, unnormalized CZ, or fluff words like Ornate/Exquisite).
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {filteredItems.map((itemState) => {
                const originalIndex = reviewItems.findIndex((r) => r.item.id === itemState.item.id);
                const isAccepted = itemState.status === 'accepted';
                const isKept = itemState.status === 'kept';

                return (
                  <div
                    key={itemState.item.id}
                    style={{
                      padding: '16px',
                      borderRadius: '10px',
                      border: '1px solid',
                      borderColor: isAccepted
                        ? 'rgba(16, 185, 129, 0.3)'
                        : isKept
                        ? 'rgba(255, 255, 255, 0.08)'
                        : 'rgba(212, 175, 55, 0.25)',
                      background: isAccepted
                        ? 'rgba(16, 185, 129, 0.04)'
                        : isKept
                        ? 'rgba(255, 255, 255, 0.02)'
                        : 'rgba(15, 18, 26, 0.65)',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    {/* Top Row: SKU Badge & Changes Breakdown */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '10px',
                        flexWrap: 'wrap',
                        gap: '8px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          style={{
                            fontFamily: 'monospace',
                            fontSize: '0.78rem',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '4px',
                            background: 'rgba(212, 175, 55, 0.15)',
                            color: '#fae084',
                            border: '1px solid rgba(212, 175, 55, 0.3)',
                          }}
                        >
                          {itemState.item.sku}
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                          (Permanent SKU unchanged)
                        </span>
                      </div>

                      {/* Changed Terms Badges */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        {itemState.changes.map((c, cIdx) => (
                          <span
                            key={cIdx}
                            style={{
                              fontSize: '0.68rem',
                              fontWeight: 500,
                              padding: '2px 7px',
                              borderRadius: '4px',
                              background: 'rgba(245, 158, 11, 0.12)',
                              color: '#fbbf24',
                              border: '1px solid rgba(245, 158, 11, 0.25)',
                            }}
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Comparison Block */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto 1fr',
                        alignItems: 'center',
                        gap: '12px',
                        marginBottom: '12px',
                        background: 'rgba(0, 0, 0, 0.25)',
                        padding: '10px 14px',
                        borderRadius: '8px',
                      }}
                    >
                      {/* Current Title */}
                      <div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)', marginBottom: '3px', textTransform: 'uppercase' }}>
                          Current Title
                        </div>
                        <div
                          style={{
                            fontSize: '0.85rem',
                            color: isAccepted ? 'var(--text-dim)' : '#e2e8f0',
                            textDecoration: isAccepted ? 'line-through' : 'none',
                          }}
                        >
                          {itemState.currentTitle}
                        </div>
                      </div>

                      {/* Arrow */}
                      <ArrowRight size={16} color="var(--text-dim)" />

                      {/* Suggested Title / Editable Input */}
                      <div>
                        <div style={{ fontSize: '0.68rem', color: '#34d399', marginBottom: '3px', textTransform: 'uppercase', fontWeight: 600 }}>
                          Suggested Clean Title
                        </div>
                        {itemState.isEditing ? (
                          <input
                            type="text"
                            className="input-field"
                            value={itemState.editedTitle}
                            onChange={(e) => {
                              const val = e.target.value;
                              setReviewItems((prev) =>
                                prev.map((r, i) =>
                                  i === originalIndex ? { ...r, editedTitle: val } : r
                                )
                              );
                            }}
                            style={{ fontSize: '0.82rem', padding: '6px 8px' }}
                          />
                        ) : (
                          <div
                            style={{
                              fontSize: '0.85rem',
                              color: isAccepted ? '#34d399' : '#fae084',
                              fontWeight: 600,
                            }}
                          >
                            {itemState.editedTitle}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: '8px',
                      }}
                    >
                      {isAccepted ? (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.75rem',
                            color: '#34d399',
                            fontWeight: 600,
                          }}
                        >
                          <Check size={14} /> Accepted & Saved
                        </span>
                      ) : isKept ? (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.75rem',
                            color: 'var(--text-dim)',
                          }}
                        >
                          <Lock size={12} /> Kept & Locked
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => handleKeepCurrent(originalIndex)}
                            style={{
                              padding: '5px 12px',
                              fontSize: '0.75rem',
                              borderRadius: '6px',
                            }}
                            title="Keep current title and lock it against future AI suggestions"
                          >
                            Keep Current
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => handleToggleEdit(originalIndex)}
                            style={{
                              padding: '5px 12px',
                              fontSize: '0.75rem',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              borderRadius: '6px',
                            }}
                          >
                            <Edit3 size={12} />
                            <span>{itemState.isEditing ? 'Done Editing' : 'Edit'}</span>
                          </button>
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={() => handleAccept(originalIndex)}
                            style={{
                              padding: '5px 14px',
                              fontSize: '0.75rem',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              borderRadius: '6px',
                            }}
                          >
                            <Check size={13} />
                            <span>Accept</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(15, 18, 26, 0.95)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            <AlertCircle size={13} color="#fae084" />
            <span>Title changes never modify permanent SKUs or purchase lot history.</span>
          </div>
          <button type="button" className="btn-secondary" onClick={onClose} style={{ padding: '6px 16px', fontSize: '0.8rem' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
