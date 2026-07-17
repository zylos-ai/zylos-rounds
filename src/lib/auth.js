/**
 * Admin auth for zylos-standup — port of the zylos-dashboard AuthGate pattern:
 * scrypt-hashed password in config.json, session tokens in SQLite (sha256 at rest),
 * sliding expiry, per-IP + global login rate limiting, __Host- session cookie.
 *
 * JSON API shape (SPA login), not form POST:
 *   POST api/auth/login  {password} -> 204 + cookie | 401 | 429
 *   POST api/auth/logout            -> 204
 *   GET  api/auth/me                -> {authenticated}
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { sendJson, readJsonBody, getClientIp, parseCookies } from './http-util.js';

const SCRYPT_KEYLEN = 64;
const COOKIE_NAME = '__Host-zylos_standup_session';
const SESSION_ABSOLUTE_MS = 7 * 86_400_000;
const SESSION_IDLE_MS = 86_400_000;
const CLEANUP_INTERVAL_MS = 300_000;
const MAX_FAILURES = 5;
const WINDOW_MS = 60_000;
const LOCKOUT_MS = 600_000;
const GLOBAL_MAX_PER_MIN = 30;

export function hashPassword(plaintext) {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plaintext, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt:')) return false;
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const actual = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export class AuthGate {
  constructor(config, store, configPath) {
    this.config = config;
    this.store = store;
    this.configPath = configPath;
    this.failedAttempts = new Map();
    this.globalFailures = { count: 0, resetAt: Date.now() + 60_000 };
    this.migratePasswordIfNeeded();
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      this.store.cleanupSessions(now - SESSION_ABSOLUTE_MS, now - SESSION_IDLE_MS);
    }, CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref?.();
  }

  get enabled() {
    return Boolean(this.config.auth?.enabled);
  }

  get configured() {
    return this.enabled && Boolean(this.config.auth?.password);
  }

  /** If config.json carries a plaintext password (fresh install), hash it in place. */
  migratePasswordIfNeeded() {
    const pw = this.config.auth?.password;
    if (typeof pw !== 'string' || !pw || pw.startsWith('scrypt:')) return;
    const hashed = hashPassword(pw);
    try {
      const existing = fs.existsSync(this.configPath)
        ? JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
        : {};
      existing.auth = { ...(existing.auth || {}), password: hashed };
      fs.writeFileSync(this.configPath, `${JSON.stringify(existing, null, 2)}\n`);
      this.config.auth.password = hashed;
      console.log('[standup] Auth: migrated plaintext password to scrypt hash');
    } catch (err) {
      console.error(`[standup] Auth: failed to migrate password: ${err.message}`);
    }
  }

  sessionToken(req) {
    return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
  }

  isAuthenticated(req) {
    if (!this.enabled) return true;
    if (!this.configured) return false;
    const token = this.sessionToken(req);
    if (!token) return false;
    const session = this.store.getSession(sha256(token));
    if (!session) return false;
    const now = Date.now();
    if (now - session.created_at > SESSION_ABSOLUTE_MS ||
        now - session.last_activity_at > SESSION_IDLE_MS) {
      this.store.deleteSession(sha256(token));
      return false;
    }
    this.store.touchSession(sha256(token), now);
    return true;
  }

  isLockedOut(ip) {
    const record = this.failedAttempts.get(ip);
    if (!record) return false;
    const now = Date.now();
    if (record.count >= MAX_FAILURES) {
      if (now - record.firstFailAt < LOCKOUT_MS) return true;
      this.failedAttempts.delete(ip);
      return false;
    }
    if (now - record.firstFailAt > WINDOW_MS) this.failedAttempts.delete(ip);
    return false;
  }

  isGlobalLimited() {
    const now = Date.now();
    if (now > this.globalFailures.resetAt) {
      this.globalFailures = { count: 0, resetAt: now + 60_000 };
    }
    return this.globalFailures.count >= GLOBAL_MAX_PER_MIN;
  }

  recordFailure(ip) {
    const now = Date.now();
    const record = this.failedAttempts.get(ip);
    if (!record || now - record.firstFailAt > WINDOW_MS) {
      this.failedAttempts.set(ip, { count: 1, firstFailAt: now });
    } else {
      record.count += 1;
    }
    if (now > this.globalFailures.resetAt) {
      this.globalFailures = { count: 1, resetAt: now + 60_000 };
    } else {
      this.globalFailures.count += 1;
    }
  }

  async handleLogin(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    if (!this.enabled) return sendJson(res, 204, {});
    if (!this.configured) return sendJson(res, 503, { error: 'auth_not_configured' });
    const ip = getClientIp(req);
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }
    if (this.isLockedOut(ip) || this.isGlobalLimited()) {
      return sendJson(res, 429, { error: 'rate_limited' });
    }
    if (!verifyPassword(body.password || '', this.config.auth.password)) {
      this.recordFailure(ip);
      return sendJson(res, 401, { error: 'invalid_password' });
    }
    this.failedAttempts.delete(ip);
    const token = crypto.randomBytes(64).toString('hex');
    this.store.insertSession(sha256(token), Date.now());
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_ABSOLUTE_MS / 1000}`);
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  }

  handleLogout(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
    const token = this.sessionToken(req);
    if (token) this.store.deleteSession(sha256(token));
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  }

  handleMe(req, res) {
    sendJson(res, 200, { authenticated: this.isAuthenticated(req) });
  }

  stop() {
    clearInterval(this._cleanupTimer);
  }
}
