import React, { useEffect, useState } from 'react';

export type BackgroundIsolationMode = 'auto' | 'plain' | 'styled' | 'model';

const MODE_LABELS: Record<BackgroundIsolationMode, string> = {
  auto: 'Auto Detect',
  plain: 'Plain Background',
  styled: 'Styled / Props',
  model: 'Model Wearing',
};

const MODE_HELP: Record<BackgroundIsolationMode, string> = {
  auto: 'Detects plain vs styled automatically. PhotoRoom first; Gemini is used only when a styled mask fails validation.',
  plain: 'For white paper, plain board or simple seamless backgrounds. Uses exact PhotoRoom source pixels and fails instead of redesigning.',
  styled: 'For silk, flowers, marble, cloth or props. Uses strict mask validation and Gemini semantic isolation only when PhotoRoom keeps props.',
  model: 'Exact product extraction from a worn photo is blocked because hidden chain/product geometry cannot be recovered safely.',
};

function getToken(): string | null {
  try {
    return localStorage.getItem('saaz_auth_token') || localStorage.getItem('saaz_token');
  } catch {
    return null;
  }
}

export const BackgroundIsolationModeControl: React.FC = () => {
  const [mode, setMode] = useState<BackgroundIsolationMode>(() => {
    try {
      const saved = localStorage.getItem('saaz_background_isolation_mode');
      return saved === 'plain' || saved === 'styled' || saved === 'model' || saved === 'auto'
        ? saved
        : 'auto';
    } catch {
      return 'auto';
    }
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/ai-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (cancelled || !cfg) return;
        const remote = cfg.bgRemovalProvider;
        if (remote === 'plain' || remote === 'styled' || remote === 'model' || remote === 'auto') {
          setMode(remote);
          try {
            localStorage.setItem('saaz_background_isolation_mode', remote);
          } catch {}
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const updateMode = async (next: BackgroundIsolationMode) => {
    setMode(next);
    try {
      localStorage.setItem('saaz_background_isolation_mode', next);
    } catch {}

    setSaving(true);
    try {
      const token = getToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch('/api/settings/ai-config', {
        method: 'POST',
        headers,
        body: JSON.stringify({ bgRemovalProvider: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn('Could not persist background isolation mode:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 126,
        right: 92,
        zIndex: 100003,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        borderRadius: 10,
        border: '1px solid rgba(245, 158, 11, 0.38)',
        background: 'rgba(10, 13, 20, 0.96)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        color: '#e5e7eb',
        fontSize: 12,
      }}
      title={MODE_HELP[mode]}
    >
      <span style={{ color: '#fbbf24', fontWeight: 800, whiteSpace: 'nowrap' }}>
        Jewellery Isolation
      </span>
      <select
        value={mode}
        onChange={(e) => updateMode(e.target.value as BackgroundIsolationMode)}
        disabled={saving}
        style={{
          background: '#111827',
          color: '#f9fafb',
          border: '1px solid #4b5563',
          borderRadius: 7,
          padding: '5px 8px',
          fontWeight: 700,
          cursor: saving ? 'wait' : 'pointer',
        }}
      >
        {(Object.keys(MODE_LABELS) as BackgroundIsolationMode[]).map((key) => (
          <option key={key} value={key}>
            {MODE_LABELS[key]}
          </option>
        ))}
      </select>
      <span style={{ color: '#9ca3af', maxWidth: 300, lineHeight: 1.25 }}>
        {mode === 'styled'
          ? 'Strict props removal: PhotoRoom → validate → Gemini fallback → PhotoRoom'
          : mode === 'auto'
            ? 'Recommended'
            : mode === 'plain'
              ? 'Exact PhotoRoom pixels'
              : 'Use product-only photo for white listing image'}
      </span>
    </div>
  );
};
