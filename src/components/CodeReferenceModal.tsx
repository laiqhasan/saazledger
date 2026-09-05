import React, { useState } from 'react';
import type { CodeTables, CodeReferenceItem } from '../types/inventory';
import { X, Plus, Trash2, Sliders, Check, ShieldCheck } from 'lucide-react';

interface CodeReferenceModalProps {
  codeTables: CodeTables;
  onSaveCodeTables: (updated: CodeTables) => void;
  onClose: () => void;
}

type ActiveTab = 'types' | 'stones' | 'colors';

export const CodeReferenceModal: React.FC<CodeReferenceModalProps> = ({
  codeTables,
  onSaveCodeTables,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>('types');
  const [tables, setTables] = useState<CodeTables>(codeTables);

  // New item inputs
  const [newCode, setNewCode] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedFeedback, setSavedFeedback] = useState(false);

  const handleAddCode = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const cleanCode = newCode.trim().toUpperCase();
    const cleanLabel = newLabel.trim();

    if (!cleanCode || !cleanLabel) {
      setErrorMsg('Please specify both a short code and a full label.');
      return;
    }

    const currentList = tables[activeTab];
    if (currentList.some((item) => item.code.toUpperCase() === cleanCode)) {
      setErrorMsg(`Code "${cleanCode}" already exists in this table! Each code must be unique.`);
      return;
    }

    const newItem: CodeReferenceItem = {
      code: cleanCode,
      label: cleanLabel,
      description: newDesc.trim() || undefined,
    };

    const updated = {
      ...tables,
      [activeTab]: [...currentList, newItem],
    };

    setTables(updated);
    onSaveCodeTables(updated);

    // Reset inputs
    setNewCode('');
    setNewLabel('');
    setNewDesc('');
    showSavedToast();
  };

  const handleDeleteCode = (codeToDelete: string) => {
    const updated = {
      ...tables,
      [activeTab]: tables[activeTab].filter((item) => item.code !== codeToDelete),
    };
    setTables(updated);
    onSaveCodeTables(updated);
    showSavedToast();
  };

  const showSavedToast = () => {
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 1800);
  };

  const currentList = tables[activeTab];

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '680px' }}>
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
                background: 'rgba(212, 175, 55, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Sliders size={18} color="#fae084" />
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
                Code Reference System
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                Central tables for Product Types, Stones, and Colors used in SKU generation
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

        {/* Tab Selection */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'rgba(255, 255, 255, 0.02)',
            padding: '0 24px',
          }}
        >
          {(
            [
              { id: 'types', label: `Product Types (${tables.types.length})` },
              { id: 'stones', label: `Stones / Materials (${tables.stones.length})` },
              { id: 'colors', label: `Colors & Tones (${tables.colors.length})` },
            ] as const
          ).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  setErrorMsg(null);
                }}
                style={{
                  padding: '12px 16px',
                  background: 'none',
                  border: 'none',
                  borderBottom: active ? '2px solid #d4af37' : '2px solid transparent',
                  color: active ? '#fae084' : 'var(--text-muted)',
                  fontWeight: active ? 600 : 400,
                  fontSize: '0.86rem',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div style={{ padding: '24px' }}>
          {/* Add Code Form */}
          <form
            onSubmit={handleAddCode}
            style={{
              padding: '16px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-subtle)',
              marginBottom: '20px',
            }}
          >
            <div
              style={{
                fontSize: '0.78rem',
                fontWeight: 600,
                color: '#fae084',
                textTransform: 'uppercase',
                marginBottom: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>Add New Code to {activeTab.toUpperCase()}</span>
              {savedFeedback && (
                <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Check size={14} /> Saved immediately
                </span>
              )}
            </div>

            {errorMsg && (
              <div
                style={{
                  color: '#f87171',
                  fontSize: '0.8rem',
                  marginBottom: '10px',
                }}
              >
                {errorMsg}
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '90px 1fr 1fr auto',
                gap: '10px',
                alignItems: 'flex-end',
              }}
            >
              <div>
                <label className="input-label" style={{ fontSize: '0.72rem' }}>Code *</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. CZ"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                  maxLength={5}
                  required
                />
              </div>

              <div>
                <label className="input-label" style={{ fontSize: '0.72rem' }}>Display Label *</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. Cubic Zirconia"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="input-label" style={{ fontSize: '0.72rem' }}>Description (optional)</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. Brilliant cut simulants"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </div>

              <button
                type="submit"
                className="btn-primary"
                style={{ padding: '9px 14px', height: '42px' }}
                title="Add code to scheme"
              >
                <Plus size={16} />
                <span>Add</span>
              </button>
            </div>
          </form>

          {/* Current Codes List */}
          <div
            style={{
              maxHeight: '260px',
              overflowY: 'auto',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '8px',
            }}
          >
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    background: 'rgba(255, 255, 255, 0.02)',
                    color: 'var(--text-dim)',
                    fontSize: '0.72rem',
                    textTransform: 'uppercase',
                  }}
                >
                  <th style={{ padding: '8px 12px', textAlign: 'left', width: '80px' }}>Code</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Label</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Description</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', width: '50px' }}></th>
                </tr>
              </thead>
              <tbody>
                {currentList.map((item) => (
                  <tr
                    key={item.code}
                    style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}
                  >
                    <td style={{ padding: '8px 12px' }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontWeight: 700,
                          color: '#fae084',
                          background: 'rgba(212, 175, 55, 0.1)',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          border: '1px solid rgba(212, 175, 55, 0.3)',
                        }}
                      >
                        {item.code}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px', color: '#ffffff', fontWeight: 500 }}>
                      {item.label}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>
                      {item.description || '—'}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => handleDeleteCode(item.code)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--text-dim)',
                          cursor: 'pointer',
                          padding: '4px',
                        }}
                        title={`Delete code [${item.code}]`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{
              marginTop: '16px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '0.78rem',
              color: 'var(--text-dim)',
            }}
          >
            <ShieldCheck size={14} color="#10b981" />
            <span>
              All modifications persist across sessions and survive inventory resets.
            </span>
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
          <button type="button" className="btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
