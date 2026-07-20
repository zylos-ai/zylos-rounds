/**
 * Shared one-shot chat-completions call, used by the profile updater (动态画像)
 * and the task digest generator. `base` override exists for E2E mocks.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';

/** `onUsage` (optional) receives the response's usage object for cost tracking. */
export function callChatModel({ base, model, key, prompt, proxy, timeoutMs = 60_000, onUsage }) {
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
