import React, { useState, useEffect } from 'react';
import type { MediaStorageSettings, ConnectionTestResult } from '../types/media';
import {
  fetchMediaStorageSettings,
  saveMediaStorageSettings,
  testS3Connection,
  testGoogleDriveConnection,
} from '../services/mediaService';
import {
  X,
  Cloud,
  HardDrive,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Database,
  Info,
} from 'lucide-react';

interface MediaStorageSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const MediaStorageSettingsModal: React.FC<MediaStorageSettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [settings, setSettings] = useState<MediaStorageSettings | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  // Connection Probing State
  const [isTestingS3, setIsTestingS3] = useState(false);
  const [s3TestResult, setS3TestResult] = useState<ConnectionTestResult | null>(null);

  const [isTestingDrive, setIsTestingDrive] = useState(false);
  const [driveTestResult, setDriveTestResult] = useState<ConnectionTestResult | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchMediaStorageSettings().then((s) => {
        if (s) setSettings(s);
      });
    }
  }, [isOpen]);

  if (!isOpen || !settings) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const ok = await saveMediaStorageSettings(settings);
      if (ok) {
        setSaveSuccessMsg('Media storage settings successfully saved to secure vault.');
        setTimeout(() => setSaveSuccessMsg(null), 5000);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const runS3Test = async () => {
    setIsTestingS3(true);
    setS3TestResult(null);
    try {
      // First save current inputs so probe uses updated values
      await saveMediaStorageSettings(settings);
      const res = await testS3Connection();
      setS3TestResult(res);
    } finally {
      setIsTestingS3(false);
    }
  };

  const runDriveTest = async () => {
    setIsTestingDrive(true);
    setDriveTestResult(null);
    try {
      await saveMediaStorageSettings(settings);
      const res = await testGoogleDriveConnection();
      setDriveTestResult(res);
    } finally {
      setIsTestingDrive(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal-content"
        style={{
          maxWidth: '860px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          background: 'var(--bg-card)',
          overflow: 'hidden',
        }}
      >
        {/* Modal Header */}
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
                width: '38px',
                height: '38px',
                borderRadius: '8px',
                background: 'rgba(212, 175, 55, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--gold)',
              }}
            >
              <Database size={20} />
            </div>
            <div>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Cloud Media Storage Settings
              </h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                Manage Amazon S3 & Google Drive providers, IAM permissions, and replication rules
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '6px',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} style={{ overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {saveSuccessMsg && (
            <div
              style={{
                padding: '10px 16px',
                background: 'rgba(16, 185, 129, 0.15)',
                color: 'var(--success)',
                fontSize: '0.85rem',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <CheckCircle2 size={16} />
              {saveSuccessMsg}
            </div>
          )}

          {/* Section 1: Storage Mode & Primary Provider */}
          <div
            style={{
              padding: '18px',
              background: 'var(--bg-surface)',
              borderRadius: '10px',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Cloud size={18} style={{ color: 'var(--gold)' }} />
              Primary Media Storage Provider
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '14px' }}>
              Select where all new jewelry photography and uploads will be stored. Changing the primary provider affects new uploads only; existing catalog photos remain accessible.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
              {/* Option 1: Amazon S3 */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '14px',
                  borderRadius: '8px',
                  border: settings.primaryProvider === 's3' ? '2px solid var(--gold)' : '1px solid var(--border-subtle)',
                  background: settings.primaryProvider === 's3' ? 'rgba(212, 175, 55, 0.08)' : 'var(--bg-card)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <input
                    type="radio"
                    name="primaryProvider"
                    checked={settings.primaryProvider === 's3'}
                    onChange={() => setSettings({ ...settings, primaryProvider: 's3' })}
                  />
                  <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>Amazon S3</span>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Enterprise object vault with multipart uploads, SSE-S3 encryption & CloudFront CDN delivery.
                </span>
              </label>

              {/* Option 2: Google Drive */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '14px',
                  borderRadius: '8px',
                  border: settings.primaryProvider === 'google_drive' ? '2px solid var(--gold)' : '1px solid var(--border-subtle)',
                  background: settings.primaryProvider === 'google_drive' ? 'rgba(212, 175, 55, 0.08)' : 'var(--bg-card)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <input
                    type="radio"
                    name="primaryProvider"
                    checked={settings.primaryProvider === 'google_drive'}
                    onChange={() => setSettings({ ...settings, primaryProvider: 'google_drive' })}
                  />
                  <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>Google Drive</span>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Team Shared Drive / Workspace folder with OAuth authorization and resumable chunking.
                </span>
              </label>

              {/* Option 3: Local Vault */}
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '14px',
                  borderRadius: '8px',
                  border: settings.primaryProvider === 'local_disk' ? '2px solid var(--gold)' : '1px solid var(--border-subtle)',
                  background: settings.primaryProvider === 'local_disk' ? 'rgba(212, 175, 55, 0.08)' : 'var(--bg-card)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                  <input
                    type="radio"
                    name="primaryProvider"
                    checked={settings.primaryProvider === 'local_disk'}
                    onChange={() => setSettings({ ...settings, primaryProvider: 'local_disk' })}
                  />
                  <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>Local Disk Vault</span>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Content-addressable SHA-256 local disk storage. Zero external credentials needed.
                </span>
              </label>
            </div>

            {/* Asynchronous Backup Copy Toggle */}
            <div
              style={{
                marginTop: '16px',
                paddingTop: '14px',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                  Asynchronous Dual-Cloud Backup to Google Drive
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  When enabled, files uploaded to Amazon S3 are automatically copied to Google Drive in the background.
                </div>
              </div>
              <input
                type="checkbox"
                checked={settings.backupEnabled}
                onChange={(e) => setSettings({ ...settings, backupEnabled: e.target.checked })}
                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--gold)' }}
              />
            </div>
          </div>

          {/* Section 2: Amazon S3 Configuration */}
          <div
            style={{
              padding: '18px',
              background: 'var(--bg-surface)',
              borderRadius: '10px',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <HardDrive size={18} style={{ color: '#f59e0b' }} />
                Amazon S3 Configuration
              </h3>
              <button
                type="button"
                onClick={runS3Test}
                disabled={isTestingS3 || !settings.s3.bucket}
                className="btn btn-secondary"
                style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <RefreshCw size={13} className={isTestingS3 ? 'animate-spin' : ''} />
                Test S3 Connection & Permissions
              </button>
            </div>

            {s3TestResult && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: '6px',
                  marginBottom: '14px',
                  fontSize: '0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: s3TestResult.success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  color: s3TestResult.success ? 'var(--success)' : 'var(--danger)',
                }}
              >
                {s3TestResult.success ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                <div>
                  <strong>{s3TestResult.message}</strong>
                  {s3TestResult.latencyMs && <span> ({s3TestResult.latencyMs}ms roundtrip)</span>}
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
              <div>
                <label className="form-label">S3 Bucket Name *</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. saaz-aura-media-vault"
                  value={settings.s3.bucket}
                  onChange={(e) => setSettings({ ...settings, s3: { ...settings.s3, bucket: e.target.value } })}
                  required={settings.primaryProvider === 's3'}
                />
              </div>

              <div>
                <label className="form-label">AWS Region *</label>
                <select
                  className="form-control"
                  value={settings.s3.region}
                  onChange={(e) => setSettings({ ...settings, s3: { ...settings.s3, region: e.target.value } })}
                >
                  <option value="ap-south-1">Asia Pacific (Mumbai) - ap-south-1</option>
                  <option value="ap-southeast-1">Asia Pacific (Singapore) - ap-southeast-1</option>
                  <option value="me-central-1">Middle East (UAE) - me-central-1</option>
                  <option value="eu-west-1">Europe (Ireland) - eu-west-1</option>
                  <option value="us-east-1">US East (N. Virginia) - us-east-1</option>
                </select>
              </div>

              <div>
                <label className="form-label">Object Key Prefix</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="saaz-ledger/media"
                  value={settings.s3.prefix}
                  onChange={(e) => setSettings({ ...settings, s3: { ...settings.s3, prefix: e.target.value } })}
                />
              </div>

              <div>
                <label className="form-label">Custom CDN / CloudFront Domain (Optional)</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="https://media.saazaura.com"
                  value={settings.s3.cdnCustomDomain || ''}
                  onChange={(e) => setSettings({ ...settings, s3: { ...settings.s3, cdnCustomDomain: e.target.value } })}
                />
              </div>
            </div>

            <div
              style={{
                marginTop: '12px',
                padding: '10px 14px',
                background: 'rgba(245, 158, 11, 0.08)',
                borderRadius: '6px',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <ShieldCheck size={16} style={{ color: '#f59e0b', flexShrink: 0 }} />
              <span>
                <strong>IAM Security Best Practice</strong>: Workload identity and IAM role authentication preferred. Raw AWS secret keys are securely vaulted on the backend and never exposed in client bundles.
              </span>
            </div>
          </div>

          {/* Section 3: Google Drive Configuration */}
          <div
            style={{
              padding: '18px',
              background: 'var(--bg-surface)',
              borderRadius: '10px',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Cloud size={18} style={{ color: '#3b82f6' }} />
                Google Drive Configuration
              </h3>
              <button
                type="button"
                onClick={runDriveTest}
                disabled={isTestingDrive}
                className="btn btn-secondary"
                style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <RefreshCw size={13} className={isTestingDrive ? 'animate-spin' : ''} />
                Test Drive Connection
              </button>
            </div>

            {driveTestResult && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: '6px',
                  marginBottom: '14px',
                  fontSize: '0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: driveTestResult.success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  color: driveTestResult.success ? 'var(--success)' : 'var(--danger)',
                }}
              >
                {driveTestResult.success ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                <div>
                  <strong>{driveTestResult.message}</strong>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
              <div>
                <label className="form-label">Destination Folder ID / Shared Drive *</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. 1BxiMVs0XRqcEYOHFUKZSm_..."
                  value={settings.googleDrive.folderId}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      googleDrive: { ...settings.googleDrive, folderId: e.target.value },
                    })
                  }
                  required={settings.primaryProvider === 'google_drive' || settings.backupEnabled}
                />
              </div>

              <div>
                <label className="form-label">Connected Google Account</label>
                <input
                  type="email"
                  className="form-control"
                  placeholder="atelier@saazaura.com"
                  value={settings.googleDrive.connectedEmail || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      googleDrive: { ...settings.googleDrive, connectedEmail: e.target.value },
                    })
                  }
                />
              </div>
            </div>

            <div
              style={{
                marginTop: '12px',
                padding: '10px 14px',
                background: 'rgba(59, 130, 246, 0.08)',
                borderRadius: '6px',
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <Info size={16} style={{ color: '#3b82f6', flexShrink: 0 }} />
              <span>
                <strong>OAuth Scope Scoping</strong>: Requests scoped strictly to <code>https://www.googleapis.com/auth/drive.file</code>. Only files created by Saaz Ledger within the designated folder are accessed.
              </span>
            </div>
          </div>

          {/* Section 4: Storage & Cost Analytics */}
          <div
            style={{
              padding: '16px 18px',
              background: 'var(--bg-surface)',
              borderRadius: '10px',
              border: '1px solid var(--border-subtle)',
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '12px',
            }}
          >
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Total Media Assets</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
                6 Pieces Cataloged
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>~0.6 MB active storage</div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Derivative Overhead</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', marginTop: '2px' }}>
                Thumbnails (300px)
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>~20% storage footprint</div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Estimated Monthly Cost</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--gold)', marginTop: '2px' }}>
                ₹0.00 / Free Tier
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Subject to provider billing data</div>
            </div>
          </div>

          {/* Footer Actions */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              paddingTop: '12px',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={isSaving} className="btn btn-primary" style={{ minWidth: '130px' }}>
              {isSaving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
