import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { ProfileUpdater } from '../src/lib/profile.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-prof-'));
  const store = new Store(path.join(dir, 'test.db'));
  const updater = new ProfileUpdater(
    store,
    () => ({}),
    { openaiApiKey: 'sk-test', proxy: null },
    { textConnection: () => ({ key: 'sk-test', base: null, model: 'model-x' }) },
  );
  return { store, updater };
}

const submit = (store, id, date, extra = {}) => store.upsertSummary(
  id, date,
  { yesterday: ['修完发布 bug'], today: ['联调新接口'], blockers: [], topics_for_meeting: [], ...extra },
  '{}', 'model-x',
);

test('buildPrompt carries existing profile, base context, report and date rules', () => {
  const { store, updater } = setup();
  const id = Number(store.addMember('小王', 't1').lastInsertRowid);
  store.setMemberContext(id, '前端负责人');
  store.setMemberProfile(id, '- [2026-07-01] 在做发布系统');
  submit(store, id, '2026-07-18');
  store.appendTranscript(id, '2026-07-18', '小王: 我昨天修完了发布 bug', 60, 'model-x', true);

  const prompt = updater.buildPrompt(store.getMemberById(id), store.getReport(id, '2026-07-18'), '2026-07-18');
  assert.match(prompt, /「小王」的动态画像/);
  assert.match(prompt, /今天是 2026-07-18/);
  assert.match(prompt, /【人工填写的基础背景】[\s\S]*前端负责人/);
  assert.match(prompt, /【现有画像】[\s\S]*在做发布系统/);
  assert.match(prompt, /【今天的日报】[\s\S]*修完发布 bug/);
  assert.match(prompt, /【今天的原始对话】/);
  assert.match(prompt, /不超过 500 字/);
  store.close();
});

test('buildPrompt without prior profile/context marks first generation', () => {
  const { store, updater } = setup();
  const id = Number(store.addMember('新人', 't2').lastInsertRowid);
  submit(store, id, '2026-07-18');
  const prompt = updater.buildPrompt(store.getMemberById(id), store.getReport(id, '2026-07-18'), '2026-07-18');
  assert.match(prompt, /第一次生成/);
  assert.doesNotMatch(prompt, /【人工填写的基础背景】/);
  store.close();
});

test('updateAfterReport writes the model output as the new profile', async () => {
  const { store, updater } = setup();
  const id = Number(store.addMember('小李', 't3').lastInsertRowid);
  submit(store, id, '2026-07-18');
  updater.callModel = async () => '- [2026-07-18] 在做接口联调\n';
  assert.equal(await updater.updateAfterReport(id, '2026-07-18'), true);
  const m = store.getMemberById(id);
  assert.equal(m.profile, '- [2026-07-18] 在做接口联调');
  assert.ok(m.profile_updated_at);
  store.close();
});

test('updateAfterReport skips test members, drafts, missing reports; soft-fails on model error', async () => {
  const { store, updater } = setup();
  let calls = 0;
  updater.callModel = async () => { calls++; return 'x'; };

  const testMember = store.ensureTestMember('体验成员', 'tt');
  submit(store, testMember.id, '2026-07-18');
  assert.equal(await updater.updateAfterReport(testMember.id, '2026-07-18'), false);

  const draft = Number(store.addMember('草稿', 't4').lastInsertRowid);
  store.appendTranscript(draft, '2026-07-18', 'x: y', 10, 'm', false); // draft only
  assert.equal(await updater.updateAfterReport(draft, '2026-07-18'), false);
  assert.equal(await updater.updateAfterReport(draft, '2026-01-01'), false); // no report at all
  assert.equal(await updater.updateAfterReport(9999, '2026-07-18'), false);  // no member
  assert.equal(calls, 0);

  const ok = Number(store.addMember('出错', 't5').lastInsertRowid);
  submit(store, ok, '2026-07-18');
  updater.callModel = async () => { throw new Error('boom'); };
  assert.equal(await updater.updateAfterReport(ok, '2026-07-18'), false); // never throws
  assert.equal(store.getMemberById(ok).profile, null);
  store.close();
});

test('updateAfterReport without any API key is a no-op', async () => {
  const { store } = setup();
  const updater = new ProfileUpdater(store, () => ({}), { openaiApiKey: '', proxy: null }, { resolveKey: () => '' });
  const id = Number(store.addMember('无钥', 't6').lastInsertRowid);
  submit(store, id, '2026-07-18');
  assert.equal(await updater.updateAfterReport(id, '2026-07-18'), false);
  store.close();
});
