import React, { useState, useEffect } from 'react';
import { X, Key, CheckCircle2, AlertTriangle, ShieldCheck, Hash } from 'lucide-react';
import { fetchGlobalSkuStatus } from '../services/apiService';

interface GlobalSkuInitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const GlobalSkuInitModal: React.FC<GlobalSkuInitModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [status, setStatus] = useState<any>(null);
  const [startingSerial, setStartingSerial] = useState<number>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadStatus = async () => {
    setIsLoading(true);
    try {
      const data = await fetchGlobalSkuStatus();
      if (data) {
        setStatus(data);
        setStartingSerial(data.nextSerial || data.currentSerial + 1);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadStatus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleInitialize = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const token = localStorage.getItem('saaz_token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/sku/initialize-sequence', {
        method: 'POST',
        headers,
        body: JSON.stringify({ startingSerial: Number(startingSerial) }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to initialize sequence');
      }

      setSuccessMsg(`Global 5-digit sequence successfully calibrated! First new piece will be minted as #${String(startingSerial).padStart(5, '0')}.`);
      setStatus(data.status);
      if (onSuccess) onSuccess();
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '680px',
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
                color: 'var(--gold)',
              }}
            >
              <Key size={20} />
            </div>
            <div>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Global 5-Digit SKU System
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                Enterprise sequence calibration & V2 SKU format management
              </p>
            </div>
          </div>

          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {errorMsg && (
            <div
              style={{
                padding: '10px 14px',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                color: '#ef4444',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <AlertTriangle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div
              style={{
                padding: '10px 14px',
                background: 'rgba(16, 185, 129, 0.15)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '8px',
                color: '#10b981',
                fontSize: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <CheckCircle2 size={16} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Metrics Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
            <div style={{ background: 'rgba(255,255,255,0.03)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Legacy V1 SKUs</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
                {status ? status.totalV1Items : '...'}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '2px' }}>PDJ12001 style</div>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.03)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Next V2 Serial</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--gold)', marginTop: '4px' }}>
                #{status ? status.formattedNextSerial : '00001'}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '2px' }}>PDJ12-0000X style</div>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.03)', padding: '14px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Physical Stock</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#10b981', marginTop: '4px' }}>
                {status ? status.totalPhysicalStock : '...'}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '2px' }}>Pieces in vault</div>
            </div>
          </div>

          {/* Configuration Form */}
          <div style={{ background: 'rgba(212, 175, 55, 0.05)', border: '1px solid rgba(212, 175, 55, 0.2)', borderRadius: '10px', padding: '16px' }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--gold)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <ShieldCheck size={16} />
              <span>Calibrate Starting Sequence Number</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: 1.4 }}>
              The global sequence allocates atomic 5-digit serials (00001 to 99999). It never resets across categories or collections. Once a serial is minted, it is permanently locked.
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ position: 'relative', width: '160px' }}>
                <Hash size={15} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
                <input
                  type="number"
                  className="input-field"
                  min={status ? status.currentSerial + 1 : 1}
                  max={99999}
                  value={startingSerial}
                  onChange={(e) => setStartingSerial(parseInt(e.target.value, 10) || 1)}
                  style={{ paddingLeft: '32px', height: '38px', fontWeight: 700 }}
                />
              </div>

              <button
                type="button"
                className="btn-primary"
                onClick={handleInitialize}
                disabled={isLoading}
                style={{ padding: '8px 18px', fontSize: '0.85rem' }}
              >
                Save Starting Sequence
              </button>
            </div>
          </div>
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
