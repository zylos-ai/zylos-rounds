import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { AuthGate, hashPassword, verifyPassword } from '../src/lib/auth.js';

function setup({ password = hashPassword('correct-horse') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-auth-'));
  const store = new Store(path.join(dir, 'test.db'));
  const configPath = path.join(dir, 'config.json');
  const config = { auth: { enabled: true, password } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const auth = new AuthGate(config, store, configPath);
  return { auth, store, config, configPath };
}

function mockReq({ cookie, ip = '10.0.0.1' } = {}) {
  return { headers: cookie ? { cookie } : {}, socket: { remoteAddress: ip }, method: 'POST' };
}

function mockRes() {
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers || {}); },
    end(body) { this.body = body; this.ended = true; },
  };
  return res;
}

test('password hash/verify roundtrip', () => {
  const h = hashPassword('s3cret');
  assert.ok(h.startsWith('scrypt:'));
  assert.ok(verifyPassword('s3cret', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('s3cret', 'not-a-hash'));
});

test('plaintext config password is migrated to scrypt on construction', () => {
  const { auth, config, configPath } = setup({ password: 'plain-pw' });
  assert.ok(config.auth.password.startsWith('scrypt:'));
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(onDisk.auth.password.startsWith('scrypt:'));
  assert.ok(verifyPassword('plain-pw', config.auth.password));
  auth.stop();
});

test('login flow sets cookie and session validates', async () => {
  const { auth, store } = setup();
  const req = mockReq({});
  const res = mockRes();
  const handlers = {};
  req.on = (ev, fn) => { handlers[ev] = fn; };
  process.nextTick(() => {
    handlers.data(JSON.stringify({ password: 'correct-horse' }));
    handlers.end();
  });
  await auth.handleLogin(req, res);
  assert.equal(res.code, 204);
  const cookie = res.headers['set-cookie'];
  assert.match(cookie, /__Host-zylos_standup_session=/);
  const token = cookie.match(/session=([0-9a-f]+);/)[1];
  const authedReq = mockReq({ cookie: `__Host-zylos_standup_session=${token}` });
  assert.ok(auth.isAuthenticated(authedReq));
  // logout destroys session
  const res2 = mockRes();
  auth.handleLogout(authedReq, res2);
  assert.equal(res2.code, 204);
  assert.ok(!auth.isAuthenticated(authedReq));
  auth.stop();
  store.close();
});

test('wrong password 401s and repeated failures lock out the ip', async () => {
  const { auth, store } = setup();
  for (let i = 0; i < 6; i++) {
    const req = mockReq({ ip: '10.9.9.9' });
    const res = mockRes();
    const handlers = {};
    req.on = (ev, fn) => { handlers[ev] = fn; };
    process.nextTick(() => {
      handlers.data(JSON.stringify({ password: 'nope' }));
      handlers.end();
    });
    await auth.handleLogin(req, res);
    if (i < 5) assert.equal(res.code, 401);
    else assert.equal(res.code, 429); // locked out after MAX_FAILURES
  }
  auth.stop();
  store.close();
});

test('auth disabled means everything is authenticated', () => {
  const { store } = setup();
  const config = { auth: { enabled: false, password: '' } };
  const auth = new AuthGate(config, store, '/dev/null');
  assert.ok(auth.isAuthenticated(mockReq({})));
  auth.stop();
  store.close();
});
