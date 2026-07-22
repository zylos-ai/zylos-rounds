#!/usr/bin/env node
/**
 * zylos-rounds — voice daily-standup component.
 *
 * Root-internal HTTP app on 127.0.0.1:<port>; Caddy exposes it at /standup/*
 * (strip_prefix + X-Forwarded-Prefix). Serves the built React frontend,
 * the admin REST API, and the OpenAI Realtime WS relay.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getConfig, saveConfig, watchConfig, loadEnvSecrets, DATA_DIR, CONFIG_PATH } from './lib/config.js';
import { Store } from './lib/store.js';
import { AuthGate } from './lib/auth.js';
import { Api } from './lib/api.js';
import { Relay } from './lib/relay.js';
import { Settings } from './lib/settings.js';
import { AgentContext } from './lib/context.js';
import { ProfileUpdater } from './lib/profile.js';
import { DigestGenerator } from './lib/digest.js';
import { Static } from './lib/static.js';
import { sendText, sendJson } from './lib/http-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('[rounds] Starting...');
console.log(`[rounds] Data directory: ${DATA_DIR}`);

const config = getConfig();
if (!config.enabled) {
  console.log('[rounds] Component disabled in config, exiting.');
  process.exit(0);
}

const env = loadEnvSecrets();

const store = new Store(path.join(DATA_DIR, 'data', 'rounds.db'));
const settings = new Settings(store, getConfig, env);
if (settings.migrateLegacyEnvKey()) console.log('[rounds] Migrated legacy OPENAI_API_KEY from the process environment into the builtin provider (DB); env keys are no longer read');
// Keys live in the DB and can be set later from the admin settings page —
// missing at startup is a warning, not a fatal error.
if (!settings.resolveKey()) {
  console.warn('[rounds] No API key configured for the builtin provider yet — set one in the admin settings page');
}
// Built-in try-it member: full talk flow, excluded from all rosters/digests.
store.ensureTestMember('体验成员', crypto.randomBytes(8).toString('base64url'));

// The daily standup is the built-in recurring communication task. v0.28:
// daily membership is explicit (join_daily on create / the roster API) —
// the old boot-time backfill of every active member is gone, or it would
// resurrect members removed from the daily on every restart. Only the
// try-it member always keeps a link.
const dailyTask = store.ensureDailyTask('每日日报');
const tryIt = store.getTestMember();
if (tryIt && !store.getTaskMember(dailyTask.id, tryIt.id)) {
  store.addTaskMember(dailyTask.id, tryIt.id, crypto.randomBytes(8).toString('base64url'));
}

// The agent's maintainable brain (background + probing + knowledge). Seed the
// default probing guidance once so the mechanism is useful out of the box.
const context = new AgentContext(store);
context.seedDefaults();

// Bearer API keys for the management API — full admin scope (roster, brain,
// knowledge, reports, settings) for agents and scripts/cli.js. v0.18: keys
// are named DB rows only (/api/tokens, `cli.js token ...`); config.json
// carries no auth credential. A same-host cli.json is written at mint time
// so the local CLI stays zero-config.
const sha256hex = v => crypto.createHash('sha256').update(v).digest('hex');
const writeCliJson = (plaintext) => {
  const cliJsonPath = path.join(DATA_DIR, 'cli.json');
  if (fs.existsSync(cliJsonPath)) return;
  fs.writeFileSync(cliJsonPath,
    `${JSON.stringify({ url: `http://127.0.0.1:${config.port ?? 3478}`, apiKey: plaintext }, null, 2)}\n`,
    { mode: 0o600 });
};
if (config.serviceToken) {
  // pre-v0.18 config: one-time migration of the shared serviceToken into the
  // DB — same plaintext keeps working, existing clients are untouched
  try {
    const name = store.getApiTokenByName('default') ? 'migrated' : 'default';
    if (!store.getApiTokenByHash(sha256hex(config.serviceToken))) {
      store.createApiToken(name, sha256hex(config.serviceToken));
    }
    writeCliJson(config.serviceToken);
    delete config.serviceToken;
    saveConfig(config);
    console.log(`[rounds] migrated config.serviceToken into the DB as named API key "${name}" (same plaintext; local cli.json ensured)`);
  } catch (err) {
    console.error(`[rounds] serviceToken migration failed: ${err.message}`);
  }
} else if (!store.listApiTokens().length) {
  // fresh install (or everything revoked): bootstrap one named key
  const plaintext = `rk_${crypto.randomBytes(24).toString('base64url')}`;
  store.createApiToken('default', sha256hex(plaintext));
  try {
    writeCliJson(plaintext);
  } catch (err) {
    console.error(`[rounds] failed to write cli.json: ${err.message}`);
  }
  console.log(`[rounds] FIRST-START API key "default" (for cli.js / remote clients): ${plaintext}`);
}

// Standalone first start: auth is on but no password exists yet (the zylos
// component install seeds one via its post-install hook). Generate one,
// print it once, and persist — AuthGate hashes it in place right after.
if (config.auth?.enabled && !config.auth.password) {
  config.auth.password = crypto.randomBytes(9).toString('base64url');
  try {
    saveConfig(config);
    console.log(`[rounds] FIRST-START admin password (change it in config.json anytime): ${config.auth.password}`);
  } catch (err) {
    console.error(`[rounds] failed to persist generated admin password: ${err.message}`);
  }
}

const auth = new AuthGate(config, store, CONFIG_PATH);
const digests = new DigestGenerator(store, getConfig, env, settings);
const api = new Api(store, auth, getConfig, settings, context, digests);
const statics = new Static(path.join(__dirname, 'public'));
const profiles = new ProfileUpdater(store, getConfig, env, settings);
const relay = new Relay(store, getConfig, env, settings, context, profiles);
digests.startScheduler();

watchConfig(() => console.log('[rounds] Config reloaded'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  try {
    if (url.pathname === '/health') return sendText(res, 200, 'OK');

    if (url.pathname.startsWith('/api/')) {
      if (await api.handle(req, res, url)) return;
      return sendJson(res, 404, { error: 'not_found' });
    }

    // hashed build assets — immutable
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      if (statics.serve(res, url.pathname, { cacheImmutable: true })) return;
      return sendText(res, 404, 'not found');
    }

    // member talk page — token checked server-side before serving the app.
    // v0.7: only per-(task, member) tokens resolve; closed tasks 404.
    const m = url.pathname.match(/^\/u\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'GET') {
      if (!store.getTaskSessionByToken(m[1])) {
        return sendText(res, 404, '链接无效或已失效', 'text/plain; charset=utf-8');
      }
      if (statics.serve(res, 'talk.html')) return;
      return sendText(res, 503, 'frontend build missing');
    }

    // admin SPA shell (hash routing — one entry serves all admin views)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (statics.serve(res, 'index.html')) return;
      return sendText(res, 503, 'frontend build missing');
    }

    // other static files at public/ root (favicon etc.)
    if (req.method === 'GET' && statics.serve(res, url.pathname)) return;

    sendText(res, 404, 'not found');
  } catch (e) {
    console.error('[rounds] http error', e);
    if (!res.headersSent) sendText(res, 500, 'server error');
    else res.end();
  }
});

relay.attach(server);

const port = config.port ?? 3478;
// Bind host: 127.0.0.1 behind the zylos reverse proxy (default); Docker /
// standalone set ROUNDS_BIND=0.0.0.0 (or config.host) to expose the port.
const host = process.env.ROUNDS_BIND || config.host || '127.0.0.1';
server.listen(port, host, () => {
  console.log(`[rounds] Listening on ${host}:${port} (model=${settings.resolveModel()}, voice=${settings.resolveVoice()}, key=${settings.keySource()}, proxy=${env.proxy ? 'on' : 'off'}, auth=${auth.enabled ? 'on' : 'OFF'})`);
});

function shutdown() {
  console.log('[rounds] Shutting down...');
  auth.stop();
  digests.stopScheduler();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
