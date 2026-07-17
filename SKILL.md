---
name: standup
version: 0.2.1
description: >-
  Voice daily-standup component. Team members talk to an AI agent (OpenAI
  Realtime, Chinese voice conversation) via a personal no-login link; the agent
  collects yesterday/today/blockers/meeting-topics, stores structured reports,
  and serves per-day team digests. Use when managing standup members (add /
  remove / reset link), reading daily reports or digests, checking who has
  reported today, or troubleshooting the voice relay. Triggers: "日报",
  "语音日报", "standup", "每日汇报", "日会待议", "谁还没汇报".
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
| `/standup/#/report/<YYYY-MM-DD>` | admin | daily digest (topics first, per-member cards, missing list) |
| `/standup/#/reports` | admin | multi-day history |
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

## Data

- `data/standup.db` — members (permanent tokens), reports (one row per
  member×date, UNIQUE), admin sessions. WAL mode.
- Reports keep both the structured summary (function-call output) and the
  full conversation transcript.

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
