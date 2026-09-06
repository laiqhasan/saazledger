import React, { useState, useEffect, useRef } from 'react';
import { Gem, ShieldCheck, AlertCircle, CheckCircle, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const LoginScreen: React.FC = () => {
  const {
    loginWithGoogle,
    devLogin,
    googleClientId,
    isGoogleConfigured,
    isLoading,
  } = useAuth();

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  // Load Google Identity Services (GIS)
  useEffect(() => {
    const initGoogle = () => {
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
                setSuccessMsg('Authentication verified. Welcome to Atelier OS.');
              } catch (err: any) {
                setErrorMsg(err.message || 'Google sign-in failed');
              }
            }
          },
          auto_select: false,
        });

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
        console.warn('GIS button render error:', err);
      }
    };

    if (!window.google?.accounts?.id) {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = initGoogle;
      document.body.appendChild(script);
    } else {
      initGoogle();
    }
  }, [googleClientId, isGoogleConfigured]);

  const handleDevLogin = async () => {
    setErrorMsg(null);
    try {
      await devLogin('hasan.laiq@gmail.com', 'Laiq Hasan', 'admin');
      setSuccessMsg('Signed in as Main Super Admin (hasan.laiq@gmail.com)!');
    } catch (err: any) {
      setErrorMsg(err.message || 'Developer login failed');
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        background: 'radial-gradient(circle at 50% 20%, #171b26 0%, #090c10 80%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        color: '#f3f4f6',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Decorative background glow */}
      <div
        style={{
          position: 'absolute',
          top: '15%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '500px',
          height: '350px',
          background: 'radial-gradient(ellipse, rgba(212, 175, 55, 0.12) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          width: '100%',
          maxWidth: '460px',
          background: 'linear-gradient(180deg, rgba(22, 27, 38, 0.95) 0%, rgba(13, 17, 23, 0.98) 100%)',
          borderRadius: '20px',
          border: '1px solid rgba(212, 175, 55, 0.3)',
          boxShadow: '0 30px 60px -12px rgba(0, 0, 0, 0.8), 0 0 40px rgba(212, 175, 55, 0.12)',
          backdropFilter: 'blur(20px)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 10,
        }}
      >
        {/* Top Header */}
        <div
          style={{
            padding: '36px 32px 24px',
            textAlign: 'center',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.25), rgba(212, 175, 55, 0.05))',
              border: '1px solid rgba(212, 175, 55, 0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '16px',
              boxShadow: '0 0 24px rgba(212, 175, 55, 0.25)',
            }}
          >
            <Gem size={30} color="#fae084" />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <h1
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: '1.65rem',
                fontWeight: 700,
                letterSpacing: '0.08em',
                background: 'linear-gradient(135deg, #ffffff 0%, #fae084 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                margin: 0,
              }}
            >
              SAAZ LEDGER
            </h1>
            <span
              style={{
                fontSize: '0.7rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
                background: 'rgba(212, 175, 55, 0.15)',
                color: '#fae084',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid rgba(212, 175, 55, 0.3)',
              }}
            >
              ATELIER OS
            </span>
          </div>

          <p style={{ fontSize: '0.82rem', color: '#9ca3af', margin: '4px 0 0', lineHeight: 1.4 }}>
            Bespoke Fashion Jewelry SKU & Profit Platform
          </p>
        </div>

        {/* Form Area */}
        <div style={{ padding: '28px 32px 36px' }}>
          {errorMsg && (
            <div
              style={{
                marginBottom: '20px',
                padding: '12px 16px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                color: '#f87171',
                fontSize: '0.85rem',
              }}
            >
              <AlertCircle size={18} />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div
              style={{
                marginBottom: '20px',
                padding: '12px 16px',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '10px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                color: '#34d399',
                fontSize: '0.85rem',
              }}
            >
              <CheckCircle size={18} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Google Single Sign-On Area */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
            <div
              style={{
                width: '100%',
                padding: '24px 20px',
                background: 'rgba(255, 255, 255, 0.02)',
                borderRadius: '14px',
                border: '1px solid rgba(212, 175, 55, 0.2)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '16px',
              }}
            >
              {/* Official Google Button */}
              <div ref={googleBtnRef} style={{ minHeight: '44px', display: 'flex', justifyContent: 'center' }}>
                {/* Google Identity Services button mounts here */}
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.78rem',
                  color: '#9ca3af',
                }}
              >
                <ShieldCheck size={14} color="#fae084" />
                <span>Restricted to authorized atelier accounts</span>
              </div>
            </div>

            {/* Instant Master Admin Shortcut */}
            <div style={{ width: '100%' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  margin: '8px 0 16px',
                  gap: '12px',
                  color: 'rgba(255, 255, 255, 0.2)',
                  fontSize: '0.72rem',
                  letterSpacing: '0.05em',
                }}
              >
                <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }} />
                <span>OR DIRECT MASTER ADMIN ACCESS</span>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255, 255, 255, 0.08)' }} />
              </div>

              <button
                type="button"
                onClick={handleDevLogin}
                className="btn-secondary"
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  padding: '12px',
                  background: 'rgba(212, 175, 55, 0.06)',
                  borderColor: 'rgba(212, 175, 55, 0.4)',
                  fontSize: '0.88rem',
                  color: '#fae084',
                  fontWeight: 600,
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
                <span>Sign in as Master Admin (hasan.laiq@gmail.com)</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer Security Badge */}
        <div
          style={{
            padding: '16px 24px',
            background: 'rgba(0, 0, 0, 0.4)',
            borderTop: '1px solid rgba(255, 255, 255, 0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            fontSize: '0.75rem',
            color: '#6b7280',
          }}
        >
          <Lock size={12} color="#fae084" />
          <span>Protected by Atelier RBAC • Enterprise Authentication Gate</span>
        </div>
      </div>
    </div>
  );
};
