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

test('member lifecycle: add, task-link lookup, reset, deactivate (v0.7 task×member tokens)', () => {
  const s = tmpStore();
  const info = s.addMember('李四', 'tokA');
  const id = Number(info.lastInsertRowid);
  assert.throws(() => s.addMember('李四', 'tokB'), /UNIQUE/); // name unique
  const daily = s.ensureDailyTask('每日日报');
  s.addTaskMember(daily.id, id, 'linkA');
  // the permanent member token never routes; only the task link does
  assert.equal(s.getTaskSessionByToken('tokA'), null);
  assert.equal(s.getTaskSessionByToken('linkA').member.name, '李四');
  assert.equal(s.getTaskSessionByToken('linkA').task.id, daily.id);
  s.resetTaskMemberToken(daily.id, id, 'linkB');
  assert.equal(s.getTaskSessionByToken('linkA'), null); // old link dies
  assert.equal(s.getTaskSessionByToken('linkB').member.id, id);
  s.deactivateMember(id);
  assert.equal(s.getTaskSessionByToken('linkB'), null); // inactive member rejected
  assert.equal(s.listActiveMembers().length, 0);
  // closing the task kills routing too
  s.reactivateMember(id, 'tokA2');
  assert.ok(s.getTaskSessionByToken('linkB'));
  s.setTaskStatus(daily.id, 'closed');
  assert.equal(s.getTaskSessionByToken('linkB'), null);
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

test('incremental flush: cycle chunks persist with dur 0, finalize records duration once (crash-safe)', () => {
  const s = tmpStore();
  const member = Number(s.addMember('Nick', 'tokN').lastInsertRowid);
  const task = s.createTask({ type: 'oneshot', title: 'Q2' });
  s.addTaskMember(task.id, member, 'tokQ');
  const CK = '-';
  // live session flushing turn-by-turn — chunks carry duration 0
  s.appendCycleTranscript(task.id, member, CK, 'Nick: 昨天做了发布', 0, [7]);
  s.appendCycleTranscript(task.id, member, CK, 'Luna: 好的，今天呢', 0, [7]);
  // ---- a crash here already leaves both turns on disk ----
  let rec = s.getCycleRecord(task.id, member, CK);
  assert.match(rec.transcript, /昨天做了发布[\s\S]*今天呢/); // order preserved
  assert.equal(rec.duration_s, 0); // not double-counted mid-session
  assert.equal(rec.status, 'draft');
  // clean end records the total duration once, transcript untouched
  s.finalizeCycleRecord(task.id, member, CK, 137);
  rec = s.getCycleRecord(task.id, member, CK);
  assert.equal(rec.duration_s, 137);
  assert.match(rec.transcript, /昨天做了发布[\s\S]*今天呢/);
  s.close();
});

test('incremental flush: daily finalizeReport records duration/status without touching the saved transcript', () => {
  const s = tmpStore();
  const id = Number(s.addMember('Owen', 'tokO').lastInsertRowid);
  s.appendTranscript(id, '2026-07-22', 'Owen: 昨天', 0, 'm1', false);
  s.appendTranscript(id, '2026-07-22', 'Luna: 今天?', 0, 'm1', false);
  let rep = s.getReport(id, '2026-07-22');
  assert.equal(rep.duration_s, 0);
  assert.equal(rep.status, 'draft');
  s.finalizeReport(id, '2026-07-22', 200, 'm1', false); // clean end, still draft
  rep = s.getReport(id, '2026-07-22');
  assert.equal(rep.duration_s, 200);
  assert.equal(rep.status, 'draft');
  assert.match(rep.transcript, /昨天[\s\S]*今天/);
  s.finalizeReport(id, '2026-07-22', 0, 'm1', true); // a submitted finalize promotes status
  assert.equal(s.getReport(id, '2026-07-22').status, 'submitted');
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
  // the talk flow reaches the test member via its daily task link
  const daily = s.ensureDailyTask('每日日报');
  s.addTaskMember(daily.id, t.id, 'linkT');
  assert.equal(s.getTaskSessionByToken('linkT').member.is_test, 1);
  s.close();
});

test('follow-up scope: private stays in-task, team crosses, external is walled off', () => {
  const s = tmpStore();
  const daily = s.ensureDailyTask('每日日报'); // internal
  const other = s.createTask({ type: 'recurring', title: '客户周报' }); // internal by default
  const ext = s.createTask({ type: 'oneshot', title: '对外访谈' });
  s.setTaskAudience(ext.id, 'external');

  s.addFollowup({ taskId: daily.id, content: 'daily private note', scope: 'private' });
  s.addFollowup({ taskId: daily.id, content: 'daily TEAM decision', scope: 'team' });
  s.addFollowup({ taskId: other.id, content: 'other private note', scope: 'private' });
  s.addFollowup({ taskId: ext.id, content: 'ext own note', scope: 'private' });

  // internal task sees its own (any scope) + team-shared from other tasks, never others' private
  const dailyView = s.recentFollowups(daily.id, 'internal').map(r => r.content);
  assert.ok(dailyView.includes('daily private note'));
  assert.ok(dailyView.includes('daily TEAM decision'));
  assert.ok(!dailyView.includes('other private note'));

  const otherView = s.recentFollowups(other.id, 'internal').map(r => r.content);
  assert.ok(otherView.includes('other private note'));
  assert.ok(otherView.includes('daily TEAM decision')); // team-shared crosses in
  assert.ok(!otherView.includes('daily private note'));  // private does not

  // external task sees ONLY its own follow-ups — no team-shared, no other-task data
  const extView = s.recentFollowups(ext.id, 'external').map(r => r.content);
  assert.deepEqual(extView, ['ext own note']);
  // and its recall is walled off from the knowledge base + team follow-ups
  s.addKnowledge('internal secret', 'internal only material', 'reference');
  assert.equal(s.recall(ext.id, 'external', 'internal').length, 0);
  assert.equal(s.recall(ext.id, 'external', 'ext').length, 1);
  s.close();
});

test('report and cycle records persist injected follow-up snapshot ids', () => {
  const s = tmpStore();
  const daily = s.ensureDailyTask('每日日报');
  const member = Number(s.addMember('Nick', 'tok').lastInsertRowid);
  const keep = Number(s.addFollowup({ taskId: daily.id, content: 'today context', scope: 'team' }).lastInsertRowid);
  const later = Number(s.addFollowup({ taskId: daily.id, content: 'later context', scope: 'team' }).lastInsertRowid);

  s.upsertSummary(member, '2026-07-22', { yesterday: [], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm', [keep]);
  s.appendTranscript(member, '2026-07-22', 'Nick: hi', 10, 'm', true, [later]);
  assert.deepEqual(JSON.parse(s.getReport(member, '2026-07-22').injected_followup_ids), [keep]);
  assert.deepEqual(s.followupsByIds([later, keep]).map(f => f.id), [later, keep]);

  const task = s.createTask({ type: 'oneshot', title: 'Q2' });
  s.addTaskMember(task.id, member, 'tt');
  s.submitCycleSummary(task.id, member, '-', JSON.stringify(['x']), JSON.stringify([]), [later]);
  s.appendCycleTranscript(task.id, member, '-', 'Nick: q2', 12, [keep]);
  assert.deepEqual(JSON.parse(s.getCycleRecord(task.id, member, '-').injected_followup_ids), [later]);
  s.close();
});

test('recentFollowups since-anchor: strictly-after window replaces the rolling days window', () => {
  const s = tmpStore();
  const task = s.createTask({ type: 'recurring', title: '增长日报', cadenceType: 'daily' });
  const oldId = Number(s.addFollowup({ taskId: task.id, content: 'settled last week', scope: 'private' }).lastInsertRowid);
  s.addFollowup({ taskId: task.id, content: 'fresh since prior cycle', scope: 'private' });
  s.db.prepare('UPDATE follow_up SET created_at=? WHERE id=?').run('2026-07-10 09:00:00', oldId);

  // anchored: only strictly-after entries
  const anchored = s.recentFollowups(task.id, 'internal', { since: '2026-07-15 00:00:00' }).map(f => f.content);
  assert.deepEqual(anchored, ['fresh since prior cycle']);
  // boundary is exclusive — a follow-up created exactly at the anchor moment
  // was already visible to that conversation's snapshot
  assert.equal(s.recentFollowups(task.id, 'internal', { since: '2026-07-10 09:00:00' })
    .map(f => f.content).includes('settled last week'), false);
  // no anchor: legacy rolling window keeps only recent entries
  const legacy = s.recentFollowups(task.id, 'internal').map(f => f.content);
  assert.deepEqual(legacy, ['fresh since prior cycle']);
  const wide = s.recentFollowups(task.id, 'internal', { days: 30 }).map(f => f.content);
  assert.ok(wide.includes('settled last week'));
  s.close();
});

test('memberFollowupAnchor: member last-conversation moment, task fallback, null when no history', () => {
  const s = tmpStore();
  const daily = s.ensureDailyTask('每日日报');
  const member = Number(s.addMember('Nick', 'tok').lastInsertRowid);
  const other = Number(s.addMember('Wen', 'tok2').lastInsertRowid);

  // builtin path: no history at all → null (legacy window applies)
  assert.equal(s.memberFollowupAnchor(daily, member, '2026-07-22'), null);
  // a prior report anchors that member to its updated_at moment
  s.upsertSummary(member, '2026-07-21', { yesterday: [], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  const rep = s.getReport(member, '2026-07-21');
  assert.equal(s.memberFollowupAnchor(daily, member, '2026-07-22'), rep.updated_at);
  // member without own history falls back to the task-level anchor (cycle start)
  assert.equal(s.memberFollowupAnchor(daily, other, '2026-07-22'), '2026-07-21 00:00:00');

  // generic recurring path
  const task = s.createTask({ type: 'recurring', title: '增长日报', cadenceType: 'daily' });
  s.addTaskMember(task.id, member, 'gt');
  assert.equal(s.memberFollowupAnchor(task, member, '2026-07-22'), null);
  s.submitCycleSummary(task.id, member, '2026-07-21', '- did things', '[]');
  const rec = s.getCycleRecord(task.id, member, '2026-07-21');
  assert.equal(s.memberFollowupAnchor(task, member, '2026-07-22'), rec.updated_at);
  s.close();
});

test('injection anchor: snapshot moment survives session-end updated_at pushes', () => {
  const s = tmpStore();
  const member = Number(s.addMember('Nick', 'tok').lastInsertRowid);
  const anchor = '2026-07-21 10:00:00';

  // generic path: flush + finalize push updated_at past the snapshot moment
  const task = s.createTask({ type: 'recurring', title: '增长日报', cadenceType: 'daily' });
  s.addTaskMember(task.id, member, 'gt');
  s.appendCycleTranscript(task.id, member, '2026-07-21', 'hello', 0, [1]);
  s.setInjectionAnchor(task, member, '2026-07-21', anchor);
  s.finalizeCycleRecord(task.id, member, '2026-07-21', 300);
  const rec = s.getCycleRecord(task.id, member, '2026-07-21');
  assert.notEqual(rec.updated_at, anchor); // finalize did push updated_at…
  assert.equal(rec.anchor_at, anchor); // …but the frozen anchor survived
  assert.equal(s.memberFollowupAnchor(task, member, '2026-07-22'), anchor);

  // the P1 scenario: a follow-up appended mid-session (after the snapshot,
  // before finalize) must fall inside the next cycle's since-window
  const fid = Number(s.addFollowup({ taskId: task.id, content: 'added mid-call', scope: 'private' }).lastInsertRowid);
  s.db.prepare('UPDATE follow_up SET created_at=? WHERE id=?').run('2026-07-21 10:30:00', fid);
  const carried = s.recentFollowups(task.id, 'internal', {
    since: s.memberFollowupAnchor(task, member, '2026-07-22'),
  }).map(f => f.content);
  assert.ok(carried.includes('added mid-call'));

  // builtin path: same freeze on the reports row
  const daily = s.ensureDailyTask('每日日报');
  s.upsertSummary(member, '2026-07-21', { yesterday: [], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  s.setInjectionAnchor(daily, member, '2026-07-21', anchor);
  s.finalizeReport(member, '2026-07-21', 300, 'm', true);
  assert.equal(s.memberFollowupAnchor(daily, member, '2026-07-22'), anchor);

  // UPDATE-only: anchoring a cycle with no record row is a no-op
  s.setInjectionAnchor(task, member, '2026-07-23', anchor);
  assert.ok(!s.getCycleRecord(task.id, member, '2026-07-23'));
  s.close();
});

test('taskFollowupAnchor: previous ACTIVE cycle start (weekend gap), oneshot rows ignored', () => {
  const s = tmpStore();
  const task = s.createTask({ type: 'recurring', title: '增长日报', cadenceType: 'daily' });
  const member = Number(s.addMember('Nick', 'tok').lastInsertRowid);
  s.addTaskMember(task.id, member, 'gt');
  assert.equal(s.taskFollowupAnchor(task, '2026-07-20'), null);
  // Friday cycle happened; the Monday cycle anchors to Friday 00:00 — the
  // weekend had no rounds so "previous cycle" follows activity, not calendar
  s.submitCycleSummary(task.id, member, '2026-07-17', '- fri', '[]');
  assert.equal(s.taskFollowupAnchor(task, '2026-07-20'), '2026-07-17 00:00:00');
  // oneshot placeholder key never anchors anything
  const one = s.createTask({ type: 'oneshot', title: '访谈' });
  s.addTaskMember(one.id, member, 'ot');
  s.submitCycleSummary(one.id, member, '-', '- x', '[]');
  assert.equal(s.taskFollowupAnchor(one, '-'), null);
  s.close();
});

test('priorCycleSummary: latest non-empty prior summary, blank ones skipped', () => {
  const s = tmpStore();
  const task = s.createTask({ type: 'recurring', title: '增长日报', cadenceType: 'daily' });
  const member = Number(s.addMember('Nick', 'tok').lastInsertRowid);
  s.addTaskMember(task.id, member, 'gt');
  assert.equal(s.priorCycleSummary(task.id, member, '2026-07-22'), null);
  s.submitCycleSummary(task.id, member, '2026-07-18', '## 进展\n- 完成 A', '[]');
  // a later cycle with transcript but no summary must not shadow the real one
  s.appendCycleTranscript(task.id, member, '2026-07-21', 'Nick: hi', 5);
  const prev = s.priorCycleSummary(task.id, member, '2026-07-22');
  assert.equal(prev.cycle_key, '2026-07-18');
  assert.match(prev.summary, /完成 A/);
  // only cycles strictly before the given key count
  assert.equal(s.priorCycleSummary(task.id, member, '2026-07-18'), null);
  s.close();
});

test('listFollowups window filter + countFollowups full-ledger count', () => {
  const s = tmpStore();
  const task = s.createTask({ type: 'recurring', title: '增长日报', cadenceType: 'daily' });
  const a = Number(s.addFollowup({ taskId: task.id, content: 'day one', scope: 'private' }).lastInsertRowid);
  s.addFollowup({ taskId: task.id, content: 'day two', scope: 'private' });
  s.db.prepare('UPDATE follow_up SET created_at=? WHERE id=?').run('2026-07-21 10:00:00', a);
  const win = s.listFollowups(task.id, { from: '2026-07-21 00:00:00', until: '2026-07-22 00:00:00' });
  assert.deepEqual(win.map(f => f.content), ['day one']);
  assert.equal(s.listFollowups(task.id).length, 2);
  assert.equal(s.countFollowups(task.id), 2);
  s.close();
});

test('carry_prior_summary: defaults on, updateTask can toggle it off and back', () => {
  const s = tmpStore();
  const task = s.createTask({ type: 'recurring', title: '增长日报', cadenceType: 'daily' });
  assert.equal(s.getTask(task.id).carry_prior_summary, 1);
  s.updateTask(task.id, { carryPriorSummary: false });
  assert.equal(s.getTask(task.id).carry_prior_summary, 0);
  s.updateTask(task.id, { carryPriorSummary: true });
  assert.equal(s.getTask(task.id).carry_prior_summary, 1);
  s.close();
});

test('member self-service reset: deleteReport / deleteCycleRecord drop exactly one row', () => {
  const s = tmpStore();
  const id = Number(s.addMember('Rita', 'tokR').lastInsertRowid);
  s.appendTranscript(id, '2026-07-23', 'Rita: hi', 10, 'm1', false);
  s.appendTranscript(id, '2026-07-22', 'Rita: old', 10, 'm1', true);
  assert.equal(s.deleteReport(id, '2026-07-23'), true);
  assert.equal(s.getReport(id, '2026-07-23'), undefined);
  assert.ok(s.getReport(id, '2026-07-22')); // other dates untouched
  assert.equal(s.deleteReport(id, '2026-07-23'), false); // idempotent signal

  const task = s.createTask({ type: 'oneshot', title: 'Q2' });
  s.addTaskMember(task.id, id, 'tokQ2');
  s.appendCycleTranscript(task.id, id, '-', 'Rita: q2', 5, null);
  assert.equal(s.deleteCycleRecord(task.id, id, '-'), true);
  assert.equal(s.getCycleRecord(task.id, id, '-'), undefined);
  assert.equal(s.deleteCycleRecord(task.id, id, '-'), false);
  s.close();
});
