# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-07-18

### Added
- Voice preview (试听) button next to the voice dropdown on the settings
  page: plays a short pre-generated Chinese sample of the selected voice,
  toggles to a stop button while playing
- Bundled wav samples for all 10 voices (`assets/voice-samples/`), served
  via the session-protected `GET /api/settings/voice-sample/:voice` route
- `scripts/generate-voice-samples.mjs`: regenerates samples through the
  Realtime API (marin/cedar are realtime-only voices, so the TTS endpoint
  cannot produce them); skips voices whose sample file already exists

## [0.2.0] - 2026-07-17

### Added
- Settings page (`#/settings`) in the admin UI: configure the OpenAI API
  key, conversation model, and voice without touching server files
  - API key is stored in the component DB and is write-only at the API
    surface (GET only reports the source: env / db / none); a key in
    `~/zylos/.env` always takes precedence, the DB key is the fallback
  - Model and voice dropdowns apply to the next call (no restart needed)
  - Test-connection button probes `/v1/models` with the resolved key
- Built-in try-it member (体验成员): seeded automatically with a permanent
  link, shares the full talk flow (including the spoken summary) but is
  excluded from every roster count, completion rate, daily report, and
  history; shown as a separate "体验链接" block on the roster page and
  cannot be deleted; its talk page is labeled 体验模式
- DB migration v2: `settings` table + `members.is_test` column

### Changed
- The server no longer exits when no OpenAI key is configured at startup:
  it warns and lets the admin configure one from the settings page; calls
  without any key fail with a clear in-call error message

## [0.1.2] - 2026-07-17

### Changed
- Redesigned member talk page to match the bold admin style: full-screen
  centered welcome hero (brand mark, large personalized greeting, 128px mic
  orb), and an in-call layout with a compact branded header and roomier
  chat bubbles

## [0.1.1] - 2026-07-17

### Changed
- Bolder admin UI: 1200px shell with a branded header, hero page titles,
  large stat tiles with a completion progress bar, taller table rows,
  two-column report cards, and a brand-marked login page

### Added
- Open-in-new-tab button next to each member link's copy button
- `publicOrigin` config option: overrides `X-Forwarded-*`-derived origin when
  building member links, so TLS-terminating proxies that forward plain HTTP
  still produce `https://` links

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
