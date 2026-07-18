/**
 * Runtime settings resolved from three layers:
 *
 *   OpenAI API key:  ~/zylos/.env (or process.env)  >  settings DB  >  none
 *   model / voice:   settings DB (admin UI)  >  config.json  >  defaults
 *
 * The env layer keeps existing key-in-.env deployments working untouched;
 * the DB layer lets a fresh install be configured entirely from the admin
 * page. The key is write-only at the API surface — GET never returns it.
 */

import { request as httpsRequest } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { callChatModel } from './llm.js';
import { DEFAULT_PROFILE_MODEL } from './profile.js';

export const MODEL_OPTIONS = ['gpt-realtime-2.1', 'gpt-realtime', 'gpt-realtime-mini'];
export const VOICE_OPTIONS = ['marin', 'cedar', 'coral', 'sage', 'shimmer', 'alloy', 'ash', 'ballad', 'echo', 'verse'];

const KEY_SETTING = 'openai_api_key';

export class Settings {
  constructor(store, getConfig, env) {
    this.store = store;
    this.getConfig = getConfig;
    this.env = env; // loadEnvSecrets() result: { openaiApiKey, proxy }
  }

  keySource() {
    if (this.env.openaiApiKey) return 'env';
    if (this.store.getSetting(KEY_SETTING)) return 'db';
    return 'none';
  }

  resolveKey() {
    return this.env.openaiApiKey || this.store.getSetting(KEY_SETTING) || '';
  }

  setKey(value) {
    this.store.setSetting(KEY_SETTING, value);
  }

  clearKey() {
    this.store.deleteSetting(KEY_SETTING);
  }

  resolveModel() {
    return this.store.getSetting('model') || this.getConfig().model || MODEL_OPTIONS[0];
  }

  resolveVoice() {
    return this.store.getSetting('voice') || this.getConfig().voice || VOICE_OPTIONS[0];
  }

  setModel(value) {
    this.store.setSetting('model', value);
  }

  setVoice(value) {
    this.store.setSetting('voice', value);
  }

  // ---- text models (profile updater 画像 / task digest 汇总) ----
  // Same layering as model/voice: settings DB > config.json > defaults.
  // The digest model falls back to the profile model when unset anywhere.

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

  /**
   * Verify a text model actually answers: one minimal chat-completions call
   * with the resolved key. Honors profileApiBase (E2E mocks / custom base).
   */
  async testTextModel(model) {
    const key = this.resolveKey();
    if (!key) return { ok: false, error: 'no_key' };
    try {
      await callChatModel({
        base: this.getConfig().profileApiBase,
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

  /** Cheap key + connectivity probe: GET /v1/models with the resolved key. */
  testConnection() {
    const key = this.resolveKey();
    if (!key) return Promise.resolve({ ok: false, error: 'no_key' });
    return new Promise(resolve => {
      const req = httpsRequest('https://api.openai.com/v1/models?limit=1', {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
        agent: this.env.proxy ? new HttpsProxyAgent(this.env.proxy) : undefined,
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
}
