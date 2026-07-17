/**
 * Admin REST API (session-protected) + member talk-session endpoint (token-auth).
 * All routes are root-internal; Caddy exposes them under /standup/*.
 */

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, readJsonBody, browserOrigin, todayLocal } from './http-util.js';
import { MODEL_OPTIONS, VOICE_OPTIONS } from './settings.js';

const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'voice-samples');

const parseList = v => {
  try {
    const arr = JSON.parse(v || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};

function newToken() {
  return crypto.randomBytes(8).toString('base64url');
}

export class Api {
  constructor(store, auth, getConfig, settings, context) {
    this.store = store;
    this.auth = auth;
    this.getConfig = getConfig;
    this.settings = settings;
    this.context = context;
  }

  // Management surface (context/knowledge) is reachable by a human admin
  // (session cookie) OR by Luna / the coco avatar (Bearer service token) — the
  // latter is how the brain gets tuned programmatically from a conversation.
  isManager(req) {
    if (this.auth.isAuthenticated(req)) return true;
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const tok = m && m[1].trim();
    const svc = this.getConfig().serviceToken;
    if (!tok || !svc || tok.length !== svc.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(svc));
    } catch {
      return false;
    }
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
      const date = todayLocal(this.getConfig().timeZone);
      sendJson(res, 200, { authenticated: this.auth.isAuthenticated(req), date });
      return true;
    }

    // member endpoint (token auth, no session)
    if (p === '/api/talk/session' && req.method === 'GET') {
      const member = this.store.getMemberByToken(url.searchParams.get('token') || '');
      if (!member) return sendJson(res, 404, { error: 'invalid_token' }), true;
      return sendJson(res, 200, { name: member.name, is_test: Boolean(member.is_test) }), true;
    }

    if (!p.startsWith('/api/')) return false;

    // ---- management surface: admin session OR bearer service token ----
    if (p === '/api/context' || p === '/api/context/members' || p === '/api/knowledge' ||
        /^\/api\/knowledge\/\d+$/.test(p) || /^\/api\/members\/\d+\/context$/.test(p)) {
      if (!this.isManager(req)) return sendJson(res, 401, { error: 'unauthorized' }), true;

      if (p === '/api/context' && req.method === 'GET') return this.getContext(res), true;
      if (p === '/api/context' && req.method === 'PUT') return await this.putContext(req, res), true;

      // id/name/context only (no talk links) — lets Luna / the avatar target
      // per-member context without the session-only roster.
      if (p === '/api/context/members' && req.method === 'GET') {
        return sendJson(res, 200, {
          members: this.store.listActiveMembers().map(mb => ({ id: mb.id, name: mb.name, context: mb.context || '' })),
        }), true;
      }

      if (p === '/api/knowledge' && req.method === 'GET') return this.listKnowledge(res), true;
      if (p === '/api/knowledge' && req.method === 'POST') return await this.addKnowledge(req, res), true;

      let km = p.match(/^\/api\/knowledge\/(\d+)$/);
      if (km && req.method === 'PUT') return await this.updateKnowledge(req, res, Number(km[1])), true;
      if (km && req.method === 'DELETE') return this.deleteKnowledge(res, Number(km[1])), true;

      const cm = p.match(/^\/api\/members\/(\d+)\/context$/);
      if (cm && req.method === 'PUT') return await this.putMemberContext(req, res, Number(cm[1])), true;

      return sendJson(res, 404, { error: 'not_found' }), true;
    }

    // everything else under /api/ requires an admin session
    if (!this.auth.isAuthenticated(req)) {
      return sendJson(res, 401, { error: 'unauthorized' }), true;
    }

    if (p === '/api/members' && req.method === 'GET') return this.listMembers(req, res), true;
    if (p === '/api/members' && req.method === 'POST') return await this.addMember(req, res), true;

    let m = p.match(/^\/api\/members\/(\d+)$/);
    if (m && req.method === 'DELETE') return this.removeMember(res, Number(m[1])), true;

    m = p.match(/^\/api\/members\/(\d+)\/reset-token$/);
    if (m && req.method === 'POST') return this.resetToken(req, res, Number(m[1])), true;

    if (p === '/api/reports/history' && req.method === 'GET') return this.history(res), true;

    m = p.match(/^\/api\/reports\/(\d{4}-\d{2}-\d{2})$/);
    if (m && req.method === 'GET') return this.dayReport(res, m[1]), true;

    if (p === '/api/settings' && req.method === 'GET') return this.getSettings(res), true;
    if (p === '/api/settings' && req.method === 'PUT') return await this.putSettings(req, res), true;
    if (p === '/api/settings/test-connection' && req.method === 'POST') {
      return sendJson(res, 200, await this.settings.testConnection()), true;
    }

    m = p.match(/^\/api\/settings\/voice-sample\/([a-z]+)$/);
    if (m && req.method === 'GET') return this.voiceSample(res, m[1]), true;

    sendJson(res, 404, { error: 'not_found' });
    return true;
  }

  // Pre-generated wav samples (scripts/generate-voice-samples.mjs); the
  // VOICE_OPTIONS check doubles as path sanitization for the file read.
  voiceSample(res, voice) {
    if (!VOICE_OPTIONS.includes(voice)) return sendJson(res, 404, { error: 'not_found' });
    const file = path.join(SAMPLES_DIR, `${voice}.wav`);
    let data;
    try {
      data = readFileSync(file);
    } catch {
      return sendJson(res, 404, { error: 'sample_missing' });
    }
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(data);
  }

  // The key itself is write-only: GET exposes only whether/where one is set.
  getSettings(res) {
    sendJson(res, 200, {
      openai_key_source: this.settings.keySource(), // 'env' | 'db' | 'none'
      model: this.settings.resolveModel(),
      voice: this.settings.resolveVoice(),
      model_options: MODEL_OPTIONS,
      voice_options: VOICE_OPTIONS,
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
      if (!MODEL_OPTIONS.includes(body.model)) return sendJson(res, 400, { error: 'invalid_model' });
      this.settings.setModel(body.model);
    }
    if (body.voice !== undefined) {
      if (!VOICE_OPTIONS.includes(body.voice)) return sendJson(res, 400, { error: 'invalid_voice' });
      this.settings.setVoice(body.voice);
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

  // ---- agent context containers (background + probing guidance) ----
  getContext(res) {
    sendJson(res, 200, {
      team_background: this.store.getContext('team_background') || '',
      probing_guidance: this.store.getContext('probing_guidance') || '',
    });
  }

  async putContext(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    for (const key of ['team_background', 'probing_guidance']) {
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

  listMembers(req, res) {
    const members = this.store.listActiveMembers();
    const date = todayLocal(this.getConfig().timeZone);
    const done = new Set(this.store.submittedMemberIds(date));
    const test = this.store.getTestMember();
    sendJson(res, 200, {
      date,
      members: members.map(mb => ({
        id: mb.id,
        name: mb.name,
        active: Boolean(mb.active),
        reported_today: done.has(mb.id),
        link: this.memberLink(req, mb.token),
        context: mb.context || '',
      })),
      // built-in try-it member: shares the same talk flow, never counted
      test_member: test ? {
        id: test.id,
        name: test.name,
        link: this.memberLink(req, test.token),
      } : null,
    });
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
    const token = newToken();
    try {
      const info = this.store.addMember(name, token);
      sendJson(res, 201, {
        id: Number(info.lastInsertRowid),
        name,
        active: true,
        reported_today: false,
        link: this.memberLink(req, token),
      });
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
      const inactive = this.store.getInactiveMemberByName(name);
      if (!inactive) return sendJson(res, 409, { error: 'duplicate_name' });
      this.store.reactivateMember(inactive.id, token);
      const date = todayLocal(this.getConfig().timeZone);
      const done = new Set(this.store.submittedMemberIds(date));
      sendJson(res, 201, {
        id: inactive.id,
        name,
        active: true,
        reported_today: done.has(inactive.id),
        link: this.memberLink(req, token),
      });
    }
  }

  removeMember(res, id) {
    const member = this.store.getMemberById(id);
    if (member?.is_test) return sendJson(res, 400, { error: 'test_member_undeletable' });
    const info = this.store.deactivateMember(id);
    if (!info.changes) return sendJson(res, 404, { error: 'not_found' });
    sendJson(res, 204, {});
  }

  resetToken(req, res, id) {
    const member = this.store.getMemberById(id);
    if (!member || !member.active) return sendJson(res, 404, { error: 'not_found' });
    const token = newToken();
    this.store.resetMemberToken(id, token);
    sendJson(res, 200, { id, link: this.memberLink(req, token) });
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

  dayReport(res, date) {
    const rows = this.store.dayReports(date);
    const members = this.store.listActiveMembers();
    const doneIds = new Set(rows.map(r => r.member_id));
    sendJson(res, 200, {
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
    });
  }
}
