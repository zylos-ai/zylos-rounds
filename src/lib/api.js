/**
 * Admin REST API (session-protected) + member talk-session endpoint (token-auth).
 * All routes are root-internal; Caddy exposes them under /standup/*.
 */

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, readJsonBody, browserOrigin, todayLocal } from './http-util.js';
import { MODEL_OPTIONS, VOICE_OPTIONS, SLOTS, LANGUAGES, providerProtocol, AUTH_CHATGPT_OAUTH, CHATGPT_MODEL_OPTIONS } from './settings.js';
import * as chatgptOAuth from './chatgpt-oauth.js';
import { GEMINI_VOICES } from './gemini-live.js';
import { ONESHOT_CYCLE, currentCycleKey, cadenceLabel, parseDowSet } from './cycle.js';

const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'voice-samples');

const parseList = v => {
  try {
    const arr = JSON.parse(v || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};

const parseIdList = v => parseList(v).map(Number).filter(Number.isInteger);

function newToken() {
  return crypto.randomBytes(8).toString('base64url');
}

export class Api {
  constructor(store, auth, getConfig, settings, context, digests) {
    this.store = store;
    this.auth = auth;
    this.getConfig = getConfig;
    this.settings = settings;
    this.context = context;
    this.digests = digests;
  }

  // The whole admin surface is reachable by a human admin (session cookie) OR
  // by an agent with a bearer API key — roster, brain content, knowledge,
  // reports and settings alike. Owner's 2026-07-18 ruling: the API key is a
  // full management credential so agents can operate the app (via
  // scripts/cli.js) without touching the database; only the login itself
  // stays session-only. v0.18: keys are named DB rows only (sha256 at rest,
  // create/rotate/revoke via /api/tokens); a pre-v0.18 config.serviceToken
  // is migrated into the DB at startup.
  isManager(req) {
    if (this.auth.isAuthenticated(req)) return true;
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const tok = m && m[1].trim();
    if (!tok) return false;
    const row = this.store.getApiTokenByHash(
      crypto.createHash('sha256').update(tok).digest('hex'));
    if (!row) return false;
    this.store.touchApiToken(row.id);
    return true;
  }

  // publicOrigin covers TLS-terminating proxies that forward plain http
  // (X-Forwarded-Proto would otherwise mislabel the public https links).
  memberLink(req, token) {
    const origin = (this.getConfig().publicOrigin || '').replace(/\/+$/, '') || browserOrigin(req);
    return `${origin}/u/${token}`;
  }

  /**
   * Route an /api/* request. Returns true if handled.
   */
  async handle(req, res, url) {
    const p = url.pathname;

    // auth endpoints (no session required)
    if (p === '/api/auth/login') return this.auth.handleLogin(req, res), true;
    if (p === '/api/auth/logout') return this.auth.handleLogout(req, res), true;
    if (p === '/api/auth/me') {
      const date = todayLocal(this.settings.resolveTimeZone());
      sendJson(res, 200, { authenticated: this.auth.isAuthenticated(req), date });
      return true;
    }

    // member endpoint (token auth, no session). v0.7: every link is a
    // per-(task, member) token — including the built-in daily standup.
    if (p === '/api/talk/session' && req.method === 'GET') {
      const token = url.searchParams.get('token') || '';
      const ts = this.store.getTaskSessionByToken(token);
      if (!ts) return sendJson(res, 404, { error: 'invalid_token' }), true;
      const date = todayLocal(this.settings.resolveTimeZone());
      // today's existing record (if any) so the talk page can open in
      // "continue" mode showing the submitted summary instead of a cold start
      let prior = null;
      if (ts.task.is_builtin) {
        const rec = this.store.getReport(ts.member.id, date);
        if (rec) {
          prior = {
            status: rec.status,
            summary: rec.status === 'submitted' ? {
              yesterday: parseList(rec.yesterday), today: parseList(rec.today),
              blockers: parseList(rec.blockers), topics_for_meeting: parseList(rec.topics),
            } : null,
          };
        }
      } else {
        const cycleKey = ts.task.type === 'oneshot' ? ONESHOT_CYCLE : currentCycleKey(ts.task, date);
        const rec = cycleKey ? this.store.getCycleRecord(ts.task.id, ts.member.id, cycleKey) : null;
        if (rec) {
          prior = {
            status: rec.status,
            summary: rec.status === 'submitted'
              ? { summary: parseList(rec.summary), highlights: parseList(rec.highlights) }
              : null,
          };
        }
      }
      return sendJson(res, 200, {
        name: ts.member.name, is_test: Boolean(ts.member.is_test),
        language: this.settings.memberLanguage(ts.member),
        task: {
          id: ts.task.id, title: ts.task.title, type: ts.task.type,
          is_builtin: Boolean(ts.task.is_builtin),
        },
        date, prior,
      }), true;
    }

    if (!p.startsWith('/api/')) return false;

    // everything else under /api/ requires admin session OR bearer API key
    if (!this.isManager(req)) {
      return sendJson(res, 401, { error: 'unauthorized' }), true;
    }

    if (p === '/api/context' && req.method === 'GET') return this.getContext(res), true;
    if (p === '/api/context' && req.method === 'PUT') return await this.putContext(req, res), true;

    // id/name/context/profile only (no talk links) — compact brain view
    if (p === '/api/context/members' && req.method === 'GET') {
      return sendJson(res, 200, {
        members: this.store.listActiveMembers().map(mb => ({
          id: mb.id, name: mb.name, context: mb.context || '',
          profile: mb.profile || '', profile_updated_at: mb.profile_updated_at || null,
        })),
      }), true;
    }

    if (p === '/api/knowledge' && req.method === 'GET') return this.listKnowledge(res), true;
    if (p === '/api/knowledge' && req.method === 'POST') return await this.addKnowledge(req, res), true;
    if (p === '/api/knowledge/search' && req.method === 'GET') {
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 3));
      const hits = this.store.searchKnowledge(url.searchParams.get('q') || '', limit);
      return sendJson(res, 200, {
        results: hits.map(k => ({ id: k.id, title: k.title, content: k.content, tags: k.tags || '', updated_at: k.updated_at })),
      }), true;
    }

    let m = p.match(/^\/api\/knowledge\/(\d+)$/);
    if (m && req.method === 'PUT') return await this.updateKnowledge(req, res, Number(m[1])), true;
    if (m && req.method === 'DELETE') return this.deleteKnowledge(res, Number(m[1])), true;

    if (p === '/api/followups' && req.method === 'GET') return this.listFollowups(req, res, url), true;
    if (p === '/api/followups' && req.method === 'POST') return await this.addFollowup(req, res), true;
    m = p.match(/^\/api\/followups\/(\d+)$/);
    if (m && req.method === 'DELETE') return this.deleteFollowup(res, Number(m[1])), true;

    m = p.match(/^\/api\/members\/(\d+)\/context$/);
    if (m && req.method === 'PUT') return await this.putMemberContext(req, res, Number(m[1])), true;

    m = p.match(/^\/api\/members\/(\d+)\/profile$/);
    if (m && req.method === 'PUT') return await this.putMemberProfile(req, res, Number(m[1])), true;

    m = p.match(/^\/api\/members\/(\d+)\/language$/);
    if (m && req.method === 'PUT') return await this.putMemberLanguage(req, res, Number(m[1])), true;

    m = p.match(/^\/api\/members\/(\d+)\/name$/);
    if (m && req.method === 'PUT') return await this.putMemberName(req, res, Number(m[1])), true;

    if (p === '/api/members' && req.method === 'GET') return this.listMembers(req, res), true;
    if (p === '/api/members' && req.method === 'POST') return await this.addMember(req, res), true;

    m = p.match(/^\/api\/members\/(\d+)$/);
    if (m && req.method === 'DELETE') return this.removeMember(res, Number(m[1])), true;

    // ---- communication tasks ----
    if (p === '/api/tasks' && req.method === 'GET') return this.listTasks(req, res), true;
    if (p === '/api/tasks' && req.method === 'POST') return await this.createTask(req, res), true;

    // per-(task, member) link rotation — the only reset-token surface in v0.7
    m = p.match(/^\/api\/tasks\/(\d+)\/members\/(\d+)\/reset-token$/);
    if (m && req.method === 'POST') return this.resetTaskToken(req, res, Number(m[1]), Number(m[2])), true;

    m = p.match(/^\/api\/tasks\/(\d+)$/);
    if (m && req.method === 'GET') return this.taskDetail(req, res, Number(m[1]), url.searchParams.get('cycle')), true;
    if (m && req.method === 'PUT') return await this.updateTask(req, res, Number(m[1])), true;
    if (m && req.method === 'DELETE') return this.deleteTask(res, Number(m[1])), true;

    m = p.match(/^\/api\/tasks\/(\d+)\/digest$/);
    if (m && req.method === 'POST') return await this.triggerDigest(req, res, Number(m[1])), true;

    m = p.match(/^\/api\/tasks\/(\d+)\/(close|reopen)$/);
    if (m && req.method === 'POST') return this.setTaskStatus(res, Number(m[1]), m[2]), true;

    if (p === '/api/reports/history' && req.method === 'GET') return this.history(res), true;

    m = p.match(/^\/api\/reports\/(\d{4}-\d{2}-\d{2})$/);
    if (m && req.method === 'GET') return this.dayReport(res, m[1]), true;

    if (p === '/api/providers' && req.method === 'GET') return this.listProviders(res), true;
    if (p === '/api/providers' && req.method === 'POST') return await this.createProvider(req, res), true;

    m = p.match(/^\/api\/providers\/([a-z0-9-]+)$/);
    if (m && req.method === 'PUT') return await this.updateProvider(req, res, m[1]), true;
    if (m && req.method === 'DELETE') return this.deleteProvider(res, m[1]), true;

    m = p.match(/^\/api\/providers\/([a-z0-9-]+)\/models$/);
    if (m && req.method === 'GET') return await this.providerModels(res, m[1]), true;

    m = p.match(/^\/api\/providers\/([a-z0-9-]+)\/test$/);
    if (m && req.method === 'POST') return await this.testProvider(req, res, m[1]), true;

    // ChatGPT subscription device-flow connect (RFC 8628-style).
    m = p.match(/^\/api\/providers\/([a-z0-9-]+)\/oauth\/start$/);
    if (m && req.method === 'POST') return await this.oauthStart(res, m[1]), true;
    m = p.match(/^\/api\/providers\/([a-z0-9-]+)\/oauth\/status$/);
    if (m && req.method === 'GET') return this.oauthStatus(res, m[1]), true;
    m = p.match(/^\/api\/providers\/([a-z0-9-]+)\/oauth\/disconnect$/);
    if (m && req.method === 'POST') return this.oauthDisconnect(res, m[1]), true;

    if (p === '/api/settings' && req.method === 'GET') return this.getSettings(res), true;
    if (p === '/api/settings' && req.method === 'PUT') return await this.putSettings(req, res), true;
    if (p === '/api/settings/test-connection' && req.method === 'POST') {
      return sendJson(res, 200, await this.settings.testConnection()), true;
    }
    if (p === '/api/settings/test-text-model' && req.method === 'POST') {
      return await this.testTextModel(req, res), true;
    }

    m = p.match(/^\/api\/settings\/voice-sample\/([A-Za-z]+)$/);
    if (m && req.method === 'GET') return this.voiceSample(res, m[1], url.searchParams.get('model')), true;

    if (p === '/api/usage' && req.method === 'GET') return this.getUsage(res, url), true;

    if (p === '/api/tokens' && req.method === 'GET') return this.listTokens(res), true;
    if (p === '/api/tokens' && req.method === 'POST') return await this.createToken(req, res), true;

    m = p.match(/^\/api\/tokens\/(\d+)\/rotate$/);
    if (m && req.method === 'POST') return this.rotateToken(res, Number(m[1])), true;

    m = p.match(/^\/api\/tokens\/(\d+)$/);
    if (m && req.method === 'DELETE') return this.revokeToken(res, Number(m[1])), true;

    sendJson(res, 404, { error: 'not_found' });
    return true;
  }

  // ---- management API tokens (v0.17) ----

  listTokens(res) {
    sendJson(res, 200, { tokens: this.store.listApiTokens() });
  }

  async createToken(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const name = String(body.name || '').trim();
    if (!name || name.length > 60) return sendJson(res, 400, { error: 'invalid_name' });
    if (this.store.getApiTokenByName(name)) return sendJson(res, 409, { error: 'name_taken' });
    const plaintext = `rk_${crypto.randomBytes(24).toString('base64url')}`;
    const row = this.store.createApiToken(
      name, crypto.createHash('sha256').update(plaintext).digest('hex'));
    // the plaintext is shown exactly once — only its hash is stored
    sendJson(res, 201, { ...row, token: plaintext });
  }

  rotateToken(res, id) {
    if (!this.store.getApiToken(id)) return sendJson(res, 404, { error: 'not_found' });
    const plaintext = `rk_${crypto.randomBytes(24).toString('base64url')}`;
    const row = this.store.rotateApiToken(
      id, crypto.createHash('sha256').update(plaintext).digest('hex'));
    sendJson(res, 200, { ...row, token: plaintext });
  }

  revokeToken(res, id) {
    if (!this.store.deleteApiToken(id)) return sendJson(res, 404, { error: 'not_found' });
    sendJson(res, 200, { ok: true, revoked: id });
  }

  // Pre-generated wav samples (scripts/generate-voice-samples.mjs and
  // scripts/generate-gemini-voice-samples.mjs); the voice-list check doubles
  // as path sanitization for the file read. The same voice name sounds
  // different per model (notably across Gemini Live models), so samples live
  // in per-model subdirectories with the flat file as fallback; the model
  // name is whitelisted to a path-safe charset before touching the fs.
  voiceSample(res, voice, model) {
    if (!VOICE_OPTIONS.includes(voice) && !GEMINI_VOICES.includes(voice)) {
      return sendJson(res, 404, { error: 'not_found' });
    }
    const modelDir = (model || this.settings.resolveModel()).replace(/^models\//, '');
    const candidates = /^[A-Za-z0-9._-]+$/.test(modelDir) && !modelDir.includes('..')
      ? [path.join(SAMPLES_DIR, modelDir, `${voice}.wav`), path.join(SAMPLES_DIR, `${voice}.wav`)]
      : [path.join(SAMPLES_DIR, `${voice}.wav`)];
    let data;
    for (const file of candidates) {
      try {
        data = readFileSync(file);
        break;
      } catch { /* try next */ }
    }
    if (!data) return sendJson(res, 404, { error: 'sample_missing' });
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(data);
  }

  // ---- usage/cost (v0.11) ----

  /** Month rollup for the admin 用量与成本 card. ?month=YYYY-MM, default current. */
  getUsage(res, url) {
    const tz = this.settings.resolveTimeZone();
    const today = todayLocal(tz);
    const month = url.searchParams.get('month') || today.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return sendJson(res, 400, { error: 'invalid_month' });
    sendJson(res, 200, this.store.usageSummary(month, today));
  }

  // ---- providers (v0.8) ----

  // Keys are write-only: the view exposes only where a key comes from.
  providerView(p) {
    const authType = p.auth_type || 'api_key';
    return {
      slug: p.slug,
      name: p.name,
      base_url: p.base_url,
      auth_type: authType,
      key_source: this.settings.providerKeySource(p), // 'db' | 'none'
      // ChatGPT subscription providers expose their (non-secret) connection
      // status instead of a key source.
      oauth: authType === AUTH_CHATGPT_OAUTH ? this.settings.oauthStatus(p) : undefined,
      cap_realtime: Boolean(p.cap_realtime),
      cap_models: Boolean(p.cap_models),
      protocol: providerProtocol(p),
      is_builtin: Boolean(p.is_builtin),
      in_use: SLOTS.filter(s => this.settings.slotProvider(s)?.slug === p.slug),
    };
  }

  listProviders(res) {
    sendJson(res, 200, { providers: this.store.listProviders().map(p => this.providerView(p)) });
  }

  /** Validate + normalize provider body fields shared by create/update. */
  providerFields(body) {
    const out = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 64) return { error: 'invalid_name' };
      out.name = name;
    }
    if (body.base_url !== undefined) {
      const baseUrl = String(body.base_url).trim().replace(/\/+$/, '');
      if (!/^https?:\/\/\S+$/.test(baseUrl) || baseUrl.length > 256) return { error: 'invalid_base_url' };
      out.baseUrl = baseUrl;
    }
    if (body.clear_api_key === true) out.apiKey = '';
    else if (body.api_key !== undefined) {
      const key = String(body.api_key).trim();
      if (key.length > 512) return { error: 'invalid_key' };
      out.apiKey = key;
    }
    if (body.cap_realtime !== undefined) out.capRealtime = Boolean(body.cap_realtime);
    if (body.cap_models !== undefined) out.capModels = Boolean(body.cap_models);
    return { fields: out };
  }

  async createProvider(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    // ChatGPT subscription provider: no static key, no base URL to enter, and
    // no realtime/list capabilities. Auth is established afterwards via the
    // device-flow connect endpoints; base_url is informational only.
    if (body.auth_type === AUTH_CHATGPT_OAUTH) {
      const name = String(body.name || '').trim();
      if (!name || name.length > 64) return sendJson(res, 400, { error: 'invalid_name' });
      let slug = body.slug !== undefined ? String(body.slug).trim()
        : (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'chatgpt');
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) return sendJson(res, 400, { error: 'invalid_slug' });
      if (this.store.getProvider(slug)) {
        if (body.slug !== undefined) return sendJson(res, 409, { error: 'slug_taken' });
        const base = slug; for (let n = 2; this.store.getProvider(slug); n++) slug = `${base}-${n}`;
      }
      const created = this.store.createProvider({
        slug, name, baseUrl: chatgptOAuth.ISSUER,
        authType: AUTH_CHATGPT_OAUTH, capRealtime: false, capModels: false,
      });
      return sendJson(res, 201, this.providerView(created));
    }
    const { fields, error } = this.providerFields(body);
    if (error) return sendJson(res, 400, { error });
    if (!fields.name || !fields.baseUrl) return sendJson(res, 400, { error: fields.name ? 'invalid_base_url' : 'invalid_name' });

    let slug;
    if (body.slug !== undefined) {
      slug = String(body.slug).trim();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) return sendJson(res, 400, { error: 'invalid_slug' });
      if (this.store.getProvider(slug)) return sendJson(res, 409, { error: 'slug_taken' });
    } else {
      const base = fields.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'provider';
      slug = base;
      for (let n = 2; this.store.getProvider(slug); n++) slug = `${base}-${n}`;
    }
    const created = this.store.createProvider({ slug, ...fields });
    return sendJson(res, 201, this.providerView(created));
  }

  async updateProvider(req, res, slug) {
    const provider = this.store.getProvider(slug);
    if (!provider) return sendJson(res, 404, { error: 'not_found' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const { fields, error } = this.providerFields(body);
    if (error) return sendJson(res, 400, { error });
    // The builtin's identity is fixed; only its key is editable.
    if (provider.is_builtin && (fields.name !== undefined || fields.baseUrl !== undefined
      || fields.capRealtime !== undefined || fields.capModels !== undefined)) {
      return sendJson(res, 400, { error: 'builtin_readonly' });
    }
    const updated = this.store.updateProvider(slug, fields);
    return sendJson(res, 200, this.providerView(updated));
  }

  // Owner's ruling: a referenced provider cannot be deleted — change the
  // referencing slots first. The response names them.
  deleteProvider(res, slug) {
    const provider = this.store.getProvider(slug);
    if (!provider) return sendJson(res, 404, { error: 'not_found' });
    if (provider.is_builtin) return sendJson(res, 400, { error: 'builtin' });
    const slots = SLOTS.filter(s => this.settings.storedSlotProvider(s) === slug);
    if (slots.length) return sendJson(res, 400, { error: 'in_use', slots });
    this.store.deleteProvider(slug);
    res.writeHead(204);
    res.end();
  }

  async providerModels(res, slug) {
    const provider = this.store.getProvider(slug);
    if (!provider) return sendJson(res, 404, { error: 'not_found' });
    if (!provider.cap_models) return sendJson(res, 400, { error: 'not_supported' });
    return sendJson(res, 200, await this.settings.listModels(provider));
  }

  /** body.model: probe that model; without one, probe the models endpoint. */
  async testProvider(req, res, slug) {
    const provider = this.store.getProvider(slug);
    if (!provider) return sendJson(res, 404, { error: 'not_found' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const model = String(body.model || '').trim();
    if (model.length > 128) return sendJson(res, 400, { error: 'invalid_model' });
    if (model) return sendJson(res, 200, await this.settings.testTextModel(model, provider));
    if (!provider.cap_models) return sendJson(res, 400, { error: 'model_required' });
    return sendJson(res, 200, await this.settings.testConnection(provider));
  }

  // ---- ChatGPT subscription device-flow connect (v0.24) ----
  //
  // A per-slug in-memory session holds the pending device authorization while
  // the human confirms on another device. A background poll exchanges the code
  // for tokens on confirmation and persists the family; the UI polls
  // oauth/status. The session is ephemeral — a restart mid-connect just means
  // the user clicks "connect" again.

  async oauthStart(res, slug) {
    const provider = this.store.getProvider(slug);
    if (!provider) return sendJson(res, 404, { error: 'not_found' });
    if (provider.auth_type !== AUTH_CHATGPT_OAUTH) return sendJson(res, 400, { error: 'not_oauth_provider' });
    this._oauthSessions ??= new Map();
    let dc;
    try {
      dc = await chatgptOAuth.requestDeviceCode({ proxy: this.settings.env.proxy });
    } catch (err) {
      return sendJson(res, 502, { error: 'device_code_failed', detail: String(err.message || '').slice(0, 160) });
    }
    const session = { state: 'pending', userCode: dc.userCode, verificationUrl: dc.verificationUrl, expiresAt: dc.expiresAt, error: null };
    this._oauthSessions.set(slug, session);
    // Background poll → exchange → persist. Fire-and-forget; status endpoint reports progress.
    (async () => {
      try {
        const { authorizationCode, codeVerifier } = await chatgptOAuth.pollForAuthorization({
          deviceAuthId: dc.deviceAuthId, userCode: dc.userCode, interval: dc.interval,
          expiresAt: dc.expiresAt, proxy: this.settings.env.proxy,
          shouldStop: () => this._oauthSessions.get(slug) !== session,
        });
        const tokens = await chatgptOAuth.exchangeAuthCode({ authorizationCode, codeVerifier, proxy: this.settings.env.proxy });
        this.store.setProviderOAuth(slug, tokens);
        session.state = 'connected';
      } catch (err) {
        session.state = 'error';
        session.error = String(err.message || 'failed').slice(0, 160);
      }
    })();
    return sendJson(res, 200, { user_code: dc.userCode, verification_url: dc.verificationUrl, expires_at: dc.expiresAt });
  }

  oauthStatus(res, slug) {
    const provider = this.store.getProvider(slug);
    if (!provider) return sendJson(res, 404, { error: 'not_found' });
    if (provider.auth_type !== AUTH_CHATGPT_OAUTH) return sendJson(res, 400, { error: 'not_oauth_provider' });
    const session = this._oauthSessions?.get(slug);
    const status = this.settings.oauthStatus(provider);
    // A persisted token family always reports connected, regardless of any
    // stale pending session.
    if (status.connected) return sendJson(res, 200, { state: 'connected', ...status });
    if (session) return sendJson(res, 200, { state: session.state, user_code: session.userCode, verification_url: session.verificationUrl, expires_at: session.expiresAt, error: session.error });
    return sendJson(res, 200, { state: 'idle', connected: false });
  }

  oauthDisconnect(res, slug) {
    const provider = this.store.getProvider(slug);
    if (!provider) return sendJson(res, 404, { error: 'not_found' });
    if (provider.auth_type !== AUTH_CHATGPT_OAUTH) return sendJson(res, 400, { error: 'not_oauth_provider' });
    this._oauthSessions?.delete(slug);
    this.settings.disconnectOAuth(slug);
    return sendJson(res, 200, { state: 'idle', connected: false });
  }

  // The key itself is write-only: GET exposes only whether/where one is set.
  getSettings(res) {
    sendJson(res, 200, {
      openai_key_source: this.settings.keySource(), // builtin provider: 'db' | 'none'
      model: this.settings.resolveModel(),
      voice: this.settings.resolveVoice(),
      model_options: MODEL_OPTIONS, // suggestions only since v0.8
      chatgpt_model_options: CHATGPT_MODEL_OPTIONS, // suggestions for subscription providers
      voice_options: VOICE_OPTIONS,
      gemini_voice_options: GEMINI_VOICES,
      // team default language: stored value ('' = unset, default applies)
      language: this.settings.storedLanguage(),
      language_default: this.settings.defaultLanguage(),
      language_effective: this.settings.resolveLanguage(),
      // time zone: stored value ('' = unset, default applies) + layering info
      time_zone: this.settings.storedTimeZone(),
      time_zone_default: this.settings.defaultTimeZone(),
      time_zone_effective: this.settings.resolveTimeZone(),
      // usage slots: stored provider slug ('' = default builtin) + effective slug
      voice_provider: this.settings.storedSlotProvider('voice'),
      profile_provider: this.settings.storedSlotProvider('profile'),
      digest_provider: this.settings.storedSlotProvider('digest'),
      voice_provider_effective: this.settings.slotProvider('voice')?.slug,
      profile_provider_effective: this.settings.slotProvider('profile')?.slug,
      digest_provider_effective: this.settings.slotProvider('digest')?.slug,
      // text models: stored value ('' = unset, defaults apply) + what applies then
      profile_model: this.settings.storedProfileModel(),
      digest_model: this.settings.storedDigestModel(),
      profile_model_default: this.settings.defaultProfileModel(),
      digest_model_default: this.settings.defaultDigestModel(),
      profile_model_effective: this.settings.resolveProfileModel(),
      digest_model_effective: this.settings.resolveDigestModel(),
    });
  }

  async putSettings(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    if (body.model !== undefined) {
      const v = String(body.model).trim();
      if (!v || v.length > 128) return sendJson(res, 400, { error: 'invalid_model' });
      this.settings.setModel(v);
    }
    if (body.voice !== undefined) {
      if (!VOICE_OPTIONS.includes(body.voice) && !GEMINI_VOICES.includes(body.voice)) {
        return sendJson(res, 400, { error: 'invalid_voice' });
      }
      this.settings.setVoice(body.voice);
    }
    // '' reverts to the default (config.json > zh)
    if (body.language !== undefined) {
      const v = String(body.language).trim();
      if (v && !LANGUAGES.includes(v)) return sendJson(res, 400, { error: 'invalid_language' });
      this.settings.setLanguage(v);
    }
    // '' reverts to the default (config.json > Asia/Singapore)
    if (body.time_zone !== undefined) {
      const tz = String(body.time_zone).trim();
      if (tz) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
        } catch {
          return sendJson(res, 400, { error: 'invalid_time_zone' });
        }
      }
      this.settings.setTimeZone(tz);
    }
    // usage slots: '' reverts to the default (builtin) provider
    for (const slot of SLOTS) {
      const field = `${slot}_provider`;
      if (body[field] === undefined) continue;
      const slug = String(body[field]).trim();
      if (slug) {
        const provider = this.store.getProvider(slug);
        if (!provider) return sendJson(res, 400, { error: 'unknown_provider' });
        if (slot === 'voice' && !provider.cap_realtime) return sendJson(res, 400, { error: 'not_realtime_capable' });
      }
      this.settings.setSlotProvider(slot, slug);
    }
    if (body.profile_model !== undefined) {
      const v = String(body.profile_model).trim();
      if (v.length > 128) return sendJson(res, 400, { error: 'invalid_model' });
      this.settings.setProfileModel(v); // '' reverts to default
    }
    if (body.digest_model !== undefined) {
      const v = String(body.digest_model).trim();
      if (v.length > 128) return sendJson(res, 400, { error: 'invalid_model' });
      this.settings.setDigestModel(v); // '' reverts to following the profile model
    }
    if (body.clear_openai_key === true) {
      this.settings.clearKey();
    } else if (body.openai_key !== undefined) {
      const key = String(body.openai_key).trim();
      if (!key || key.length > 512) return sendJson(res, 400, { error: 'invalid_key' });
      this.settings.setKey(key);
    }
    return this.getSettings(res);
  }

  /**
   * Probe a text model with one minimal completion. body.model defaults to
   * the effective profile model; body.provider (slug) to the builtin.
   */
  async testTextModel(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const model = String(body.model || '').trim() || this.settings.resolveProfileModel();
    if (model.length > 128) return sendJson(res, 400, { error: 'invalid_model' });
    let provider;
    if (body.provider !== undefined && String(body.provider).trim()) {
      provider = this.store.getProvider(String(body.provider).trim());
      if (!provider) return sendJson(res, 400, { error: 'unknown_provider' });
    }
    return sendJson(res, 200, await this.settings.testTextModel(model, provider ?? undefined));
  }

  // ---- agent context containers (background + probing + profile instruction) ----
  getContext(res) {
    sendJson(res, 200, {
      team_background: this.store.getContext('team_background') || '',
      probing_guidance: this.store.getContext('probing_guidance') || '',
      profile_instruction: this.store.getContext('profile_instruction') || '',
    });
  }

  async putContext(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    for (const key of ['team_background', 'probing_guidance', 'profile_instruction']) {
      if (body[key] === undefined) continue;
      const v = String(body[key]);
      if (v.length > 20000) return sendJson(res, 400, { error: 'too_long' });
      this.store.setContext(key, v);
    }
    return this.getContext(res);
  }

  async putMemberContext(req, res, id) {
    const member = this.store.getMemberById(id);
    if (!member) return sendJson(res, 404, { error: 'not_found' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const v = body.context === undefined || body.context === null ? '' : String(body.context);
    if (v.length > 8000) return sendJson(res, 400, { error: 'too_long' });
    this.store.setMemberContext(id, v || null);
    sendJson(res, 200, { id, context: v });
  }

  // '' reverts the member to the team default language.
  async putMemberLanguage(req, res, id) {
    const member = this.store.getMemberById(id);
    if (!member) return sendJson(res, 404, { error: 'not_found' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const v = String(body.language ?? '').trim();
    if (v && !LANGUAGES.includes(v)) return sendJson(res, 400, { error: 'invalid_language' });
    this.store.setMemberLanguage(id, v || null);
    sendJson(res, 200, { id, language: v, language_effective: this.settings.memberLanguage(this.store.getMemberById(id)) });
  }

  // Rename a member. Name is globally unique; display-only — talk links (keyed
  // by token) and all history (keyed by id) are unaffected.
  async putMemberName(req, res, id) {
    const member = this.store.getMemberById(id);
    if (!member) return sendJson(res, 404, { error: 'not_found' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const name = String(body.name || '').trim();
    if (!name || name.length > 64) return sendJson(res, 400, { error: 'invalid_name' });
    if (name === member.name) return sendJson(res, 200, { id, name });
    try {
      this.store.setMemberName(id, name);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return sendJson(res, 409, { error: 'duplicate_name' });
      throw err;
    }
    sendJson(res, 200, { id, name });
  }

  // Manual correction surface for the auto-maintained profile (动态画像).
  async putMemberProfile(req, res, id) {
    const member = this.store.getMemberById(id);
    if (!member) return sendJson(res, 404, { error: 'not_found' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const v = body.profile === undefined || body.profile === null ? '' : String(body.profile);
    if (v.length > 8000) return sendJson(res, 400, { error: 'too_long' });
    this.store.setMemberProfile(id, v || null);
    sendJson(res, 200, { id, profile: v });
  }

  // ---- team knowledge base ----
  listKnowledge(res) {
    sendJson(res, 200, {
      knowledge: this.store.listKnowledge().map(k => ({
        id: k.id, title: k.title, content: k.content, tags: k.tags || '', updated_at: k.updated_at,
      })),
    });
  }

  async addKnowledge(req, res) {
    const b = await this.readKnowledgeBody(req, res);
    if (!b) return;
    const info = this.store.addKnowledge(b.title, b.content, b.tags);
    sendJson(res, 201, { id: Number(info.lastInsertRowid), ...b });
  }

  async updateKnowledge(req, res, id) {
    if (!this.store.getKnowledge(id)) return sendJson(res, 404, { error: 'not_found' });
    const b = await this.readKnowledgeBody(req, res);
    if (!b) return;
    this.store.updateKnowledge(id, b.title, b.content, b.tags);
    sendJson(res, 200, { id, ...b });
  }

  deleteKnowledge(res, id) {
    const info = this.store.deleteKnowledge(id);
    if (!info.changes) return sendJson(res, 404, { error: 'not_found' });
    sendJson(res, 204, {});
  }

  // ---- follow-ups (补充/跟进) — the generalized carry-forward container ----
  followupJson(rows = []) {
    return rows.map(f => ({
      id: f.id, content: f.content, scope: f.scope, author: f.author, created_at: f.created_at,
    }));
  }

  listFollowups(req, res, url) {
    const taskId = Number(url.searchParams.get('task_id'));
    if (!taskId || !this.store.getTask(taskId)) return sendJson(res, 400, { error: 'invalid_task' });
    sendJson(res, 200, {
      followups: this.followupJson(this.store.listFollowups(taskId)),
    });
  }

  async addFollowup(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const taskId = Number(body.task_id);
    if (!taskId || !this.store.getTask(taskId)) return sendJson(res, 400, { error: 'invalid_task' });
    const content = String(body.content || '').trim();
    if (!content || content.length > 20000) return sendJson(res, 400, { error: 'invalid_content' });
    const scope = body.scope === 'team' ? 'team' : 'private';
    const author = body.author === undefined || body.author === null ? '' : String(body.author).trim();
    const info = this.store.addFollowup({ taskId, content, scope, author });
    sendJson(res, 201, { id: Number(info.lastInsertRowid), task_id: taskId, content, scope, author });
  }

  deleteFollowup(res, id) {
    if (!this.store.getFollowup(id)) return sendJson(res, 404, { error: 'not_found' });
    this.store.deleteFollowup(id);
    sendJson(res, 200, { id });
  }

  // Shared parse/validate for knowledge create+update. Returns null (and sends
  // the error response) on invalid input.
  async readKnowledgeBody(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' }), null;
    }
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    const tags = body.tags === undefined || body.tags === null ? '' : String(body.tags).trim();
    if (!title || title.length > 200) return sendJson(res, 400, { error: 'invalid_title' }), null;
    if (!content || content.length > 20000) return sendJson(res, 400, { error: 'invalid_content' }), null;
    if (tags.length > 500) return sendJson(res, 400, { error: 'invalid_tags' }), null;
    return { title, content, tags };
  }

  // ---- communication tasks ----

  taskJson(task) {
    return {
      id: task.id,
      type: task.type,
      is_builtin: Boolean(task.is_builtin),
      title: task.title,
      brief: task.brief || '',
      questions: task.questions || '',
      status: task.status,
      deadline: task.deadline || null,
      digest_auto_at: task.digest_auto_at || null,
      digest_close_linked: Boolean(task.digest_close_linked),
      digest_instruction: task.digest_instruction || '',
      probe_instruction: task.probe_instruction || '',
      cadence_type: task.cadence_type || null,
      cadence_dow: task.cadence_dow || null,
      cadence_interval_days: task.cadence_interval_days || null,
      cadence_label: cadenceLabel(task),
      created_at: task.created_at,
    };
  }

  listTasks(req, res) {
    const today = todayLocal(this.settings.resolveTimeZone());
    const tasks = this.store.listTasks().map(t => {
      const base = this.taskJson(t);
      if (t.is_builtin) {
        const members = this.store.listActiveMembers();
        const done = this.store.submittedMemberIds(today);
        return { ...base, cycle_key: today, member_count: members.length, submitted_count: done.length };
      }
      const key = t.type === 'oneshot' ? ONESHOT_CYCLE : currentCycleKey(t, today);
      const rows = (key ? this.store.cycleRecords(t.id, key) : this.store.taskMembers(t.id))
        .filter(r => !r.is_test);
      return {
        ...base,
        cycle_key: key,
        member_count: rows.length,
        submitted_count: rows.filter(r => r.status === 'submitted').length,
      };
    });
    sendJson(res, 200, { tasks });
  }

  /**
   * Task detail, per cycle. `?cycle=` selects a past cycle (defaults to the
   * current one). Built-in daily: reports-shaped day view + member links.
   * Generic tasks: cycle_records + per-cycle digest (oneshot = fixed '-').
   */
  taskDetail(req, res, id, cycleParam = null) {
    const task = this.store.getTask(id);
    if (!task) return sendJson(res, 404, { error: 'not_found' });
    const today = todayLocal(this.settings.resolveTimeZone());
    const requested = /^\d{4}-\d{2}-\d{2}$/.test(cycleParam || '') ? cycleParam : null;

    if (task.is_builtin) {
      const date = requested || today;
      const members = this.store.listActiveMembers();
      const links = new Map(this.store.taskMembers(id).map(r => [r.member_id, r.token]));
      const report = this.dayReportJson(date);
      const done = new Set(this.store.submittedMemberIds(date));
      const test = this.store.getTestMember();
      const testToken = test ? links.get(test.id) : null;
      return sendJson(res, 200, {
        ...this.taskJson(task),
        cycle_key: date,
        current_cycle_key: today,
        cycles: [...new Set([today, ...this.store.reportHistory().map(d => d.report_date)])],
        member_count: members.length,
        submitted_count: members.filter(mb => done.has(mb.id)).length,
        members: members.map(mb => ({
          member_id: mb.id,
          name: mb.name,
          status: done.has(mb.id) ? 'submitted' : 'pending',
          link: links.has(mb.id) ? this.memberLink(req, links.get(mb.id)) : null,
        })),
        test_member: test && testToken ? { name: test.name, link: this.memberLink(req, testToken) } : null,
        report,
        digest: this.store.getCycleDigest(id, date)?.content || '',
        digest_updated_at: this.store.getCycleDigest(id, date)?.updated_at || null,
      });
    }

    const current = task.type === 'oneshot' ? ONESHOT_CYCLE : currentCycleKey(task, today);
    const key = task.type === 'oneshot' ? ONESHOT_CYCLE : (requested || current);
    const cycles = this.store.taskCycleKeys(id);
    if (current && !cycles.includes(current)) cycles.unshift(current);
    cycles.sort().reverse();
    const rows = key ? this.store.cycleRecords(id, key).filter(r => !r.is_test) : [];
    const contextFollowupIds = [...new Set(rows.flatMap(r => parseIdList(r.injected_followup_ids)))];
    const digestRow = task.type === 'oneshot'
      ? { content: task.digest, updated_at: task.digest_updated_at }
      : (key ? this.store.getCycleDigest(id, key) : null);
    sendJson(res, 200, {
      ...this.taskJson(task),
      cycle_key: key,
      current_cycle_key: current,
      cycles,
      member_count: rows.length,
      submitted_count: rows.filter(r => r.status === 'submitted').length,
      members: rows.map(r => ({
        member_id: r.member_id,
        name: r.name,
        status: r.status || 'pending',
        link: this.memberLink(req, r.token),
        summary: parseList(r.summary),
        highlights: parseList(r.highlights),
        transcript: r.transcript || '',
        duration_s: r.duration_s || 0,
        updated_at: r.updated_at || null,
      })),
      context_followups: this.followupJson(this.store.followupsByIds(contextFollowupIds)),
      digest: digestRow?.content || '',
      digest_updated_at: digestRow?.updated_at || null,
    });
  }

  // Free-text task fields per the owner's Q4 ruling — brief and questions are
  // plain text, no structured form.
  readTaskFields(body) {
    const out = {};
    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t || t.length > 120) return { error: 'invalid_title' };
      out.title = t;
    }
    for (const [k, camel] of [['brief', 'brief'], ['questions', 'questions'], ['digest_instruction', 'digestInstruction'], ['probe_instruction', 'probeInstruction']]) {
      if (body[k] === undefined) continue;
      const v = String(body[k] ?? '');
      if (v.length > 20000) return { error: `invalid_${k}` };
      out[camel] = v.trim() || null;
    }
    if (body.deadline !== undefined) {
      const v = String(body.deadline ?? '').trim();
      if (v && !/^\d{4}-\d{2}-\d{2}/.test(v)) return { error: 'invalid_deadline' };
      out.deadline = v || null;
    }
    if (body.digest_auto_at !== undefined) {
      const v = String(body.digest_auto_at ?? '').trim();
      if (v && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return { error: 'invalid_digest_auto_at' };
      out.digestAutoAt = v || null;
    }
    if (body.digest_close_linked !== undefined) out.digestCloseLinked = Boolean(body.digest_close_linked);
    return { fields: out };
  }

  // Cadence per the owner's ruling: structured options only (no cron) —
  // daily / weekly with an ISO dow set / every N days anchored on a date.
  readCadence(body, today) {
    const type = String(body.cadence_type || '').trim();
    if (!['daily', 'weekly', 'interval'].includes(type)) return { error: 'invalid_cadence_type' };
    const out = { cadenceType: type, cadenceDow: null, cadenceIntervalDays: null, cadenceAnchor: null };
    if (type === 'weekly') {
      const dows = parseDowSet(body.cadence_dow);
      if (!dows.length) return { error: 'invalid_cadence_dow' };
      out.cadenceDow = dows.join(',');
    }
    if (type === 'interval') {
      const n = Number(body.cadence_interval_days);
      if (!Number.isInteger(n) || n < 1 || n > 365) return { error: 'invalid_cadence_interval' };
      out.cadenceIntervalDays = n;
      const anchor = String(body.cadence_anchor || '').trim();
      if (anchor && !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return { error: 'invalid_cadence_anchor' };
      out.cadenceAnchor = anchor || today;
    }
    return { fields: out };
  }

  async createTask(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const parsed = this.readTaskFields(body);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    if (!parsed.fields.title) return sendJson(res, 400, { error: 'invalid_title' });

    const type = body.type === 'recurring' ? 'recurring' : 'oneshot';
    let cadence = {};
    if (type === 'recurring') {
      const c = this.readCadence(body, todayLocal(this.settings.resolveTimeZone()));
      if (c.error) return sendJson(res, 400, { error: c.error });
      cadence = c.fields;
    }

    const ids = Array.isArray(body.member_ids) ? body.member_ids.map(Number) : [];
    const roster = new Map(this.store.listActiveMembers().map(mb => [mb.id, mb]));
    const memberIds = [...new Set(ids)].filter(id => roster.has(id));
    if (!memberIds.length) return sendJson(res, 400, { error: 'no_members' });

    const task = this.store.createTask({ type, ...parsed.fields, ...cadence });
    for (const memberId of memberIds) this.store.addTaskMember(task.id, memberId, newToken());
    return this.taskDetail(req, res, task.id);
  }

  async updateTask(req, res, id) {
    const task = this.store.getTask(id);
    if (!task) return sendJson(res, 404, { error: 'not_found' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const parsed = this.readTaskFields(body);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    let cadence = {};
    if (body.cadence_type !== undefined) {
      // cadence is only meaningful on user-created recurring tasks; the
      // built-in daily stays daily
      if (task.type !== 'recurring' || task.is_builtin) return sendJson(res, 400, { error: 'cadence_not_editable' });
      const c = this.readCadence(body, todayLocal(this.settings.resolveTimeZone()));
      if (c.error) return sendJson(res, 400, { error: c.error });
      cadence = c.fields;
    }
    this.store.updateTask(id, { ...parsed.fields, ...cadence });
    return this.taskDetail(req, res, id);
  }

  async triggerDigest(req, res, id) {
    const task = this.store.getTask(id);
    if (!task) return sendJson(res, 404, { error: 'not_found' });
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch { /* empty body is fine */ }
    const opts = {};
    if (body.close !== undefined) opts.close = Boolean(body.close);
    const cycle = String(body.cycle || '').trim();
    if (cycle && (cycle === ONESHOT_CYCLE || /^\d{4}-\d{2}-\d{2}$/.test(cycle))) opts.cycleKey = cycle;
    try {
      const result = await this.digests.trigger(id, opts);
      if (!result.ok) return sendJson(res, 409, { error: result.error });
      return this.taskDetail(req, res, id, opts.cycleKey || null);
    } catch (err) {
      console.error('[rounds] digest trigger failed', err.message);
      return sendJson(res, 502, { error: 'digest_failed', message: err.message });
    }
  }

  // close/reopen applies to every task; closing the built-in daily pauses the
  // standup (its links stop resolving) without deleting anything.
  setTaskStatus(res, id, action) {
    const task = this.store.getTask(id);
    if (!task) return sendJson(res, 404, { error: 'not_found' });
    this.store.setTaskStatus(id, action === 'close' ? 'closed' : 'open');
    sendJson(res, 200, { id, status: this.store.getTask(id).status });
  }

  deleteTask(res, id) {
    const task = this.store.getTask(id);
    if (!task) return sendJson(res, 404, { error: 'not_found' });
    if (task.is_builtin) return sendJson(res, 400, { error: 'builtin_undeletable' });
    this.store.deleteTask(id);
    sendJson(res, 204, {});
  }

  resetTaskToken(req, res, taskId, memberId) {
    const tm = this.store.getTaskMember(taskId, memberId);
    if (!tm) return sendJson(res, 404, { error: 'not_found' });
    const token = newToken();
    this.store.resetTaskMemberToken(taskId, memberId, token);
    sendJson(res, 200, { task_id: taskId, member_id: memberId, link: this.memberLink(req, token) });
  }

  /** Cross-task member entity: roster + one link per open task (v0.7). */
  memberJson(req, mb) {
    return {
      id: mb.id,
      name: mb.name,
      active: Boolean(mb.active),
      language: mb.language || '',
      language_effective: this.settings.memberLanguage(mb),
      context: mb.context || '',
      profile: mb.profile || '',
      profile_updated_at: mb.profile_updated_at || null,
      links: this.store.memberTaskLinks(mb.id).map(l => ({
        task_id: l.task_id,
        title: l.title,
        type: l.type,
        is_builtin: Boolean(l.is_builtin),
        link: this.memberLink(req, l.token),
      })),
    };
  }

  listMembers(req, res) {
    const test = this.store.getTestMember();
    sendJson(res, 200, {
      members: this.store.listActiveMembers().map(mb => this.memberJson(req, mb)),
      // built-in try-it member: shares the same talk flow, never counted
      test_member: test ? this.memberJson(req, test) : null,
    });
  }

  /** Every member gets a link for the built-in daily task; rotate invalidates the old one. */
  mintDailyLink(memberId, { rotate = false } = {}) {
    const daily = this.store.getDailyTask();
    if (!daily) return;
    if (this.store.getTaskMember(daily.id, memberId)) {
      if (rotate) this.store.resetTaskMemberToken(daily.id, memberId, newToken());
    } else {
      this.store.addTaskMember(daily.id, memberId, newToken());
    }
  }

  async addMember(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    const name = String(body.name || '').trim();
    if (!name || name.length > 64) return sendJson(res, 400, { error: 'invalid_name' });
    const language = String(body.language ?? '').trim();
    if (language && !LANGUAGES.includes(language)) return sendJson(res, 400, { error: 'invalid_language' });
    try {
      const info = this.store.addMember(name, newToken());
      const id = Number(info.lastInsertRowid);
      if (language) this.store.setMemberLanguage(id, language);
      this.mintDailyLink(id);
      sendJson(res, 201, this.memberJson(req, this.store.getMemberById(id)));
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
      const inactive = this.store.getInactiveMemberByName(name);
      if (!inactive) return sendJson(res, 409, { error: 'duplicate_name' });
      this.store.reactivateMember(inactive.id, newToken());
      if (language) this.store.setMemberLanguage(inactive.id, language);
      // returning member: fresh daily link — the pre-deactivation one stays dead
      this.mintDailyLink(inactive.id, { rotate: true });
      sendJson(res, 201, this.memberJson(req, this.store.getMemberById(inactive.id)));
    }
  }

  removeMember(res, id) {
    const member = this.store.getMemberById(id);
    if (member?.is_test) return sendJson(res, 400, { error: 'test_member_undeletable' });
    const info = this.store.deactivateMember(id);
    if (!info.changes) return sendJson(res, 404, { error: 'not_found' });
    sendJson(res, 204, {});
  }

  history(res) {
    const memberCount = this.store.listActiveMembers().length;
    const days = this.store.reportHistory().map(d => ({
      date: d.report_date,
      submitted: Number(d.submitted),
      member_count: memberCount,
      topics_count: Number(d.topics_count || 0),
    }));
    sendJson(res, 200, { days });
  }

  /** Day view of the built-in daily standup — shared by /api/reports/:date and the builtin task detail. */
  dayReportJson(date) {
    const rows = this.store.dayReports(date);
    const members = this.store.listActiveMembers();
    const doneIds = new Set(rows.map(r => r.member_id));
    const contextFollowupIds = [...new Set(rows.flatMap(r => parseIdList(r.injected_followup_ids)))];
    return {
      date,
      member_count: members.length,
      reports: rows.map(r => ({
        member_name: r.name,
        yesterday: parseList(r.yesterday),
        today: parseList(r.today),
        blockers: parseList(r.blockers),
        topics: parseList(r.topics),
        transcript: r.transcript || '',
        duration_s: r.duration_s || 0,
        updated_at: r.updated_at,
      })),
      missing: members.filter(mb => !doneIds.has(mb.id)).map(mb => mb.name),
      topics: rows.flatMap(r => parseList(r.topics).map(t => ({ name: r.name, topic: t }))),
      context_followups: this.followupJson(this.store.followupsByIds(contextFollowupIds)),
    };
  }

  dayReport(res, date) {
    sendJson(res, 200, this.dayReportJson(date));
  }
}
