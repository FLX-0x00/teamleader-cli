import { credentials, saveTokens, readConfig } from './config.js';
import { notice } from './output.js';

export const BASE_URL = process.env.TEAMLEADER_API_BASE || 'https://api.focus.teamleader.eu';
export const AUTH_BASE = process.env.TEAMLEADER_AUTH_BASE || 'https://focus.teamleader.eu';

export class ApiError extends Error {
  constructor(message, { status, errors } = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export class AuthError extends Error {}

export async function exchangeToken(params) {
  const res = await fetch(`${AUTH_BASE}/oauth2/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthError(
      `token request failed (${res.status}): ${json.error_description || json.error || 'unknown error'}`
    );
  }
  return json;
}

async function refreshAccessToken() {
  const { clientId, clientSecret, refreshToken } = credentials();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new AuthError('not authenticated — run: tl auth login');
  }
  const tokens = await exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  saveTokens(tokens);
  return tokens.access_token;
}

export async function getAccessToken() {
  const creds = credentials();
  if (process.env.TEAMLEADER_ACCESS_TOKEN) return process.env.TEAMLEADER_ACCESS_TOKEN;
  if (!creds.accessToken && !creds.refreshToken) {
    throw new AuthError('not authenticated — run: tl auth login');
  }
  // refresh proactively when the token expires within a minute
  if (creds.expiresAt && creds.expiresAt - 60_000 < Date.now() && creds.refreshToken) {
    return refreshAccessToken();
  }
  return creds.accessToken;
}

const MAX_ATTEMPTS = 4;

/**
 * Call an API endpoint. Returns { status, json, headers }.
 * Handles 401 (token refresh + retry) and 429 (wait + retry) transparently.
 */
export async function apiCall(path, body, { verbose = false } = {}) {
  let token = await getAccessToken();
  let refreshed = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (verbose) {
      notice(`> POST ${BASE_URL}${path}`);
      notice(`> ${JSON.stringify(body ?? {})}`);
    }
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body && Object.keys(body).length ? JSON.stringify(body) : '{}',
      });
    } catch (e) {
      throw new ApiError(`network error calling ${path}: ${e.message}`);
    }

    if (res.status === 401 && !refreshed && !process.env.TEAMLEADER_ACCESS_TOKEN) {
      refreshed = true;
      token = await refreshAccessToken();
      continue;
    }
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      const wait = Number(res.headers.get('Retry-After')) || 5;
      notice(`rate limited — retrying in ${wait}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }

    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }

    if (!res.ok) {
      const messages = (json?.errors || [])
        .map((e) => e.title + (e.detail ? ` — ${e.detail}` : ''))
        .join('; ');
      throw new ApiError(`${path} failed (HTTP ${res.status})${messages ? ': ' + messages : ''}`, {
        status: res.status,
        errors: json?.errors,
      });
    }
    return { status: res.status, json, headers: res.headers };
  }
  throw new ApiError(`${path}: gave up after ${MAX_ATTEMPTS} attempts (rate limited)`);
}

/** Used by `auth status` and after login. */
export async function whoAmI() {
  const { json } = await apiCall('/users.me', {});
  return json?.data;
}

export function hasStoredAuth() {
  const cfg = readConfig();
  return !!(cfg.access_token || cfg.refresh_token || process.env.TEAMLEADER_ACCESS_TOKEN);
}
