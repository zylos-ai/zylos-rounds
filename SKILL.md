---
name: standup
version: 0.3.0
description: >-
  Voice daily-standup component. Team members talk to an AI agent (OpenAI
  Realtime, Chinese voice conversation) via a personal no-login link; the agent
  collects yesterday/today/blockers/meeting-topics, stores structured reports,
  and serves per-day team digests. The agent has a maintainable "brain" —
  editable team background, probing guidance and per-member context injected
  every call, plus on-demand tools to recall a member's past reports and search
  a team knowledge base. Use when managing standup members (add / remove /
  reset link), tuning the agent's background / probing / knowledge, reading
  daily reports / transcripts / digests, checking who has reported today, or
  troubleshooting the voice relay. Triggers: "日报", "语音日报", "standup",
  "每日汇报", "日会待议", "谁还没汇报", "追问", "背景", "知识库".
type: capability

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-standup
    entry: src/index.js
  data_dir: ~/zylos/components/standup
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - data/

http_routes:
  - path: /standup/*
    type: reverse_proxy
    target: localhost:3478
    strip_prefix: /standup

upgrade:
  repo: zylos-ai/zylos-standup
  branch: main

config:
  required: []
  optional:
    - name: STANDUP_PORT
      description: Local port the component listens on (127.0.0.1)
      default: "3478"

dependencies: []
---

# Standup — 语音日报

Voice-first daily standup: each member gets a permanent personal link
(`/standup/u/<token>`), talks to the agent for 3–5 minutes, and a structured
report (昨天 / 今天 / 卡点 / 日会待议) is stored per member per day. Admin
surfaces (roster, daily digest, history) sit behind password login
(dashboard-style scrypt + session cookie).

## URLs (behind Caddy)

| Path | Who | What |
|------|-----|------|
| `/standup/` | admin (login) | roster: members, links, today status; add/remove/reset-link |
| `/standup/#/report/<YYYY-MM-DD>` | admin | daily digest (topics first, per-member cards, raw transcript on demand, missing list) |
| `/standup/#/reports` | admin | multi-day history |
| `/standup/#/brain` | admin | 背景/追问: team background, probing guidance, knowledge base |
| `/standup/u/<token>` | member | voice conversation page (no login) |

## Configuration (`~/zylos/components/standup/config.json`)

| Key | Default | Notes |
|-----|---------|-------|
| `enabled` | `true` | |
| `port` | `3478` | listens on 127.0.0.1 only |
| `model` | `gpt-realtime-2.1` | OpenAI Realtime model |
| `voice` | `marin` | agent voice |
| `transcriptionModel` | `gpt-realtime-whisper` | input ASR sidecar model |
| `maxConcurrent` | `4` | concurrent voice sessions |
| `maxSessionMs` | `600000` | per-session hard cap |
| `timeZone` | `Asia/Shanghai` | report-date boundary |
| `auth.enabled` | `true` | admin auth (never disable in production) |
| `auth.password` | generated | scrypt hash; plaintext printed once at install |
| `serviceToken` | generated | bearer token for the management API (context / knowledge) — minted on first start |

`OPENAI_API_KEY` and `HTTPS_PROXY` are read from `~/zylos/.env` (process.env
wins) — they are never stored in config.json.

To reset the admin password: write a plaintext value into `auth.password`,
restart the service — it is migrated to a scrypt hash on startup and printed
to neither logs nor console.

## Admin operations (agent-side, via API)

The admin API uses the session cookie; for agent-side operations, log in with
the password from the operator, or operate through the web UI in a browser.
Routine member management should go through the web UI / API — never write to
the SQLite DB directly.

## Agent brain (background / probing / knowledge)

The agent's behaviour is shaped by editable content, not code. Three
always-injected containers plus a searchable knowledge base:

| Container | Scope | Effect |
|-----------|-------|--------|
| `team_background` | global | injected as 【团队背景】 so the agent understands what people talk about |
| `probing_guidance` | global | 【追问指引】 — when / what / how-deep to follow up (this is *how* smart probing is controlled) |
| member `context` | per-member | 【关于 X】 — that person's role and what to probe for them |
| knowledge base | global | entries the agent searches on demand via `search_team_knowledge` |

The agent also has two on-demand realtime tools (it decides when to call them):

- `recall_member_history` — this member's recent submitted reports, so it can
  follow up on past progress / blockers.
- `search_team_knowledge` — keyword search over the knowledge base.

Tune the brain from a conversation with the owner, then push the change here.
Every edit takes effect on the next call — this is the loop that makes the app
sharper over time.

### Maintenance API (Luna / the coco avatar)

Maintainable via the admin UI (`#/brain`, per-member 背景 dialog) **or**
programmatically with the bearer service token (`config.serviceToken`).
Base: `https://luna.jinglever.com/standup` (or `http://127.0.0.1:3478`).

```bash
TOK=$(node -e "console.log(require(process.env.HOME+'/zylos/components/standup/config.json').serviceToken)")
B=http://127.0.0.1:3478
AUTH="Authorization: Bearer $TOK"

# background + probing guidance
curl -s -H "$AUTH" $B/api/context
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"team_background":"...", "probing_guidance":"..."}' $B/api/context

# per-member context (get ids/names first — no talk links exposed here)
curl -s -H "$AUTH" $B/api/context/members
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"context":"前端负责人，关注上线节奏"}' $B/api/members/<id>/context

# knowledge base
curl -s -H "$AUTH" $B/api/knowledge
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"title":"发布系统","content":"...","tags":"release 前端"}' $B/api/knowledge
curl -s -X PUT    -H "$AUTH" -H 'Content-Type: application/json' -d '{...}' $B/api/knowledge/<id>
curl -s -X DELETE -H "$AUTH" $B/api/knowledge/<id>
```

Member roster management (add / remove / reset link) stays session-only — the
service token is scoped to brain content, not the roster.

## Data

- `data/standup.db` — members (permanent tokens, optional per-member
  `context`), reports (one row per member×date, UNIQUE), admin sessions,
  `agent_context` (background + probing), `knowledge`. WAL mode.
- Reports keep both the structured summary (function-call output) and the
  full conversation transcript (viewable per member on the daily report page).

## Migration from the MVP (one-time)

```bash
node ~/zylos/.claude/skills/standup/scripts/migrate-from-poc.js --dry-run
node ~/zylos/.claude/skills/standup/scripts/migrate-from-poc.js
```

Preserves member ids and tokens — existing member links keep working.

## Troubleshooting

- `pm2 logs zylos-standup` — session start/end lines, `client ... ctx_rate=`
  device beacons (capture-side audio issues show up here), ASR failures.
- Member reports garbled AI hearing → check the client beacon sample rate;
  the client captures at device-native rate and downsamples to 24k (never
  force a sample rate on mobile browsers).
- Upstream connect failures → verify proxy in `~/zylos/.env` and key validity.
