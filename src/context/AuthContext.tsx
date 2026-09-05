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

  const [googleClientId, setGoogleClientId] = useState<string>('');
  const [isGoogleConfigured, setIsGoogleConfigured] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Fetch Google OAuth configuration from backend
  const refreshConfig = async () => {
    try {
      const res = await fetch('/api/auth/google/config');
      if (res.ok) {
        const data = await res.json();
        setGoogleClientId(data.clientId || '');
        setIsGoogleConfigured(Boolean(data.isConfigured));
      }
    } catch (err) {
      console.warn('Could not fetch Google auth config:', err);
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
        } else {
          // Token expired or invalid
          logout();
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
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
  };

  const loginWithGoogle = async (credential: string) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      });

      if (!res.ok) {
        let errMsg = 'Google authentication failed.';
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

  const devLogin = async (email?: string, name?: string, role?: string) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/google/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, role }),
      });

      if (!res.ok) {
        let errMsg = 'Developer login failed.';
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
    const res = await fetch('/api/auth/google/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ clientId: newClientId }),
    });

    if (!res.ok) {
      let errMsg = 'Failed to save Google Client ID.';
      try {
        const err = await res.json();
        if (err?.error) errMsg = err.error;
      } catch {
        if (res.status === 405) {
          errMsg = 'Server returned HTTP 405 Method Not Allowed. Backend server is currently deploying.';
        } else {
          errMsg = `Server error (HTTP ${res.status}).`;
        }
      }
      throw new Error(errMsg);
    }

    await refreshConfig();
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
