import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { SESSION_EXPIRED_EVENT, ACCOUNT_STATE_EVENT } from '../services/authFetch';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  email?: string;
  role: 'admin' | 'manager' | 'staff' | 'clerk' | 'viewer';
  status: 'pending' | 'active' | 'rejected' | 'suspended';
  avatarUrl?: string;
  authProvider?: string;
  approvedBy?: string;
  approvedAt?: string;
  createdAt?: string;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  googleClientId: string;
  isGoogleConfigured: boolean;
  loginWithGoogle: (credential: string) => Promise<void>;
  devLogin: (email?: string, name?: string, role?: string, status?: string) => Promise<void>;
  loginWithCredentials: (username: string, password: string) => Promise<void>;
  logout: () => void;
  updateGoogleClientId: (clientId: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = 'saaz_auth_token';
const USER_KEY = 'saaz_auth_user';
const GOOGLE_CLIENT_ID_STORAGE_KEY = 'saaz_google_client_id';
export const DEFAULT_GOOGLE_CLIENT_ID = '319932828190-1891h3n974u85qm4g1lq75nm3bhj76tf.apps.googleusercontent.com';

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
              status: data.user.status || 'active',
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

  // Central fetch wrapper events: expired/invalid session -> back to login; account state change -> re-read /me.
  useEffect(() => {
    const onExpired = () => {
      setToken(null);
      setUser(null);
    };
    const onAccountState = () => {
      refreshUser();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    window.addEventListener(ACCOUNT_STATE_EVENT, onAccountState);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.removeEventListener(ACCOUNT_STATE_EVENT, onAccountState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const refreshUser = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          const updatedUser: AuthUser = {
            id: data.user.id,
            username: data.user.username,
            fullName: data.user.fullName || data.user.full_name || 'User',
            email: data.user.email,
            role: data.user.role,
            status: data.user.status || 'active',
            avatarUrl: data.user.avatarUrl || data.user.avatar_url,
            authProvider: data.user.authProvider || data.user.auth_provider || 'google',
            approvedBy: data.user.approvedBy,
            approvedAt: data.user.approvedAt,
          };
          setUser(updatedUser);
          try {
            localStorage.setItem(USER_KEY, JSON.stringify(updatedUser));
          } catch {}
        }
      }
    } catch (err) {
      console.warn('Could not refresh user session:', err);
    }
  };

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
      // The server verifies the Google ID token and issues the ONLY session token the app accepts. There is
      // no client-side fallback session any more: a token the server did not sign is rejected with 401.
      let res: Response;
      try {
        res = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential }),
        });
      } catch {
        throw new Error('Could not reach the server. Please try again in a moment.');
      }
      if (!res.ok) {
        let msg = `Google sign-in failed (HTTP ${res.status}).`;
        try {
          const err = await res.json();
          if (err?.error) msg = err.error;
        } catch {}
        throw new Error(msg);
      }
      const data = await res.json();
      if (!data.token || !data.user) throw new Error('Google sign-in failed: malformed server response.');
      setSession(data.token, data.user);
    } finally {
      setIsLoading(false);
    }
  };

  const devLogin = async (email?: string, name?: string, role?: string, status?: string) => {
    setIsLoading(true);
    try {
      // Server-only dev helper (404 in production). No offline/demo token fallback.
      const res = await fetch('/api/auth/google/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, role, status }),
      });
      if (!res.ok) {
        throw new Error(res.status === 404 ? 'Developer login is disabled on this server.' : `Developer login failed (HTTP ${res.status}).`);
      }
      const data = await res.json();
      if (!data.token || !data.user) throw new Error('Developer login failed: malformed server response.');
      setSession(data.token, data.user);
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
        refreshUser,
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
