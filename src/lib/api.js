/**
 * Admin REST API (session-protected) + member talk-session endpoint (token-auth).
 * All routes are root-internal; Caddy exposes them under /standup/*.
 */

import crypto from 'node:crypto';
import { sendJson, readJsonBody, browserOrigin, todayLocal } from './http-util.js';
import { MODEL_OPTIONS, VOICE_OPTIONS } from './settings.js';

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
  constructor(store, auth, getConfig, settings) {
    this.store = store;
    this.auth = auth;
    this.getConfig = getConfig;
    this.settings = settings;
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

    sendJson(res, 404, { error: 'not_found' });
    return true;
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
        duration_s: r.duration_s || 0,
        updated_at: r.updated_at,
      })),
      missing: members.filter(mb => !doneIds.has(mb.id)).map(mb => mb.name),
      topics: rows.flatMap(r => parseList(r.topics).map(t => ({ name: r.name, topic: t }))),
    });
  }
}
