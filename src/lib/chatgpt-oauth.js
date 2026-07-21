/**
 * ChatGPT/Codex subscription provider — OAuth device-authorization flow and
 * the ChatGPT-backend model call. Verified end-to-end against the live
 * auth.openai.com / chatgpt.com backend on 2026-07-21.
 *
 * This module is deliberately stateless: it performs network round-trips and
 * decodes tokens, but never touches the DB. Token persistence and refresh
 * single-flight live in the settings layer (which owns the store).
 *
 * Design rationale (Howard, 07-21): each device-flow login mints a fresh,
 * independent token family. Rounds gets its own delegated subscription access
 * that a human can revoke independently (ChatGPT account → device management)
 * without disturbing their own Codex CLI login. We never read or write
 * ~/.codex/auth.json, so there is no refresh-token-rotation conflict.
 */

import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Public OAuth client id used by the Codex CLI's ChatGPT login. This is a
// public client (PKCE, no secret) — not a credential.
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const ISSUER = 'https://auth.openai.com';
// The device-flow API subpaths live under /api/accounts. An earlier probe of
// the bare /deviceauth/* paths hit a Cloudflare bot-challenge; the /api/accounts
// paths are the real API surface and pass cleanly from a server-side client.
const API_BASE = `${ISSUER}/api/accounts`;
export const VERIFICATION_URL = `${ISSUER}/codex/device`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Device-flow pollers and the refresh path are long-lived and run through a
 * proxy, so a single transient socket reset must not kill them. A 4xx that is
 * not a poll-pending status will never fix itself, so it fails fast.
 */
function isTransient(err) {
  const m = String(err?.message || '');
  const http = m.match(/http_(\d{3})/);
  if (http) {
    const code = Number(http[1]);
    return code === 429 || code >= 500;
  }
  return true; // ECONNRESET, TLS disconnect, timeout, non-JSON — all transient
}

/** One JSON round-trip. Rejects with `http_<status>: <body>` on non-2xx. */
function jsonOnce(url, { method = 'POST', headers = {}, body, proxy, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`http_${res.statusCode}: ${data.slice(0, 200)}`);
          err.status = res.statusCode;
          return reject(err);
        }
        try { resolve(data ? JSON.parse(data) : {}); }
        catch { reject(new Error('non-JSON response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** JSON round-trip with bounded transient-error retry. */
async function jsonWithRetry(url, opts, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await jsonOnce(url, opts); }
    catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isTransient(err)) throw err;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

// ---- token introspection (JWT claims, no verification — we only read
// non-secret metadata the backend put there) ----

export function decodeClaims(jwt) {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
  } catch { return {}; }
}

/** Non-secret metadata for the settings UI + the account-id request header. */
export function tokenMeta(oauth) {
  if (!oauth?.access_token) return { connected: false };
  const a = decodeClaims(oauth.access_token);
  const i = oauth.id_token ? decodeClaims(oauth.id_token) : {};
  const auth = i['https://api.openai.com/auth'] || a['https://api.openai.com/auth'] || {};
  const accountId = auth.chatgpt_account_id || null;
  return {
    connected: true,
    accountId,
    accountIdPrefix: accountId ? `${accountId.slice(0, 8)}…` : null,
    plan: auth.chatgpt_plan_type || null,
    email: i.email || null,
    expiresAt: a.exp ? new Date(a.exp * 1000).toISOString() : null,
    earliestRefreshAt: oauth.earliest_refresh_at || null,
  };
}

/** True when the access token is expired or within `skewSec` of expiry. */
export function needsRefresh(oauth, skewSec = 300) {
  if (!oauth?.access_token) return false;
  const a = decodeClaims(oauth.access_token);
  if (!a.exp) return false;
  return Date.now() >= (a.exp - skewSec) * 1000;
}

// ---- device authorization flow (RFC 8628 style) ----

/** Step 1 — obtain a user code + device_auth_id to show the human. */
export async function requestDeviceCode({ proxy } = {}) {
  const r = await jsonWithRetry(`${API_BASE}/deviceauth/usercode`, {
    body: JSON.stringify({ client_id: CLIENT_ID }),
    proxy,
  });
  return {
    deviceAuthId: r.device_auth_id,
    userCode: r.user_code,
    interval: Number(r.interval) || 5,
    expiresAt: r.expires_at || null,
    verificationUrl: VERIFICATION_URL,
  };
}

/**
 * Step 2 — poll until the human confirms (or the code expires). Returns the
 * authorization_code + PKCE verifier. `shouldStop()` lets the caller abort.
 */
export async function pollForAuthorization({ deviceAuthId, userCode, interval = 5, expiresAt, proxy, shouldStop }) {
  const deadline = expiresAt ? Date.parse(expiresAt) : Date.now() + 15 * 60_000;
  const body = JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode });
  while (Date.now() < deadline) {
    if (shouldStop && shouldStop()) throw new Error('cancelled');
    let res;
    try {
      res = await jsonOnce(`${API_BASE}/deviceauth/token`, { body, proxy });
    } catch (err) {
      // 403/404 = still pending; anything else transient → wait and retry.
      if (err.status && err.status !== 403 && err.status !== 404) throw err;
      await sleep(interval * 1000);
      continue;
    }
    return { authorizationCode: res.authorization_code, codeVerifier: res.code_verifier };
  }
  throw new Error('device code expired before confirmation');
}

/** Step 3 — exchange the authorization code for the token family. */
export async function exchangeAuthCode({ authorizationCode, codeVerifier, proxy }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const tokens = await jsonWithRetry(`${ISSUER}/oauth/token`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    proxy,
  });
  return normalizeTokens(tokens);
}

/** Refresh an access token from the stored refresh token. */
export async function refreshTokens({ refreshToken, proxy }) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  const tokens = await jsonWithRetry(`${ISSUER}/oauth/token`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    proxy,
  });
  // A refresh response may omit refresh_token (rotation not always returned) —
  // keep the previous one so we never lose the ability to refresh again.
  const next = normalizeTokens(tokens);
  if (!next.refresh_token) next.refresh_token = refreshToken;
  return next;
}

/** Keep only the fields we persist; stamp earliest_refresh_at if present. */
function normalizeTokens(t) {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    id_token: t.id_token,
    token_type: t.token_type || 'Bearer',
    earliest_refresh_at: t.earliest_refresh_at || null,
  };
}

// ---- model call (ChatGPT backend Responses API) ----

/**
 * One chat turn against the ChatGPT backend using an OAuth access token.
 * Maps the shared `prompt` string onto the Responses `input` shape, streams
 * the SSE response, and aggregates the assistant text. `onUsage` (optional)
 * receives a chat-completions-shaped usage object so cost tracking is uniform.
 */
export function callResponses({ accessToken, accountId, model, prompt, instructions, proxy, timeoutMs = 120_000, onUsage }) {
  const body = JSON.stringify({
    model,
    instructions: instructions || 'You are a helpful assistant.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    stream: true,
    store: false,
  });
  return new Promise((resolve, reject) => {
    const req = httpsRequest(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId || '',
        'OpenAI-Beta': 'responses=experimental',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        session_id: randomUUID(),
        'Content-Length': Buffer.byteLength(body),
      },
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`model http_${res.statusCode}: ${data.slice(0, 200)}`);
          err.status = res.statusCode;
          return reject(err);
        }
        try { resolve(aggregateSSE(data, onUsage)); }
        catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('model timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Aggregate a Responses SSE stream into plain text. We parse the JSON payload
 * of each `data:` line and concatenate output_text deltas; the terminal
 * `response.completed` event carries usage.
 */
function aggregateSSE(raw, onUsage) {
  let text = '';
  let done = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
      text += evt.delta;
    } else if (evt.type === 'response.output_text.done' && typeof evt.text === 'string') {
      done = evt.text; // authoritative final text for this content part
    } else if (evt.type === 'response.completed' && evt.response?.usage && onUsage) {
      try { onUsage(mapUsage(evt.response.usage)); } catch { /* accounting must not break the call */ }
    }
  }
  return (done || text).trim();
}

/** Responses usage → chat-completions usage shape (what recordTextUsage expects). */
function mapUsage(u) {
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
  };
}
