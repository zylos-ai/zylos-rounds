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
  {
    // v0.8 provider framework: providers own connection info (base URL, key,
    // capability flags); usage slots in settings reference them by slug.
    // The builtin 'openai' row replaces the implicit global OpenAI connection;
    // a legacy DB-stored key migrates onto it (env key still wins at runtime).
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT,
        cap_realtime INTEGER NOT NULL DEFAULT 0,
        cap_models INTEGER NOT NULL DEFAULT 0,
        is_builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO providers(slug,name,base_url,cap_realtime,cap_models,is_builtin)
        VALUES ('openai','OpenAI 官方','https://api.openai.com',1,1,1);
      UPDATE providers SET api_key=(SELECT value FROM settings WHERE key='openai_api_key')
        WHERE slug='openai';
      DELETE FROM settings WHERE key='openai_api_key';
    `,
  },
  {
    // v0.11 usage/cost tracking: one row per voice session or text call.
    // Raw token breakdown is stored alongside the computed cost so costs can
    // be recomputed if the price table changes retroactively.
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        date TEXT NOT NULL,
        slot TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        member_id INTEGER,
        seconds INTEGER NOT NULL DEFAULT 0,
        input_text INTEGER NOT NULL DEFAULT 0,
        input_audio INTEGER NOT NULL DEFAULT 0,
        cached_text INTEGER NOT NULL DEFAULT 0,
        cached_audio INTEGER NOT NULL DEFAULT 0,
        output_text INTEGER NOT NULL DEFAULT 0,
        output_audio INTEGER NOT NULL DEFAULT 0,
        asr_seconds REAL NOT NULL DEFAULT 0,
        asr_model TEXT,
        cost_usd REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_log_date ON usage_log(date);
    `,
  },
  {
    // v0.12 multi-language: per-member conversation/UI language. NULL follows
    // the team default (settings key 'language', default zh). The value drives
    // the member's talk-page UI, the agent's spoken language, ASR language and
    // profile language; owner-facing digests follow the team default.
    version: 10,
    sql: `
      ALTER TABLE members ADD COLUMN language TEXT;
    `,
  },
  {
    // v0.17 named management API keys: per-client bearer tokens (create /
    // rotate / revoke without touching the server), sha256 at rest. Since
    // v0.18 these are the only bearer credentials (config.serviceToken is
    // migrated into this table at startup).
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        last_used_at TEXT
      );
    `,
  },
  {
    // v0.22 follow-ups + scope. A follow-up is a free-text note appended after a
    // cycle of a task ("补充/跟进/更新信息") that the NEXT cycle carries in and
    // the agent can also recall on demand. It is deliberately unstructured — no
    // status, no lifecycle: a decision is just a follow-up whose text states a
    // decision (the v0.21 decision-writeback special case dissolves into this).
    //
    // Visibility is enforced structurally, never by prompt. Each task carries an
    // `audience` (internal / external); each follow-up a `scope` (private /
    // team). Read rule (see Store.recall* helpers): a task always sees its own
    // follow-ups; team-shared follow-ups and the knowledge base are visible only
    // to INTERNAL tasks; another task's private follow-ups are never visible; an
    // external task sees only its own follow-ups. This wall keeps internal
    // context from leaking into an external-facing conversation.
    version: 12,
    sql: `
      ALTER TABLE tasks ADD COLUMN audience TEXT NOT NULL DEFAULT 'internal';
      CREATE TABLE IF NOT EXISTS follow_up (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        content TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('private','team')),
        author TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_follow_up_task ON follow_up(task_id, created_at);
      INSERT INTO follow_up(task_id, content, scope, author, created_at)
        SELECT (SELECT id FROM tasks WHERE is_builtin=1 LIMIT 1), content, 'team', NULL, created_at
        FROM knowledge WHERE tags='decision'
          AND (SELECT id FROM tasks WHERE is_builtin=1 LIMIT 1) IS NOT NULL;
      DELETE FROM knowledge WHERE tags='decision';
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

  // ---- providers (v0.8 model provider framework) ----
  listProviders() {
    return this.db.prepare('SELECT * FROM providers ORDER BY is_builtin DESC, id').all();
  }

  getProvider(slug) {
    return this.db.prepare('SELECT * FROM providers WHERE slug=?').get(slug) ?? null;
  }

  createProvider({ slug, name, baseUrl, apiKey, capRealtime, capModels }) {
    this.db.prepare(`
      INSERT INTO providers(slug,name,base_url,api_key,cap_realtime,cap_models,is_builtin)
      VALUES(?,?,?,?,?,?,0)
    `).run(slug, name, baseUrl, apiKey || null, capRealtime ? 1 : 0, capModels ? 1 : 0);
    return this.getProvider(slug);
  }

  updateProvider(slug, patch) {
    const cur = this.getProvider(slug);
    if (!cur) return null;
    const next = {
      name: patch.name ?? cur.name,
      base_url: patch.baseUrl ?? cur.base_url,
      api_key: patch.apiKey !== undefined ? (patch.apiKey || null) : cur.api_key,
      cap_realtime: patch.capRealtime !== undefined ? (patch.capRealtime ? 1 : 0) : cur.cap_realtime,
      cap_models: patch.capModels !== undefined ? (patch.capModels ? 1 : 0) : cur.cap_models,
    };
    this.db.prepare(`
      UPDATE providers SET name=?, base_url=?, api_key=?, cap_realtime=?, cap_models=? WHERE slug=?
    `).run(next.name, next.base_url, next.api_key, next.cap_realtime, next.cap_models, slug);
    return this.getProvider(slug);
  }

  deleteProvider(slug) {
    this.db.prepare('DELETE FROM providers WHERE slug=? AND is_builtin=0').run(slug);
  }

  // ---- management API tokens (v0.17) ----
  listApiTokens() {
    return this.db.prepare('SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY id').all();
  }

  getApiToken(id) {
    return this.db.prepare('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE id=?').get(id) ?? null;
  }

  getApiTokenByName(name) {
    return this.db.prepare('SELECT id, name FROM api_tokens WHERE name=?').get(name) ?? null;
  }

  getApiTokenByHash(hash) {
    return this.db.prepare('SELECT id, name FROM api_tokens WHERE token_hash=?').get(hash) ?? null;
  }

  createApiToken(name, hash) {
    const r = this.db.prepare('INSERT INTO api_tokens(name, token_hash) VALUES(?,?)').run(name, hash);
    return this.getApiToken(r.lastInsertRowid);
  }

  /** Rotate: same row (id/name), new secret, created_at reset to now. */
  rotateApiToken(id, hash) {
    this.db.prepare(`
      UPDATE api_tokens SET token_hash=?, created_at=datetime('now','localtime'), last_used_at=NULL WHERE id=?
    `).run(hash, id);
    return this.getApiToken(id);
  }

  deleteApiToken(id) {
    return this.db.prepare('DELETE FROM api_tokens WHERE id=?').run(id).changes > 0;
  }

  touchApiToken(id) {
    this.db.prepare(`UPDATE api_tokens SET last_used_at=datetime('now','localtime') WHERE id=?`).run(id);
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

  // ---- follow-ups (补充/跟进) + scope-aware visibility ----------------------
  // A follow-up is free text appended after a cycle of a task; the next cycle
  // carries recent ones in and the agent can also recall them on demand. No
  // status, no lifecycle — a decision is just a follow-up whose text states one.
  //
  // Visibility is enforced in the QUERY, never by prompt. `scope` is per
  // follow-up ('private' | 'team'); `audience` is per task ('internal' |
  // 'external'). A task always sees its own follow-ups; team-shared follow-ups
  // are visible only to internal tasks; another task's private follow-ups are
  // never visible; an external task sees only its own follow-ups.
  builtinTaskId() {
    return this.db.prepare('SELECT id FROM tasks WHERE is_builtin=1 LIMIT 1').get()?.id ?? null;
  }

  /** Set a task's audience class ('internal' | 'external'). Governs whether the
   *  task can read team-shared follow-ups and the knowledge base. */
  setTaskAudience(id, audience) {
    const a = audience === 'external' ? 'external' : 'internal';
    return this.db.prepare("UPDATE tasks SET audience=?, updated_at=datetime('now','localtime') WHERE id=?").run(a, id);
  }

  addFollowup({ taskId, content, scope = 'private', author } = {}) {
    const body = String(content || '').trim();
    if (!body) throw new Error('follow-up content required');
    if (!taskId) throw new Error('follow-up taskId required');
    const sc = scope === 'team' ? 'team' : 'private';
    const who = author ? String(author).trim() : null;
    return this.db.prepare('INSERT INTO follow_up(task_id,content,scope,author) VALUES(?,?,?,?)')
      .run(taskId, body, sc, who);
  }

  listFollowups(taskId) {
    return this.db.prepare('SELECT * FROM follow_up WHERE task_id=? ORDER BY created_at DESC, id DESC').all(taskId);
  }

  getFollowup(id) {
    return this.db.prepare('SELECT * FROM follow_up WHERE id=?').get(id);
  }

  deleteFollowup(id) {
    return this.db.prepare('DELETE FROM follow_up WHERE id=?').run(id);
  }

  /**
   * Recent follow-ups to deterministically inject into `taskId`'s next cycle
   * (probing + digest closeout). Own follow-ups always; team-shared from any
   * task only when the task is internal; never another task's private ones.
   */
  recentFollowups(taskId, audience = 'internal', days = 3, limit = 30) {
    const since = `-${Math.max(0, Number(days) || 0)} days`;
    const lim = Math.max(1, Number(limit) || 1);
    if (audience === 'external') {
      return this.db.prepare(
        `SELECT * FROM follow_up
           WHERE task_id=? AND datetime(created_at) >= datetime('now','localtime', ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(taskId, since, lim);
    }
    return this.db.prepare(
      `SELECT * FROM follow_up
         WHERE datetime(created_at) >= datetime('now','localtime', ?)
           AND (task_id=? OR scope='team')
       ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(since, taskId, lim);
  }

  /**
   * Scope-aware heuristic recall for the agent's search tool. Searches the
   * follow-ups visible to `taskId` plus — only for internal tasks — the team
   * knowledge base. External tasks never reach knowledge or other tasks' data.
   * Deterministic string match (AND over terms), title/knowledge hits ranked
   * higher. Returns knowledge-shaped rows {id, title, content, tags, source}.
   */
  recall(taskId, audience = 'internal', query, limit = 5) {
    const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    const fu = audience === 'external'
      ? this.db.prepare('SELECT id, content, created_at FROM follow_up WHERE task_id=?').all(taskId)
      : this.db.prepare("SELECT id, content, created_at FROM follow_up WHERE task_id=? OR scope='team'").all(taskId);
    const rows = fu.map(r => ({
      id: r.id,
      title: `【补充】${String(r.content).split('\n')[0].slice(0, 40)}`,
      content: r.content,
      tags: 'follow-up',
      source: 'follow_up',
    }));
    if (audience !== 'external') {
      for (const k of this.db.prepare('SELECT id, title, content, tags FROM knowledge').all()) {
        rows.push({ ...k, source: 'knowledge' });
      }
    }
    const scored = [];
    for (const r of rows) {
      const hay = `${r.title}\n${r.content}\n${r.tags || ''}`.toLowerCase();
      const title = String(r.title).toLowerCase();
      if (!terms.every(t => hay.includes(t))) continue;
      const score = terms.reduce((s, t) => s + (title.includes(t) ? 2 : 1), 0);
      scored.push({ ...r, _score: score });
    }
    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }

  // Back-compat aliases — the v0.21 decision-writeback API dissolved into
  // follow-ups. A recorded decision is a team-scoped follow-up on the built-in
  // daily task (where 待议 lives). Kept so existing /api/decisions + CLI keep
  // working; new callers should use addFollowup / recentFollowups directly.
  addDecision({ topic, content, decidedBy } = {}) {
    const body = String(content || '').trim();
    if (!body) throw new Error('decision content required');
    const taskId = this.builtinTaskId();
    if (!taskId) throw new Error('no built-in daily task to attach the decision to');
    const t = String(topic || '').trim();
    const stamp = `（${new Date().toLocaleString('sv').replace('T', ' ').slice(0, 16)}${decidedBy ? ' · ' + String(decidedBy).trim() + ' 拍板' : ''}）`;
    const text = `${t ? `【${t}】` : ''}${body}\n${stamp}`;
    return this.addFollowup({ taskId, content: text, scope: 'team', author: decidedBy });
  }

  recentDecisions(days = 3, limit = 20) {
    const taskId = this.builtinTaskId();
    if (!taskId) return [];
    return this.recentFollowups(taskId, 'internal', days, limit);
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
  setMemberLanguage(id, language) {
    return this.db.prepare('UPDATE members SET language=? WHERE id=?').run(language ?? null, id);
  }

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

  // ---- usage/cost tracking (v0.11) ----

  insertUsage(u) {
    this.db.prepare(`
      INSERT INTO usage_log(ts,date,slot,provider,model,member_id,seconds,
        input_text,input_audio,cached_text,cached_audio,output_text,output_audio,
        asr_seconds,asr_model,cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      u.ts ?? Date.now(), u.date, u.slot, u.provider, u.model, u.member_id ?? null,
      Math.round(u.seconds || 0),
      Math.round(u.input_text || 0), Math.round(u.input_audio || 0),
      Math.round(u.cached_text || 0), Math.round(u.cached_audio || 0),
      Math.round(u.output_text || 0), Math.round(u.output_audio || 0),
      u.asr_seconds || 0, u.asr_model ?? null, u.cost_usd || 0,
    );
  }

  /** Month rollup ('YYYY-MM'): totals plus by-day/model/member breakdowns. */
  usageSummary(month, today) {
    const like = `${month}-%`;
    const total = this.db.prepare(
      'SELECT COALESCE(SUM(cost_usd),0) usd, COUNT(*) rows FROM usage_log WHERE date LIKE ?',
    ).get(like);
    const todayRow = this.db.prepare(
      'SELECT COALESCE(SUM(cost_usd),0) usd FROM usage_log WHERE date = ?',
    ).get(today);
    const byDay = this.db.prepare(
      'SELECT date, SUM(cost_usd) usd FROM usage_log WHERE date LIKE ? GROUP BY date ORDER BY date',
    ).all(like);
    const byModel = this.db.prepare(`
      SELECT model, slot, COUNT(*) calls, SUM(seconds) seconds, SUM(cost_usd) usd,
        SUM(input_text+input_audio) tokens_in, SUM(output_text+output_audio) tokens_out
      FROM usage_log WHERE date LIKE ? GROUP BY model, slot ORDER BY usd DESC
    `).all(like);
    const byMember = this.db.prepare(`
      SELECT u.member_id, m.name, COUNT(*) calls, SUM(u.seconds) seconds, SUM(u.cost_usd) usd
      FROM usage_log u LEFT JOIN members m ON m.id = u.member_id
      WHERE u.date LIKE ? AND u.member_id IS NOT NULL
      GROUP BY u.member_id ORDER BY usd DESC
    `).all(like);
    return {
      month,
      total_usd: total.usd,
      entries: total.rows,
      today_usd: todayRow.usd,
      by_day: byDay,
      by_model: byModel,
      by_member: byMember,
    };
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
