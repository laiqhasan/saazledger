import React, { useEffect, useState } from 'react';
import { fetchItemVerification } from '../services/apiService';

interface Props {
  itemId: string;
  sku?: string;
  onClose: () => void;
}

/** Read-only view of exactly what the server stores for an item plus its linked media. */
export const ServerVerifyModal: React.FC<Props> = ({ itemId, sku, onClose }) => {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; error: string; code: number } | { status: 'ok'; report: any }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchItemVerification(itemId).then((r) => {
      if (cancelled) return;
      setState(r.ok ? { status: 'ok', report: r.report } : { status: 'error', error: r.error, code: r.status });
    });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const mono: React.CSSProperties = { fontFamily: 'monospace', fontSize: '0.74rem', wordBreak: 'break-all' };

  return (
    <div className="modal-overlay" style={{ zIndex: 1200 }} onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: 760, width: '94vw', maxHeight: '88vh', overflow: 'auto', padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Server record (read-only){sku ? ` - ${sku}` : ''}</h3>
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        </div>

        {state.status === 'loading' && <p>Loading what the server stores...</p>}
        {state.status === 'error' && (
          <p style={{ color: '#f87171' }}>
            {state.code === 404 ? 'NOT FOUND ON SERVER: this piece is not stored on the server. ' : 'Could not verify: '}
            {state.error}
          </p>
        )}
        {state.status === 'ok' && (
          <>
            <p style={{ color: '#34d399', marginTop: 0 }}>
              Found on server. id <span style={mono}>{state.report.id}</span> · SKU <span style={mono}>{state.report.sku}</span>
            </p>
            <div style={{ marginBottom: 12 }}>
              <strong>Media summary:</strong> {state.report.counts.activeLinks} active / {state.report.counts.totalLinks} linked
              {' · '}main image: {state.report.counts.hasMainImage ? 'yes' : 'no'}
              {' · '}original photo: {state.report.counts.hasOriginalImage ? 'yes' : 'no'}
              {Object.keys(state.report.counts.byRole).length > 0 && (
                <span> · roles: {Object.entries(state.report.counts.byRole).map(([k, v]) => `${k}=${v}`).join(', ')}</span>
              )}
            </div>
            <table style={{ width: '100%', fontSize: '0.78rem', borderCollapse: 'collapse', marginBottom: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>Slot</th><th>Role</th><th>Status</th><th>URL</th>
                </tr>
              </thead>
              <tbody>
                {state.report.media.map((m: any) => (
                  <tr key={m.link_id} style={{ opacity: m.is_deleted ? 0.5 : 1 }}>
                    <td>{m.slot_type}{m.is_cover ? ' (cover)' : ''}</td>
                    <td>{m.file_role}</td>
                    <td>{m.processing_status}/{m.approval_status}{m.is_deleted ? ' / deleted' : ''}</td>
                    <td style={mono}>{m.url || '(no url)'}</td>
                  </tr>
                ))}
                {state.report.media.length === 0 && (
                  <tr><td colSpan={4}>No gallery/media links stored for this piece.</td></tr>
                )}
              </tbody>
            </table>
            <details>
              <summary>Raw stored row</summary>
              <pre style={{ ...mono, whiteSpace: 'pre-wrap' }}>{JSON.stringify(state.report.stored, null, 2)}</pre>
            </details>
            <p style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>Verified at {state.report.verifiedAt}</p>
          </>
        )}
      </div>
    </div>
  );
};
