# Dev Plan: standup v2 — 语音日报正式化

> Working document for the development period only — removed before merge (convention 2026-06-07).
> Spec anchor: confirmed design doc (standup-v2-design.md, Howard-approved 2026-07-17) + Howard's rulings below.

## Summary

Rewrite the voice-standup MVP (`voice-standup-poc`, PM2 `voice-poc`) as the formal zylos component `standup`: same validated voice-relay core, plus dashboard-style admin auth and a modern React UI, delivered with full component lifecycle (install/upgrade/uninstall/config).

## Settled decisions (Howard, 2026-07-17 — do not re-open)

1. `/voice/*` manual Caddy route is removed outright after cutover — **no 301** (links not yet distributed when decided; new links distributed post-launch by coco avatar).
2. First version scope = **MVP parity + admin auth + new UI**. No reminder channels, no scheduled pushes, no deadline/calendar logic (12:00 daily meeting is a verbal convention; a day nobody reports simply has no report).
3. Repo `zylos-ai/zylos-standup`, component name `standup`, route `/standup/*`.
4. Web-page voice form factor confirmed.
5. Model `gpt-realtime` family (config default `gpt-realtime-2.1`); provider relay layer keeps a switch seam for future Gemini/domestic models. **Voice = `marin`** (Howard confirmed 2026-07-17; Sol is ChatGPT-exclusive, not in API).
6. Member links permanent; token regenerable per-member if leaked.
7. Data migration preserves all existing member tokens (15 active members already imported).

## Scope

**In:** relay backend port (with all MVP audio fixes), member/report/digest surfaces as React app, admin password auth (dashboard pattern), component packaging, data migration, E2E + browser verification.

**Out (later iterations):** reminders/nudges, digest push to IM, non-OpenAI providers, calendar/scheduling logic, member self-service beyond the talk page.

## Architecture

```
Browser ──(HTTPS/WSS via Caddy /standup/* strip-prefix)──▶ component server (127.0.0.1:3478)
   │                                                            │
   │  static React build (web/ → src/public/)                   ├─ node:sqlite DB (data dir)
   │  /u/<token> talk page ── /ws?token= ──▶ WS relay ──proxy──▶ OpenAI Realtime
   │  admin SPA (hash routing)                                  └─ scrypt+session AuthGate
```

- **Backend**: Node 20+ ESM, deps only `ws` + `https-proxy-agent`. Entry `src/index.js`. Listens `127.0.0.1`, port from config (default **3478** — POC keeps 3477 until cutover). Root-internal app per template convention; `X-Forwarded-Prefix` honored where absolute URLs are unavoidable (member link display).
- **DB**: `~/zylos/components/standup/data/standup.db`, schema = MVP schema (members, reports) + `sessions` + `schema_migrations` (incremental, idempotent — dashboard pattern).
- **Auth**: port of dashboard `AuthGate`, simplified: scrypt config password, session in SQLite (sha256(token) stored), sliding expiry (7d absolute / 24h idle), per-IP + global login rate limiting, HttpOnly+Secure+SameSite=Strict cookie `__Host-zylos_standup_session`. Member token auth completely separate (token = identity for talk page + WS only; zero admin surface).
- **Relay** (port from POC `server.mjs`, all hard-won fixes preserved):
  - client event allowlist; `poc.*` protocol renamed `app.*`
  - session.update: semantic_vad eagerness low; transcription `gpt-realtime-whisper` language zh; voice/model from config; anti-hallucination instructions
  - function call `submit_standup_summary` → structured upsert; transcript accumulation → draft/submitted upsert on close; 10min session cap; max 4 concurrent
  - client_info diagnostic beacon (ctx_rate + UA) preserved
- **Frontend** (`web/`, Vite + React + Tailwind + shadcn/ui; build committed to `src/public/`):
  - `talk.html` entry → `/u/<token>` page: port MVP capture logic **verbatim in behavior** — native-sample-rate capture + client downsample to 24k (48k exact 2:1 averaging; other rates linear interp with cross-packet `dsPos` phase clamped ≥0), AudioWorklet ~100ms chunking, playback scheduling with `item_id` tracking, `conversation.item.truncate` with real played ms on barge-in, flush-on-speech_started. Call-state UI upgrade: waveform/volume visualization + call state machine (idle→connecting→listening→speaking→done).
  - `index.html` entry → admin SPA, **hash routing** (`#/`, `#/report/:date`, `#/reports`, `#/login`) so prefix-stripping needs no server URL rewriting; all fetches relative.
- **PM2**: service `zylos-standup` via SKILL.md lifecycle.

## API contract (frontend ↔ backend)

Admin routes require session (401 JSON `{error:"unauthorized"}` → SPA shows login view). All paths relative to component root.

| Method/Path | Auth | Req | Resp |
|---|---|---|---|
| POST `api/auth/login` | — | `{password}` | 204 + cookie; 401 `{error}`; 429 rate-limited |
| POST `api/auth/logout` | session | — | 204 |
| GET `api/auth/me` | — | — | `{authenticated: bool}` |
| GET `api/members` | session | — | `{members:[{id,name,active,reported_today,link}]}` (`link` = absolute member URL built from X-Forwarded-Prefix + Host) |
| POST `api/members` | session | `{name}` | 201 member; 409 duplicate name |
| DELETE `api/members/:id` | session | — | 204 (soft deactivate) |
| POST `api/members/:id/reset-token` | session | — | `{link}` new token |
| GET `api/reports/history` | session | — | `{days:[{date,submitted,member_count,topics_count}]}` |
| GET `api/reports/:date` | session | — | `{date, reports:[{member_name,yesterday[],today[],blockers[],topics[],duration_s,updated_at}], missing:[names], topics:[{name,topic}]}` |
| GET `api/talk/session?token=` | token | — | `{name}` (404 invalid/inactive) |
| GET `u/:token` | token | — | talk page HTML (404 page if invalid) |
| WS `ws?token=` | token | realtime relay | `app.ready / app.error / app.saved {summary} / app.end` + passthrough events |
| GET `health` | — | — | `OK` |

## Development checklist

- [ ] Backend: config loader (port/model/voice/limits + auth block), DB layer with migrations
- [ ] Backend: AuthGate port (login/logout/session/rate-limit) + tests
- [ ] Backend: REST API per contract + tests
- [ ] Backend: WS relay port with protocol rename + report upserts
- [ ] Backend: static serving of `src/public/` (immutable assets caching, no-store for HTML)
- [ ] Frontend: Vite workspace (`web/`), Tailwind + shadcn/ui setup, two entries
- [ ] Frontend: talk page (capture/playback/truncate logic port + call-state UI + live captions + summary card)
- [ ] Frontend: admin SPA (login, roster+links+copy+add/remove/reset-token, daily report, history)
- [ ] Packaging: SKILL.md (http_routes `/standup/*` → 3478, lifecycle, config schema), hooks (post-install generates password + prints once, configure, pre/post-upgrade), ecosystem.config.cjs
- [ ] Migration: `scripts/migrate-from-poc.js` — import members+reports from POC DB preserving ids/tokens; idempotent
- [ ] Version 0.1.0 + CHANGELOG inside the feature PR

## Test checklist

- [ ] Unit: auth (hash/verify/session expiry/rate limit), report upsert logic, API handlers (node:test)
- [ ] E2E direct-WS: adapted POC `test/e2e.mjs` — synthetic Chinese audio through full relay → submitted report
- [ ] E2E browser: full Chromium + `--use-fake-device-for-media-stream` + `--use-file-for-fake-audio-capture=<48k wav>` → talk page full flow at 48kHz
- [ ] Browser screenshots of every page (light+dark), login/logout flow, invalid token page
- [ ] Migration dry-run against a copy of the live POC DB; verify 15 active member tokens byte-identical

## Assumptions

- [ ] `node:sqlite` DatabaseSync available on target Node (validated: POC runs on it today)
- [ ] `OPENAI_API_KEY` + proxy read from `~/zylos/.env` (same as POC) — not duplicated into config.json
- [ ] members.name UNIQUE and members.token UNIQUE are enforced by schema (yes — POC schema, carried over)
- [ ] No id-arithmetic anywhere; date windowing via ORDER BY/GROUP BY (pattern: never assume id contiguity)
- [ ] Caddy strips `/standup` and forwards `X-Forwarded-Prefix` (template convention; verify with real Caddyfile block at deploy)

## Acceptance checklist

- [ ] All MVP behaviors reproduced (four-question flow, barge-in, summary card, admin roster, daily report, history)
- [ ] Admin pages unreachable without login; member token grants only own talk page; key no longer appears in any URL
- [ ] Browser screenshots compared page-by-page with Howard-approved MVP look (upgraded, not regressed)
- [ ] 15 member links unchanged after migration
- [ ] `npm test` green; syntax check green
- [ ] Fresh-install path verified (`zylos add standup` on a temp dir simulation) + upgrade-preserve semantics (config.json, data/)
