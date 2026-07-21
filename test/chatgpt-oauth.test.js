import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeClaims, tokenMeta, needsRefresh } from '../src/lib/chatgpt-oauth.js';
import { Store } from '../src/lib/store.js';
import { Settings, AUTH_CHATGPT_OAUTH } from '../src/lib/settings.js';

/** Build a fake (unsigned) JWT with the given payload — we only read claims. */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

function oauthBlob({ expSecFromNow = 3600, accountId = 'acc_12345678', plan = 'pro', email = 'x@y.z', refresh = 'rt_1' } = {}) {
  const exp = Math.floor(Date.now() / 1000) + expSecFromNow;
  const authClaim = { chatgpt_account_id: accountId, chatgpt_plan_type: plan };
  return {
    access_token: fakeJwt({ exp, 'https://api.openai.com/auth': authClaim }),
    id_token: fakeJwt({ email, 'https://api.openai.com/auth': authClaim }),
    refresh_token: refresh,
    token_type: 'Bearer',
    earliest_refresh_at: null,
  };
}

test('decodeClaims parses a JWT payload and tolerates garbage', () => {
  const jwt = fakeJwt({ sub: 'u1', exp: 123 });
  assert.equal(decodeClaims(jwt).sub, 'u1');
  assert.deepEqual(decodeClaims('not-a-jwt'), {});
  assert.deepEqual(decodeClaims(''), {});
});

test('tokenMeta surfaces non-secret metadata; disconnected when no token', () => {
  assert.equal(tokenMeta(null).connected, false);
  const meta = tokenMeta(oauthBlob({ accountId: 'acc_abcdef99', plan: 'pro', email: 'a@b.c' }));
  assert.equal(meta.connected, true);
  assert.equal(meta.accountId, 'acc_abcdef99');
  assert.equal(meta.accountIdPrefix, 'acc_abcd…');
  assert.equal(meta.plan, 'pro');
  assert.equal(meta.email, 'a@b.c');
  assert.ok(meta.expiresAt);
});

test('needsRefresh is true within the skew window, false when fresh', () => {
  assert.equal(needsRefresh(oauthBlob({ expSecFromNow: 3600 })), false);
  assert.equal(needsRefresh(oauthBlob({ expSecFromNow: 60 })), true); // inside 300s skew
  assert.equal(needsRefresh(oauthBlob({ expSecFromNow: -10 })), true); // already expired
  assert.equal(needsRefresh(null), false);
});

function tmpSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rounds-oauth-'));
  const store = new Store(path.join(dir, 'test.db'));
  const settings = new Settings(store, () => ({}), { proxy: null, openaiApiKey: '' });
  return { store, settings };
}

test('textConnection returns oauth shape and getAuth for a chatgpt provider', () => {
  const { store, settings } = tmpSettings();
  store.createProvider({ slug: 'cgpt', name: 'ChatGPT', baseUrl: 'https://auth.openai.com', authType: AUTH_CHATGPT_OAUTH });
  store.setProviderOAuth('cgpt', oauthBlob());
  settings.setSlotProvider('profile', 'cgpt');

  const conn = settings.textConnection('profile');
  assert.equal(conn.authType, AUTH_CHATGPT_OAUTH);
  assert.equal(conn.key, 'oauth');
  assert.equal(typeof conn.getAuth, 'function');
  store.close();
});

test('ensureAccessToken returns the stored token without refreshing when fresh', async () => {
  const { store, settings } = tmpSettings();
  store.createProvider({ slug: 'cgpt', name: 'ChatGPT', baseUrl: 'https://auth.openai.com', authType: AUTH_CHATGPT_OAUTH });
  const blob = oauthBlob({ accountId: 'acc_deadbeef' });
  store.setProviderOAuth('cgpt', blob);
  const provider = store.getProvider('cgpt');

  const { accessToken, accountId } = await settings.ensureAccessToken(provider);
  assert.equal(accessToken, blob.access_token);
  assert.equal(accountId, 'acc_deadbeef');
  store.close();
});

test('ensureAccessToken throws when the provider is not connected', async () => {
  const { store, settings } = tmpSettings();
  store.createProvider({ slug: 'cgpt', name: 'ChatGPT', baseUrl: 'https://auth.openai.com', authType: AUTH_CHATGPT_OAUTH });
  const provider = store.getProvider('cgpt');
  await assert.rejects(() => settings.ensureAccessToken(provider), /not connected/);
  store.close();
});

test('disconnectOAuth clears the token family', () => {
  const { store, settings } = tmpSettings();
  store.createProvider({ slug: 'cgpt', name: 'ChatGPT', baseUrl: 'https://auth.openai.com', authType: AUTH_CHATGPT_OAUTH });
  store.setProviderOAuth('cgpt', oauthBlob());
  assert.equal(settings.oauthStatus(store.getProvider('cgpt')).connected, true);
  settings.disconnectOAuth('cgpt');
  assert.equal(settings.oauthStatus(store.getProvider('cgpt')).connected, false);
  store.close();
});
