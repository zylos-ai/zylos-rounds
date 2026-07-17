# zylos-standup Development Guide

This document guides AI assistants working on the zylos-standup component.

## Project Conventions

- **ESM only** — `import`/`export`, never `require()`. `"type": "module"` in package.json. Exception: `ecosystem.config.cjs` (PM2 requires CJS)
- **Node.js 22.13+** — Minimum runtime version (uses `node:sqlite` DatabaseSync)
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **All runtime config in `config.json`** — `~/zylos/components/standup/config.json` (data directory, never committed). `OPENAI_API_KEY` / proxy come from `~/zylos/.env`, never config.json
- **English for code** — Comments, commit messages, PR descriptions

## Architecture

```
Browser ──(Caddy /standup/* strip-prefix)──▶ 127.0.0.1:3478
  static React build ─┐                        │
  /u/<token> talk ────┼── /ws?token= ─▶ WS relay ──proxy──▶ OpenAI Realtime
  admin SPA (#/ hash) ┘                        └─ SQLite (data dir)
```

### Backend (`src/`)

| File | Purpose |
|------|---------|
| `index.js` | Entry — HTTP routing, static, WS upgrade wiring |
| `lib/config.js` | config.json loader + `~/zylos/.env` secrets |
| `lib/store.js` | SQLite with incremental migrations (`schema_migrations`) |
| `lib/auth.js` | AuthGate: scrypt password, SQLite sessions, rate limiting |
| `lib/api.js` | Admin REST API + member talk-session endpoint |
| `lib/relay.js` | OpenAI Realtime WS relay (see invariants below) |
| `lib/static.js` | Static serving of built frontend |
| `lib/http-util.js` | JSON/body/cookie/X-Forwarded-* helpers |

### Frontend (`web/` → built into `src/public/`, build output committed)

Vite + React + Tailwind + shadcn/ui. Two entries: `index.html` (admin SPA,
**hash routing only** — the app runs behind a stripped path prefix) and
`talk.html` (member voice page). All fetches are relative URLs.

## Relay invariants (hard-won — do not regress)

1. **Never force a sample rate in the browser.** Mobile Chromium ignores a
   forced 24k AudioContext and captures at 48k while labeling it 24k — the
   model hears pitch-shifted garbage. Capture at device-native rate, client
   downsamples to 24k (48k = exact 2:1 pair averaging; other rates linear
   interpolation with cross-packet phase `dsPos` clamped ≥ 0).
2. **Input transcription needs the ASR sidecar model** (`transcription:
   {model, language: 'zh'}`) — realtime models do not emit input transcripts.
3. **On barge-in send `conversation.item.truncate`** with the real played ms
   (client tracks per-item scheduled duration) or the model thinks its full
   answer was heard — context desyncs.
4. **semantic_vad eagerness low** — default splits long Chinese sentences.
5. **Anti-hallucination instructions** — the model must say "没听清" rather
   than guess; this is also the best capture-problem diagnostic.
6. Client → upstream events pass through an **allowlist** only.

## Testing

```bash
npm run check   # node --check all backend sources
npm test        # unit tests (node:test): store, auth
```

E2E: `test/e2e.mjs` (direct-WS synthetic audio) and browser E2E via full
Chromium with `--use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=<48kHz wav>` (headless_shell has no audio).
Browser screenshot verification is mandatory for any frontend change.

## Release Process

All four files in the same commit (inside the feature PR, not after merge):
`package.json`, `package-lock.json` (run `npm install`), `SKILL.md`
frontmatter version, `CHANGELOG.md` entry. After merge:
`gh release create vX.Y.Z --target main`.

## Directory Convention

```
Code:  ~/zylos/.claude/skills/standup/   # overwritten on upgrade
Data:  ~/zylos/components/standup/       # preserved (config.json, data/)
```

Never write to the SQLite DB directly for routine operations — use the API.
