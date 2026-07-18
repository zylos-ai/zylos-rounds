/**
 * SQLite store for zylos-rounds.
 *
 * Incremental, idempotent migrations tracked in schema_migrations —
 * never modify an existing migration, only append new ones.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Exported for the migration test (which replays v1..v5 then upgrades).
export const MIGRATIONS = [
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
  {
    // v0.6 communication tasks (沟通任务). A task = brief + question frame +
    // participants + window + digest form. The daily standup becomes the single
    // built-in `recurring` task (its per-day data stays in `reports`); `oneshot`
    // tasks (e.g. quarterly reviews) get one conversation per participant,
    // reached via a per-(task, member) link token. The permanent member token
    // keeps routing to the recurring task. Digest lives on the task row and is
    // overwritten on each (manual or scheduled) trigger; closing is decoupled.
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('recurring','oneshot')),
        title TEXT NOT NULL,
        brief TEXT,
        questions TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        deadline TEXT,
        digest_auto_at TEXT,
        digest_auto_fired INTEGER NOT NULL DEFAULT 0,
        digest_close_linked INTEGER NOT NULL DEFAULT 0,
        digest TEXT,
        digest_updated_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE TABLE IF NOT EXISTS task_members (
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        member_id INTEGER NOT NULL REFERENCES members(id),
        token TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        summary TEXT,
        highlights TEXT,
        transcript TEXT,
        duration_s INTEGER,
        updated_at TEXT,
        PRIMARY KEY(task_id, member_id)
      );
      ALTER TABLE reports ADD COLUMN task_id INTEGER;
    `,
  },
  {
    // v0.7 unified task model. Owner rulings 2026-07-18 (evening):
    //   - recurring tasks are user-creatable with a cadence (daily / weekly
    //     dow set / every-N-days); the built-in daily standup becomes a
    //     protected instance (is_builtin=1) keeping its structured pipeline
    //   - ALL links are per-(task, member): the permanent member token no
    //     longer routes anywhere (task_members.token is the only credential)
    //   - data is organized per cycle: generic conversation output lives in
    //     cycle_records keyed (task, member, cycle_key); a oneshot task is the
    //     degenerate single cycle '-'; the built-in daily keeps `reports`
    //     (its four-bucket standup shape) with report_date as the cycle key
    //   - per-cycle digests for recurring tasks live in cycle_digests; the
    //     digest instruction is customizable per task (NULL = default template)
    version: 6,
    sql: `
      ALTER TABLE tasks ADD COLUMN cadence_type TEXT;
      ALTER TABLE tasks ADD COLUMN cadence_dow TEXT;
      ALTER TABLE tasks ADD COLUMN cadence_interval_days INTEGER;
      ALTER TABLE tasks ADD COLUMN cadence_anchor TEXT;
      ALTER TABLE tasks ADD COLUMN digest_instruction TEXT;
      ALTER TABLE tasks ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0;
      UPDATE tasks SET is_builtin=1, cadence_type='daily'
        WHERE type='recurring' AND id=(SELECT MIN(id) FROM tasks WHERE type='recurring');

      CREATE TABLE IF NOT EXISTS cycle_records (
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        member_id INTEGER NOT NULL REFERENCES members(id),
        cycle_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        summary TEXT, highlights TEXT, transcript TEXT, duration_s INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        PRIMARY KEY(task_id, member_id, cycle_key)
      );
      INSERT INTO cycle_records(task_id,member_id,cycle_key,status,summary,highlights,transcript,duration_s,updated_at)
        SELECT task_id, member_id, '-', status, summary, highlights, transcript, duration_s,
               COALESCE(updated_at, datetime('now','localtime'))
        FROM task_members
        WHERE status='submitted' OR summary IS NOT NULL OR transcript IS NOT NULL;

      CREATE TABLE IF NOT EXISTS cycle_digests (
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        cycle_key TEXT NOT NULL,
        content TEXT,
        auto_fired INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        PRIMARY KEY(task_id, cycle_key)
      );
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE tasks ADD COLUMN probe_instruction TEXT;
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

  // ---- communication tasks (沟通任务) ----

  /** Seed the built-in daily-standup task (is_builtin=1, cadence daily). Idempotent. */
  ensureDailyTask(title) {
    const existing = this.getDailyTask();
    if (existing) return existing;
    this.db.prepare("INSERT INTO tasks(type,title,is_builtin,cadence_type) VALUES('recurring',?,1,'daily')").run(title);
    return this.getDailyTask();
  }

  getDailyTask() {
    return this.db.prepare('SELECT * FROM tasks WHERE is_builtin=1 ORDER BY id LIMIT 1').get();
  }

  getTask(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  }

  listTasks() {
    return this.db.prepare('SELECT * FROM tasks ORDER BY (type=\'recurring\') DESC, id DESC').all();
  }

  createTask({ type, title, brief, questions, deadline, digestAutoAt, digestCloseLinked,
    cadenceType, cadenceDow, cadenceIntervalDays, cadenceAnchor, digestInstruction, probeInstruction }) {
    const info = this.db.prepare(`
      INSERT INTO tasks(type,title,brief,questions,deadline,digest_auto_at,digest_close_linked,
        cadence_type,cadence_dow,cadence_interval_days,cadence_anchor,digest_instruction,probe_instruction)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(type, title, brief ?? null, questions ?? null, deadline ?? null, digestAutoAt ?? null,
      digestCloseLinked ? 1 : 0, cadenceType ?? null, cadenceDow ?? null,
      cadenceIntervalDays ?? null, cadenceAnchor ?? null, digestInstruction ?? null, probeInstruction ?? null);
    return this.getTask(Number(info.lastInsertRowid));
  }

  updateTask(id, fields) {
    const cols = {
      title: 'title', brief: 'brief', questions: 'questions', deadline: 'deadline',
      digestAutoAt: 'digest_auto_at', digestCloseLinked: 'digest_close_linked',
      digestInstruction: 'digest_instruction', probeInstruction: 'probe_instruction',
      cadenceType: 'cadence_type', cadenceDow: 'cadence_dow',
      cadenceIntervalDays: 'cadence_interval_days', cadenceAnchor: 'cadence_anchor',
    };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(cols)) {
      if (fields[k] === undefined) continue;
      sets.push(`${col}=?`);
      vals.push(k === 'digestCloseLinked' ? (fields[k] ? 1 : 0) : (fields[k] ?? null));
    }
    // editing the auto-trigger re-arms it
    if (fields.digestAutoAt !== undefined) sets.push('digest_auto_fired=0');
    if (!sets.length) return this.getTask(id);
    vals.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(',')}, updated_at=datetime('now','localtime') WHERE id=?`).run(...vals);
    return this.getTask(id);
  }

  setTaskStatus(id, status) {
    this.db.prepare("UPDATE tasks SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(status, id);
    return this.getTask(id);
  }

  /** Overwrite the task-level digest (re-triggering replaces the previous one). */
  setTaskDigest(id, digest) {
    this.db.prepare(`
      UPDATE tasks SET digest=?, digest_updated_at=datetime('now','localtime'),
        updated_at=datetime('now','localtime') WHERE id=?
    `).run(digest, id);
  }

  markTaskAutoFired(id) {
    this.db.prepare('UPDATE tasks SET digest_auto_fired=1 WHERE id=?').run(id);
  }

  /** Open tasks whose auto-trigger time has passed and hasn't fired yet. */
  dueAutoDigestTasks(nowLocalIso) {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE status='open' AND digest_auto_at IS NOT NULL AND digest_auto_fired=0 AND digest_auto_at <= ?
    `).all(nowLocalIso);
  }

  /** Delete a non-builtin task and everything keyed to it. */
  deleteTask(id) {
    const task = this.getTask(id);
    if (!task || task.is_builtin) return { changes: 0 };
    this.db.prepare('DELETE FROM task_members WHERE task_id=?').run(id);
    this.db.prepare('DELETE FROM cycle_records WHERE task_id=?').run(id);
    this.db.prepare('DELETE FROM cycle_digests WHERE task_id=?').run(id);
    return this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  }

  addTaskMember(taskId, memberId, token) {
    this.db.prepare(`
      INSERT INTO task_members(task_id,member_id,token) VALUES(?,?,?)
      ON CONFLICT(task_id,member_id) DO NOTHING
    `).run(taskId, memberId, token);
  }

  removeTaskMember(taskId, memberId) {
    this.db.prepare('DELETE FROM task_members WHERE task_id=? AND member_id=?').run(taskId, memberId);
  }

  getTaskMember(taskId, memberId) {
    return this.db.prepare('SELECT * FROM task_members WHERE task_id=? AND member_id=?').get(taskId, memberId);
  }

  resetTaskMemberToken(taskId, memberId, token) {
    return this.db.prepare('UPDATE task_members SET token=? WHERE task_id=? AND member_id=?').run(token, taskId, memberId);
  }

  taskMembers(taskId) {
    return this.db.prepare(`
      SELECT tm.task_id, tm.member_id, tm.token, m.name, m.active, m.is_test
      FROM task_members tm JOIN members m ON m.id=tm.member_id
      WHERE tm.task_id=? ORDER BY m.id
    `).all(taskId);
  }

  /** All open-task link rows for one member — the member page's link list. */
  memberTaskLinks(memberId) {
    return this.db.prepare(`
      SELECT tm.task_id, tm.token, t.title, t.type, t.is_builtin
      FROM task_members tm JOIN tasks t ON t.id=tm.task_id
      WHERE tm.member_id=? AND t.status='open'
      ORDER BY t.is_builtin DESC, t.id DESC
    `).all(memberId);
  }

  /** Resolve a per-(task, member) link token → { task, member } for open tasks only. */
  getTaskSessionByToken(token) {
    const row = this.db.prepare(`
      SELECT tm.task_id, tm.member_id FROM task_members tm
      JOIN tasks t ON t.id=tm.task_id
      JOIN members m ON m.id=tm.member_id
      WHERE tm.token=? AND t.status='open' AND m.active=1
    `).get(token);
    if (!row) return null;
    return { task: this.getTask(row.task_id), member: this.getMemberById(row.member_id) };
  }

  // ---- per-cycle conversation records (generic shape; oneshot cycle_key='-') ----

  cycleRecords(taskId, cycleKey) {
    return this.db.prepare(`
      SELECT tm.member_id, tm.token, m.name, m.active, m.is_test,
        cr.status, cr.summary, cr.highlights, cr.transcript, cr.duration_s, cr.updated_at
      FROM task_members tm
      JOIN members m ON m.id=tm.member_id
      LEFT JOIN cycle_records cr ON cr.task_id=tm.task_id AND cr.member_id=tm.member_id AND cr.cycle_key=?
      WHERE tm.task_id=? ORDER BY m.id
    `).all(cycleKey, taskId);
  }

  getCycleRecord(taskId, memberId, cycleKey) {
    return this.db.prepare(`
      SELECT * FROM cycle_records WHERE task_id=? AND member_id=? AND cycle_key=?
    `).get(taskId, memberId, cycleKey);
  }

  /** Distinct cycle keys a task has data or a digest for (newest first). */
  taskCycleKeys(taskId) {
    return this.db.prepare(`
      SELECT cycle_key FROM (
        SELECT cycle_key FROM cycle_records WHERE task_id=?
        UNION SELECT cycle_key FROM cycle_digests WHERE task_id=?
      ) ORDER BY cycle_key DESC
    `).all(taskId, taskId).map(r => r.cycle_key);
  }

  submitCycleSummary(taskId, memberId, cycleKey, summary, highlights) {
    this.db.prepare(`
      INSERT INTO cycle_records(task_id,member_id,cycle_key,status,summary,highlights)
      VALUES(?,?,?,'submitted',?,?)
      ON CONFLICT(task_id,member_id,cycle_key) DO UPDATE SET status='submitted',
        summary=excluded.summary, highlights=excluded.highlights,
        updated_at=datetime('now','localtime')
    `).run(taskId, memberId, cycleKey, summary ?? null, highlights ?? null);
  }

  appendCycleTranscript(taskId, memberId, cycleKey, transcript, durationS) {
    this.db.prepare(`
      INSERT INTO cycle_records(task_id,member_id,cycle_key,status,transcript,duration_s)
      VALUES(?,?,?,'draft',?,?)
      ON CONFLICT(task_id,member_id,cycle_key) DO UPDATE SET
        transcript=COALESCE(cycle_records.transcript,'')||CASE WHEN cycle_records.transcript IS NULL THEN '' ELSE char(10) END||excluded.transcript,
        duration_s=COALESCE(cycle_records.duration_s,0)+excluded.duration_s,
        updated_at=datetime('now','localtime')
    `).run(taskId, memberId, cycleKey, transcript, durationS);
  }

  // ---- per-cycle digests (recurring tasks; oneshot keeps tasks.digest) ----

  getCycleDigest(taskId, cycleKey) {
    return this.db.prepare('SELECT * FROM cycle_digests WHERE task_id=? AND cycle_key=?').get(taskId, cycleKey);
  }

  setCycleDigest(taskId, cycleKey, content, { autoFired } = {}) {
    this.db.prepare(`
      INSERT INTO cycle_digests(task_id,cycle_key,content,auto_fired)
      VALUES(?,?,?,?)
      ON CONFLICT(task_id,cycle_key) DO UPDATE SET
        content=COALESCE(excluded.content, cycle_digests.content),
        auto_fired=MAX(cycle_digests.auto_fired, excluded.auto_fired),
        updated_at=datetime('now','localtime')
    `).run(taskId, cycleKey, content ?? null, autoFired ? 1 : 0);
  }

  /** Open, non-builtin recurring tasks — the auto cycle-digest scheduler's scan set. */
  openRecurringTasks() {
    return this.db.prepare(`
      SELECT * FROM tasks WHERE status='open' AND type='recurring' AND is_builtin=0
    `).all();
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
