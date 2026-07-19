#!/usr/bin/env node
/**
 * zylos-rounds — voice daily-standup component.
 *
 * Root-internal HTTP app on 127.0.0.1:<port>; Caddy exposes it at /standup/*
 * (strip_prefix + X-Forwarded-Prefix). Serves the built React frontend,
 * the admin REST API, and the OpenAI Realtime WS relay.
 */

import http from 'node:http';
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

// The daily standup is the built-in recurring communication task. v0.7: every
// link is a per-(task, member) token — mint missing daily links idempotently
// (existing tokens are kept; rotation happens only via the reset API).
const dailyTask = store.ensureDailyTask('每日日报');
for (const mb of [...store.listActiveMembers(), store.getTestMember()].filter(Boolean)) {
  if (!store.getTaskMember(dailyTask.id, mb.id)) {
    store.addTaskMember(dailyTask.id, mb.id, crypto.randomBytes(8).toString('base64url'));
  }
}

// The agent's maintainable brain (background + probing + knowledge). Seed the
// default probing guidance once so the mechanism is useful out of the box.
const context = new AgentContext(store);
context.seedDefaults();

// Bearer API key for the management API — full admin scope (roster, brain,
// knowledge, reports, settings) for Luna / the coco avatar and scripts/cli.js.
// Minted once and persisted into the component config.
if (!config.serviceToken) {
  config.serviceToken = crypto.randomBytes(24).toString('base64url');
  try {
    saveConfig(config);
    console.log('[rounds] minted management API service token (config.serviceToken)');
  } catch (err) {
    console.error(`[rounds] failed to persist service token: ${err.message}`);
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
server.listen(port, '127.0.0.1', () => {
  console.log(`[rounds] Listening on 127.0.0.1:${port} (model=${settings.resolveModel()}, voice=${settings.resolveVoice()}, key=${settings.keySource()}, proxy=${env.proxy ? 'on' : 'off'}, auth=${auth.enabled ? 'on' : 'OFF'})`);
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
