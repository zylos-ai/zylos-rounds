/**
 * Shared one-shot chat-completions call, used by the profile updater (动态画像)
 * and the task digest generator. `base` override exists for E2E mocks.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Which failures are worth retrying: transient network/proxy errors, timeouts,
 * rate limits (429) and server errors (5xx). A 4xx (bad request / auth / not
 * found) will never fix itself on retry, so it fails fast.
 */
function isRetryable(err) {
  const m = String(err?.message || '');
  const http = m.match(/http_(\d{3})/);
  if (http) {
    const code = Number(http[1]);
    return code === 429 || code >= 500;
  }
  // Network resets, TLS socket disconnects, timeouts, truncated/non-JSON
  // responses — all transient.
  return true;
}

/** One request/response round-trip. Rejects on network / HTTP / parse errors. */
function callOnce({ base, model, key, prompt, proxy, timeoutMs, onUsage }) {
  const root = (base || 'https://api.openai.com').replace(/\/+$/, '');
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
  });
  const isHttps = root.startsWith('https:');
  const doRequest = isHttps ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = doRequest(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      agent: isHttps && proxy ? new HttpsProxyAgent(proxy) : undefined,
      timeout: timeoutMs,
    }, res => {
      // Accumulate raw bytes and decode once: per-chunk string concatenation
      // mangles multi-byte UTF-8 characters split across chunk boundaries.
      const chunks = [];
      res.on('data', c => { chunks.push(c); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`model http_${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (onUsage && parsed.usage) {
            try { onUsage(parsed.usage); } catch { /* accounting must not break the call */ }
          }
          resolve(parsed.choices?.[0]?.message?.content || '');
        } catch {
          reject(new Error('model returned non-JSON'));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('model timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Chat-completions call with bounded retry. `attempts` is the total number of
 * tries (default 1 = no retry, preserving prior behaviour); callers that own
 * an idempotent, overwrite-style result (digest / profile) pass a higher value
 * so a transient proxy hiccup recovers on its own instead of surfacing as a
 * user-facing failure. Only transient errors are retried (see isRetryable),
 * with a short linear backoff. `onUsage` (optional) receives the response's
 * usage object for cost tracking.
 */
export async function callChatModel({ base, model, key, prompt, proxy, timeoutMs = 60_000, onUsage, attempts = 1 }) {
  const total = Math.max(1, attempts | 0);
  let lastErr;
  for (let i = 0; i < total; i++) {
    try {
      return await callOnce({ base, model, key, prompt, proxy, timeoutMs, onUsage });
    } catch (err) {
      lastErr = err;
      if (i === total - 1 || !isRetryable(err)) throw err;
      console.warn(`[rounds] model call failed (attempt ${i + 1}/${total}), retrying: ${err.message}`);
      await sleep(500 * (i + 1)); // 500ms, then 1000ms, ...
    }
  }
  throw lastErr;
}
