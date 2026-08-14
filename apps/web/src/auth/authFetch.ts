import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig, loginRequest } from './msalConfig';

let msalInstance: PublicClientApplication | null = null;

export function setMsalInstance(instance: PublicClientApplication) {
  msalInstance = instance;
}

/* ─── In-memory token cache ───────────────────────────────────────────────
 * acquireTokenSilent() can take 200–800ms on every call even when the token
 * is still valid. We cache the result ourselves and only call MSAL when the
 * token is within 5 minutes of expiring (i.e., at most once per ~55 min).
 * ──────────────────────────────────────────────────────────────────────── */
let _cachedToken: string | null = null;
let _cachedTokenExpiry = 0;
let _pendingRefresh: Promise<string | null> | null = null;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export async function getAccessToken(): Promise<string | null> {
  if (!msalInstance) return null;

  // Return cached token if still valid
  if (_cachedToken && Date.now() < _cachedTokenExpiry) {
    return _cachedToken;
  }

  // Deduplicate concurrent refresh requests (don't call MSAL 5 times at once)
  if (_pendingRefresh) return _pendingRefresh;

  _pendingRefresh = (async () => {
    try {
      const account = msalInstance!.getActiveAccount() ?? msalInstance!.getAllAccounts()[0];
      if (!account) return null;

      const response = await msalInstance!.acquireTokenSilent({
        scopes: loginRequest.scopes,
        account,
      });

      _cachedToken = response.accessToken;
      _cachedTokenExpiry = response.expiresOn
        ? response.expiresOn.getTime() - TOKEN_REFRESH_BUFFER_MS
        : Date.now() + 55 * 60 * 1000; // fallback: 55 min
      return _cachedToken;
    } catch {
      _cachedToken = null;
      _cachedTokenExpiry = 0;
      return null;
    } finally {
      _pendingRefresh = null;
    }
  })();

  return _pendingRefresh;
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}
