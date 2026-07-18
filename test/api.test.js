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
  const api = new Api(store, auth, getConfig, settings, new AgentContext(store));
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
  const { call, close } = await boot();
  try {
    // roster management via bearer (owner's 2026-07-18 ruling)
    const added = await call('POST', '/api/members', { name: '阿明' });
    assert.equal(added.status, 201);
    const id = added.data.id;

    const list = await call('GET', '/api/members');
    assert.equal(list.status, 200);
    const me = list.data.members.find(m => m.id === id);
    assert.equal(me.name, '阿明');
    assert.ok('profile' in me && 'context' in me);

    const reset = await call('POST', `/api/members/${id}/reset-token`);
    assert.equal(reset.status, 200);
    assert.notEqual(reset.data.link, added.data.link);

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
