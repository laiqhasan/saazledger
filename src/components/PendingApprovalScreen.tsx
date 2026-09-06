import React, { useState, useEffect } from 'react';
import { Gem, Clock, RefreshCw, LogOut, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const PendingApprovalScreen: React.FC = () => {
  const { user, refreshUser, logout } = useAuth();
  const [isChecking, setIsChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  const isRejected = user?.status === 'rejected';
  const isSuspended = user?.status === 'suspended';

  // Guarantee pending record is registered in server SQLite database
  useEffect(() => {
    if (user && user.email) {
      fetch('/api/auth/google/sync-pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          fullName: user.fullName,
          avatarUrl: user.avatarUrl,
          id: user.id,
        }),
      }).catch((err) => console.warn('Sync pending user error:', err));
    }
  }, [user]);

  // Automatically poll every 6 seconds to see if Master Admin has approved the user
  useEffect(() => {
    if (isRejected || isSuspended) return;

    const interval = setInterval(async () => {
      try {
        await refreshUser();
      } catch {}
    }, 6000);

    return () => clearInterval(interval);
  }, [refreshUser, isRejected, isSuspended]);

  const handleManualCheck = async () => {
    setIsChecking(true);
    setCheckMessage(null);
    try {
      await refreshUser();
      setCheckMessage('Status verified with Master Ledger.');
    } catch {
      setCheckMessage('Unable to reach server. Please try again in a moment.');
    } finally {
      setIsChecking(false);
      setTimeout(() => setCheckMessage(null), 4000);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        background: 'var(--bg-primary, #0a0b0e)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        backgroundImage:
          'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(212, 175, 55, 0.12), transparent), radial-gradient(ellipse 60% 40% at 100% 100%, rgba(16, 185, 129, 0.05), transparent)',
        backgroundAttachment: 'fixed',
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: '520px',
          padding: '36px 32px',
          borderRadius: '20px',
          border: isRejected || isSuspended ? '1px solid rgba(244, 63, 94, 0.35)' : '1px solid rgba(212, 175, 55, 0.35)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7), 0 0 30px rgba(212, 175, 55, 0.1)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: '20px',
        }}
      >
        {/* Brand Icon */}
        <div
          style={{
            width: '60px',
            height: '60px',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, #262112 0%, #12141a 100%)',
            border: isRejected || isSuspended ? '1px solid #f43f5e' : '1px solid #d4af37',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: isRejected || isSuspended ? '0 0 20px rgba(244, 63, 94, 0.25)' : '0 0 20px rgba(212, 175, 55, 0.3)',
          }}
        >
          {isRejected || isSuspended ? (
            <ShieldAlert size={30} color="#f43f5e" />
          ) : (
            <Gem size={30} color="#fae084" />
          )}
        </div>

        {/* Title */}
        <div>
          <h2
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: '1.65rem',
              fontWeight: 700,
              letterSpacing: '0.04em',
              background: isRejected || isSuspended
                ? 'linear-gradient(135deg, #ffffff 0%, #f43f5e 100%)'
                : 'linear-gradient(135deg, #ffffff 0%, #fae084 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              margin: '0 0 6px 0',
            }}
          >
            {isRejected
              ? 'Access Request Declined'
              : isSuspended
              ? 'Account Suspended'
              : 'Access Request Pending'}
          </h2>
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 600,
              letterSpacing: '0.08em',
              background: isRejected || isSuspended ? 'rgba(244, 63, 94, 0.15)' : 'rgba(212, 175, 55, 0.15)',
              color: isRejected || isSuspended ? '#f43f5e' : '#fae084',
              padding: '3px 8px',
              borderRadius: '4px',
              border: isRejected || isSuspended ? '1px solid rgba(244, 63, 94, 0.3)' : '1px solid rgba(212, 175, 55, 0.3)',
              display: 'inline-block',
            }}
          >
            SAAZ LEDGER ATELIER OS
          </span>
        </div>

        {/* User Card */}
        <div
          style={{
            width: '100%',
            padding: '16px',
            borderRadius: '12px',
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            textAlign: 'left',
          }}
        >
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.fullName}
              style={{ width: '48px', height: '48px', borderRadius: '50%', objectFit: 'cover', border: '2px solid #d4af37' }}
            />
          ) : (
            <div
              style={{
                width: '48px',
                height: '48px',
                borderRadius: '50%',
                background: '#d4af37',
                color: '#0d1117',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.2rem',
                fontWeight: 'bold',
              }}
            >
              {user?.fullName[0]?.toUpperCase() || 'U'}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f3f4f6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.fullName}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.email}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
              <span
                style={{
                  fontSize: '0.68rem',
                  textTransform: 'uppercase',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontWeight: 600,
                  background: isRejected || isSuspended
                    ? 'rgba(244, 63, 94, 0.2)'
                    : 'rgba(245, 158, 11, 0.2)',
                  color: isRejected || isSuspended ? '#f43f5e' : '#fbbf24',
                  border: isRejected || isSuspended
                    ? '1px solid rgba(244, 63, 94, 0.4)'
                    : '1px solid rgba(245, 158, 11, 0.4)',
                }}
              >
                {isRejected ? 'Declined' : isSuspended ? 'Suspended' : 'Pending Approval'}
              </span>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                Google Identity Verified
              </span>
            </div>
          </div>
        </div>

        {/* Security / Explanation Notice */}
        <div
          style={{
            fontSize: '0.86rem',
            color: 'var(--text-muted)',
            lineHeight: '1.6',
            background: 'rgba(20, 24, 34, 0.6)',
            padding: '16px',
            borderRadius: '10px',
            border: '1px solid rgba(212, 175, 55, 0.15)',
            textAlign: 'left',
          }}
        >
          {isRejected ? (
            <span>
              Your access request has been declined by the Master Administrator. If you believe this is an error, please contact{' '}
              <strong style={{ color: '#fae084' }}>hasan.laiq@gmail.com</strong>.
            </span>
          ) : isSuspended ? (
            <span>
              Your account access has been temporarily suspended. Please reach out to{' '}
              <strong style={{ color: '#fae084' }}>hasan.laiq@gmail.com</strong> for reactivation.
            </span>
          ) : (
            <span>
              To protect proprietary jewelry SKU formulas, purchase lots, and profit metrics, new registrations require authorization from Master Admin{' '}
              <strong style={{ color: '#fae084' }}>hasan.laiq@gmail.com</strong>.
              <br />
              <br />
              Your request has been queued. Once approved, your assigned role (<strong>Admin</strong>, <strong>Manager</strong>, <strong>Staff</strong>, or <strong>Viewer</strong>) will activate automatically.
            </span>
          )}
        </div>

        {/* Live Status indicator */}
        {!isRejected && !isSuspended && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: '#fbbf24' }}>
            <Clock size={16} className="animate-spin" style={{ animationDuration: '3s' }} />
            <span>Listening for approval in real-time...</span>
          </div>
        )}

        {checkMessage && (
          <div style={{ fontSize: '0.8rem', color: '#34d399', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ShieldCheck size={16} />
            <span>{checkMessage}</span>
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '12px', width: '100%', marginTop: '8px' }}>
          {!isRejected && !isSuspended && (
            <button
              type="button"
              className="btn-secondary"
              onClick={handleManualCheck}
              disabled={isChecking}
              style={{
                flex: 1,
                padding: '11px 16px',
                fontSize: '0.88rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              <RefreshCw size={16} className={isChecking ? 'animate-spin' : ''} />
              <span>{isChecking ? 'Verifying...' : 'Check Status'}</span>
            </button>
          )}

          <button
            type="button"
            className={isRejected || isSuspended ? 'btn-primary' : 'btn-secondary'}
            onClick={logout}
            style={{
              flex: isRejected || isSuspended ? 1 : undefined,
              padding: '11px 18px',
              fontSize: '0.88rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
            }}
          >
            <LogOut size={16} />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </div>
  );
};
