#!/usr/bin/env node
/**
 * standup CLI — agent-friendly management client for zylos-rounds.
 *
 * Talks to the admin API with the bearer API key (config.serviceToken); never
 * touches the database. Designed for AI agents: JSON output, stdin for long
 * text, zero interactive prompts.
 *
 * Credential resolution (first hit wins):
 *   1. --url / --key flags
 *   2. ROUNDS_URL / ROUNDS_API_KEY environment variables
 *   3. ~/zylos/components/rounds/cli.json        {"url": "...", "apiKey": "..."}
 *   4. ~/zylos/components/rounds/config.json     (same-host install: 127.0.0.1:<port> + serviceToken)
 *
 * A remote agent (e.g. the coco avatar) only needs cli.json in its own data
 * directory pointing at the public URL — see SKILL.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HELP = `standup CLI — manage the voice-standup app via its admin API

Usage: cli.js [--url U] [--key K] <command> [args]

Members
  member list                         roster with links, today's status, context/profile
  member add <name>                   add (or re-activate) a member
  member remove <id>                  deactivate a member (history kept, link dies)
  member reset-link <id>              mint a fresh personal link
  member set-context <id> [text]      set 基础背景 (text arg or stdin; empty clears)
  member set-profile <id> [text]      overwrite 动态画像 (text arg or stdin; empty clears)

Agent brain
  brain get                           team_background + probing_guidance
  brain set <team-background|probing-guidance> [text]    (text arg or stdin)

Knowledge base
  knowledge list
  knowledge search <query...>
  knowledge add --title T [--tags G] [text]              (content from text arg or stdin)
  knowledge update <id> [--title T] [--tags G] [text]
  knowledge remove <id>

Reports & settings
  report today | report <YYYY-MM-DD>  day digest (structured + transcripts)
  report history                      per-day submission counts
  settings get
  settings set [--model M] [--voice V]

All output is JSON. Long text is best piped via stdin:
  cat notes.md | cli.js member set-context 3
`;

function fail(msg) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

/** Pull --flags out of argv (flags may appear anywhere). */
export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1] ?? '';
      i++;
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

export function resolveTarget(flags, env, home) {
  if (flags.url && flags.key) return { url: flags.url, key: flags.key };
  if (env.ROUNDS_URL && env.ROUNDS_API_KEY) return { url: env.ROUNDS_URL, key: env.ROUNDS_API_KEY };
  const dataDir = path.join(home, 'zylos/components/rounds');
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'cli.json'), 'utf8'));
    if (c.url && c.apiKey) return { url: c.url, key: c.apiKey };
  } catch { /* no cli.json — try the same-host config */ }
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    if (c.serviceToken) return { url: `http://127.0.0.1:${c.port || 3478}`, key: c.serviceToken };
  } catch { /* fall through */ }
  return null;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  return fs.readFileSync(0, 'utf8');
}

/** Long-text argument: explicit arg wins, otherwise piped stdin. */
function textInput(arg) {
  return (arg !== undefined ? String(arg) : readStdin()).trim();
}

async function call(target, method, apiPath, body) {
  const url = `${target.url.replace(/\/+$/, '')}${apiPath}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${target.key}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`request failed: ${e.message} (${url})`);
  }
  if (res.status === 204) return {};
  let data;
  try {
    data = await res.json();
  } catch {
    fail(`non-JSON response (http ${res.status}) from ${url}`);
  }
  if (!res.ok) fail(`http ${res.status}: ${data.error || 'request failed'}`);
  return data;
}

const BRAIN_KEYS = { 'team-background': 'team_background', 'probing-guidance': 'probing_guidance' };

async function run(target, cmd, sub, args, flags) {
  const get = p => call(target, 'GET', p);
  const put = (p, b) => call(target, 'PUT', p, b);
  const post = (p, b) => call(target, 'POST', p, b);
  const del = p => call(target, 'DELETE', p);
  const id = v => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) fail(`invalid id: ${v}`);
    return n;
  };

  switch (`${cmd} ${sub}`) {
    case 'member list': return get('/api/members');
    case 'member add': {
      if (!args[0]) fail('usage: member add <name>');
      return post('/api/members', { name: args[0] });
    }
    case 'member remove': return del(`/api/members/${id(args[0])}`).then(() => ({ ok: true, removed: id(args[0]) }));
    case 'member reset-link': return post(`/api/members/${id(args[0])}/reset-token`);
    case 'member set-context': return put(`/api/members/${id(args[0])}/context`, { context: textInput(args[1]) });
    case 'member set-profile': return put(`/api/members/${id(args[0])}/profile`, { profile: textInput(args[1]) });

    case 'brain get': return get('/api/context');
    case 'brain set': {
      const key = BRAIN_KEYS[args[0]];
      if (!key) fail('usage: brain set <team-background|probing-guidance> [text]');
      return put('/api/context', { [key]: textInput(args[1]) });
    }

    case 'knowledge list': return get('/api/knowledge');
    case 'knowledge search': {
      if (!args.length) fail('usage: knowledge search <query...>');
      return get(`/api/knowledge/search?q=${encodeURIComponent(args.join(' '))}&limit=${flags.limit || 5}`);
    }
    case 'knowledge add': {
      if (!flags.title) fail('usage: knowledge add --title T [--tags G] [text|stdin]');
      const content = textInput(args[0]);
      if (!content) fail('knowledge content required (text arg or stdin)');
      return post('/api/knowledge', { title: flags.title, content, tags: flags.tags || '' });
    }
    case 'knowledge update': {
      const kid = id(args[0]);
      const existing = (await get('/api/knowledge')).knowledge.find(k => k.id === kid);
      if (!existing) fail(`knowledge ${kid} not found`);
      const content = textInput(args[1]) || existing.content;
      return put(`/api/knowledge/${kid}`, {
        title: flags.title ?? existing.title,
        content,
        tags: flags.tags ?? existing.tags,
      });
    }
    case 'knowledge remove': return del(`/api/knowledge/${id(args[0])}`).then(() => ({ ok: true, removed: id(args[0]) }));

    case 'report today': {
      const date = (await get('/api/auth/me')).date;
      return get(`/api/reports/${date}`);
    }
    case 'report history': return get('/api/reports/history');

    case 'settings get': return get('/api/settings');
    case 'settings set': {
      const body = {};
      if (flags.model) body.model = flags.model;
      if (flags.voice) body.voice = flags.voice;
      if (!Object.keys(body).length) fail('usage: settings set [--model M] [--voice V]');
      return put('/api/settings', body);
    }

    default:
      if (cmd === 'report' && /^\d{4}-\d{2}-\d{2}$/.test(sub || '')) return get(`/api/reports/${sub}`);
      fail(`unknown command: ${cmd} ${sub || ''} (run with --help)`);
  }
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  if (flags.help !== undefined || rest[0] === 'help' || !rest.length) {
    console.log(HELP);
    return;
  }
  const target = resolveTarget(flags, process.env, process.env.HOME || '');
  if (!target) fail('no credentials: pass --url/--key, set ROUNDS_URL/ROUNDS_API_KEY, or provide cli.json/config.json in ~/zylos/components/rounds/');
  const out = await run(target, rest[0], rest[1], rest.slice(2), flags);
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => fail(e.message));
}
