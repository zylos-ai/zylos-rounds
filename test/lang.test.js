import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { Settings } from '../src/lib/settings.js';
import { AgentContext } from '../src/lib/context.js';

const CJK = /[一-鿿]/;

function setup(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rounds-lang-'));
  const store = new Store(path.join(dir, 'test.db'));
  const settings = new Settings(store, () => config, { openaiApiKey: '', proxy: null });
  return { store, settings };
}

test('language layering: default zh, config override, DB override, member override', () => {
  const { store, settings } = setup();
  assert.equal(settings.resolveLanguage(), 'zh');

  const cfg = setup({ language: 'en' });
  assert.equal(cfg.settings.resolveLanguage(), 'en');

  store.setSetting('language', 'en');
  assert.equal(settings.resolveLanguage(), 'en');

  const id = Number(store.addMember('Alex', 't1').lastInsertRowid);
  // no member language -> team default
  assert.equal(settings.memberLanguage(store.getMemberById(id)), 'en');
  store.setMemberLanguage(id, 'zh');
  assert.equal(settings.memberLanguage(store.getMemberById(id)), 'zh');
  // clearing reverts to team default
  store.setMemberLanguage(id, null);
  assert.equal(settings.memberLanguage(store.getMemberById(id)), 'en');
  // invalid stored values fall back safely
  store.setSetting('language', 'fr');
  assert.equal(settings.resolveLanguage(), 'zh');
  store.close();
  cfg.store.close();
});

test('buildInstructions en: English persona/rules, no Chinese leakage', () => {
  const { store } = setup();
  const ctx = new AgentContext(store);
  const member = { name: 'Alex', context: '', profile: '' };

  const en = ctx.buildInstructions(member, null, null, 'Asia/Singapore', 'en');
  assert.match(en, /You are Luna/);
  assert.match(en, /Speak English throughout/);
  assert.match(en, /submit_standup_summary/);
  assert.match(en, /didn't catch that/);
  assert.doesNotMatch(en, CJK);

  // continuation variants exist in English too
  const cont = ctx.buildInstructions(member, null, { transcript: 'Luna: hi', submitted: true }, 'Asia/Singapore', 'en');
  assert.match(cont, /continuation mode/);
  assert.match(cont, /What was already discussed/);
  assert.doesNotMatch(cont, CJK);
  store.close();
});

test('buildInstructions zh default unchanged (backward compatible signature)', () => {
  const { store } = setup();
  const ctx = new AgentContext(store);
  const member = { name: '小王', context: '', profile: '' };
  const zh = ctx.buildInstructions(member, null, null, 'Asia/Singapore');
  assert.match(zh, /你是团队的日报助手 Luna/);
  assert.match(zh, /全程说中文/);
  assert.match(zh, /submit_standup_summary/);
  store.close();
});

test('generic task instructions en: brief/questions frame localized', () => {
  const { store } = setup();
  const ctx = new AgentContext(store);
  const member = { name: 'Alex', context: '', profile: '' };
  const task = { id: 9, is_builtin: 0, type: 'oneshot', title: 'Q2 review', brief: 'the brief', questions: 'q1\nq2' };
  const en = ctx.buildInstructions(member, task, null, 'Asia/Singapore', 'en');
  assert.match(en, /"Q2 review"/);
  assert.match(en, /\[Task background\][\s\S]*the brief/);
  assert.match(en, /\[Question frame\][\s\S]*q1/);
  assert.match(en, /submit_conversation_summary/);
  assert.doesNotMatch(en, CJK);
  store.close();
});

test('migration 10: members.language column exists and persists', () => {
  const { store } = setup();
  const id = Number(store.addMember('Bea', 't2').lastInsertRowid);
  store.setMemberLanguage(id, 'en');
  assert.equal(store.getMemberById(id).language, 'en');
  store.setMemberLanguage(id, null);
  assert.equal(store.getMemberById(id).language, null);
  store.close();
});
