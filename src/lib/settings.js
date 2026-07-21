/**
 * Runtime settings over the v0.8 provider framework.
 *
 * Providers (DB table) own connection info: base URL, API key (write-only at
 * the API surface), capability flags (realtime WS / models listing). All
 * keys live in the DB — set via the settings page or the provider API. A
 * legacy OPENAI_API_KEY in the process environment is copied into the
 * builtin provider's DB row once at startup (migrateLegacyEnvKey) and never
 * read at resolution time.
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
import * as chatgptOAuth from './chatgpt-oauth.js';

export const BUILTIN_PROVIDER = 'openai';
// auth_type values for a provider row.
export const AUTH_API_KEY = 'api_key';
export const AUTH_CHATGPT_OAUTH = 'chatgpt_oauth';
// Suggested models for a ChatGPT subscription provider (no backend list API).
export const CHATGPT_MODEL_OPTIONS = ['gpt-5.5', 'gpt-5.5-codex', 'gpt-5-codex'];
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

export const LANGUAGES = ['zh', 'en'];

export class Settings {
  constructor(store, getConfig, env) {
    this.store = store;
    this.getConfig = getConfig;
    this.env = env; // loadEnvSecrets() result: { openaiApiKey (legacy migration source), proxy }
  }

  // ---- providers ----

  builtinProvider() {
    return this.store.getProvider(BUILTIN_PROVIDER);
  }

  /** Effective key for a provider — always the DB value. */
  providerKey(provider) {
    return provider?.api_key || '';
  }

  /** 'db' | 'none' — whether a provider has a key stored. */
  providerKeySource(provider) {
    return provider?.api_key ? 'db' : 'none';
  }

  // ---- ChatGPT subscription providers (auth_type='chatgpt_oauth') ----

  /** Parsed OAuth token family for a provider row, or null. */
  providerOAuth(provider) {
    if (!provider?.oauth_json) return null;
    try { return JSON.parse(provider.oauth_json); }
    catch { return null; }
  }

  /** Non-secret connection status for the settings UI. */
  oauthStatus(provider) {
    return chatgptOAuth.tokenMeta(this.providerOAuth(provider));
  }

  /**
   * Return a usable access token for a chatgpt_oauth provider, refreshing (and
   * persisting the rotated family) when the current one is near expiry. A
   * single in-flight refresh per slug is shared so concurrent profile/digest
   * calls never trigger duplicate refreshes (which could race the rotation).
   */
  async ensureAccessToken(provider) {
    const oauth = this.providerOAuth(provider);
    if (!oauth?.access_token) throw new Error('provider not connected');
    if (!chatgptOAuth.needsRefresh(oauth)) {
      const meta = chatgptOAuth.tokenMeta(oauth);
      return { accessToken: oauth.access_token, accountId: meta.accountId };
    }
    if (!oauth.refresh_token) throw new Error('token expired and no refresh token');
    this._refreshInflight ??= new Map();
    if (!this._refreshInflight.has(provider.slug)) {
      const p = (async () => {
        const next = await chatgptOAuth.refreshTokens({ refreshToken: oauth.refresh_token, proxy: this.env.proxy });
        this.store.setProviderOAuth(provider.slug, next);
        const meta = chatgptOAuth.tokenMeta(next);
        return { accessToken: next.access_token, accountId: meta.accountId };
      })().finally(() => this._refreshInflight.delete(provider.slug));
      this._refreshInflight.set(provider.slug, p);
    }
    return this._refreshInflight.get(provider.slug);
  }

  disconnectOAuth(slug) {
    return this.store.setProviderOAuth(slug, null);
  }

  /**
   * One-shot legacy migration: copy OPENAI_API_KEY from the process
   * environment into the builtin provider's DB row, only if the row has no
   * key yet. Guarded by a settings flag so a later deliberate key clear is
   * never overwritten.
   */
  migrateLegacyEnvKey() {
    if (this.store.getSetting('env_key_migrated')) return false;
    this.store.setSetting('env_key_migrated', '1');
    const legacy = this.env.openaiApiKey || '';
    const builtin = this.builtinProvider();
    if (!legacy || !builtin || builtin.api_key) return false;
    this.store.updateProvider(BUILTIN_PROVIDER, { apiKey: legacy });
    return true;
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

  // ---- language (DB > config.json > zh). 'zh' | 'en' ----

  storedLanguage() {
    return this.store.getSetting('language') || '';
  }

  defaultLanguage() {
    return LANGUAGES.includes(this.getConfig().language) ? this.getConfig().language : 'zh';
  }

  /** Team default language — owner-facing output (digests) and member fallback. */
  resolveLanguage() {
    const stored = this.storedLanguage();
    return LANGUAGES.includes(stored) ? stored : this.defaultLanguage();
  }

  setLanguage(value) {
    if (value) this.store.setSetting('language', value);
    else this.store.deleteSetting('language');
  }

  /** A member's conversation/UI language: per-member value > team default. */
  memberLanguage(member) {
    return LANGUAGES.includes(member?.language) ? member.language : this.resolveLanguage();
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
    const authType = provider?.auth_type || AUTH_API_KEY;
    const model = kind === 'digest' ? this.resolveDigestModel() : this.resolveProfileModel();
    if (authType === AUTH_CHATGPT_OAUTH) {
      return {
        provider,
        authType,
        model,
        // A truthy `key` marks the slot as usable; the real bearer is minted
        // (and refreshed) per-call via getAuth so it is never stale.
        key: this.providerOAuth(provider)?.access_token ? 'oauth' : '',
        getAuth: () => this.ensureAccessToken(provider),
      };
    }
    return {
      provider,
      authType,
      key: this.providerKey(provider),
      // profileApiBase remains a global test/E2E override for text calls
      base: this.getConfig().profileApiBase || provider?.base_url,
      model,
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
        const chunks = [];
        res.on('data', c => { chunks.push(c); });
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
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
    const oauth = (provider?.auth_type === AUTH_CHATGPT_OAUTH);
    if (!oauth && !this.providerKey(provider)) return { ok: false, error: 'no_key' };
    if (oauth && !this.providerOAuth(provider)?.access_token) return { ok: false, error: 'not_connected' };
    try {
      await callChatModel({
        base: this.getConfig().profileApiBase || provider?.base_url,
        model,
        key: oauth ? 'oauth' : this.providerKey(provider),
        authType: provider?.auth_type || AUTH_API_KEY,
        getAuth: oauth ? () => this.ensureAccessToken(provider) : undefined,
        prompt: '只回复两个字符：OK',
        proxy: this.env.proxy,
        timeoutMs: 30_000,
      });
      return { ok: true };
    } catch (err) {
      const m = String(err.message || '');
      if (m.includes('http_401')) return { ok: false, error: oauth ? 'reconnect_needed' : 'invalid_key' };
      if (m.includes('http_404') || m.includes('http_400')) return { ok: false, error: 'invalid_model' };
      if (m.includes('timeout')) return { ok: false, error: 'timeout' };
      return { ok: false, error: 'network' };
    }
  }
}
