import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-test-'));
  return new Store(path.join(dir, 'test.db'));
}

test('migrations create schema and are idempotent on reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-test-'));
  const dbPath = path.join(dir, 'test.db');
  const s1 = new Store(dbPath);
  s1.addMember('张三', 'tok1');
  s1.close();
  const s2 = new Store(dbPath); // re-running migrations must not fail or wipe
  assert.equal(s2.listActiveMembers().length, 1);
  s2.close();
});

test('member lifecycle: add, token lookup, deactivate, reset', () => {
  const s = tmpStore();
  const info = s.addMember('李四', 'tokA');
  const id = Number(info.lastInsertRowid);
  assert.equal(s.getMemberByToken('tokA').name, '李四');
  assert.throws(() => s.addMember('李四', 'tokB'), /UNIQUE/); // name unique
  s.resetMemberToken(id, 'tokC');
  assert.equal(s.getMemberByToken('tokA'), undefined);
  assert.equal(s.getMemberByToken('tokC').id, id);
  s.deactivateMember(id);
  assert.equal(s.getMemberByToken('tokC'), undefined); // inactive token rejected
  assert.equal(s.listActiveMembers().length, 0);
  s.close();
});

test('summary upsert overwrites structured fields, keeps one row per member+date', () => {
  const s = tmpStore();
  const id = Number(s.addMember('王五', 'tokW').lastInsertRowid);
  s.upsertSummary(id, '2026-07-17', { yesterday: ['a'], today: ['b'], blockers: [], topics_for_meeting: ['t'] }, '{}', 'm1');
  s.upsertSummary(id, '2026-07-17', { yesterday: ['a2'], today: ['b2'], blockers: ['x'], topics_for_meeting: [] }, '{}', 'm1');
  const rows = s.dayReports('2026-07-17');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].yesterday), ['a2']);
  assert.deepEqual(JSON.parse(rows[0].blockers), ['x']);
  s.close();
});

test('transcript append accumulates and never downgrades submitted status', () => {
  const s = tmpStore();
  const id = Number(s.addMember('赵六', 'tokZ').lastInsertRowid);
  s.appendTranscript(id, '2026-07-17', 'line1', 60, 'm1', false);
  assert.equal(s.dayReports('2026-07-17').length, 0); // draft not in digest
  s.upsertSummary(id, '2026-07-17', { yesterday: [], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm1');
  s.appendTranscript(id, '2026-07-17', 'line2', 30, 'm1', false); // later draft close
  const rows = s.dayReports('2026-07-17');
  assert.equal(rows.length, 1); // still submitted
  assert.match(rows[0].transcript, /line1/);
  assert.match(rows[0].transcript, /line2/);
  assert.equal(rows[0].duration_s, 90);
  s.close();
});

test('history aggregates submitted counts and topic counts', () => {
  const s = tmpStore();
  const a = Number(s.addMember('A', 't1').lastInsertRowid);
  const b = Number(s.addMember('B', 't2').lastInsertRowid);
  s.upsertSummary(a, '2026-07-16', { yesterday: [], today: [], blockers: [], topics_for_meeting: ['x', 'y'] }, '{}', 'm');
  s.upsertSummary(b, '2026-07-16', { yesterday: [], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  s.upsertSummary(a, '2026-07-17', { yesterday: [], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  const days = s.reportHistory();
  assert.equal(days.length, 2);
  assert.equal(days[0].report_date, '2026-07-17'); // desc order
  assert.equal(Number(days[1].submitted), 2);
  assert.equal(Number(days[1].topics_count), 2);
  s.close();
});
