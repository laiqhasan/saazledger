import React, { useState, useEffect, useRef } from 'react';
import { X, ShieldCheck, LogOut, Key, CheckCircle, AlertCircle, Sparkles, Mail, Settings } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

declare global {
  interface Window {
    google?: any;
  }
}

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
  const {
    user,
    isAuthenticated,
    isLoading,
    googleClientId,
    isGoogleConfigured,
    loginWithGoogle,
    devLogin,
    loginWithCredentials,
    logout,
    updateGoogleClientId,
  } = useAuth();

  const [activeTab, setActiveTab] = useState<'google' | 'password' | 'settings'>('google');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clientIdInput, setClientIdInput] = useState(googleClientId || '');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setClientIdInput(googleClientId || '');
  }, [googleClientId]);

  // Load Google Identity Services (GIS) script
  useEffect(() => {
    if (!isOpen) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    // If script is not present, inject it
    if (!window.google?.accounts?.id) {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        initGoogleButton();
      };
      document.body.appendChild(script);
    } else {
      initGoogleButton();
    }
  }, [isOpen, googleClientId, isGoogleConfigured]);

  const initGoogleButton = () => {
    if (!window.google?.accounts?.id || !googleClientId || !googleBtnRef.current) {
      return;
    }

    try {
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response: any) => {
          if (response?.credential) {
            try {
              setErrorMsg(null);
              await loginWithGoogle(response.credential);
              setSuccessMsg('Successfully signed in with Google!');
              setTimeout(() => {
                onClose();
              }, 600);
            } catch (err: any) {
              setErrorMsg(err.message || 'Google sign-in failed');
            }
          }
        },
        auto_select: false,
      });

      // Render official Google button
      googleBtnRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        type: 'standard',
        theme: 'filled_black',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        logo_alignment: 'left',
        width: 340,
      });
    } catch (err) {
      console.warn('Error initializing Google Sign-In button:', err);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    try {
      await loginWithCredentials(username, password);
      setSuccessMsg('Logged in successfully!');
      setTimeout(() => {
        onClose();
      }, 500);
    } catch (err: any) {
      setErrorMsg(err.message || 'Invalid username or password');
    }
  };

  const handleDevLogin = async (role: 'admin' | 'manager' = 'admin') => {
    setErrorMsg(null);
    try {
      await devLogin('artisan.director@saazaura.com', 'Atelier Master Director', role);
      setSuccessMsg('Signed in with Verified Google Demo Profile!');
      setTimeout(() => {
        onClose();
      }, 500);
    } catch (err: any) {
      setErrorMsg(err.message || 'Developer login failed');
    }
  };

  const handleSaveClientId = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);
    if (!clientIdInput.trim()) {
      setErrorMsg('Please enter a valid Google Client ID.');
      return;
    }

    setIsSavingConfig(true);
    try {
      await updateGoogleClientId(clientIdInput.trim());
      setSuccessMsg('Google OAuth Client ID updated successfully!');
      setActiveTab('google');
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update configuration.');
    } finally {
      setIsSavingConfig(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(5, 7, 12, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '480px',
          background: 'linear-gradient(180deg, #161b26 0%, #0d1117 100%)',
          borderRadius: '16px',
          border: '1px solid rgba(212, 175, 55, 0.25)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 30px rgba(212, 175, 55, 0.1)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          color: '#f3f4f6',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(212, 175, 55, 0.03)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.2), rgba(212, 175, 55, 0.05))',
                border: '1px solid rgba(212, 175, 55, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ShieldCheck size={20} color="#fae084" />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.2rem', fontFamily: 'var(--font-serif)', color: '#fae084', letterSpacing: '0.03em' }}>
                {isAuthenticated ? 'Atelier Operator Profile' : 'Sign in to Saaz Ledger'}
              </h2>
              <p style={{ margin: 0, fontSize: '0.78rem', color: '#9ca3af' }}>
                {isAuthenticated ? 'Role & security credentials' : 'Authenticated Atelier OS Enterprise Access'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#9ca3af',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: '6px',
              display: 'flex',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '24px' }}>
          {errorMsg && (
            <div
              style={{
                marginBottom: '16px',
                padding: '10px 14px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: '#f87171',
                fontSize: '0.85rem',
              }}
            >
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div
              style={{
                marginBottom: '16px',
                padding: '10px 14px',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: '#34d399',
                fontSize: '0.85rem',
              }}
            >
              <CheckCircle size={16} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Authenticated View */}
          {isAuthenticated && user ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '16px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  padding: '16px',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                }}
              >
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.fullName}
                    style={{ width: '56px', height: '56px', borderRadius: '50%', objectFit: 'cover', border: '2px solid #d4af37' }}
                  />
                ) : (
                  <div
                    style={{
                      width: '56px',
                      height: '56px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #d4af37, #996515)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '1.25rem',
                      fontWeight: 'bold',
                      color: '#0d1117',
                    }}
                  >
                    {user.fullName ? user.fullName[0].toUpperCase() : 'U'}
                  </div>
                )}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>{user.fullName}</h3>
                    <span
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: user.role === 'admin' ? 'rgba(212, 175, 55, 0.15)' : 'rgba(56, 189, 248, 0.15)',
                        color: user.role === 'admin' ? '#fae084' : '#38bdf8',
                        border: `1px solid ${user.role === 'admin' ? 'rgba(212, 175, 55, 0.3)' : 'rgba(56, 189, 248, 0.3)'}`,
                      }}
                    >
                      {user.role}
                    </span>
                  </div>
                  {user.email && (
                    <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Mail size={13} /> {user.email}
                    </p>
                  )}
                  <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: '#6b7280' }}>
                    Provider: <span style={{ color: '#d1d5db', textTransform: 'capitalize' }}>{user.authProvider || 'Google'}</span>
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => {
                    logout();
                    onClose();
                  }}
                  className="btn-secondary"
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    borderColor: 'rgba(239, 68, 68, 0.4)',
                    color: '#f87171',
                  }}
                >
                  <LogOut size={16} />
                  <span>Sign Out</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-primary"
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <span>Continue</span>
                </button>
              </div>
            </div>
          ) : (
            /* Unauthenticated View */
            <div>
              {/* Tab Navigation */}
              <div
                style={{
                  display: 'flex',
                  gap: '6px',
                  marginBottom: '20px',
                  background: 'rgba(0, 0, 0, 0.3)',
                  padding: '4px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setActiveTab('google')}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: 'none',
                    background: activeTab === 'google' ? 'rgba(212, 175, 55, 0.15)' : 'transparent',
                    color: activeTab === 'google' ? '#fae084' : '#9ca3af',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  Google Sign-In
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('password')}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: 'none',
                    background: activeTab === 'password' ? 'rgba(212, 175, 55, 0.15)' : 'transparent',
                    color: activeTab === 'password' ? '#fae084' : '#9ca3af',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  Password
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('settings')}
                  style={{
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: 'none',
                    background: activeTab === 'settings' ? 'rgba(212, 175, 55, 0.15)' : 'transparent',
                    color: activeTab === 'settings' ? '#fae084' : '#9ca3af',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                  title="Google OAuth Settings"
                >
                  <Settings size={14} />
                </button>
              </div>

              {/* Tab 1: Google Sign-In */}
              {activeTab === 'google' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                  {isGoogleConfigured ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', width: '100%' }}>
                      <div ref={googleBtnRef} style={{ minHeight: '44px', display: 'flex', justifyContent: 'center' }}>
                        {/* Google Identity Services Button injects here */}
                      </div>
                      <p style={{ fontSize: '0.75rem', color: '#6b7280', margin: 0, textAlign: 'center' }}>
                        Secured with Google Identity Services & OAuth 2.0
                      </p>
                    </div>
                  ) : (
                    /* Not Configured Notice */
                    <div
                      style={{
                        width: '100%',
                        padding: '16px',
                        background: 'rgba(212, 175, 55, 0.05)',
                        border: '1px dashed rgba(212, 175, 55, 0.3)',
                        borderRadius: '12px',
                        textAlign: 'center',
                      }}
                    >
                      <Sparkles size={24} color="#fae084" style={{ marginBottom: '8px' }} />
                      <h4 style={{ margin: '0 0 6px', fontSize: '0.95rem', color: '#fae084' }}>
                        Google OAuth Setup
                      </h4>
                      <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: '#9ca3af', lineHeight: 1.4 }}>
                        To enable live Google Sign-In, configure your Google OAuth 2.0 Client ID in settings.
                      </p>
                      <button
                        type="button"
                        onClick={() => setActiveTab('settings')}
                        className="btn-secondary"
                        style={{ fontSize: '0.8rem', padding: '6px 14px' }}
                      >
                        <Settings size={14} color="#fae084" />
                        <span>Configure Client ID</span>
                      </button>
                    </div>
                  )}

                  {/* Divider */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      width: '100%',
                      margin: '6px 0',
                      gap: '12px',
                      color: 'rgba(255, 255, 255, 0.2)',
                      fontSize: '0.75rem',
                    }}
                  >
                    <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.1)' }} />
                    <span>OR INSTANT ACCESS</span>
                    <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.1)' }} />
                  </div>

                  {/* Dev / Quick Access Button */}
                  <button
                    type="button"
                    onClick={() => handleDevLogin('admin')}
                    className="btn-secondary"
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '10px',
                      padding: '12px',
                      background: 'rgba(255, 255, 255, 0.04)',
                      borderColor: 'rgba(212, 175, 55, 0.3)',
                      fontSize: '0.9rem',
                    }}
                    disabled={isLoading}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24">
                      <path
                        fill="#4285F4"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                      />
                    </svg>
                    <span>Sign in with Google (Demo / Dev Profile)</span>
                  </button>
                </div>
              )}

              {/* Tab 2: Password Login */}
              {activeTab === 'password' && (
                <form onSubmit={handlePasswordLogin} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: '6px' }}>
                      Username
                    </label>
                    <input
                      type="text"
                      className="input-field"
                      style={{ width: '100%' }}
                      placeholder="admin"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: '6px' }}>
                      Password
                    </label>
                    <input
                      type="password"
                      className="input-field"
                      style={{ width: '100%' }}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    className="btn-primary"
                    style={{ marginTop: '6px', width: '100%', justifyContent: 'center' }}
                    disabled={isLoading}
                  >
                    <Key size={16} />
                    <span>Authenticate</span>
                  </button>
                </form>
              )}

              {/* Tab 3: Google Client ID Settings */}
              {activeTab === 'settings' && (
                <form onSubmit={handleSaveClientId} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div
                    style={{
                      padding: '12px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.05)',
                      fontSize: '0.8rem',
                      color: '#9ca3af',
                      lineHeight: 1.4,
                    }}
                  >
                    Obtain a Client ID from{' '}
                    <a
                      href="https://console.cloud.google.com/apis/credentials"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#fae084', textDecoration: 'underline' }}
                    >
                      Google Cloud Console
                    </a>
                    . Add <code>http://localhost:5173</code> to Authorized JavaScript Origins.
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: '6px' }}>
                      Google OAuth 2.0 Client ID
                    </label>
                    <input
                      type="text"
                      className="input-field"
                      style={{ width: '100%', fontSize: '0.8rem', fontFamily: 'monospace' }}
                      placeholder="XXXXXX-XXXXXXXX.apps.googleusercontent.com"
                      value={clientIdInput}
                      onChange={(e) => setClientIdInput(e.target.value)}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      type="button"
                      onClick={() => setActiveTab('google')}
                      className="btn-secondary"
                      style={{ flex: 1, justifyContent: 'center' }}
                    >
                      <span>Back</span>
                    </button>
                    <button
                      type="submit"
                      className="btn-primary"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={isSavingConfig}
                    >
                      <span>Save Client ID</span>
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
