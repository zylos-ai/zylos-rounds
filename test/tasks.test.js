import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { AgentContext } from '../src/lib/context.js';
import { DigestGenerator } from '../src/lib/digest.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rounds-test-'));
  return new Store(path.join(dir, 'test.db'));
}

test('daily task seeded once; permanent member token never resolves as task token', () => {
  const s = tmpStore();
  const t1 = s.ensureDailyTask('每日日报');
  const t2 = s.ensureDailyTask('每日日报');
  assert.equal(t1.id, t2.id);
  assert.equal(t1.type, 'recurring');
  s.addMember('张三', 'tokA');
  assert.equal(s.getTaskSessionByToken('tokA'), null);
  s.close();
});

test('oneshot task lifecycle: create, per-member tokens, submit, close kills routing', () => {
  const s = tmpStore();
  const m1 = Number(s.addMember('张三', 'tokA').lastInsertRowid);
  const m2 = Number(s.addMember('李四', 'tokB').lastInsertRowid);
  const task = s.createTask({ type: 'oneshot', title: 'Q2 复盘', brief: '聊聊本季度', questions: '- 最好的事\n- 最遗憾的事' });
  s.addTaskMember(task.id, m1, 'tt1');
  s.addTaskMember(task.id, m2, 'tt2');

  const resolved = s.getTaskSessionByToken('tt1');
  assert.equal(resolved.task.id, task.id);
  assert.equal(resolved.member.id, m1);

  s.submitCycleSummary(task.id, m1, '-', JSON.stringify(['要点1']), JSON.stringify(['信号1']));
  s.appendCycleTranscript(task.id, m1, '-', '张三: 大家好', 60);
  const rows = s.cycleRecords(task.id, '-');
  assert.equal(rows.find(r => r.member_id === m1).status, 'submitted');
  assert.equal(rows.find(r => r.member_id === m2).status, null); // no record yet
  assert.match(rows.find(r => r.member_id === m1).transcript, /大家好/);

  // closing the task invalidates its links; reopening restores them
  s.setTaskStatus(task.id, 'closed');
  assert.equal(s.getTaskSessionByToken('tt1'), null);
  s.setTaskStatus(task.id, 'open');
  assert.equal(s.getTaskSessionByToken('tt1').member.id, m1);

  // deactivated members can't open their task link either
  s.deactivateMember(m1);
  assert.equal(s.getTaskSessionByToken('tt1'), null);
  s.close();
});

test('digest is overwritten on re-set; auto-due query respects fired flag and status', () => {
  const s = tmpStore();
  const task = s.createTask({ type: 'oneshot', title: 'T', digestAutoAt: '2026-07-18T10:00' });
  s.setTaskDigest(task.id, '第一版');
  s.setTaskDigest(task.id, '第二版');
  assert.equal(s.getTask(task.id).digest, '第二版');

  assert.equal(s.dueAutoDigestTasks('2026-07-18T09:59').length, 0);
  assert.equal(s.dueAutoDigestTasks('2026-07-18T10:01').length, 1);
  s.markTaskAutoFired(task.id);
  assert.equal(s.dueAutoDigestTasks('2026-07-18T10:01').length, 0);
  // editing the auto time re-arms the trigger
  s.updateTask(task.id, { digestAutoAt: '2026-07-18T11:00' });
  assert.equal(s.dueAutoDigestTasks('2026-07-18T11:01').length, 1);
  // closed tasks never fire
  s.setTaskStatus(task.id, 'closed');
  assert.equal(s.dueAutoDigestTasks('2026-07-18T11:01').length, 0);
  s.close();
});

test('updateTask patches only provided fields; deleteTask removes oneshot and links', () => {
  const s = tmpStore();
  const m1 = Number(s.addMember('张三', 'tokA').lastInsertRowid);
  const task = s.createTask({ type: 'oneshot', title: 'A', brief: 'b1' });
  s.addTaskMember(task.id, m1, 'tt1');
  const updated = s.updateTask(task.id, { title: 'B', digestCloseLinked: true });
  assert.equal(updated.title, 'B');
  assert.equal(updated.brief, 'b1');
  assert.equal(updated.digest_close_linked, 1);
  s.deleteTask(task.id);
  assert.equal(s.getTask(task.id), undefined);
  assert.equal(s.getTaskSessionByToken('tt1'), null);

  // the built-in recurring task is not deletable
  const daily = s.ensureDailyTask('每日日报');
  s.deleteTask(daily.id);
  assert.ok(s.getTask(daily.id));
  s.close();
});

test('oneshot instructions carry task brief/questions and the oneshot submit tool; daily unchanged', () => {
  const s = tmpStore();
  const m = { id: 1, name: '张三', context: '', profile: '' };
  const ctx = new AgentContext(s);
  const daily = s.ensureDailyTask('每日日报');
  const dailyText = ctx.buildInstructions(m, daily);
  assert.match(dailyText, /日报助手/);
  assert.match(dailyText, /submit_standup_summary/);

  const task = s.createTask({ type: 'oneshot', title: 'Q2 复盘', brief: '本季度结束', questions: '- 收获\n- 遗憾' });
  const text = ctx.buildInstructions(m, task);
  assert.match(text, /Q2 复盘/);
  assert.match(text, /本季度结束/);
  assert.match(text, /- 收获/);
  assert.match(text, /submit_conversation_summary/);
  assert.doesNotMatch(text, /submit_standup_summary/);
  s.close();
});

test('digest prompt includes per-member results and flags incomplete members', () => {
  const s = tmpStore();
  const m1 = Number(s.addMember('张三', 'tokA').lastInsertRowid);
  const m2 = Number(s.addMember('李四', 'tokB').lastInsertRowid);
  const task = s.createTask({ type: 'oneshot', title: 'Q2 复盘', brief: 'brief内容', questions: '问题清单' });
  s.addTaskMember(task.id, m1, 'tt1');
  s.addTaskMember(task.id, m2, 'tt2');
  s.submitCycleSummary(task.id, m1, '-', JSON.stringify(['进展顺利']), JSON.stringify(['想换方向']));

  const gen = new DigestGenerator(s, () => ({}), {}, { resolveKey: () => null });
  const prompt = gen.buildPrompt(s.getTask(task.id), s.cycleRecords(task.id, '-'), '-');
  assert.match(prompt, /brief内容/);
  assert.match(prompt, /问题清单/);
  assert.match(prompt, /进展顺利/);
  assert.match(prompt, /想换方向/);
  assert.match(prompt, /李四（未完成对话）/);
  assert.match(prompt, /共识/);
  s.close();
});

test('digest generate: no submissions -> null; trigger applies decoupled close linkage', async () => {
  const s = tmpStore();
  const m1 = Number(s.addMember('张三', 'tokA').lastInsertRowid);
  const task = s.createTask({ type: 'oneshot', title: 'T' });
  s.addTaskMember(task.id, m1, 'tt1');

  const gen = new DigestGenerator(s, () => ({}), {}, { resolveKey: () => 'k' });
  assert.equal(await gen.generate(task.id), null); // nothing submitted yet

  s.submitCycleSummary(task.id, m1, '-', JSON.stringify(['a']), JSON.stringify([]));
  // stub the model call — unit tests never hit the network
  gen.generate = async (id) => { s.setTaskDigest(id, '## 共识\n- a'); return '## 共识\n- a'; };

  // default: close linkage off -> stays open
  let r = await gen.trigger(task.id);
  assert.equal(r.ok, true);
  assert.equal(s.getTask(task.id).status, 'open');

  // linkage on -> closes with the trigger
  s.updateTask(task.id, { digestCloseLinked: true });
  r = await gen.trigger(task.id);
  assert.equal(r.closed, true);
  assert.equal(s.getTask(task.id).status, 'closed');

  // explicit override wins over the flag
  s.setTaskStatus(task.id, 'open');
  r = await gen.trigger(task.id, { close: false });
  assert.equal(s.getTask(task.id).status, 'open');
  s.close();
});
