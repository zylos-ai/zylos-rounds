/**
 * Model price table and cost math for usage tracking.
 *
 * Prices are USD per 1M tokens (except asrPerMinute, USD per audio minute),
 * verified against the official OpenAI/Google pricing pages on 2026-07-19.
 * Defaults can be overridden without a code change via the settings-DB key
 * `prices` (JSON, deep-merged over the defaults by model key) — official
 * price changes only need a settings edit.
 *
 * Model lookup is exact-first, then longest-prefix, so dated/`-latest`
 * variants (e.g. gemini-2.5-flash-native-audio-preview-12-2025) inherit the
 * family entry. Unknown models record usage with cost 0 rather than guessing.
 */

import { todayLocal } from './http-util.js';

const M = 1_000_000;

export const DEFAULT_PRICES = {
  // OpenAI Realtime (speech-to-speech)
  'gpt-realtime-2.1': { textIn: 4, textCached: 0.4, textOut: 24, audioIn: 32, audioCached: 0.4, audioOut: 64 },
  'gpt-realtime-2.1-mini': { textIn: 0.6, textCached: 0.06, textOut: 2.4, audioIn: 10, audioCached: 0.3, audioOut: 20 },
  'gpt-realtime-mini': { textIn: 0.6, textCached: 0.06, textOut: 2.4, audioIn: 10, audioCached: 0.3, audioOut: 20 },
  'gpt-realtime': { textIn: 4, textCached: 0.4, textOut: 16, audioIn: 32, audioCached: 0.4, audioOut: 64 },
  // Gemini Live (native audio) — no cached-input discount on these models
  'gemini-2.5-flash-native-audio': { textIn: 0.5, textOut: 2, audioIn: 3, audioOut: 12 },
  'gemini-3.1-flash-live': { textIn: 0.75, textOut: 4.5, audioIn: 3, audioOut: 12 },
  // OpenAI text (profile / digest slots)
  'gpt-5.5': { textIn: 5, textCached: 0.5, textOut: 30 },
  'gpt-5.1': { textIn: 1.25, textCached: 0.125, textOut: 10 },
  // ASR sidecar (OpenAI voice path input transcription), USD per minute
  'gpt-4o-transcribe': { asrPerMinute: 0.006 },
  'gpt-4o-mini-transcribe': { asrPerMinute: 0.003 },
  'gpt-realtime-whisper': { asrPerMinute: 0.006 },
  'whisper-1': { asrPerMinute: 0.006 },
};

/** Defaults merged with the settings-DB `prices` JSON override (per-model shallow merge). */
export function resolvePrices(store) {
  let override = null;
  try { override = JSON.parse(store.getSetting('prices') || 'null'); } catch { /* malformed override ignored */ }
  if (!override || typeof override !== 'object') return DEFAULT_PRICES;
  const merged = { ...DEFAULT_PRICES };
  for (const [model, entry] of Object.entries(override)) {
    if (entry && typeof entry === 'object') merged[model] = { ...merged[model], ...entry };
  }
  return merged;
}

/** Exact match, else the longest price-table key the model name starts with. */
export function priceFor(model, prices = DEFAULT_PRICES) {
  const name = String(model || '').replace(/^models\//, '');
  if (prices[name]) return prices[name];
  let best = null;
  for (const key of Object.keys(prices)) {
    if (name.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? prices[best] : null;
}

/**
 * Cost in USD for one usage row. Token fields follow the usage_log columns;
 * OpenAI-style input counts INCLUDE the cached portion (cached tokens are
 * billed at the cached rate, the remainder at the full rate). asrSeconds is
 * billed per minute on the separate ASR model.
 */
export function costUsd(u, prices = DEFAULT_PRICES) {
  const p = priceFor(u.model, prices);
  let cost = 0;
  if (p) {
    const cachedText = Math.min(u.cached_text || 0, u.input_text || 0);
    const cachedAudio = Math.min(u.cached_audio || 0, u.input_audio || 0);
    cost += ((u.input_text || 0) - cachedText) * (p.textIn || 0) / M;
    cost += cachedText * (p.textCached ?? p.textIn ?? 0) / M;
    cost += ((u.input_audio || 0) - cachedAudio) * (p.audioIn || 0) / M;
    cost += cachedAudio * (p.audioCached ?? p.audioIn ?? 0) / M;
    cost += (u.output_text || 0) * (p.textOut || 0) / M;
    cost += (u.output_audio || 0) * (p.audioOut || 0) / M;
  }
  if (u.asr_seconds > 0 && u.asr_model) {
    const ap = priceFor(u.asr_model, prices);
    if (ap?.asrPerMinute) cost += (u.asr_seconds / 60) * ap.asrPerMinute;
  }
  return cost;
}

/**
 * Record one chat-completions call (profile/digest slots) into usage_log.
 * Best-effort: accounting must never break the calling feature.
 */
export function recordTextUsage(store, { slot, provider, model, memberId = null, tz, usage }) {
  try {
    const row = {
      date: todayLocal(tz), slot,
      provider: provider?.slug || 'openai',
      model, member_id: memberId,
      input_text: usage.prompt_tokens || 0,
      cached_text: usage.prompt_tokens_details?.cached_tokens || 0,
      output_text: usage.completion_tokens || 0,
    };
    row.cost_usd = costUsd(row, resolvePrices(store));
    store.insertUsage(row);
  } catch (e) {
    console.error('[rounds] text usage log failed', e.message);
  }
}
