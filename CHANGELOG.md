# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-17

### Added
- Voice daily standup: members talk to an AI agent (OpenAI Realtime, Chinese)
  via a permanent personal link; structured reports (昨天/今天/卡点/日会待议)
  stored per member per day, full transcript kept alongside
- WebSocket relay with device-adaptive audio capture (native sample rate +
  client-side downsampling to 24k), semantic VAD, barge-in truncation,
  `gpt-realtime-whisper` input transcription, anti-hallucination instructions
- Admin surfaces (React + Tailwind + shadcn/ui): roster with member links and
  today status, daily digest (meeting topics first), multi-day history
- Admin auth: scrypt-hashed password (generated at install, printed once),
  SQLite-backed sessions, login rate limiting
- `/standup/*` Caddy route (strip-prefix, root-internal app on 127.0.0.1:3478)
- `scripts/migrate-from-poc.js`: one-time idempotent import from the
  voice-standup-poc MVP DB, preserving member ids and tokens

### Upgrade Notes

Fresh installation:

```bash
zylos add standup
```

Migrating from the voice-standup-poc MVP: install, then run the migration
script (see SKILL.md) — existing member links keep working.
