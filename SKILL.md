---
name: rounds
version: 0.9.0
description: >-
  Rounds (formerly standup) — delegated 1:1 structured voice conversations for
  teams. An AI agent (OpenAI Realtime, Chinese voice) talks to each member via
  a personal no-login link on the owner's behalf; the daily standup
  (yesterday/today/blockers/meeting-topics with per-day team digests) is the
  first built-in scenario. The agent has a maintainable "brain" — editable
  team background, probing guidance, per-member context and an auto-maintained
  dynamic profile (动态画像, merged from past reports after each conversation)
  injected every call, plus on-demand tools to recall a member's past reports
  and search a team knowledge base. Full management is available to agents via
  scripts/cli.js with the bearer API key (config.serviceToken) — members,
  brain, knowledge, reports, settings — no DB access needed. Use when managing
  members (add / remove / reset link), tuning the agent's background /
  probing / knowledge / profiles, reading daily reports / transcripts /
  digests, checking who has reported today, or troubleshooting the voice
  relay. Triggers: "rounds", "日报", "语音日报", "standup", "每日汇报",
  "日会待议", "谁还没汇报", "追问", "背景", "画像", "知识库".
type: capability

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-rounds
    entry: src/index.js
  data_dir: ~/zylos/components/rounds
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - data/

http_routes:
  - path: /rounds/*
    type: reverse_proxy
    target: localhost:3478
    strip_prefix: /rounds
  # legacy alias — member links issued under /standup/ keep working
  - path: /standup/*
    type: reverse_proxy
    target: localhost:3478
    strip_prefix: /standup

upgrade:
  repo: zylos-ai/zylos-rounds
  branch: main

config:
  required: []
  optional:
    - name: ROUNDS_PORT
      description: Local port the component listens on (127.0.0.1)
      default: "3478"

dependencies: []
---

# Rounds — 代你走一轮的语音沟通 agent

Delegated 1:1 voice conversations: the agent "makes the rounds" on the
owner's behalf. The built-in first scenario is the daily voice standup:
each member gets a permanent personal link
(`/rounds/u/<token>`), talks to the agent for 3–5 minutes, and a structured
report (昨天 / 今天 / 卡点 / 日会待议) is stored per member per day. Admin
surfaces (roster, daily digest, history) sit behind password login
(dashboard-style scrypt + session cookie).

## URLs (behind Caddy)

| Path | Who | What |
|------|-----|------|
| `/rounds/` | admin (login) | roster: members, links, today status; add/remove/reset-link |
| `/rounds/#/report/<YYYY-MM-DD>` | admin | daily digest (topics first, per-member cards, raw transcript on demand, missing list) |
| `/rounds/#/reports` | admin | multi-day history |
| `/rounds/#/brain` | admin | 背景/追问: team background, probing guidance, knowledge base |
| `/rounds/u/<token>` | member | voice conversation page (no login) |

## Configuration (`~/zylos/components/rounds/config.json`)

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
| `serviceToken` | generated | bearer API key — full admin API scope (roster / brain / knowledge / reports / settings); minted on first start |
| `profileModel` | `gpt-5.1` | text model that maintains the 动态画像 after each report |
| `profileApiBase` | `https://api.openai.com` | override for tests/mocks only |

`OPENAI_API_KEY` and `HTTPS_PROXY` are read from `~/zylos/.env` (process.env
wins) — they are never stored in config.json.

Since v0.8 model connections are managed as **providers** (settings page or
CLI): each provider carries a base URL + write-only API key + capability
flags (Realtime voice / models listing), all spoken over the
OpenAI-compatible protocol. The builtin `openai` provider maps to the .env
key; voice / profile / digest each select a provider + model
(`settings set --voice-provider/--profile-provider/--digest-provider`,
`provider list/add/set/remove/models/test`). config.json model keys remain
the fallback layer under the settings DB.

To reset the admin password: write a plaintext value into `auth.password`,
restart the service — it is migrated to a scrypt hash on startup and printed
to neither logs nor console.

## Admin operations (agent-side, via CLI)

The whole admin API accepts the bearer API key (`config.serviceToken`) — use
the bundled CLI instead of raw curl or the web UI. Never write to the SQLite
DB directly.

```bash
CLI="node ~/zylos/.claude/skills/rounds/scripts/cli.js"

$CLI member list                       # roster + links + today's status
$CLI member add 小王
$CLI member remove 3                   # deactivate (history kept)
$CLI member reset-link 3
echo "前端负责人，关注上线节奏" | $CLI member set-context 3
echo "- [2026-07-18] 在做发布系统" | $CLI member set-profile 3   # correct the 动态画像

$CLI brain get
echo "..." | $CLI brain set team-background
echo "..." | $CLI brain set probing-guidance

$CLI knowledge list
$CLI knowledge search 发布 系统
echo "内容..." | $CLI knowledge add --title "发布系统" --tags "release"
$CLI knowledge update 2 --title "新标题"
$CLI knowledge remove 2

$CLI report today                      # or: report 2026-07-18 / report history
$CLI settings get
$CLI settings set --voice cedar
```

Credential resolution: `--url`/`--key` flags → `ROUNDS_URL`/`ROUNDS_API_KEY`
env → `~/zylos/components/rounds/cli.json` (`{"url","apiKey"}`) → same-host
`config.json` (127.0.0.1 + serviceToken). On this host it works with zero
setup. For a remote agent (e.g. the coco avatar): copy `scripts/cli.js`, drop
a `cli.json` in its own data dir pointing at
`https://luna.jinglever.com/rounds` with the API key — no DB, no login.

## Agent brain (background / probing / knowledge)

The agent's behaviour is shaped by editable content, not code. Three
always-injected containers plus a searchable knowledge base:

| Container | Scope | Effect |
|-----------|-------|--------|
| `team_background` | global | injected as 【团队背景】 so the agent understands what people talk about |
| `probing_guidance` | global | 【追问指引】 — when / what / how-deep to follow up (this is *how* smart probing is controlled) |
| member `context` | per-member | 【关于 X】 — hand-written role and what to probe for them |
| member `profile` | per-member | 【X 的动态画像】 — auto-maintained: after each submitted report an LLM pass merges new facts in, re-dates re-confirmed ones, ages out stale ones. Hand-correctable (roster dialog or CLI) |
| knowledge base | global | entries the agent searches on demand via `search_team_knowledge` |

The agent also has two on-demand realtime tools (it decides when to call them):

- `recall_member_history` — this member's recent submitted reports, so it can
  follow up on past progress / blockers.
- `search_team_knowledge` — keyword search over the knowledge base.

Tune the brain from a conversation with the owner, then push the change here.
Every edit takes effect on the next call — this is the loop that makes the app
sharper over time.

### Management API (Luna / the coco avatar)

Everything the admin UI can do is also available programmatically with the
bearer API key (`config.serviceToken`) — prefer the CLI above; raw endpoints
for reference: `GET/POST/DELETE /api/members`, `POST
/api/members/:id/reset-token`, `PUT /api/members/:id/context`, `PUT
/api/members/:id/profile`, `GET/PUT /api/context`, `GET /api/context/members`,
`GET/POST/PUT/DELETE /api/knowledge`, `GET /api/knowledge/search?q=`,
`GET /api/reports/history`, `GET /api/reports/<date>`, `GET/PUT
/api/settings`. Base: `https://luna.jinglever.com/rounds` (or
`http://127.0.0.1:3478`). Only login itself is session-only.

### Dynamic profiles (动态画像)

After each **submitted** report (test member excluded), a `profileModel` pass
rewrites that member's profile from: existing profile + hand-written 背景
(reference only) + the day's structured summary + transcript. Entries carry a
last-confirmed date, get re-dated when re-confirmed, and age out after ~30
days of silence. Injected into the member's next call. Failures are soft (old
profile kept; see `pm2 logs` for `profile update failed`). Correct mistakes
via the roster dialog or `member set-profile`.

## Data

- `data/rounds.db` — members (permanent tokens, optional per-member
  `context`, auto-maintained `profile`), reports (one row per member×date,
  UNIQUE), admin sessions, `agent_context` (background + probing),
  `knowledge`. WAL mode.
- Reports keep both the structured summary (function-call output) and the
  full conversation transcript (viewable per member on the daily report page).

## Migration from the MVP (one-time)

```bash
node ~/zylos/.claude/skills/rounds/scripts/migrate-from-poc.js --dry-run
node ~/zylos/.claude/skills/rounds/scripts/migrate-from-poc.js
```

Preserves member ids and tokens — existing member links keep working.

## Troubleshooting

- `pm2 logs zylos-rounds` — session start/end lines, `client ... ctx_rate=`
  device beacons (capture-side audio issues show up here), ASR failures.
- Member reports garbled AI hearing → check the client beacon sample rate;
  the client captures at device-native rate and downsamples to 24k (never
  force a sample rate on mobile browsers).
- Upstream connect failures → verify proxy in `~/zylos/.env` and key validity.
