/**
 * SQLite store for zylos-standup.
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
      console.log(`[standup] DB migrated to version ${m.version}`);
    }
  }

  // ---- members ----
  getMemberByToken(token) {
    return this.db.prepare('SELECT * FROM members WHERE token=? AND active=1').get(token);
  }

  listActiveMembers() {
    return this.db.prepare('SELECT * FROM members WHERE active=1 ORDER BY id').all();
  }

  addMember(name, token) {
    return this.db.prepare('INSERT INTO members(name,token) VALUES(?,?)').run(name, token);
  }

  getMemberById(id) {
    return this.db.prepare('SELECT * FROM members WHERE id=?').get(id);
  }

  deactivateMember(id) {
    return this.db.prepare('UPDATE members SET active=0 WHERE id=? AND active=1').run(id);
  }

  resetMemberToken(id, token) {
    return this.db.prepare('UPDATE members SET token=? WHERE id=? AND active=1').run(token, id);
  }

  // ---- reports ----
  submittedMemberIds(date) {
    return this.db.prepare(
      "SELECT member_id FROM reports WHERE report_date=? AND status='submitted'"
    ).all(date).map(r => r.member_id);
  }

  dayReports(date) {
    return this.db.prepare(`
      SELECT r.*, m.name FROM reports r JOIN members m ON m.id=r.member_id
      WHERE r.report_date=? AND r.status='submitted' ORDER BY r.updated_at
    `).all(date);
  }

  reportHistory(limit = 90) {
    return this.db.prepare(`
      SELECT report_date,
        SUM(status='submitted') submitted,
        SUM(CASE WHEN status='submitted'
          THEN (SELECT COUNT(*) FROM json_each(COALESCE(topics,'[]'))) ELSE 0 END) topics_count
      FROM reports GROUP BY report_date ORDER BY report_date DESC LIMIT ?
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
