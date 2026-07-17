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

test('seedDefaults seeds probing guidance once, does not clobber edits', () => {
  const s = tmpStore();
  const ctx = new AgentContext(s);
  ctx.seedDefaults();
  assert.equal(s.getContext('probing_guidance'), DEFAULT_PROBING_GUIDANCE);
  assert.equal(s.getContext('team_background'), '');
  s.setContext('probing_guidance', 'custom');
  ctx.seedDefaults(); // idempotent, must not overwrite
  assert.equal(s.getContext('probing_guidance'), 'custom');
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
