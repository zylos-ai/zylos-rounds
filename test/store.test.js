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

test('deactivate then reactivate with same name preserves history', () => {
  const s = tmpStore();
  const info = s.addMember('孙七', 'tokS');
  const id = Number(info.lastInsertRowid);
  s.upsertSummary(id, '2026-07-17', { yesterday: ['old'], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  s.deactivateMember(id);
  assert.equal(s.listActiveMembers().length, 0);
  assert.throws(() => s.addMember('孙七', 'tokNew'), /UNIQUE/);
  const inactive = s.getInactiveMemberByName('孙七');
  assert.ok(inactive);
  assert.equal(inactive.id, id);
  s.reactivateMember(id, 'tokNew');
  assert.equal(s.listActiveMembers().length, 1);
  assert.equal(s.getMemberByToken('tokNew').id, id);
  assert.equal(s.getMemberByToken('tokS'), undefined);
  const rows = s.dayReports('2026-07-17');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].yesterday), ['old']);
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

test('member profile: set, timestamp, clear, and report lookup', () => {
  const s = tmpStore();
  const id = Number(s.addMember('P', 'tp').lastInsertRowid);
  assert.equal(s.getMemberById(id).profile, null);
  s.setMemberProfile(id, '- [2026-07-18] 负责语音日报');
  const m = s.getMemberById(id);
  assert.match(m.profile, /语音日报/);
  assert.ok(m.profile_updated_at);
  s.setMemberProfile(id, null);
  assert.equal(s.getMemberById(id).profile, null);

  s.upsertSummary(id, '2026-07-18', { yesterday: ['y'], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  assert.equal(s.getReport(id, '2026-07-18').status, 'submitted');
  assert.equal(s.getReport(id, '2026-01-01'), undefined);
  s.close();
});

test('settings CRUD: set, overwrite, delete', () => {
  const s = tmpStore();
  assert.equal(s.getSetting('model'), null);
  s.setSetting('model', 'gpt-realtime');
  assert.equal(s.getSetting('model'), 'gpt-realtime');
  s.setSetting('model', 'gpt-realtime-2.1'); // upsert overwrites
  assert.equal(s.getSetting('model'), 'gpt-realtime-2.1');
  s.deleteSetting('model');
  assert.equal(s.getSetting('model'), null);
  s.close();
});

test('test member: ensured idempotently, reactivated if inactive', () => {
  const s = tmpStore();
  const t1 = s.ensureTestMember('体验成员', 'tokT');
  assert.equal(Boolean(t1.is_test), true);
  const t2 = s.ensureTestMember('体验成员', 'tokOther'); // second call keeps original
  assert.equal(t2.id, t1.id);
  assert.equal(t2.token, 'tokT');
  s.db.prepare('UPDATE members SET active=0 WHERE id=?').run(t1.id);
  const t3 = s.ensureTestMember('体验成员', 'tokIgnored');
  assert.equal(t3.id, t1.id);
  assert.equal(Boolean(t3.active), true); // reactivated, token preserved
  assert.equal(t3.token, 'tokT');
  s.close();
});

test('test member is excluded from rosters, digests, and history', () => {
  const s = tmpStore();
  const real = Number(s.addMember('真人', 'tokR').lastInsertRowid);
  const t = s.ensureTestMember('体验成员', 'tokT');
  // test member talks and submits like anyone else
  s.upsertSummary(t.id, '2026-07-17', { yesterday: ['试'], today: [], blockers: [], topics_for_meeting: ['话题'] }, '{}', 'm');
  s.appendTranscript(t.id, '2026-07-17', 'test line', 30, 'm', true);
  s.upsertSummary(real, '2026-07-17', { yesterday: ['真'], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  // ...but never appears in any aggregate
  assert.equal(s.listActiveMembers().length, 1); // roster: real only
  assert.deepEqual(s.submittedMemberIds('2026-07-17'), [real]);
  const rows = s.dayReports('2026-07-17');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '真人');
  const days = s.reportHistory();
  assert.equal(days.length, 1);
  assert.equal(Number(days[0].submitted), 1);
  assert.equal(Number(days[0].topics_count), 0); // test topics not counted
  // token lookup still works for the talk flow
  assert.equal(s.getMemberByToken('tokT').is_test, 1);
  s.close();
});
