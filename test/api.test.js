import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const sha256hex = v => crypto.createHash('sha256').update(v).digest('hex');

/** Boot the real Api over a real HTTP server — bearer-scope integration tests. */
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-api-'));
  const store = new Store(path.join(dir, 'test.db'));
  // v0.18: bearer keys live in the DB only — seed the fixture key
  store.createApiToken('test', sha256hex(KEY));
  const config = {
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

test('rename endpoint: renames, keeps links, rejects dup/empty/missing', async () => {
  const { call, close } = await boot();
  try {
    const added = await call('POST', '/api/members', { name: 'leslie' });
    const id = added.data.id;
    const origLink = added.data.links[0].link;

    const put = await call('PUT', `/api/members/${id}/name`, { name: 'Linfan' });
    assert.equal(put.status, 200);
    assert.equal(put.data.name, 'Linfan');

    const me = (await call('GET', '/api/members')).data.members.find(m => m.id === id);
    assert.equal(me.name, 'Linfan');
    assert.equal(me.links[0].link, origLink); // link keyed by token — unaffected by rename

    // same name is a no-op 200
    assert.equal((await call('PUT', `/api/members/${id}/name`, { name: 'Linfan' })).status, 200);

    // collision with another member's name → 409
    const other = (await call('POST', '/api/members', { name: 'Sam' })).data.id;
    assert.equal((await call('PUT', `/api/members/${other}/name`, { name: 'Linfan' })).status, 409);

    // validation
    assert.equal((await call('PUT', `/api/members/${id}/name`, { name: '   ' })).status, 400);
    assert.equal((await call('PUT', `/api/members/${id}/name`, { name: 'x'.repeat(65) })).status, 400);
    assert.equal((await call('PUT', '/api/members/9999/name', { name: 'Ghost' })).status, 404);
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
    const prompt = new DigestGenerator(store, () => ({ timeZone: 'Asia/Shanghai' }), {}, { resolveKey: () => null, resolveLanguage: () => 'zh' })
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

test('providers: builtin seeded, CRUD, builtin guard, in-use delete guard, slot validation', async () => {
  const { call, close } = await boot();
  try {
    // builtin present and effectively serving all three slots
    let list = (await call('GET', '/api/providers')).data.providers;
    assert.equal(list.length, 1);
    const builtin = list[0];
    assert.equal(builtin.slug, 'openai');
    assert.equal(builtin.is_builtin, true);
    assert.deepEqual(builtin.in_use.sort(), ['digest', 'profile', 'voice']);
    assert.equal(builtin.key_source, 'none');

    // legacy key card still works — now backed by the builtin provider row
    let s = (await call('PUT', '/api/settings', { openai_key: 'sk-db-key' })).data;
    assert.equal(s.openai_key_source, 'db');
    s = (await call('PUT', '/api/settings', { clear_openai_key: true })).data;
    assert.equal(s.openai_key_source, 'none');

    // create a custom text-only provider (slug generated from the name)
    const created = await call('POST', '/api/providers', {
      name: 'My Gateway', base_url: 'https://gw.example.com/', api_key: 'sk-gw', cap_models: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.slug, 'my-gateway');
    assert.equal(created.data.base_url, 'https://gw.example.com'); // trailing slash stripped
    assert.equal(created.data.key_source, 'db');
    assert.equal(created.data.cap_realtime, false);

    // builtin identity is fixed; its key is the only editable field
    assert.equal((await call('PUT', '/api/providers/openai', { base_url: 'https://evil.example.com' })).status, 400);
    assert.equal((await call('PUT', '/api/providers/openai', { api_key: 'sk-x' })).status, 200);

    // voice slot refuses non-realtime providers; text slots accept them
    assert.equal((await call('PUT', '/api/settings', { voice_provider: 'my-gateway' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { profile_provider: 'nope' })).status, 400);
    s = (await call('PUT', '/api/settings', { profile_provider: 'my-gateway' })).data;
    assert.equal(s.profile_provider_effective, 'my-gateway');
    assert.equal(s.digest_provider_effective, 'openai');

    // referenced provider cannot be deleted; clearing the slot frees it
    const denied = await call('DELETE', '/api/providers/my-gateway');
    assert.equal(denied.status, 400);
    assert.deepEqual(denied.data, { error: 'in_use', slots: ['profile'] });
    await call('PUT', '/api/settings', { profile_provider: '' });
    assert.equal((await call('DELETE', '/api/providers/my-gateway')).status, 204);

    // builtin cannot be deleted
    assert.equal((await call('DELETE', '/api/providers/openai')).status, 400);

    // voice model is free text since v0.8 (custom realtime-capable endpoints)
    s = (await call('PUT', '/api/settings', { model: 'my-realtime-model' })).data;
    assert.equal(s.model, 'my-realtime-model');
  } finally {
    close();
  }
});

test('talk session: date + prior record for the builtin daily (v0.9.2)', async () => {
  const { store, call, close } = await boot();
  try {
    const m = await call('POST', '/api/members', { name: '王五' });
    const daily = (await call('GET', '/api/tasks')).data.tasks.find(t => t.is_builtin);
    const token = store.taskMembers(daily.id).find(r => r.member_id === m.data.id).token;
    const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Shanghai' });

    // fresh member: date present, no prior
    let sess = await call('GET', `/api/talk/session?token=${token}`, undefined, {});
    assert.equal(sess.status, 200);
    assert.equal(sess.data.date, today);
    assert.equal(sess.data.prior, null);

    // draft (unsubmitted earlier session): status only, no summary
    store.appendTranscript(m.data.id, today, '我: 早\n', 30, 'test-model', false);
    sess = await call('GET', `/api/talk/session?token=${token}`, undefined, {});
    assert.equal(sess.data.prior.status, 'draft');
    assert.equal(sess.data.prior.summary, null);

    // submitted: full 4-field summary comes back parsed
    store.upsertSummary(m.data.id, today, {
      yesterday: ['修复了登录'], today: ['写文档'], blockers: [], topics_for_meeting: ['发布时间'],
    }, '{}', 'test-model');
    sess = await call('GET', `/api/talk/session?token=${token}`, undefined, {});
    assert.equal(sess.data.prior.status, 'submitted');
    assert.deepEqual(sess.data.prior.summary.yesterday, ['修复了登录']);
    assert.deepEqual(sess.data.prior.summary.topics_for_meeting, ['发布时间']);
    assert.deepEqual(sess.data.prior.summary.blockers, []);
  } finally {
    close();
  }
});

test('gemini voices: per-protocol options, resolveVoice fallback, sample serving (v0.10.2)', async () => {
  const { call, close } = await boot();
  try {
    // both voice lists exposed; providers carry their wire protocol
    let s = (await call('GET', '/api/settings')).data;
    assert.ok(s.voice_options.includes('marin'));
    assert.ok(s.gemini_voice_options.includes('Puck'));
    let list = (await call('GET', '/api/providers')).data.providers;
    assert.equal(list[0].protocol, 'openai');

    // gemini voice names are valid to store; garbage is not
    assert.equal((await call('PUT', '/api/settings', { voice: 'Kore' })).status, 200);
    assert.equal((await call('PUT', '/api/settings', { voice: 'NotAVoice' })).status, 400);

    // a generativelanguage base URL marks the provider as gemini-protocol
    const created = await call('POST', '/api/providers', {
      name: 'Gemini', base_url: 'https://generativelanguage.googleapis.com', api_key: 'k', cap_realtime: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.protocol, 'gemini');

    // voice resolution follows the voice slot's protocol: an OpenAI-side
    // voice under a gemini provider falls back to the gemini default…
    await call('PUT', '/api/settings', { voice: 'marin', voice_provider: 'gemini' });
    s = (await call('GET', '/api/settings')).data;
    assert.equal(s.voice, 'Puck');
    // …an explicit gemini voice sticks…
    await call('PUT', '/api/settings', { voice: 'Kore' });
    s = (await call('GET', '/api/settings')).data;
    assert.equal(s.voice, 'Kore');
    // …and switching back to the builtin snaps to the OpenAI default
    await call('PUT', '/api/settings', { voice_provider: '' });
    s = (await call('GET', '/api/settings')).data;
    assert.equal(s.voice, 'marin');

    // gemini samples are per-model (same voice sounds different per model)
    assert.equal((await call('GET', '/api/settings/voice-sample/Kore?model=gemini-2.5-flash-native-audio-preview-12-2025')).status, 200);
    assert.equal((await call('GET', '/api/settings/voice-sample/Kore?model=gemini-3.1-flash-live-preview')).status, 200);
    // OpenAI samples stay flat; an unknown model dir falls back to the flat file
    assert.equal((await call('GET', '/api/settings/voice-sample/marin?model=whatever-model')).status, 200);
    // a path-escaping model never reaches the fs as a directory
    assert.equal((await call('GET', '/api/settings/voice-sample/Kore?model=..%2F..%2Fetc')).status, 404);
    assert.equal((await call('GET', '/api/settings/voice-sample/Nope')).status, 404);
  } finally {
    close();
  }
});

test('usage endpoint: month rollup + validation (v0.11.0)', async () => {
  const { store, call, close } = await boot();
  try {
    const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Shanghai' });
    const month = today.slice(0, 7);
    const id = Number(store.addMember('赵六', 'tokZ').lastInsertRowid);
    store.insertUsage({ date: today, slot: 'voice', provider: 'gemini', model: 'gemini-3.1-flash-live-preview', member_id: id, seconds: 240, input_audio: 6000, output_audio: 3000, cost_usd: 0.054 });
    store.insertUsage({ date: `${month}-01`, slot: 'digest', provider: 'openai', model: 'gpt-5.5', input_text: 1000, output_text: 200, cost_usd: 0.011 });

    let r = await call('GET', '/api/usage');
    assert.equal(r.status, 200);
    assert.equal(r.data.month, month);
    assert.equal(r.data.entries, 2);
    assert.ok(Math.abs(r.data.total_usd - 0.065) < 1e-9);
    assert.ok(Math.abs(r.data.today_usd - 0.054) < 1e-9);
    assert.equal(r.data.by_member.length, 1); // digest has no member
    assert.equal(r.data.by_member[0].name, '赵六');

    r = await call('GET', '/api/usage?month=2020-01');
    assert.equal(r.data.entries, 0);
    assert.equal((await call('GET', '/api/usage?month=bogus')).status, 400);
    // admin auth required
    assert.equal((await call('GET', '/api/usage', null, {})).status, 401);
  } finally {
    close();
  }
});

test('time zone setting: layering, validation, blank revert (v0.10.4)', async () => {
  const { call, close } = await boot();
  try {
    // nothing stored -> config.json layer wins (fixture sets Asia/Shanghai;
    // with no config value the built-in default is Asia/Singapore)
    let s = (await call('GET', '/api/settings')).data;
    assert.equal(s.time_zone, '');
    assert.equal(s.time_zone_default, 'Asia/Shanghai');
    assert.equal(s.time_zone_effective, 'Asia/Shanghai');

    // set a valid zone; garbage rejected
    s = (await call('PUT', '/api/settings', { time_zone: 'Asia/Tokyo' })).data;
    assert.equal(s.time_zone, 'Asia/Tokyo');
    assert.equal(s.time_zone_effective, 'Asia/Tokyo');
    assert.equal((await call('PUT', '/api/settings', { time_zone: 'Mars/Olympus' })).status, 400);

    // blank reverts to the default
    s = (await call('PUT', '/api/settings', { time_zone: '' })).data;
    assert.equal(s.time_zone, '');
    assert.equal(s.time_zone_effective, 'Asia/Shanghai');
  } finally {
    close();
  }
});

test('named API tokens: create/list/auth/rotate/revoke (v0.17/v0.18)', async () => {
  const { call, close } = await boot();
  try {
    // create — plaintext returned exactly once
    const created = await call('POST', '/api/tokens', { name: 'luna' });
    assert.equal(created.status, 201);
    assert.match(created.data.token, /^rk_[A-Za-z0-9_-]+$/);
    const tid = created.data.id;
    const plain1 = created.data.token;
    assert.equal((await call('POST', '/api/tokens', { name: 'luna' })).status, 409);
    assert.equal((await call('POST', '/api/tokens', { name: '  ' })).status, 400);

    // list never exposes secrets
    const list = await call('GET', '/api/tokens');
    assert.equal(list.status, 200);
    const row = list.data.tokens.find(t => t.id === tid);
    assert.equal(row.name, 'luna');
    assert.equal(Object.hasOwn(row, 'token'), false);
    assert.equal(Object.hasOwn(row, 'token_hash'), false);

    // the minted token authenticates with full manager scope and gets last_used stamped
    const asNew = { Authorization: `Bearer ${plain1}` };
    assert.equal((await call('GET', '/api/members', null, asNew)).status, 200);
    const used = (await call('GET', '/api/tokens')).data.tokens.find(t => t.id === tid);
    assert.ok(used.last_used_at);

    // rotate: same id/name, new secret; old plaintext dies immediately
    const rotated = await call('POST', `/api/tokens/${tid}/rotate`, {});
    assert.equal(rotated.status, 200);
    assert.equal(rotated.data.id, tid);
    assert.notEqual(rotated.data.token, plain1);
    assert.equal((await call('GET', '/api/members', null, asNew)).status, 401);
    const asRotated = { Authorization: `Bearer ${rotated.data.token}` };
    assert.equal((await call('GET', '/api/members', null, asRotated)).status, 200);

    // revoke the named token — its bearer access fully gone
    assert.equal((await call('DELETE', `/api/tokens/${tid}`, null, asRotated)).status, 200);
    assert.equal((await call('GET', '/api/members', null, asRotated)).status, 401);
    assert.equal((await call('DELETE', '/api/tokens/999')).status, 404);

    // v0.18: config.serviceToken is not a credential — even if present in config
    const cfgTok = { Authorization: 'Bearer some-config-service-token' };
    assert.equal((await call('GET', '/api/members', null, cfgTok)).status, 401);
  } finally {
    close();
  }
});

test('follow-ups: POST/GET/DELETE with scope + task validation', async () => {
  const { store, call, close } = await boot();
  try {
    const taskId = store.builtinTaskId();
    const p = await call('POST', '/api/followups', { task_id: taskId, content: '私有补充', scope: 'private', author: 'Luna' });
    assert.equal(p.status, 201);
    assert.equal(p.data.scope, 'private');
    const t = await call('POST', '/api/followups', { task_id: taskId, content: '团队共享补充', scope: 'team' });
    assert.equal(t.data.scope, 'team');

    const list = await call('GET', `/api/followups?task_id=${taskId}`);
    assert.equal(list.status, 200);
    assert.equal(list.data.followups.length, 2);

    // invalid task / empty content / missing bearer are all rejected
    assert.equal((await call('POST', '/api/followups', { task_id: 99999, content: 'x' })).status, 400);
    assert.equal((await call('GET', '/api/followups?task_id=99999')).status, 400);
    assert.equal((await call('POST', '/api/followups', { task_id: taskId, content: '  ' })).status, 400);
    assert.equal((await call('POST', '/api/followups', { task_id: taskId, content: 'x' }, {})).status, 401);

    // delete
    assert.equal((await call('DELETE', `/api/followups/${p.data.id}`)).status, 200);
    assert.equal((await call('GET', `/api/followups?task_id=${taskId}`)).data.followups.length, 1);
    assert.equal((await call('DELETE', '/api/followups/99999')).status, 404);
  } finally {
    close();
  }
});
