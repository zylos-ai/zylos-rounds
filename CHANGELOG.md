# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-07-18

### Fixed
- **Mobile layout for the admin SPA.** The top nav no longer wraps tab labels
  vertically on phone widths — it scrolls horizontally (hidden scrollbar) and
  auto-centers the active tab. The roster renders as a stacked member list on
  small screens instead of a squeezed table (link copy/open plus
  context/reset/remove actions intact); raw link URLs are hidden on phones in
  the task detail member rows; the tasks-page header wraps instead of
  crowding the create button

## [0.6.0] - 2026-07-18

### Added
- **Communication tasks (沟通任务)** — the product's core abstraction. A task
  = brief + question frame (free text) + participants + window + digest form.
  The daily standup is now the single built-in `recurring` task; `oneshot`
  tasks (e.g. quarterly review 1:1s) run one conversation per participant
- **Link-driven routing** — permanent member links keep serving the daily
  standup; each oneshot task mints per-(task, member) links that open that
  task's conversation directly and die when the task closes
- **Task-level digest** — synthesizes all per-member summaries into
  共识 / 分歧 / 重点信号 for the owner. Manual trigger by default, optional
  scheduled auto-trigger, close-on-digest as a separate linkage, re-trigger
  overwrites the previous digest
- **Admin 任务 page** — task list, create form (brief/questions/participants/
  deadline/digest config), task detail with per-member links, status,
  summaries, transcripts and the digest panel
- **CLI `task` subcommands** — create/list/show/update/digest/close/reopen/
  remove, for agents driving one-off rounds via the API key
- Oneshot sessions submit via a generic `submit_conversation_summary` tool
  (要点 + 重点信号) and feed the member's dynamic profile like standups do
- DB migration v5 (`tasks`, `task_members`, `reports.task_id`)

### Fixed
- PM2 `ecosystem.config.cjs` still pointed its working directory at the old
  `skills/standup` install path, so the service failed to start on a fresh
  `zylos add` — now `skills/rounds`
- `package.json` description and the POC migration script's default target
  path updated to the Rounds naming

## [0.5.0] - 2026-07-18

### Changed
- **Rebrand: Standup → Rounds** — the product is now called **Rounds**, and
  the repository moved to `zylos-ai/zylos-rounds` (full git history
  preserved). Component name `rounds`, PM2 service `zylos-rounds`, data dir
  `~/zylos/components/rounds/` (database file `rounds.db`), env vars
  `ROUNDS_URL`/`ROUNDS_API_KEY`, public path `/rounds/*`, and UI branding all
  renamed accordingly
- **Legacy links keep working** — `/standup/*` is served as an alias of
  `/rounds/*`, so member talk links (`/standup/u/<token>`) issued before the
  rename remain valid

## [0.4.0] - 2026-07-18

### Added
- **Agent-friendly CLI** (`scripts/cli.js`) — full app management from the
  command line via the admin API, JSON in/out, stdin for long text, zero
  prompts. Members (add / remove / reset-link / context / profile), brain
  containers, knowledge base (incl. search), day reports and settings.
  Credentials resolve from flags → `ROUNDS_URL`/`ROUNDS_API_KEY` env →
  `cli.json` in the data dir → same-host `config.json`, so a remote agent
  (e.g. the coco avatar) only needs a `cli.json` with the public URL + API key
- **API key with full admin scope** — the bearer `config.serviceToken` now
  covers the entire admin API (roster, reports, settings — previously brain
  content only), so agents can operate the app without database access or a
  login session. New endpoints: `GET /api/knowledge/search`,
  `PUT /api/members/:id/profile`
- **Dynamic member profiles (动态画像)** — after each submitted report an LLM
  pass (`profileModel`, default `gpt-5.1`) merges the day's structured
  summary + transcript into a per-member profile: entries are dated, re-dated
  when re-confirmed, and aged out when stale. The profile is injected into the
  member's next call (【X 的动态画像】) alongside the hand-written 背景, and is
  viewable / hand-correctable in the roster dialog (成员管理 → 背景与画像).
  Test-member sessions never update profiles; failures are soft (previous
  profile kept). DB migration v4 (`members.profile`, `profile_updated_at`)

## [0.3.0] - 2026-07-18

### Added
- **Agent brain** — the agent's behaviour is now shaped by editable content,
  not just code:
  - `team_background` and `probing_guidance` containers, injected into every
    call as 【团队背景】/【追问指引】. The probing guidance is *how* smart
    follow-up is controlled (when / what / how-deep) — tune it, and the agent
    probes accordingly on the next call
  - per-member `context` (【关于 X】) — role and what to probe for that person
  - team knowledge base (title / content / tags)
- **On-demand retrieval tools** the realtime agent can call mid-conversation:
  - `recall_member_history` — the member's own recent submitted reports, for
    following up on past progress / blockers (conversation continuity)
  - `search_team_knowledge` — keyword search over the knowledge base
- **Management API** for the brain, reachable by admin session **or** a bearer
  service token (`config.serviceToken`, minted on first start) so Luna / the
  coco avatar can tune it programmatically:
  `GET/PUT /api/context`, `GET /api/context/members`,
  `PUT /api/members/:id/context`, `GET/POST/PUT/DELETE /api/knowledge`
- **Admin UI**: new 背景/追问 page (background, probing, knowledge base); a
  per-member 背景 editor on the roster; raw conversation transcript viewable on
  demand in the daily report (原始对话 — 备查)
- DB migration v3: `agent_context` table, `members.context` column,
  `knowledge` table

### Changed
- Session instructions are composed from the base persona + the (non-empty)
  background containers, replacing the hard-coded "最多追问一句" rule with the
  editable probing guidance
- The day-report API now returns each member's transcript for review

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
