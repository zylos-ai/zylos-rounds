import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { AgentContext, DEFAULT_PROBING_GUIDANCE } from '../src/lib/context.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-ctx-'));
  return new Store(path.join(dir, 'test.db'));
}

test('agent_context: set, overwrite, read, list', () => {
  const s = tmpStore();
  assert.equal(s.getContext('team_background'), null);
  s.setContext('team_background', 'COCO 团队');
  s.setContext('team_background', 'COCO 团队 v2');
  assert.equal(s.getContext('team_background'), 'COCO 团队 v2');
  s.setContext('probing_guidance', '追问指引');
  assert.equal(s.allContext().length, 2);
  s.close();
});

test('per-member context persists and is nullable', () => {
  const s = tmpStore();
  const id = Number(s.addMember('Tyler', 'tok').lastInsertRowid);
  assert.equal(s.getMemberById(id).context, null);
  s.setMemberContext(id, '前端负责人，关注发布节奏');
  assert.match(s.getMemberById(id).context, /前端负责人/);
  s.setMemberContext(id, null);
  assert.equal(s.getMemberById(id).context, null);
  s.close();
});

test('knowledge CRUD + AND-term search with title ranking', () => {
  const s = tmpStore();
  s.addKnowledge('语音日报项目', '基于 OpenAI Realtime 的语音汇报工具', 'standup voice');
  s.addKnowledge('Recruit ATS', '招聘看板，候选人评估', 'recruit hiring');
  const kid = Number(s.addKnowledge('临时条目', 'to be removed', '').lastInsertRowid);

  const hitTitle = s.searchKnowledge('语音');
  assert.equal(hitTitle[0].title, '语音日报项目');

  // both terms must match somewhere (AND semantics)
  assert.equal(s.searchKnowledge('语音 招聘').length, 0);
  assert.equal(s.searchKnowledge('候选人').length, 1);
  assert.equal(s.searchKnowledge('').length, 0);

  s.updateKnowledge(kid, '临时条目', 'updated body', 'x');
  assert.equal(s.getKnowledge(kid).content, 'updated body');
  s.deleteKnowledge(kid);
  assert.equal(s.getKnowledge(kid), undefined);
  s.close();
});

test('recallMemberHistory returns member-scoped submitted reports, excluding a date', () => {
  const s = tmpStore();
  const a = Number(s.addMember('A', 'ta').lastInsertRowid);
  const b = Number(s.addMember('B', 'tb').lastInsertRowid);
  s.upsertSummary(a, '2026-07-15', { yesterday: ['a15'], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  s.upsertSummary(a, '2026-07-16', { yesterday: ['a16'], today: [], blockers: ['stuck'], topics_for_meeting: [] }, '{}', 'm');
  s.upsertSummary(a, '2026-07-17', { yesterday: ['a17'], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');
  s.upsertSummary(b, '2026-07-16', { yesterday: ['b16'], today: [], blockers: [], topics_for_meeting: [] }, '{}', 'm');

  const rows = s.recallMemberHistory(a, '2026-07-17', 5);
  assert.deepEqual(rows.map(r => r.report_date), ['2026-07-16', '2026-07-15']); // desc, today excluded
  assert.equal(rows.length, 2); // B's report not included
  s.close();
});

test('global probing guidance defaults to empty; seedDefaults does not clobber edits', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  ctx.seedDefaults();
  // Global probing is a cross-task overlay — empty by default (daily-specific
  // probing lives in the built-in daily task's code default instead).
  assert.equal(DEFAULT_PROBING_GUIDANCE, '');
  assert.equal(s.getContext('probing_guidance'), '');
  assert.equal(s.getContext('team_background'), '');
  s.setContext('probing_guidance', 'custom');
  ctx.seedDefaults(); // idempotent, must not overwrite
  assert.equal(s.getContext('probing_guidance'), 'custom');
  s.close();
});

test('built-in daily task injects the code-level default probe; custom probe appends on top', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  // No task passed → daily flow. The daily default probe is always present.
  const dailyDefault = ctx.buildInstructions({ name: 'Nick', context: '' });
  assert.match(dailyDefault, /【本任务的追问指引】/);
  assert.match(dailyDefault, /确认它的完成状态/);

  // A built-in daily task with a custom probe: default + custom, in that order.
  const builtin = s.ensureDailyTask('每日日报');
  assert.ok(builtin && builtin.is_builtin);
  s.updateTask(builtin.id, { probeInstruction: '- 跨组阻塞第一时间上报' });
  const withCustom = ctx.buildInstructions({ name: 'Nick', context: '' }, s.getTask(builtin.id));
  const probeIdx = withCustom.indexOf('确认它的完成状态');
  const customIdx = withCustom.indexOf('跨组阻塞第一时间上报');
  assert.ok(probeIdx > -1 && customIdx > -1);
  assert.ok(probeIdx < customIdx, 'code default appears before the custom overlay');

  // A non-daily (generic) task gets NO daily default — only its own field.
  const generic = s.createTask({ type: 'oneshot', title: 'Q2 复盘' });
  const genericOut = ctx.buildInstructions({ name: 'Nick', context: '' }, generic);
  assert.doesNotMatch(genericOut, /确认它的完成状态/);
  assert.doesNotMatch(genericOut, /【本任务的追问指引】/);
  s.close();
});

test('buildInstructions injects only non-empty containers', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  const bare = ctx.buildInstructions({ name: 'Nick', context: '' });
  assert.match(bare, /日报助手 Luna/);
  assert.doesNotMatch(bare, /【团队背景】/);
  assert.doesNotMatch(bare, /【关于/);
  assert.match(bare, /recall_member_history/); // tools always advertised

  s.setContext('team_background', 'BG');
  s.setContext('probing_guidance', 'PG');
  const full = ctx.buildInstructions({ name: 'Nick', context: 'Nick 是 QA' });
  assert.match(full, /【团队背景】[\s\S]*BG/);
  assert.match(full, /【关于 Nick】[\s\S]*Nick 是 QA/);
  assert.match(full, /【追问指引】[\s\S]*PG/);

  assert.doesNotMatch(full, /动态画像/); // absent until auto-maintained
  const withProfile = ctx.buildInstructions({ name: 'Nick', context: '', profile: '- [2026-07-17] 负责发布系统' });
  assert.match(withProfile, /【Nick 的动态画像】[\s\S]*负责发布系统/);
  s.close();
});

test('recallHistory / searchKnowledge formatting stays compact', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  const id = Number(s.addMember('M', 'tm').lastInsertRowid);
  s.upsertSummary(id, '2026-07-16', { yesterday: ['y'], today: ['t'], blockers: [], topics_for_meeting: ['tp'] }, '{}', 'm');
  const rec = ctx.recallHistory({ id, name: 'M' }, '2026-07-17', 5);
  assert.equal(rec.member, 'M');
  assert.equal(rec.count, 1);
  assert.deepEqual(rec.reports[0].topics, ['tp']);

  s.addKnowledge('长文', 'x'.repeat(1000), '');
  const kn = ctx.searchKnowledge('长文');
  assert.ok(kn.results[0].content.length <= 601); // trimmed for the audio path
  s.close();
});

test('task-level probe_instruction overlays on top of global guidance', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  s.setContext('probing_guidance', 'PG');
  const task = s.createTask({ type: 'oneshot', title: 'Q2 复盘', probeInstruction: '- 延期要追影响面' });

  const withTask = ctx.buildInstructions({ name: 'Nick', context: '' }, task);
  assert.match(withTask, /【追问指引】[\s\S]*PG/);
  assert.match(withTask, /【本任务的追问指引】[\s\S]*延期要追影响面/);

  // without a task-level instruction the overlay section is absent
  const plain = s.createTask({ type: 'oneshot', title: '无指引' });
  const without = ctx.buildInstructions({ name: 'Nick', context: '' }, plain);
  assert.doesNotMatch(without, /【本任务的追问指引】/);

  // updateTask persists and clears the field
  s.updateTask(task.id, { probeInstruction: '改后的指引' });
  assert.equal(s.getTask(task.id).probe_instruction, '改后的指引');
  s.updateTask(task.id, { probeInstruction: null });
  assert.equal(s.getTask(task.id).probe_instruction, null);
  s.close();
});

test('prior transcript injects a continuation section', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  const member = { name: 'Nick', context: '' };

  // no prior — section absent
  assert.doesNotMatch(ctx.buildInstructions(member), /【已聊过的内容】/);

  // draft prior — continuation with the transcript, no submitted note
  const draft = ctx.buildInstructions(member, null, { transcript: 'Nick: 昨天修了字幕', submitted: false });
  assert.match(draft, /【已聊过的内容】[\s\S]*昨天修了字幕/);
  assert.doesNotMatch(draft, /小结之前已经提交过/);

  // submitted prior — asks for a merged re-submit
  const done = ctx.buildInstructions(member, null, { transcript: 'Nick: 都聊完了', submitted: true });
  assert.match(done, /小结之前已经提交过/);

  // long transcripts keep only the tail
  const long = ctx.buildInstructions(member, null, { transcript: 'A'.repeat(5000) + 'TAIL', submitted: false });
  assert.match(long, /更早的内容略/);
  assert.ok(!long.includes('A'.repeat(4001)));
  assert.match(long, /TAIL/);
  s.close();
});

test('submission-gate hard rule present in all instruction variants', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  const member = { name: 'Nick', context: '' };
  assert.match(ctx.buildInstructions(member), /提交时机的硬规则/);
  const task = s.createTask({ type: 'oneshot', title: '复盘' });
  assert.match(ctx.buildInstructions(member, task), /提交时机的硬规则/);
  // continuation with prior submit must not encourage early wrap-up
  const cont = ctx.buildInstructions(member, null, { transcript: 'x', submitted: true });
  assert.match(cont, /已提交过不等于可以早点收尾/);
  s.close();
});

test('instructions carry fresh wall-clock time in the configured zone (v0.10.4)', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  const member = { name: '小王', context: null, profile: null };
  const text = ctx.buildInstructions(member, null, null, 'Asia/Singapore');
  assert.match(text, /现在是\d{4}年\d{1,2}月\d{1,2}日星期./);
  assert.match(text, /(凌晨|早上|上午|中午|下午|晚上) \d{2}:\d{2}/);
  assert.match(text, /下午就不要说早安/);
  // a very different zone must produce a different clock time
  const other = ctx.buildInstructions(member, null, null, 'America/New_York');
  const hm = t => t.match(/(\d{2}:\d{2})。/)?.[1];
  assert.notEqual(hm(text), hm(other));
  s.close();
});

test('continuation replaces the scripted flow line instead of overriding it (v0.10.5)', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  const member = { name: '小王', context: null, profile: null };
  // fresh session keeps the scripted opening
  assert.match(ctx.buildInstructions(member), /依次了解四件事/);
  // submitted continuation: continuation flow, no scripted four-question line
  const sub = ctx.buildInstructions(member, null, { transcript: 'T', submitted: true });
  assert.match(sub, /流程（继续模式）/);
  assert.match(sub, /有什么想补充或更新的/);
  assert.doesNotMatch(sub, /依次了解四件事/);
  // draft continuation: resume-from-interruption flow
  const draft = ctx.buildInstructions(member, null, { transcript: 'T', submitted: false });
  assert.match(draft, /从中断的地方继续/);
  assert.doesNotMatch(draft, /依次了解四件事/);
  s.close();
});
