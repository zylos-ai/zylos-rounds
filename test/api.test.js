import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { AuthGate, hashPassword } from '../src/lib/auth.js';
import { Api } from '../src/lib/api.js';
import { Settings } from '../src/lib/settings.js';
import { AgentContext } from '../src/lib/context.js';
import { DigestGenerator } from '../src/lib/digest.js';
import { sendJson } from '../src/lib/http-util.js';

const KEY = 'test-api-key-abcdef';

/** Boot the real Api over a real HTTP server — bearer-scope integration tests. */
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-api-'));
  const store = new Store(path.join(dir, 'test.db'));
  const config = {
    serviceToken: KEY,
    timeZone: 'Asia/Shanghai',
    auth: { enabled: true, password: hashPassword('pw') },
  };
  const getConfig = () => config;
  const auth = new AuthGate(config, store, path.join(dir, 'config.json'));
  const settings = new Settings(store, getConfig, { openaiApiKey: '', proxy: null });
  const settingsStub = settings;
  // mirror index.js startup: the built-in daily task exists before any request
  store.ensureDailyTask('每日日报');
  const digests = new DigestGenerator(store, getConfig, {}, settingsStub);
  // unit tests never hit the model API — digest generation is stubbed
  digests.generate = async (id, cycleKey = null) => {
    const task = store.getTask(id);
    const key = cycleKey ?? (task.type === 'oneshot'
      ? '-'
      : new Date().toLocaleDateString('sv', { timeZone: 'Asia/Shanghai' }));
    const rows = store.cycleRecords(id, key);
    if (!rows.some(r => r.status === 'submitted')) return null;
    if (task.type === 'oneshot') store.setTaskDigest(id, '## 共识\n- stub');
    else store.setCycleDigest(id, key, '## 共识\n- stub');
    return '## 共识\n- stub';
  };
  const api = new Api(store, auth, getConfig, settings, new AgentContext(store), digests);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://internal');
    if (await api.handle(req, res, url)) return;
    sendJson(res, 404, { error: 'unrouted' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = { Authorization: `Bearer ${KEY}` }) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: res.status === 204 ? {} : await res.json().catch(() => ({})) };
  };
  const close = () => { auth.stop(); server.close(); store.close(); };
  return { store, call, close };
}

test('bearer API key has full admin scope: roster, reports, settings', async () => {
  const { store, call, close } = await boot();
  try {
    // roster management via bearer (owner's 2026-07-18 ruling); v0.7: adding a
    // member mints their daily-task link
    const daily = store.getDailyTask();
    const added = await call('POST', '/api/members', { name: '阿明' });
    assert.equal(added.status, 201);
    const id = added.data.id;
    assert.equal(added.data.links.length, 1);
    assert.equal(added.data.links[0].task_id, daily.id);
    assert.match(added.data.links[0].link, /\/u\/[A-Za-z0-9_-]+$/);

    const list = await call('GET', '/api/members');
    assert.equal(list.status, 200);
    const me = list.data.members.find(m => m.id === id);
    assert.equal(me.name, '阿明');
    assert.ok('profile' in me && 'context' in me);
    assert.equal(me.links[0].link, added.data.links[0].link);

    // link rotation is per (task, member) in v0.7
    const reset = await call('POST', `/api/tasks/${daily.id}/members/${id}/reset-token`);
    assert.equal(reset.status, 200);
    assert.notEqual(reset.data.link, added.data.links[0].link);

    assert.equal((await call('GET', '/api/reports/history')).status, 200);
    assert.equal((await call('GET', '/api/settings')).status, 200);

    const removed = await call('DELETE', `/api/members/${id}`);
    assert.equal(removed.status, 204);
  } finally {
    close();
  }
});

test('wrong or missing bearer key is rejected on every admin route', async () => {
  const { call, close } = await boot();
  try {
    for (const headers of [{}, { Authorization: 'Bearer wrong-key' }]) {
      assert.equal((await call('GET', '/api/members', undefined, headers)).status, 401);
      assert.equal((await call('POST', '/api/members', { name: 'x' }, headers)).status, 401);
      assert.equal((await call('GET', '/api/context', undefined, headers)).status, 401);
      assert.equal((await call('PUT', '/api/settings', { voice: 'marin' }, headers)).status, 401);
    }
  } finally {
    close();
  }
});

test('profile endpoint: set, clear, appears in context/members', async () => {
  const { call, close } = await boot();
  try {
    const id = (await call('POST', '/api/members', { name: '小赵' })).data.id;
    const put = await call('PUT', `/api/members/${id}/profile`, { profile: '- [2026-07-18] 在做联调' });
    assert.equal(put.status, 200);

    const view = await call('GET', '/api/context/members');
    const me = view.data.members.find(m => m.id === id);
    assert.match(me.profile, /在做联调/);
    assert.ok(me.profile_updated_at);

    await call('PUT', `/api/members/${id}/profile`, { profile: '' });
    const cleared = (await call('GET', '/api/context/members')).data.members.find(m => m.id === id);
    assert.equal(cleared.profile, '');

    assert.equal((await call('PUT', '/api/members/9999/profile', { profile: 'x' })).status, 404);
    assert.equal((await call('PUT', `/api/members/${id}/profile`, { profile: 'x'.repeat(8001) })).status, 400);
  } finally {
    close();
  }
});

test('knowledge search endpoint ranks and respects limit', async () => {
  const { call, close } = await boot();
  try {
    await call('POST', '/api/knowledge', { title: '语音日报', content: 'Realtime 语音汇报工具', tags: 'standup' });
    await call('POST', '/api/knowledge', { title: '招聘', content: '候选人评估流程', tags: '' });

    const hit = await call('GET', `/api/knowledge/search?q=${encodeURIComponent('语音')}`);
    assert.equal(hit.status, 200);
    assert.equal(hit.data.results.length, 1);
    assert.equal(hit.data.results[0].title, '语音日报');

    assert.equal((await call('GET', '/api/knowledge/search?q=')).data.results.length, 0);
  } finally {
    close();
  }
});

test('task endpoints: create with links, digest trigger/overwrite, decoupled close, delete', async () => {
  const { store, call, close } = await boot();
  try {
    const a = await call('POST', '/api/members', { name: '张三' });
    const b = await call('POST', '/api/members', { name: '李四' });

    // create — invalid without members
    assert.equal((await call('POST', '/api/tasks', { title: 'X', member_ids: [] })).status, 400);

    const created = await call('POST', '/api/tasks', {
      title: 'Q2 复盘', brief: '背景', questions: '- 问题1',
      member_ids: [a.data.id, b.data.id], digest_close_linked: false,
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.members.length, 2);
    const links = created.data.members.map(m => m.link);
    assert.ok(links.every(l => /\/u\/[A-Za-z0-9_-]+$/.test(l)));
    assert.notEqual(links[0], links[1]);
    const tid = created.data.id;

    // list includes the oneshot with progress
    const list = await call('GET', '/api/tasks');
    const row = list.data.tasks.find(t => t.id === tid);
    assert.equal(row.submitted_count, 0);

    // digest with nothing submitted -> 409
    assert.equal((await call('POST', `/api/tasks/${tid}/digest`, {})).status, 409);

    // submit one member, then trigger — task stays open (close decoupled)
    store.submitCycleSummary(tid, a.data.id, '-', JSON.stringify(['要点']), JSON.stringify([]));
    const trig = await call('POST', `/api/tasks/${tid}/digest`, {});
    assert.equal(trig.status, 200);
    assert.match(trig.data.digest, /共识/);
    assert.equal(trig.data.status, 'open');

    // close/reopen endpoints
    assert.equal((await call('POST', `/api/tasks/${tid}/close`, {})).data.status, 'closed');
    assert.equal((await call('POST', `/api/tasks/${tid}/reopen`, {})).data.status, 'open');

    // update patches config fields
    const upd = await call('PUT', `/api/tasks/${tid}`, { digest_auto_at: '2030-01-01T10:00', digest_close_linked: true });
    assert.equal(upd.data.digest_auto_at, '2030-01-01T10:00');
    assert.equal(upd.data.digest_close_linked, true);

    // talk session resolves the per-task token with task title
    const token = store.taskMembers(tid)[0].token;
    const sess = await call('GET', `/api/talk/session?token=${token}`, undefined, {});
    assert.equal(sess.status, 200);
    assert.equal(sess.data.task.title, 'Q2 复盘');

    // delete removes routing
    assert.equal((await call('DELETE', `/api/tasks/${tid}`)).status, 204);
    assert.equal((await call('GET', `/api/talk/session?token=${token}`, undefined, {})).status, 404);

    // built-in daily task is not deletable via API
    const daily = (await call('GET', '/api/tasks')).data.tasks.find(t => t.is_builtin);
    assert.equal((await call('DELETE', `/api/tasks/${daily.id}`)).status, 400);
  } finally {
    close();
  }
});

test('recurring task: create with cadence, cycle detail, per-cycle digest, custom instruction', async () => {
  const { store, call, close } = await boot();
  try {
    const a = await call('POST', '/api/members', { name: '张三' });

    // cadence is validated
    assert.equal((await call('POST', '/api/tasks', {
      title: 'X', member_ids: [a.data.id], type: 'recurring', cadence_type: 'weekly', cadence_dow: '',
    })).status, 400);

    const created = await call('POST', '/api/tasks', {
      title: '团队周报', member_ids: [a.data.id],
      type: 'recurring', cadence_type: 'weekly', cadence_dow: '1,5',
      digest_instruction: '只列三条最重要的进展',
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.type, 'recurring');
    assert.equal(created.data.cadence_dow, '1,5');
    assert.match(created.data.cadence_label, /每周/);
    assert.equal(created.data.digest_instruction, '只列三条最重要的进展');
    assert.ok(created.data.cycle_key); // current cycle resolved
    const tid = created.data.id;
    const cycle = created.data.cycle_key;

    // member holds links for daily + the new recurring task
    const me = (await call('GET', '/api/members')).data.members.find(m => m.id === a.data.id);
    assert.equal(me.links.length, 2);

    // submit into the current cycle, trigger a per-cycle digest
    store.submitCycleSummary(tid, a.data.id, cycle, JSON.stringify(['进展A']), JSON.stringify([]));
    const trig = await call('POST', `/api/tasks/${tid}/digest`, { cycle });
    assert.equal(trig.status, 200);
    assert.match(trig.data.digest, /stub/);
    assert.equal(trig.data.status, 'open'); // close linkage is oneshot-only

    // cycle detail returns the same digest via ?cycle=
    const detail = await call('GET', `/api/tasks/${tid}?cycle=${cycle}`);
    assert.equal(detail.data.cycle_key, cycle);
    assert.match(detail.data.digest, /stub/);
    assert.equal(detail.data.members[0].status, 'submitted');
    assert.ok(detail.data.cycles.includes(cycle));

    // custom digest instruction lands in the real prompt builder
    const prompt = new DigestGenerator(store, () => ({ timeZone: 'Asia/Shanghai' }), {}, { resolveKey: () => null })
      .buildPrompt(store.getTask(tid), store.cycleRecords(tid, cycle), cycle);
    assert.match(prompt, /只列三条最重要的进展/);
    assert.doesNotMatch(prompt, /进展要点/); // default template replaced
  } finally {
    close();
  }
});

test('talk session resolves only task tokens and flags the built-in daily', async () => {
  const { store, call, close } = await boot();
  try {
    const a = await call('POST', '/api/members', { name: '王五' });
    const daily = store.getDailyTask();
    const token = store.getTaskMember(daily.id, a.data.id).token;
    const sess = await call('GET', `/api/talk/session?token=${token}`, undefined, {});
    assert.equal(sess.status, 200);
    assert.equal(sess.data.task.is_builtin, true);
    assert.equal(sess.data.name, '王五');
    // a member-row token (legacy permanent link) no longer resolves
    const memberRowToken = store.getMemberById(a.data.id).token;
    assert.equal((await call('GET', `/api/talk/session?token=${memberRowToken}`, undefined, {})).status, 404);
  } finally {
    close();
  }
});

test('text models: DB > config > default layering, digest follows profile, blank reverts', async () => {
  const { call, close } = await boot();
  try {
    // fresh install: nothing stored, defaults apply, digest follows profile
    let s = (await call('GET', '/api/settings')).data;
    assert.equal(s.profile_model, '');
    assert.equal(s.digest_model, '');
    assert.equal(s.profile_model_default, 'gpt-5.1');
    assert.equal(s.profile_model_effective, 'gpt-5.1');
    assert.equal(s.digest_model_effective, 'gpt-5.1');

    // setting the profile model pulls the digest model along
    s = (await call('PUT', '/api/settings', { profile_model: 'gpt-5.2-mini' })).data;
    assert.equal(s.profile_model, 'gpt-5.2-mini');
    assert.equal(s.profile_model_effective, 'gpt-5.2-mini');
    assert.equal(s.digest_model_effective, 'gpt-5.2-mini');

    // an explicit digest model decouples it
    s = (await call('PUT', '/api/settings', { digest_model: 'gpt-5.1' })).data;
    assert.equal(s.digest_model_effective, 'gpt-5.1');
    assert.equal(s.profile_model_effective, 'gpt-5.2-mini');

    // blank reverts each field independently
    s = (await call('PUT', '/api/settings', { profile_model: '' })).data;
    assert.equal(s.profile_model, '');
    assert.equal(s.profile_model_effective, 'gpt-5.1');
    assert.equal(s.digest_model_effective, 'gpt-5.1'); // still the explicit one
    s = (await call('PUT', '/api/settings', { digest_model: '' })).data;
    assert.equal(s.digest_model, '');
    assert.equal(s.digest_model_effective, 'gpt-5.1'); // back to following profile

    // over-long model names are rejected
    const bad = await call('PUT', '/api/settings', { profile_model: 'x'.repeat(129) });
    assert.equal(bad.status, 400);

    // test endpoint: no key configured → no_key without hitting the network
    const t = await call('POST', '/api/settings/test-text-model', { model: 'gpt-5.1' });
    assert.equal(t.status, 200);
    assert.deepEqual(t.data, { ok: false, error: 'no_key' });
    // and it is auth-gated
    assert.equal((await call('POST', '/api/settings/test-text-model', { model: 'gpt-5.1' }, {})).status, 401);
  } finally {
    close();
  }
});
