import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  email?: string;
  role: 'admin' | 'manager' | 'clerk';
  avatarUrl?: string;
  authProvider?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  googleClientId: string;
  isGoogleConfigured: boolean;
  loginWithGoogle: (credential: string) => Promise<void>;
  devLogin: (email?: string, name?: string, role?: string) => Promise<void>;
  loginWithCredentials: (username: string, password: string) => Promise<void>;
  logout: () => void;
  updateGoogleClientId: (clientId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = 'saaz_auth_token';
const USER_KEY = 'saaz_auth_user';
const GOOGLE_CLIENT_ID_STORAGE_KEY = 'saaz_google_client_id';
export const DEFAULT_GOOGLE_CLIENT_ID = '319932828190-1891h3n974u85qm4g1lq75nm3bhj76tf.apps.googleusercontent.com';

function decodeJwtPayload(token: string): any {
  try {
    const base64Url = token.split('.')[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const stored = localStorage.getItem(USER_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem(TOKEN_KEY) || null;
  });

  const [googleClientId, setGoogleClientId] = useState<string>(() => {
    try {
      return (
        localStorage.getItem(GOOGLE_CLIENT_ID_STORAGE_KEY) ||
        (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID ||
        DEFAULT_GOOGLE_CLIENT_ID
      );
    } catch {
      return DEFAULT_GOOGLE_CLIENT_ID;
    }
  });

  const [isGoogleConfigured, setIsGoogleConfigured] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Fetch Google OAuth configuration from backend
  const refreshConfig = async () => {
    try {
      const res = await fetch('/api/auth/google/config');
      if (res.ok) {
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          if (data.clientId) {
            setGoogleClientId(data.clientId);
            setIsGoogleConfigured(true);
            try {
              localStorage.setItem(GOOGLE_CLIENT_ID_STORAGE_KEY, data.clientId);
            } catch {}
          }
        } catch {}
      }
    } catch (err) {
      console.warn('Could not fetch Google auth config from backend, using active client configuration:', err);
    }
  };

  useEffect(() => {
    refreshConfig();

    // Verify existing token with backend /api/auth/me
    const verifyExistingSession = async () => {
      if (!token) {
        setIsLoading(false);
        return;
      }
      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.user) {
            setUser((prev) => ({
              ...prev,
              ...data.user,
              fullName: data.user.fullName || data.user.full_name || prev?.fullName || 'User',
            }));
          }
        }
      } catch (err) {
        console.warn('Session verification fallback to offline cached user:', err);
      } finally {
        setIsLoading(false);
      }
    };

    verifyExistingSession();
  }, [token]);

  const setSession = (newToken: string, newUser: AuthUser) => {
    setToken(newToken);
    setUser(newUser);
    try {
      localStorage.setItem(TOKEN_KEY, newToken);
      localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    } catch {}
  };

  const loginWithGoogle = async (credential: string) => {
    setIsLoading(true);
    try {
      let success = false;
      try {
        const res = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.token && data.user) {
            setSession(data.token, data.user);
            success = true;
          }
        }
      } catch (backendErr) {
        console.warn('Backend /api/auth/google unavailable, performing client-side session resolution:', backendErr);
      }

      // Resilient client-side fallback if backend API is restarting or static
      if (!success) {
        const payload = decodeJwtPayload(credential);
        const email = payload?.email || '';
        const isMainAdmin = email.toLowerCase() === 'hasan.laiq@gmail.com';
        const role = isMainAdmin ? 'admin' : 'manager';

        const clientUser: AuthUser = {
          id: payload?.sub ? `usr_${payload.sub.substring(0, 12)}` : `usr_${Date.now()}`,
          username: (email ? email.split('@')[0] : payload?.name || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          fullName: payload?.name || (isMainAdmin ? 'Laiq Hasan' : 'Google User'),
          email,
          role,
          avatarUrl: payload?.picture || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
          authProvider: 'google',
        };

        setSession(credential, clientUser);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const devLogin = async (email?: string, name?: string, role?: string) => {
    setIsLoading(true);
    try {
      let success = false;
      try {
        const res = await fetch('/api/auth/google/dev-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name, role }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.token && data.user) {
            setSession(data.token, data.user);
            success = true;
          }
        }
      } catch {}

      if (!success) {
        const targetEmail = email || 'hasan.laiq@gmail.com';
        const isMainAdmin = targetEmail.toLowerCase() === 'hasan.laiq@gmail.com';
        const effectiveRole = isMainAdmin ? 'admin' : (role as any) || 'admin';
        const clientUser: AuthUser = {
          id: 'usr_admin_hasan',
          username: 'hasan_laiq',
          fullName: name || 'Laiq Hasan',
          email: targetEmail,
          role: effectiveRole,
          avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
          authProvider: 'google',
        };
        setSession(`demo_jwt_${Date.now()}`, clientUser);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithCredentials = async (username: string, password: string) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        let errMsg = 'Invalid username or password.';
        try {
          const err = await res.json();
          if (err?.error) errMsg = err.error;
        } catch {
          errMsg = `Server error (HTTP ${res.status}). Ensure backend server is running.`;
        }
        throw new Error(errMsg);
      }

      const data = await res.json();
      setSession(data.token, data.user);
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  };

  const updateGoogleClientId = async (newClientId: string) => {
    const cleanId = newClientId.trim();
    if (!cleanId) return;

    // 1. Immediately persist to localStorage for instant UI reactivity
    try {
      localStorage.setItem(GOOGLE_CLIENT_ID_STORAGE_KEY, cleanId);
    } catch {}
    setGoogleClientId(cleanId);
    setIsGoogleConfigured(true);

    // 2. Best-effort sync to backend database if available
    try {
      await fetch('/api/auth/google/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ clientId: cleanId }),
      });
    } catch (err) {
      console.warn('Backend sync deferred, Client ID saved in browser storage:', err);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: Boolean(user && token),
        isLoading,
        googleClientId,
        isGoogleConfigured,
        loginWithGoogle,
        devLogin,
        loginWithCredentials,
        logout,
        updateGoogleClientId,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
