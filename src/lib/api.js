/**
 * Admin REST API (session-protected) + member talk-session endpoint (token-auth).
 * All routes are root-internal; Caddy exposes them under /standup/*.
 */

import crypto from 'node:crypto';
import { sendJson, readJsonBody, browserOrigin, todayLocal } from './http-util.js';

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

function memberLink(req, token) {
  return `${browserOrigin(req)}/u/${token}`;
}

export class Api {
  constructor(store, auth) {
    this.store = store;
    this.auth = auth;
  }

  /**
   * Route an /api/* request. Returns true if handled.
   */
  async handle(req, res, url) {
    const p = url.pathname;

    // auth endpoints (no session required)
    if (p === '/api/auth/login') return this.auth.handleLogin(req, res), true;
    if (p === '/api/auth/logout') return this.auth.handleLogout(req, res), true;
    if (p === '/api/auth/me') return this.auth.handleMe(req, res), true;

    // member endpoint (token auth, no session)
    if (p === '/api/talk/session' && req.method === 'GET') {
      const member = this.store.getMemberByToken(url.searchParams.get('token') || '');
      if (!member) return sendJson(res, 404, { error: 'invalid_token' }), true;
      return sendJson(res, 200, { name: member.name }), true;
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

    sendJson(res, 404, { error: 'not_found' });
    return true;
  }

  listMembers(req, res) {
    const members = this.store.listActiveMembers();
    const done = new Set(this.store.submittedMemberIds(todayLocal()));
    sendJson(res, 200, {
      date: todayLocal(),
      members: members.map(mb => ({
        id: mb.id,
        name: mb.name,
        active: Boolean(mb.active),
        reported_today: done.has(mb.id),
        link: memberLink(req, mb.token),
      })),
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
        link: memberLink(req, token),
      });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return sendJson(res, 409, { error: 'duplicate_name' });
      throw err;
    }
  }

  removeMember(res, id) {
    const info = this.store.deactivateMember(id);
    if (!info.changes) return sendJson(res, 404, { error: 'not_found' });
    sendJson(res, 204, {});
  }

  resetToken(req, res, id) {
    const member = this.store.getMemberById(id);
    if (!member || !member.active) return sendJson(res, 404, { error: 'not_found' });
    const token = newToken();
    this.store.resetMemberToken(id, token);
    sendJson(res, 200, { id, link: memberLink(req, token) });
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
