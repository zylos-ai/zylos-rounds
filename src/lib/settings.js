/**
 * Runtime settings over the v0.8 provider framework.
 *
 * Providers (DB table) own connection info: base URL, API key (write-only at
 * the API surface), capability flags (realtime WS / models listing). The
 * builtin 'openai' provider replaces the old implicit global connection; for
 * it — and only it — an OPENAI_API_KEY in ~/zylos/.env overrides the DB key,
 * keeping existing key-in-.env deployments working untouched.
 *
 * Usage slots (voice / profile / digest) reference a provider by slug via the
 * settings DB and fall back to the builtin. Model / voice resolution keeps
 * the existing layering: settings DB > config.json > defaults; the digest
 * model additionally falls back to the profile model.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { callChatModel } from './llm.js';
import { DEFAULT_PROFILE_MODEL } from './profile.js';
import { GEMINI_VOICES } from './gemini-live.js';

export const BUILTIN_PROVIDER = 'openai';
// Suggestions (datalist) — no longer a validation whitelist since v0.8.
export const MODEL_OPTIONS = ['gpt-realtime-2.1', 'gpt-realtime', 'gpt-realtime-mini', 'gemini-2.5-flash-native-audio-latest', 'gemini-3.1-flash-live-preview'];

/**
 * Wire protocol a provider speaks. Inferred from the base URL — a provider
 * pointed at generativelanguage.googleapis.com is Gemini (Live API WS +
 * ?key= auth + /v1beta/models); everything else is OpenAI-compatible.
 */
export function providerProtocol(provider) {
  return /generativelanguage\.googleapis\.com/i.test(provider?.base_url || '') ? 'gemini' : 'openai';
}

const GEMINI_WS_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const VOICE_OPTIONS = ['marin', 'cedar', 'coral', 'sage', 'shimmer', 'alloy', 'ash', 'ballad', 'echo', 'verse'];

export const SLOTS = ['voice', 'profile', 'digest'];

export class Settings {
  constructor(store, getConfig, env) {
    this.store = store;
    this.getConfig = getConfig;
    this.env = env; // loadEnvSecrets() result: { openaiApiKey, proxy }
  }

  // ---- providers ----

  builtinProvider() {
    return this.store.getProvider(BUILTIN_PROVIDER);
  }

  /** Effective key for a provider. Env key applies to the builtin only. */
  providerKey(provider) {
    if (!provider) return '';
    if (provider.is_builtin) return this.env.openaiApiKey || provider.api_key || '';
    return provider.api_key || '';
  }

  /** 'env' | 'db' | 'none' — where a provider's effective key comes from. */
  providerKeySource(provider) {
    if (!provider) return 'none';
    if (provider.is_builtin && this.env.openaiApiKey) return 'env';
    return provider.api_key ? 'db' : 'none';
  }

  // Legacy surface (builtin provider's key) — startup check + settings card.
  keySource() {
    return this.providerKeySource(this.builtinProvider());
  }

  resolveKey() {
    return this.providerKey(this.builtinProvider());
  }

  setKey(value) {
    this.store.updateProvider(BUILTIN_PROVIDER, { apiKey: value });
  }

  clearKey() {
    this.store.updateProvider(BUILTIN_PROVIDER, { apiKey: '' });
  }

  // ---- usage slots ----

  storedSlotProvider(slot) {
    return this.store.getSetting(`${slot}_provider`) || '';
  }

  setSlotProvider(slot, slug) {
    if (slug) this.store.setSetting(`${slot}_provider`, slug);
    else this.store.deleteSetting(`${slot}_provider`);
  }

  /** Provider row for a slot; unset or dangling references fall back to the builtin. */
  slotProvider(slot) {
    const slug = this.storedSlotProvider(slot);
    return (slug && this.store.getProvider(slug)) || this.builtinProvider();
  }

  // ---- models / voice (layering unchanged: DB > config.json > defaults) ----

  resolveModel() {
    return this.store.getSetting('model') || this.getConfig().model || MODEL_OPTIONS[0];
  }

  /**
   * Voice names are protocol-specific (OpenAI: marin/cedar/…, Gemini:
   * Puck/Charon/…). A single stored value is kept; when the voice slot's
   * provider speaks the other protocol, fall back to that protocol's default
   * so switching providers never sends an unknown voice upstream.
   */
  resolveVoice() {
    const stored = this.store.getSetting('voice') || this.getConfig().voice || '';
    if (providerProtocol(this.slotProvider('voice')) === 'gemini') {
      return GEMINI_VOICES.find(v => v.toLowerCase() === stored.toLowerCase()) || GEMINI_VOICES[0];
    }
    return VOICE_OPTIONS.includes(stored) ? stored : VOICE_OPTIONS[0];
  }

  setModel(value) {
    this.store.setSetting('model', value);
  }

  // ---- time zone (DB > config.json > Singapore default) ----

  storedTimeZone() {
    return this.store.getSetting('time_zone') || '';
  }

  defaultTimeZone() {
    return this.getConfig().timeZone || 'Asia/Singapore';
  }

  resolveTimeZone() {
    return this.storedTimeZone() || this.defaultTimeZone();
  }

  setTimeZone(value) {
    if (value) this.store.setSetting('time_zone', value);
    else this.store.deleteSetting('time_zone');
  }

  setVoice(value) {
    this.store.setSetting('voice', value);
  }

  storedProfileModel() {
    return this.store.getSetting('profile_model') || '';
  }

  storedDigestModel() {
    return this.store.getSetting('digest_model') || '';
  }

  defaultProfileModel() {
    return this.getConfig().profileModel || DEFAULT_PROFILE_MODEL;
  }

  defaultDigestModel() {
    return this.getConfig().digestModel || '';
  }

  resolveProfileModel() {
    return this.storedProfileModel() || this.defaultProfileModel();
  }

  resolveDigestModel() {
    return this.storedDigestModel() || this.defaultDigestModel() || this.resolveProfileModel();
  }

  setProfileModel(value) {
    if (value) this.store.setSetting('profile_model', value);
    else this.store.deleteSetting('profile_model');
  }

  setDigestModel(value) {
    if (value) this.store.setSetting('digest_model', value);
    else this.store.deleteSetting('digest_model');
  }

  // ---- resolved connections ----

  /** Everything the realtime relay needs to dial the voice session. */
  voiceConnection() {
    const provider = this.slotProvider('voice');
    const base = (provider?.base_url || 'https://api.openai.com').replace(/\/+$/, '');
    const protocol = providerProtocol(provider);
    return {
      provider,
      protocol,
      key: this.providerKey(provider),
      wsUrl: `${base.replace(/^http/i, 'ws')}${protocol === 'gemini' ? GEMINI_WS_PATH : '/v1/realtime'}`,
      model: this.resolveModel(),
      voice: this.resolveVoice(),
    };
  }

  /** Connection for one-shot text calls. kind: 'profile' | 'digest'. */
  textConnection(kind) {
    const provider = this.slotProvider(kind);
    return {
      provider,
      key: this.providerKey(provider),
      // profileApiBase remains a global test/E2E override for text calls
      base: this.getConfig().profileApiBase || provider?.base_url,
      model: kind === 'digest' ? this.resolveDigestModel() : this.resolveProfileModel(),
    };
  }

  // ---- probes ----

  /** Provider-protocol-aware models endpoint + auth (Gemini: ?key=, no Bearer). */
  modelsRequest(provider, key) {
    const base = (provider.base_url || '').replace(/\/+$/, '');
    return providerProtocol(provider) === 'gemini'
      ? { url: `${base}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`, headers: {}, base }
      : { url: `${base}/v1/models`, headers: { Authorization: `Bearer ${key}` }, base };
  }

  /** Cheap key + connectivity probe against a provider's models endpoint. */
  testConnection(provider = this.builtinProvider()) {
    const key = this.providerKey(provider);
    if (!key) return Promise.resolve({ ok: false, error: 'no_key' });
    const { url, headers, base } = this.modelsRequest(provider, key);
    return new Promise(resolve => {
      const doRequest = base.startsWith('https:') ? httpsRequest : httpRequest;
      const req = doRequest(url, {
        method: 'GET',
        headers,
        agent: base.startsWith('https:') && this.env.proxy ? new HttpsProxyAgent(this.env.proxy) : undefined,
        timeout: 10_000,
      }, res => {
        res.resume(); // drain — only the status matters
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true });
        else resolve({ ok: false, error: res.statusCode === 401 ? 'invalid_key' : `http_${res.statusCode}` });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.on('error', () => resolve({ ok: false, error: 'network' }));
      req.end();
    });
  }

  /** Fetch a provider's model list (OpenAI /v1/models or Gemini /v1beta/models). */
  listModels(provider) {
    const key = this.providerKey(provider);
    if (!key) return Promise.resolve({ ok: false, error: 'no_key' });
    const { url, headers, base } = this.modelsRequest(provider, key);
    const gemini = providerProtocol(provider) === 'gemini';
    return new Promise(resolve => {
      const doRequest = base.startsWith('https:') ? httpsRequest : httpRequest;
      const req = doRequest(url, {
        method: 'GET',
        headers,
        agent: base.startsWith('https:') && this.env.proxy ? new HttpsProxyAgent(this.env.proxy) : undefined,
        timeout: 15_000,
      }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({ ok: false, error: res.statusCode === 401 ? 'invalid_key' : `http_${res.statusCode}` });
          }
          try {
            const parsed = JSON.parse(data);
            const ids = gemini
              ? (parsed.models || []).map(m => (m.name || '').replace(/^models\//, '')).filter(Boolean).sort()
              : (parsed.data || []).map(m => m.id).filter(Boolean).sort();
            resolve({ ok: true, models: ids });
          } catch {
            resolve({ ok: false, error: 'bad_response' });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.on('error', () => resolve({ ok: false, error: 'network' }));
      req.end();
    });
  }

  /**
   * Verify a text model actually answers on a given provider: one minimal
   * chat-completions call. Honors the global profileApiBase E2E override.
   */
  async testTextModel(model, provider = this.builtinProvider()) {
    const key = this.providerKey(provider);
    if (!key) return { ok: false, error: 'no_key' };
    try {
      await callChatModel({
        base: this.getConfig().profileApiBase || provider?.base_url,
        model,
        key,
        prompt: '只回复两个字符：OK',
        proxy: this.env.proxy,
        timeoutMs: 30_000,
      });
      return { ok: true };
    } catch (err) {
      const m = String(err.message || '');
      if (m.includes('http_401')) return { ok: false, error: 'invalid_key' };
      if (m.includes('http_404') || m.includes('http_400')) return { ok: false, error: 'invalid_model' };
      if (m.includes('timeout')) return { ok: false, error: 'timeout' };
      return { ok: false, error: 'network' };
    }
  }
}
