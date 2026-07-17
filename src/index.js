#!/usr/bin/env node
/**
 * zylos-standup — voice daily-standup component.
 *
 * Root-internal HTTP app on 127.0.0.1:<port>; Caddy exposes it at /standup/*
 * (strip_prefix + X-Forwarded-Prefix). Serves the built React frontend,
 * the admin REST API, and the OpenAI Realtime WS relay.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, watchConfig, loadEnvSecrets, DATA_DIR, CONFIG_PATH } from './lib/config.js';
import { Store } from './lib/store.js';
import { AuthGate } from './lib/auth.js';
import { Api } from './lib/api.js';
import { Relay } from './lib/relay.js';
import { Static } from './lib/static.js';
import { sendText, sendJson } from './lib/http-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('[standup] Starting...');
console.log(`[standup] Data directory: ${DATA_DIR}`);

const config = getConfig();
if (!config.enabled) {
  console.log('[standup] Component disabled in config, exiting.');
  process.exit(0);
}

const env = loadEnvSecrets();
if (!env.openaiApiKey) {
  console.error('[standup] Missing OPENAI_API_KEY (checked ~/zylos/.env and process.env)');
  process.exit(1);
}

const store = new Store(path.join(DATA_DIR, 'data', 'standup.db'));
const auth = new AuthGate(config, store, CONFIG_PATH);
const api = new Api(store, auth);
const statics = new Static(path.join(__dirname, 'public'));
const relay = new Relay(store, getConfig, env);

watchConfig(() => console.log('[standup] Config reloaded'));

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

    // member talk page — token checked server-side before serving the app
    const m = url.pathname.match(/^\/u\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'GET') {
      if (!store.getMemberByToken(m[1])) {
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
    console.error('[standup] http error', e);
    if (!res.headersSent) sendText(res, 500, 'server error');
    else res.end();
  }
});

relay.attach(server);

const port = config.port ?? 3478;
server.listen(port, '127.0.0.1', () => {
  console.log(`[standup] Listening on 127.0.0.1:${port} (model=${config.model}, voice=${config.voice}, proxy=${env.proxy ? 'on' : 'off'}, auth=${auth.enabled ? 'on' : 'OFF'})`);
});

function shutdown() {
  console.log('[standup] Shutting down...');
  auth.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
