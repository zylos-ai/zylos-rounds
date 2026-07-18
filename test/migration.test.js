import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, MIGRATIONS } from '../src/lib/store.js';

/**
 * Replay a real v0.6 database (schema versions 1..5 with live data), then open
 * it with the current Store and assert the v6 migration transformed it:
 *  - the earliest recurring task becomes the protected built-in daily
 *  - v0.6 task_members conversation payloads move into cycle_records ('-')
 *  - new tables exist and are usable
 */
test('v6 migration: builtin flag + task_members payloads copied to cycle_records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rounds-mig-'));
  const dbPath = path.join(dir, 'test.db');

  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
  for (const m of MIGRATIONS.filter(x => x.version <= 5)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(m.version);
  }
  // v0.6-shaped data
  db.prepare("INSERT INTO members(name,token) VALUES('张三','tokA')").run();
  db.prepare("INSERT INTO members(name,token) VALUES('李四','tokB')").run();
  db.prepare("INSERT INTO tasks(type,title) VALUES('recurring','每日日报')").run();
  db.prepare("INSERT INTO tasks(type,title) VALUES('oneshot','Q2 复盘')").run();
  db.prepare(`INSERT INTO task_members(task_id,member_id,token,status,summary,highlights,transcript,duration_s,updated_at)
    VALUES(2,1,'tt1','submitted','["要点"]','["信号"]','张三: 你好',120,'2026-07-18 10:00:00')`).run();
  db.prepare("INSERT INTO task_members(task_id,member_id,token,status) VALUES(2,2,'tt2','pending')").run();
  db.close();

  const s = new Store(dbPath);
  // built-in flag landed on the earliest recurring task, cadence forced daily
  const daily = s.getDailyTask();
  assert.equal(daily.title, '每日日报');
  assert.equal(daily.cadence_type, 'daily');
  assert.equal(daily.is_builtin, 1);
  assert.equal(s.getTask(2).is_builtin, 0);

  // submitted payload copied into the oneshot's '-' cycle; pending member has no record
  const rec = s.getCycleRecord(2, 1, '-');
  assert.equal(rec.status, 'submitted');
  assert.equal(rec.summary, '["要点"]');
  assert.equal(rec.highlights, '["信号"]');
  assert.match(rec.transcript, /你好/);
  assert.equal(rec.duration_s, 120);
  assert.equal(s.getCycleRecord(2, 2, '-'), undefined);

  // routing still resolves the surviving task tokens
  assert.equal(s.getTaskSessionByToken('tt1').member.name, '张三');

  // new tables are usable post-migration
  s.setCycleDigest(2, '-', '## 共识\n- ok');
  assert.match(s.getCycleDigest(2, '-').content, /ok/);
  s.close();

  // reopening runs no further migrations and keeps the data
  const s2 = new Store(dbPath);
  assert.equal(s2.getCycleRecord(2, 1, '-').status, 'submitted');
  s2.close();
});
