import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { AgentContext } from '../src/lib/context.js';
import { Relay } from '../src/lib/relay.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-relay-'));
  const store = new Store(path.join(dir, 'test.db'));
  const ctx = new AgentContext(store);
  const relay = new Relay(store, () => ({}), { proxy: null }, null, ctx);
  const sent = { client: [], upstream: [] };
  const client = { readyState: 1, send: (o) => sent.client.push(JSON.parse(o)) };
  const upstream = { readyState: 1, send: (o) => sent.upstream.push(JSON.parse(o)) };
  return { store, ctx, relay, sent, client, upstream };
}

test('handleToolCall: recall_member_history returns history + prompts continuation', () => {
  const { store, relay, sent, client, upstream } = fixture();
  const id = Number(store.addMember('A', 'ta').lastInsertRowid);
  store.upsertSummary(id, '2026-07-16', { yesterday: ['做了X'], today: [], blockers: ['卡在Y'], topics_for_meeting: [] }, '{}', 'm');
  const member = store.getMemberById(id);

  relay.handleToolCall(
    { name: 'recall_member_history', call_id: 'c1', arguments: '{"days":3}' },
    { client, upstream, member, reportDate: '2026-07-17', model: 'm', markSaved: () => {} }
  );

  const out = sent.upstream.find((e) => e.type === 'conversation.item.create');
  assert.ok(out, 'sends function_call_output');
  assert.equal(out.item.call_id, 'c1');
  const payload = JSON.parse(out.item.output);
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.reports[0].blockers, ['卡在Y']);
  assert.ok(sent.upstream.some((e) => e.type === 'response.create'), 'prompts model to continue');
});

test('handleToolCall: search_team_knowledge returns matches', () => {
  const { store, relay, sent, client, upstream } = fixture();
  store.addKnowledge('发布系统', '负责灰度和回滚的服务', 'release');
  const member = store.getMemberById(Number(store.addMember('B', 'tb').lastInsertRowid));

  relay.handleToolCall(
    { name: 'search_team_knowledge', call_id: 'c2', arguments: '{"query":"发布"}' },
    { client, upstream, member, reportDate: '2026-07-17', model: 'm', markSaved: () => {} }
  );

  const out = sent.upstream.find((e) => e.type === 'conversation.item.create');
  const payload = JSON.parse(out.item.output);
  assert.equal(payload.count, 1);
  assert.equal(payload.results[0].title, '发布系统');
});

test('handleToolCall: submit_standup_summary persists, notifies client, acks upstream', () => {
  const { store, relay, sent, client, upstream } = fixture();
  const member = store.getMemberById(Number(store.addMember('C', 'tc').lastInsertRowid));
  let savedFlag = false;

  relay.handleToolCall(
    {
      name: 'submit_standup_summary',
      call_id: 'c3',
      arguments: JSON.stringify({ yesterday: ['y'], today: ['t'], blockers: [], topics_for_meeting: ['tp'] }),
    },
    { client, upstream, member, reportDate: '2026-07-17', model: 'm', markSaved: () => { savedFlag = true; } }
  );

  assert.equal(savedFlag, true);
  assert.ok(sent.client.some((e) => e.type === 'app.saved'), 'client told it was saved');
  const rows = store.dayReports('2026-07-17');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].topics), ['tp']);
});

test('handleToolCall: malformed arguments do not throw', () => {
  const { store, relay, client, upstream } = fixture();
  const member = store.getMemberById(Number(store.addMember('D', 'td').lastInsertRowid));
  assert.doesNotThrow(() =>
    relay.handleToolCall(
      { name: 'recall_member_history', call_id: 'c4', arguments: 'not-json' },
      { client, upstream, member, reportDate: '2026-07-17', model: 'm', markSaved: () => {} }
    )
  );
});
