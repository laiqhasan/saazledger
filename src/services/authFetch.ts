/**
 * Central fetch wrapper for the SPA. installAuthFetch() patches window.fetch ONCE so that EVERY
 * same-origin /api call in the app (service layer and direct fetch() calls in components alike):
 *   - carries `Authorization: Bearer <token>` from the auth storage when the caller did not set one, and
 *   - on HTTP 401 for a request that carried a token, clears the stored session and broadcasts
 *     `saaz:session-expired` so AuthContext returns the user to the login screen;
 *   - on HTTP 403 with an ACCOUNT_* code (suspended/rejected/pending since login) broadcasts
 *     `saaz:account-state-changed` so AuthContext re-reads /api/auth/me and shows the right screen.
 * Third-party URLs (Google, OpenAI, Shopify CDN, ...) are never touched: the token never leaves our origin.
 * Login/exchange endpoints are exempt from session clearing (a wrong password is not an expired session).
 */
export const AUTH_TOKEN_KEY = 'saaz_auth_token';
export const AUTH_USER_KEY = 'saaz_auth_user';
export const SESSION_EXPIRED_EVENT = 'saaz:session-expired';
export const ACCOUNT_STATE_EVENT = 'saaz:account-state-changed';

const NO_SESSION_CLEAR = ['/api/auth/login', '/api/auth/google'];

function readToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem('saaz_token') || null;
  } catch {
    return null;
  }
}

/** Returns the same-origin path ('/api/...') if this request targets our own API, else null. */
export function sameOriginApiPath(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const u = new URL(raw, base);
    if (u.origin !== base) return null;
    return u.pathname.startsWith('/api/') || u.pathname === '/api' ? u.pathname : null;
  } catch {
    return null;
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  } catch {
    /* storage unavailable */
  }
}

let installed = false;

export function installAuthFetch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const apiPath = sameOriginApiPath(input);
    if (!apiPath) return nativeFetch(input, init);

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const token = readToken();
    let sentToken = false;
    if (headers.has('Authorization')) {
      sentToken = true;
    } else if (token) {
      headers.set('Authorization', `Bearer ${token}`);
      sentToken = true;
    }

    const res = await nativeFetch(input, { ...init, headers });

    if (sentToken && typeof window.dispatchEvent === 'function') {
      if (res.status === 401 && !NO_SESSION_CLEAR.some((p) => apiPath === p || apiPath.startsWith(p + '/'))) {
        clearStoredSession();
        window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      } else if (res.status === 403) {
        res
          .clone()
          .json()
          .then((b) => {
            if (typeof b?.code === 'string' && b.code.startsWith('ACCOUNT_')) {
              window.dispatchEvent(new Event(ACCOUNT_STATE_EVENT));
            }
          })
          .catch(() => {});
      }
    }
    return res;
  };
}
