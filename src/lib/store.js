/**
 * SQLite store for zylos-rounds.
 *
 * Incremental, idempotent migrations tracked in schema_migrations —
 * never modify an existing migration, only append new ones.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        token TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES members(id),
        report_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        yesterday TEXT, today TEXT, blockers TEXT, topics TEXT,
        raw_json TEXT, transcript TEXT,
        duration_s INTEGER, model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        UNIQUE(member_id, report_date)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      ALTER TABLE members ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // The agent's "brain": editable background containers, per-member notes,
    // and a searchable team knowledge base. All maintained by Luna / the coco
    // avatar (management API) or a human (admin UI); composed into the agent's
    // instructions or pulled on demand via realtime tools.
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_context (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      ALTER TABLE members ADD COLUMN context TEXT;
      CREATE TABLE IF NOT EXISTS knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
    `,
  },
  {
    // Dynamic member profile (动态画像) — auto-maintained by an LLM pass after
    // each submitted report (new facts merged in, stale ones aged out), distinct
    // from the human-written `context`. Both are injected into call instructions.
    version: 4,
    sql: `
      ALTER TABLE members ADD COLUMN profile TEXT;
      ALTER TABLE members ADD COLUMN profile_updated_at TEXT;
    `,
  },
];

export class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
    const row = this.db.prepare('SELECT MAX(version) v FROM schema_migrations').get();
    const current = row?.v || 0;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.db.exec(m.sql);
      this.db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(m.version);
      console.log(`[rounds] DB migrated to version ${m.version}`);
    }
  }

  // ---- settings ----
  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')
    `).run(key, value);
  }

  deleteSetting(key) {
    this.db.prepare('DELETE FROM settings WHERE key=?').run(key);
  }

  // ---- agent context (background + probing guidance containers) ----
  getContext(key) {
    return this.db.prepare('SELECT value FROM agent_context WHERE key=?').get(key)?.value ?? null;
  }

  setContext(key, value) {
    this.db.prepare(`
      INSERT INTO agent_context(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')
    `).run(key, value);
  }

  /** All context keys with their updated_at — for the management/admin surface. */
  allContext() {
    return this.db.prepare('SELECT key, value, updated_at FROM agent_context').all();
  }

  // ---- knowledge base (on-demand retrieval via search_team_knowledge) ----
  listKnowledge() {
    return this.db.prepare('SELECT * FROM knowledge ORDER BY updated_at DESC, id DESC').all();
  }

  getKnowledge(id) {
    return this.db.prepare('SELECT * FROM knowledge WHERE id=?').get(id);
  }

  addKnowledge(title, content, tags) {
    return this.db.prepare('INSERT INTO knowledge(title,content,tags) VALUES(?,?,?)').run(title, content, tags ?? null);
  }

  updateKnowledge(id, title, content, tags) {
    return this.db.prepare(`
      UPDATE knowledge SET title=?, content=?, tags=?, updated_at=datetime('now','localtime') WHERE id=?
    `).run(title, content, tags ?? null, id);
  }

  deleteKnowledge(id) {
    return this.db.prepare('DELETE FROM knowledge WHERE id=?').run(id);
  }

  /**
   * Keyword search over title/content/tags. Each whitespace-separated term must
   * match somewhere (AND semantics); ranking is by how many terms hit the title.
   * Deterministic string matching — no LLM in the retrieval path.
   */
  searchKnowledge(query, limit = 3) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const rows = this.db.prepare('SELECT * FROM knowledge').all();
    const scored = [];
    for (const r of rows) {
      const hay = `${r.title}\n${r.content}\n${r.tags || ''}`.toLowerCase();
      const title = r.title.toLowerCase();
      if (!terms.every(t => hay.includes(t))) continue;
      const score = terms.reduce((s, t) => s + (title.includes(t) ? 2 : 1), 0);
      scored.push({ ...r, _score: score });
    }
    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }

  // ---- members ----
  setMemberContext(id, context) {
    return this.db.prepare('UPDATE members SET context=? WHERE id=?').run(context ?? null, id);
  }

  setMemberProfile(id, profile) {
    return this.db.prepare(`
      UPDATE members SET profile=?, profile_updated_at=datetime('now','localtime') WHERE id=?
    `).run(profile ?? null, id);
  }

  getReport(memberId, date) {
    return this.db.prepare('SELECT * FROM reports WHERE member_id=? AND report_date=?').get(memberId, date);
  }

  /**
   * A member's own recent submitted reports (most recent first, excluding a
   * given date — usually today). Powers the recall_member_history tool so the
   * agent can follow up on what the member said in previous standups.
   */
  recallMemberHistory(memberId, excludeDate, limit = 5) {
    return this.db.prepare(`
      SELECT report_date, yesterday, today, blockers, topics
      FROM reports
      WHERE member_id=? AND status='submitted' AND report_date <> ?
      ORDER BY report_date DESC LIMIT ?
    `).all(memberId, excludeDate, limit);
  }

  getMemberByToken(token) {
    return this.db.prepare('SELECT * FROM members WHERE token=? AND active=1').get(token);
  }

  /** Regular (non-test) active members — the roster all stats are counted against. */
  listActiveMembers() {
    return this.db.prepare('SELECT * FROM members WHERE active=1 AND is_test=0 ORDER BY id').all();
  }

  getTestMember() {
    return this.db.prepare('SELECT * FROM members WHERE is_test=1 ORDER BY id LIMIT 1').get();
  }

  /**
   * Ensure the built-in test member exists and is active. Its reports are
   * excluded from all rosters/digests — it exists purely so anyone can try
   * the conversation without polluting real standup data.
   */
  ensureTestMember(name, token) {
    const existing = this.getTestMember();
    if (!existing) {
      this.db.prepare('INSERT INTO members(name,token,is_test) VALUES(?,?,1)').run(name, token);
      return this.getTestMember();
    }
    if (!existing.active) {
      this.db.prepare('UPDATE members SET active=1 WHERE id=?').run(existing.id);
      return this.getMemberById(existing.id);
    }
    return existing;
  }

  addMember(name, token) {
    return this.db.prepare('INSERT INTO members(name,token) VALUES(?,?)').run(name, token);
  }

  getMemberById(id) {
    return this.db.prepare('SELECT * FROM members WHERE id=?').get(id);
  }

  getInactiveMemberByName(name) {
    return this.db.prepare('SELECT * FROM members WHERE name=? AND active=0 AND is_test=0').get(name);
  }

  reactivateMember(id, token) {
    return this.db.prepare('UPDATE members SET active=1, token=? WHERE id=? AND active=0').run(token, id);
  }

  deactivateMember(id) {
    return this.db.prepare('UPDATE members SET active=0 WHERE id=? AND active=1').run(id);
  }

  resetMemberToken(id, token) {
    return this.db.prepare('UPDATE members SET token=? WHERE id=? AND active=1').run(token, id);
  }

  // ---- reports ----
  // Test-member reports are stored like any other but excluded from every
  // aggregate below — they never count toward rosters, digests, or history.
  submittedMemberIds(date) {
    return this.db.prepare(`
      SELECT r.member_id FROM reports r JOIN members m ON m.id=r.member_id
      WHERE r.report_date=? AND r.status='submitted' AND m.is_test=0
    `).all(date).map(r => r.member_id);
  }

  dayReports(date) {
    return this.db.prepare(`
      SELECT r.*, m.name FROM reports r JOIN members m ON m.id=r.member_id
      WHERE r.report_date=? AND r.status='submitted' AND m.is_test=0 ORDER BY r.updated_at
    `).all(date);
  }

  reportHistory(limit = 90) {
    return this.db.prepare(`
      SELECT r.report_date,
        SUM(r.status='submitted') submitted,
        SUM(CASE WHEN r.status='submitted'
          THEN (SELECT COUNT(*) FROM json_each(COALESCE(r.topics,'[]'))) ELSE 0 END) topics_count
      FROM reports r JOIN members m ON m.id=r.member_id
      WHERE m.is_test=0
      GROUP BY r.report_date ORDER BY r.report_date DESC LIMIT ?
    `).all(limit);
  }

  upsertSummary(memberId, date, args, rawJson, model) {
    const j = v => JSON.stringify(Array.isArray(v) ? v : []);
    this.db.prepare(`
      INSERT INTO reports(member_id,report_date,status,yesterday,today,blockers,topics,raw_json,model)
      VALUES(?,?,'submitted',?,?,?,?,?,?)
      ON CONFLICT(member_id,report_date) DO UPDATE SET status='submitted',
        yesterday=excluded.yesterday,today=excluded.today,blockers=excluded.blockers,
        topics=excluded.topics,raw_json=excluded.raw_json,updated_at=datetime('now','localtime')
    `).run(memberId, date, j(args.yesterday), j(args.today), j(args.blockers), j(args.topics_for_meeting), rawJson, model);
  }

  appendTranscript(memberId, date, transcript, durationS, model, submitted) {
    this.db.prepare(`
      INSERT INTO reports(member_id,report_date,status,transcript,duration_s,model) VALUES(?,?,?,?,?,?)
      ON CONFLICT(member_id,report_date) DO UPDATE SET
        transcript=COALESCE(reports.transcript,'')||char(10)||excluded.transcript,
        duration_s=COALESCE(reports.duration_s,0)+excluded.duration_s,
        status=CASE WHEN reports.status='submitted' THEN 'submitted' ELSE excluded.status END,
        updated_at=datetime('now','localtime')
    `).run(memberId, date, submitted ? 'submitted' : 'draft', transcript, durationS, model);
  }

  // ---- auth sessions ----
  insertSession(tokenHash, now) {
    this.db.prepare('INSERT INTO sessions(token_hash,created_at,last_activity_at) VALUES(?,?,?)')
      .run(tokenHash, now, now);
  }

  getSession(tokenHash) {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(tokenHash);
  }

  touchSession(tokenHash, now) {
    this.db.prepare('UPDATE sessions SET last_activity_at=? WHERE token_hash=?').run(now, tokenHash);
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
  }

  cleanupSessions(createdBefore, idleBefore) {
    this.db.prepare('DELETE FROM sessions WHERE created_at < ? OR last_activity_at < ?')
      .run(createdBefore, idleBefore);
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
