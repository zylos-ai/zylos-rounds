# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.25.2] - 2026-07-22

### Fixed
- **Conversations now persist incrementally (crash/restart durability)** —
  previously a voice session's transcript was buffered in memory and only
  written to the DB on clean session end, so a service restart mid-call lost the
  entire conversation. The relay now flushes the contiguous run of already-filled
  transcript entries as the call proceeds (after each answered turn / ASR result,
  plus a 7s safety timer), stopping at the first unfilled ASR slot to preserve
  true order. Chunk writes carry duration 0; the real duration is recorded once
  at session end (`store.finalizeReport` / `store.finalizeCycleRecord`). A restart
  now loses at most the last unfinished turn instead of the whole conversation.

## [0.25.1] - 2026-07-22

### Changed
- **Talk-page control copy** — the member voice page relabels its controls:
  「静音」→「闭麦」 (and「取消静音」→「取消闭麦」, muted status →「已闭麦…」),
  「文字」→「文字输入」 (EN `Text` → `Text input`). Clearer intent, no behavior
  change.

## [0.25.0] - 2026-07-22

### Added
- **Per-cycle follow-up context snapshot** — reports and generic cycle records
  now persist the follow-up IDs actually injected when a member's session
  started (`injected_followup_ids`, migration v14). Admin history views show the
  context that specific run saw (`context_followups` in the daily-report and
  task-detail APIs; a read-only "本期已带入的补充" panel separate from the
  editable current follow-ups) instead of recomputing from today's task-wide
  follow-up list.
- **Continue / revise after submit** — a member who reopens an already-submitted
  task link now sees a "继续补充/修改" CTA; clicking it tears down the finished
  session and starts a fresh continuation conversation that merges into the
  existing summary/transcript, so no hidden page refresh is required.

### Changed
- **One-question-at-a-time hardening** — flowGeneric/flowDaily now cap each
  message at one question / one question mark / one intent, plus a new
  【复杂补充规则】/[Complex follow-up rule]: when a member dumps a lot, adds
  items, corrects, or jumps topic, acknowledge first and then ask only the
  single most important gap (zh+en).
- **Bulk-text direct extraction** — new 【整段文字日报规则】/【整段文字输入规则】:
  when a member types or pastes a complete standup/material, extract it straight
  into the summary and restate for confirmation instead of restarting the oral
  interview from question one (zh+en).
- **Confirm-before-submit for custom interviews** — the generic ending now
  restates the key points and gets the member's confirmation *before* calling
  `submit_conversation_summary`. The daily standup (`submit_standup_summary`)
  flow is unchanged.

## [0.24.0] - 2026-07-21

### Added
- **ChatGPT/Codex subscription provider** — a provider can now authenticate with
  a ChatGPT subscription (Plus/Pro) instead of a static API key, for the profile
  and digest text slots. Establishes an independent OAuth token family via the
  device-authorization flow (RFC 8628-style): the settings page shows a one-time
  code + verification link, the user confirms on any device, and the server
  polls, exchanges, and stores the token family. Never reads or writes the local
  Codex CLI credentials (`~/.codex/auth.json`), so there is no refresh-token
  rotation conflict; the login is revocable independently from ChatGPT account
  settings.
  - New `auth_type`/`oauth_json` columns on `providers` (migration v13).
  - New `src/lib/chatgpt-oauth.js`: device flow, single-flight token refresh
    (honoring `earliest_refresh_at`), and the ChatGPT-backend Responses call
    (SSE aggregated to text, usage recorded like any other text call). All
    network loops tolerate transient proxy/socket errors.
  - Settings UI: pick "ChatGPT subscription" when adding a provider, connect /
    reconnect / disconnect the account, and see plan / token expiry / account.
    Model field suggests `gpt-5.5` presets; such providers are excluded from the
    voice slot (no realtime models) and serve profile/digest only.

## [0.23.0] - 2026-07-21

### Added
- **Last report injected into daily-call context** (plan-change baseline): the
  member's previous report — its plan and any blockers — now rides into the
  standup instructions as a `【上次日报】` / `[Last report]` block, so the agent
  can compare today's stated work against the previous plan and gently probe
  divergences, and can ask whether last time's blockers got resolved. A full
  production day showed the model never proactively calls
  `recall_member_history` for this on its own; injection makes the baseline
  free. Daily task only; skipped when there is no prior report or its plan is
  empty.

### Changed
- **One-question-at-a-time hardened into a hard rule** (daily flow, zh+en):
  each message may contain at most one question; blockers and meeting topics
  must be asked separately, each getting a clear answer before moving on. A
  production-day review showed bundled questions were the top probe failure —
  answers to the first question were routinely lost.
- **Garbled-input guard added to the safety rule** (zh+en): transcriptions that
  are gibberish or clearly not real speech must be re-confirmed as "didn't
  catch that" — never recorded as "no" or any assumed answer.
- Default daily probe now points the plan-change bullet at the injected last
  report instead of suggesting a `recall_member_history` call.

## [0.22.6] - 2026-07-21

### Fixed
- **Mute no longer blocks the typed channel** (owner report): switching to text
  mode now lifts mute on the spot — a stale mute can never gate or confuse the
  typed conversation, and the muted status can't linger into text mode.
- **Root cause of "typed text disappears": upstream audio starvation.** Gemini
  aborts a Live session (`1008 The operation was aborted`) after ~2.5 minutes
  without incoming audio — exactly what a muted or text-mode client produces.
  Reproduced in sandbox (session died at t+153s of muted idle). The adapter now
  streams a 100ms zero-PCM silence frame after every 5s of client-audio
  starvation: sessions stay alive through long mutes and full text-mode
  conversations (silence carries no user signal, never trips VAD, negligible cost).
- **Typed messages can no longer vanish silently.** Send now fails loudly when
  the socket is down (draft is kept in the box + error status) and the bubble
  renders immediately client-side (dimmed until the server echo confirms it),
  instead of depending on the round-trip echo to appear at all.

### Added
- **Waiting-state feedback for weak networks** (owner report): after a typed
  send the status shows 已发出 ✓ 等待回复中…; a voice turn shows 已收到，等待回复中…
  as soon as the server registers it; if no reply starts within 12s the status
  escalates to 网络较慢，仍在等待回复…. Statuses clear on the first reply token.
- **Half-open connection detection**: the relay heartbeats `app.ping` every
  20s; the client watchdog force-closes a socket that has been silent for 45s
  so the auto-reconnect flow runs instead of the user talking into a dead link.

### Changed
- Documented the **follow-up convention** in both `SKILL.md` (server) and `client/SKILL.md` (mirrored to the client): always `followup list` before adding, and when new info is progress/a decision on the same topic as an existing entry, replace it (`followup remove` + add) instead of accumulating duplicates — one current follow-up per topic. Also surfaced `followup list/add/remove` in the server SKILL.md CLI examples (previously undocumented there). Docs-only.

## [0.22.4] - 2026-07-21

### Added
- Task-detail digest section (`本期汇总` / Cycle digest) is now collapsible via a chevron toggle on its title, matching the existing `任务背景` / `追问指引` cards. Defaults to expanded; the regenerate/instruction controls stay accessible when collapsed. Frontend-only change.

## [0.22.3] - 2026-07-21

### Added
- `member rename <id> <new-name>` CLI command (and `PUT /api/members/:id/name`) — renaming a member was previously impossible without a raw DB write. The name is display-only: talk links (keyed by token) and all history/reports (keyed by id) are unaffected. Names remain globally unique (colliding rename → 409 `duplicate_name`).

## [0.22.2] - 2026-07-21

### Fixed
- `client/SKILL.md` version was stuck at 0.19.6, which failed the `mirror-client` workflow's version-consistency gate on every release since v0.20.0 — so the portable client mirror (`zylos-ai/zylos-rounds-client`) had not updated in seven releases. Bumped it in lockstep and added it (plus `scripts/cli.js` `CLIENT_VERSION`) to the release checklist so the gate stays green. First release to actually mirror the `followup` client commands.

### Changed
- `client/SKILL.md`: documented the `followup` commands in the usage examples.

## [0.22.1] - 2026-07-21

### Removed
- The v0.21 back-compat aliases `/api/decisions` (GET/POST) and the `decision` CLI commands. A decision is a team-scoped follow-up — use `/api/followups` and the `followup` CLI. The one-time v12 migration that dissolves any `decision`-tagged knowledge into team follow-ups is unaffected.

## [0.22.0] - 2026-07-21

### Added
- Follow-ups: a free-text note appended to any task after a cycle, carried into the next cycle's probing/digest for the AI and recallable on demand. Admin UI panel on each task's detail page (list + compose + 「设为团队共享」 toggle); `/api/followups` endpoints + `followup` CLI commands. The v0.21 decision write-back dissolves into this — a decision is just a team-scoped follow-up.
- Per-task `audience` (internal / external) and per-follow-up `scope` (private / team) with query-enforced visibility: a task sees its own follow-ups; team-shared reach only internal tasks; an external task is walled off from the knowledge base and other tasks' data. The `search_team_knowledge` recall tool is now scope-aware.

### Changed
- `/api/decisions` + the `decision` CLI are retained as back-compat aliases (a team-scoped follow-up on the built-in daily task).

### Migration
- v12: `follow_up` table + `tasks.audience`; existing `decision`-tagged knowledge is migrated into team follow-ups on the built-in daily task.

## [0.21.0] - 2026-07-20

### Added
- **Decision writeback (决议回写)** — closes the loop between a 待议 item being
  raised and a decision being made about it. After the meeting, an agent records
  the decision via `decision add [--topic T] [--by NAME] <text>` (CLI) or
  `POST /api/decisions`; it is stored as a knowledge row tagged `decision`, so
  it is recallable for free via `search_team_knowledge`. Recently-settled
  decisions are then (a) injected into the **next cycle's probing context** for
  the built-in daily standup, so the agent knows what is already decided and
  doesn't re-probe settled items, and (b) fed into the **next daily digest** with
  an instruction to drop them from the 待议 agenda and note any follow-up under
  the detail sections instead. Without this, the next day's conversation and
  digest were built only from the prior day's raw reports and lost the meeting's
  outcome. New store helpers `addDecision` / `recentDecisions`; injection is
  scoped to the built-in daily task (that's where 待议 lives), non-daily tasks
  are unaffected.

## [0.20.3] - 2026-07-20

### Added
- **Digest and profile model calls now auto-retry transient failures** (up to 3
  attempts, short linear backoff). Proxy/network hiccups — TLS socket
  disconnects, resets, timeouts, 429/5xx — recovered on their own instead of
  surfacing as "汇总生成失败，请重试". 4xx errors (bad request / auth) still fail
  fast without retry. Opt-in per call site via a new `attempts` option on
  `callChatModel` (default 1 = unchanged); enabled for digest and profile, left
  at a single attempt for the settings provider connectivity test.

## [0.20.2] - 2026-07-20

### Changed
- **Default recurring digest: 待议 (For discussion) is now the single
  consolidated agenda.** Following v0.20.1's meeting-facing reorder, the top of
  the digest was still repeating the same hot items across 待议 / 卡点与风险 /
  依赖比对. Now the top half is just 总览 + 待议: 待议 merges everything that
  needs discussion/alignment/decision (member-raised topics + blockers needing
  multi-party alignment + dependency gaps needing alignment) into one
  de-duplicated list. 卡点与风险 and 依赖比对 move below the detail divider as
  supporting reference and only one-line anything already elevated into 待议,
  so no item is stated three times. Order: 总览 → 待议 → *divider* → 卡点与风险
  → 依赖比对 → 已完成 → 进行中 → 计划. (Owner ruling, 2026-07-20.)

## [0.20.1] - 2026-07-20

### Changed
- **Default recurring digest reordered to be meeting-facing.** The template now
  leads with the summary and the items to align on / decide, and pushes the
  work detail to the bottom for lookup. New section order: 总览 (Overview:
  submission rate, core workstreams, main risks, plus any non-submitters) →
  待议 (For discussion — the meeting agenda) → 卡点与风险 (Blockers & risks) →
  依赖比对 (Dependency check) → *detail divider* → 已完成 (Completed) → 进行中
  (In progress) → 计划 (Planned). Reading the top half is enough to run the
  daily meeting; the detail is there when someone needs to look it up. The
  not-submitted roster moves into 总览 (recurring) / stays at the end (oneshot),
  so the shared rules no longer pin it to the tail. (Owner ruling, 2026-07-20.)

### Fixed
- `CLIENT_VERSION` in the portable client CLI now tracks the package version
  (was left at 0.19.6 in the 0.20.0 bump).

## [0.20.0] - 2026-07-20

### Changed
- **Probing defaults re-layered so daily-specific probing no longer leaks into
  other tasks.** The global `probing_guidance` container applies to *every*
  task, so it now defaults to **empty** — teams append their own cross-task
  guidance only if they want it. The daily-standup-specific probing (confirm
  completion status, verify "almost done", chase blockers/owner, question plan
  changes, offer to escalate to the meeting) moves into a **code-level default
  probe carried by the built-in daily task itself** (bilingual zh/en). A team's
  custom `probe_instruction` on the daily task now **appends** on top of this
  code default (append, not override), so each team maintains only its own
  delta and future improvements to the default reach every install
  automatically. Non-daily communication tasks get no daily probing at all.
  (Owner ruling, 2026-07-20.)

## [0.19.6] - 2026-07-20

### Changed
- Task detail: the 追问指引 (probing guidance) card now collapses by default
  and renders markdown when expanded, matching the brief / question-frame
  cards. Its edit button stays available in the collapsed header.
- **Default probing guidance and recurring digest template improved** (merged
  from PR #1, by the coco avatar): the default probing guidance now asks the
  agent to confirm each item's completion status (done vs in-progress); the
  default recurring digest template splits Progress into Completed / In
  progress / Planned, adds a Dependency-check section (cross-references members
  for dependency gaps, deadline risks, and duplication), and folds those
  findings into For-discussion. These are the out-of-box defaults; teams with a
  custom digest instruction or brain probing guidance keep their own.

## [0.19.5] - 2026-07-20

### Changed
- **Daily report page reorganized for large rosters.** The cycle digest
  (本期汇总) now sits directly under the meeting-topics highlight, above the
  per-member cards, so the aggregate view is reachable without scrolling past
  everyone. Per-member cards collapse to a single line by default (name +
  blocker badge + duration) and expand on click, with an expand-all /
  collapse-all toggle. Empty blocker sections are hidden and surface only as a
  count badge when present. Page order is now: topics → digest → not-reported →
  member detail → member links.

## [0.19.4] - 2026-07-20

### Changed
- Task detail: the 任务背景 (brief) and 问题框架 (question frame) cards are now
  collapsed by default and expand on click — they are reference context, not
  the daily focus, so they no longer dominate the page. Content renders as
  markdown (headings, lists, bold) instead of raw pre-wrapped text.

## [0.19.3] - 2026-07-20

### Changed
- **Blockers vs meeting-topics semantics sharpened** (owner ruling): a blocker
  is a prerequisite dependency (who/what you're waiting on, solvable
  point-to-point); a meeting topic needs the team meeting (multi-party
  alignment, trade-offs, decisions). Encoded in the submit-tool field
  descriptions and the daily conversation flow, plus a bridging rule — the
  agent proactively offers to promote a multi-person/decision blocker into a
  meeting topic. Default probing guidance updated to match.
- UI labels annotated with the new semantics: day-view blockers section
  ("卡点 · 前置依赖"), meeting-topics card subtitle, talk-page section labels
  and subtitle (zh/en).

## [0.19.2] - 2026-07-20

### Fixed
- **UTF-8 corruption of multi-byte characters split across network chunk
  boundaries.** HTTP responses (LLM chat calls, model-list fetch) and request
  bodies were accumulated via per-chunk string concatenation, so a CJK
  character straddling a TCP chunk boundary decoded as U+FFFD replacement
  characters — observed in a member's dynamic profile ("链路" stored as
  "��路"). All three sites now accumulate raw bytes and decode once.
  Regression tests cover both the response and request paths.

## [0.19.1] - 2026-07-20

### Changed
- Muted-state button restyled from destructive red to the page's soft indigo
  accent (accent-soft fill, accent text, accent-line border) — reads as a
  toggled state coordinated with the talk UI instead of an alarm (owner
  feedback). Verified in light and dark themes.

## [0.19.0] - 2026-07-20

### Changed
- **Talk page: pause button replaced with a mic mute button** (owner request).
  Muting gates only the member's microphone — captured frames are dropped
  before send and any half-captured utterance is cleared upstream — while the
  agent keeps talking and captions keep flowing. Previously "pause" froze the
  whole conversation (cancelled the agent's response and flushed playback).
  Muted state is unmistakable (red button, mic-off icon, status line) and
  deliberately survives reconnects and text-mode round-trips: a network blip
  must never silently hot-mic the user. Waveform hides while muted since the
  mic feed is dropped.

## [0.18.1] - 2026-07-20

### Added
- **rounds-client is now an installable zylos component**: every release tag
  auto-mirrors `client/SKILL.md` + `scripts/cli.js` to
  [zylos-ai/zylos-rounds-client](https://github.com/zylos-ai/zylos-rounds-client)
  via GitHub Action (`mirror-client.yml`), so zylos users get versioned
  `zylos add rounds-client` / `zylos upgrade rounds-client` instead of a
  static curl copy. The mirror workflow refuses to run if package.json,
  cli.js or client/SKILL.md versions drift from the tag.
- `cli.js version` / `--version` prints the client version without a server
  call; help header shows it too.

## [0.18.0] - 2026-07-20

### Changed
- **Named DB keys are now the only bearer credentials** (owner's ruling: no
  legacy compatibility). `config.serviceToken` is no longer checked at auth
  time; a pre-v0.18 value migrates once into the DB as key `default` at
  startup (same plaintext keeps working) and is removed from config.json.
- First start mints a named `default` key (printed once) instead of a config
  serviceToken, and writes a same-host `cli.json` into the data dir so the
  local CLI stays zero-config.
- CLI credential resolution drops the `config.json` fallback tier (cli.json
  in `$ROUNDS_HOME` / `~/.rounds` / zylos data dir remains).

### Removed
- `DELETE /api/tokens/legacy`, `cli.js token revoke legacy`, the legacy row
  in the settings API Keys card, and the `legacy` field of `GET /api/tokens`
  (all introduced hours earlier in v0.17.0).

## [0.17.0] - 2026-07-20

### Added
- Named management API keys (`api_tokens` table, sha256 at rest): create /
  rotate / revoke per client instead of sharing one `serviceToken`. Plaintext
  is shown exactly once at mint time.
- Remote management: `cli.js token list|create|rotate|revoke` subcommands and
  `GET/POST /api/tokens`, `POST /api/tokens/:id/rotate`, `DELETE
  /api/tokens/:id`, `DELETE /api/tokens/legacy` endpoints — standard rotation
  needs no server access.
- Admin Settings page "API Keys" card: mint (one-time plaintext display with
  copy), rotate, revoke; doubles as the recovery path via password login.

### Changed
- `config.serviceToken` is now a legacy/bootstrap credential: still honored
  until revoked (`token revoke legacy`), minted on start only when no named
  key exists.

## [0.16.0] - 2026-07-20

### Added
- **Standalone deployment.** The server now runs on any machine without
  zylos: `ROUNDS_HOME` selects the data directory (default unchanged:
  `~/zylos/components/rounds`), `ROUNDS_BIND`/`config.host` selects the
  bind address (default unchanged: `127.0.0.1`), and an empty data dir
  self-provisions on first start — the admin password and service token
  are generated and printed once. Ships a `Dockerfile`,
  `docker-compose.yml` and a full deployment guide
  (`docs/deploy-standalone.md`: Docker, bare metal + systemd, reverse
  proxy/TLS).
- **Portable client package (`client/SKILL.md`).** The zero-dependency
  `scripts/cli.js` plus a client-oriented SKILL.md install into any agent
  runtime (Claude Code, Codex, bare terminal) with two `curl` commands —
  no zylos required. Credentials live in `~/.rounds/cli.json` (mode 600).

### Changed
- `cli.js` credential resolution now searches `$ROUNDS_HOME` and
  `~/.rounds/` before the zylos component data dir (which remains as a
  fallback, so existing setups are unaffected).

## [0.15.1] - 2026-07-20

### Changed
- **View mode by default for background/profile and brain cards.** The
  member background & profile dialog and the three Brain-page guidance
  cards now open in a read view (Markdown-rendered, "not set" hint when
  empty) with an explicit Edit action; textareas only appear while
  editing. The member dialog still opens straight into edit when both
  fields are empty.

## [0.15.0] - 2026-07-19

### Changed
- **Member profiles are now synthesized portraits, not event logs.** The
  profile prompt no longer produces dated "- [YYYY-MM-DD] entry" lines;
  profiles are organized by dimension (角色与职责 / 工作主线 / 关注点与诉求 /
  卡点模式 / 风格与习惯), folding new information into existing wording.
  Only Current-workstreams lines carry a last-confirmed date; other
  dimensions hold distilled stable traits.

### Added
- **Custom profile instruction (global).** New `profile_instruction`
  agent-context key — editable on the Brain page and via
  `cli.js brain set profile-instruction` — fully replaces the built-in
  profile template for all members when set.
- **Digest instruction editable on existing tasks.** The digest card now has
  an edit affordance (previously create-form only), so any task — including
  the built-in daily standup — can set or change its per-task custom digest
  instruction from the detail page.

## [0.14.1] - 2026-07-19

### Changed
- **Digest cards render Markdown.** Digest text was shown as raw
  preformatted text; a lightweight built-in renderer (headings, lists,
  bold, inline code — no raw-HTML pass-through) now formats it.
- **Recurring digest template rewritten to be workstream-centric.** The
  per-cycle digest no longer lists members one by one; content is grouped
  by workstream (进展 / 卡点与风险 / 待议), merging all members' input per
  item with names only as inline attribution, and the model is told not to
  emit a top-level `#` heading. One-shot and custom digest instructions
  are unchanged.

## [0.14.0] - 2026-07-19

### Added
- **Manual digest for the built-in daily standup.** The daily task detail
  page now has the same cycle-digest card as other tasks (生成汇总 /
  重新生成汇总); the generator adapts the day's structured reports
  (yesterday/today/blockers/topics) plus the not-yet-reported roster into
  the recurring digest template. Works for past days via the cycle picker.

## [0.13.0] - 2026-07-19

### Changed
- **Rounds no longer reads the shared `~/zylos/.env`.** Provider API keys
  live exclusively in the settings DB (settings page or provider API); the
  built-in OpenAI provider's special env-key override is removed. A legacy
  `OPENAI_API_KEY` in the process environment is migrated into the builtin
  provider's DB row once at first start, then ignored.
- Outbound proxy is now configured via config.json `proxy` (app data dir),
  falling back to `HTTPS_PROXY`/`HTTP_PROXY` from the process environment.
- Settings page: removed the "key from .env" provider badge (the state no
  longer exists).

## [0.12.0] - 2026-07-19

### Added
- **Multi-language support (zh/en).** Language now flows through every
  surface:
  - **Per-member language** (`members.language`, migration 10; NULL = team
    default): drives the member's talk-page UI, the agent's spoken language
    (full English instruction/tool-description set mirroring the
    battle-tested Chinese one — anti-hallucination, submit-timing and
    continuation rules included), the ASR sidecar language, the Gemini
    adapter's kick strings, and the member's dynamic-profile language.
    Set via admin members page selector, `PUT /api/members/:id/language`,
    or `cli.js member add --language` / `member set-language`.
  - **Team default language** (settings key `language`, default zh; config
    fallback `config.language`): fallback for members without their own
    setting, and the language of owner-facing digest prompts/reports.
    Set via settings page, `PUT /api/settings {language}`, or
    `cli.js settings set --language`.
  - **Admin SPA viewer language**: 中/EN toggle in the header
    (localStorage-persisted, browser-language default) — independent of
    team/member languages; all admin pages fully bilingual.
  - `GET /api/talk/session` now returns the member's resolved `language`;
    `GET /api/members` returns `language` + `language_effective`.

## [0.11.3] - 2026-07-19

### Fixed
- **Brand:** 大脑 page team-background placeholder still said COCO — now
  OpenMax (repo-wide sweep found no other user-facing occurrence)

## [0.11.2] - 2026-07-19

### Changed
- **Mobile bottom tab bar.** Five nav entries outgrew the top bar on phones
  (tabs truncated into horizontal scroll). On small screens the entries now
  live in a fixed bottom tab bar (icon + label, active in accent, safe-area
  inset padding) — the standard five-slot mobile pattern; the top bar keeps
  logo + logout. Desktop navigation unchanged

## [0.11.1] - 2026-07-19

### Changed
- **用量与成本 promoted to its own nav page.** Cost is something the owner
  checks, not configures — buried at the bottom of a five-card settings page
  it was hard to reach. New 用量 tab (任务/成员/大脑/用量/设置) with the
  month rollup as a full page; the settings page returns to pure
  configuration. Mobile-adapted: single-line table headers, truncated model
  ids with the slot label kept visible, 用途 column folded into the model
  cell on small screens, no page-level horizontal scroll

## [0.11.0] - 2026-07-19

### Added
- **Built-in usage & cost tracking.** Every voice session and every
  profile/digest text call now records its real API-reported token usage
  (text/audio/cached in and out, plus ASR sidecar seconds on the OpenAI
  path) into a new `usage_log` table, with a cost computed from a built-in
  price table verified against the official OpenAI/Google pricing pages.
  Gemini per-turn `usageMetadata` accumulation was verified against a live
  probe (per-turn semantics, not cumulative). New `GET /api/usage?month=`
  rollup (by day / model / member) and a 用量与成本 settings card with month
  navigation. Prices can be overridden without a code change via the
  settings-DB `prices` JSON (merged per model over
  `src/lib/pricing.js` defaults). Accounting is best-effort by design —
  a tracking failure never breaks a call or session close

## [0.10.6] - 2026-07-19

### Changed
- **Per-model voice previews.** The same Gemini voice name sounds completely
  different across Live models, so pre-generated samples now live in
  per-model directories (`assets/voice-samples/<model>/<Voice>.wav`) with the
  flat file as fallback (OpenAI voices stay flat). The admin picker passes
  the model currently selected in the card
  (`GET /api/settings/voice-sample/<voice>?model=…`), so previews always
  match what saving would actually sound like. Ships a full 8-voice Chinese
  sample set generated with `gemini-3.1-flash-live-preview` alongside the
  existing 12-2025 set; `scripts/generate-gemini-voice-samples.mjs` takes the
  model id as an argument

## [0.10.5] - 2026-07-19

### Fixed
- **Continuation sessions re-ran the scripted opening.** Reopening a finished
  (or interrupted) conversation replayed the fixed four-question flow instead
  of continuing naturally. Root cause was contradictory instructions: the
  scripted 流程 line stayed in the prompt and weaker models obey it over the
  later continuation block. The flow line is now replaced with a continuation
  flow (submitted → ask what to add; draft → resume where it stopped), and
  the greeting kick carries the same continuation framing
- **Gemini adapter:** an instructed first `response.create` now counts as the
  greeting — previously the first bare `response.create` after a tool result
  would fire the greeting kick mid-conversation

## [0.10.4] - 2026-07-19

### Added
- **Session-start wall-clock injection.** Instructions now open with the
  current date, weekday and a period-labelled time (凌晨/早上/上午/中午/下午/晚上)
  in the configured time zone, with an explicit rule to match greetings to
  the time of day — the model has no clock and greeted "早安" at any hour
- **Configurable time zone.** New settings-DB `time_zone` (admin UI card with
  IANA suggestions, `PUT /api/settings {time_zone}`, CLI `--time-zone`),
  layered DB > config.json > `Asia/Singapore` default and validated via Intl.
  Every timeZone consumer (session instructions, report dates, cycle keys,
  digests, profile dates) now resolves through it

### Fixed
- SKILL.md frontmatter version had fallen behind since 0.10.2 — realigned

## [0.10.3] - 2026-07-19

### Fixed
- **Text mode blocked phone-keyboard voice dictation.** Switching to text
  mode previously only gated the audio feed while keeping the capture track
  open, so mobile OSes considered the mic in use and disabled the IME's
  built-in speech-to-text. Text mode now fully releases the mic device
  (tracks stopped, graph node detached); switching back to voice re-acquires
  it into the persistent audio graph, resuming a suspended AudioContext and
  restarting the resample phase. A denied re-acquire keeps the session in
  text mode with a visible hint instead of a dead voice mode

## [0.10.2] - 2026-07-19

### Added
- **Gemini voice picker with previews.** The settings voice dropdown now
  follows the selected provider's protocol: a Gemini provider lists the
  Gemini prebuilt voices (Puck / Charon / Kore / Fenrir / Aoede / Leda /
  Orus / Zephyr) with pre-generated Chinese samples behind the existing 试听
  button (`scripts/generate-gemini-voice-samples.mjs`). Providers expose
  their wire `protocol` in the API; voice resolution falls back to the
  active protocol's default when the stored voice belongs to the other
  protocol, so switching providers never sends an unknown voice upstream

## [0.10.1] - 2026-07-19

### Fixed
- **Gemini VAD splitting Chinese sentences.** Automatic activity detection is
  now tuned (`END_SENSITIVITY_LOW`, 1200ms silence window, 300ms prefix
  padding) — default settings treated mid-sentence pauses as end-of-turn and
  the model answered each fragment
- **Slow user subtitles on Gemini.** Input transcription now streams
  progressively (each chunk updates the same slot) instead of appearing only
  when the model starts replying; late chunks merge into the same line until
  turnComplete, so one utterance is one bubble and one archive line
- **ASR quality: anti-alias filter.** A 15-tap windowed-sinc low-pass now
  runs before the 24k→16k decimation — bare linear interpolation folded
  8–12kHz content into the speech band and audibly degraded Gemini's
  transcription

## [0.10.0] - 2026-07-19

### Added
- **Gemini Live voice provider.** A provider whose base URL points at
  `generativelanguage.googleapis.com` now speaks Google's BidiGenerateContent
  protocol through a new upstream adapter (`src/lib/gemini-live.js`) that
  emulates the OpenAI Realtime surface — the relay, client, tools
  (submit/recall/knowledge), continuation, transcripts and text-mode gating
  all work unchanged. Audio input is resampled 24k→16k server-side
  (phase-continuous); input/output transcription is native (no ASR sidecar).
  Thinking is disabled (`thinkingBudget: 0`) — thinking plus tool calls in
  audio sessions trips a server-side `CONTENT_TYPE_AUDIO` close (observed on
  native-audio-preview-12-2025). Provider probes (`provider test/models`)
  are protocol-aware (`?key=` auth, `/v1beta/models`). Verified end-to-end:
  full 4-topic standup with probing, summary submission and goodbye on
  `gemini-2.5-flash-native-audio-preview-12-2025`. Known limits: mid-call
  voice/text switching is adapter-gated (subtitles keep streaming, audio is
  dropped in text mode); OpenAI voices don't map (Gemini default voice or
  `Kore` family via settings); `gemini-*-native-audio-latest` currently
  rejects tools+audio upstream — use the dated preview or
  `gemini-3.1-flash-live-preview`.

## [0.9.2] - 2026-07-19

### Added
- **Prominent report-date display on the talk page.** A colored date chip
  ("今天 7月19日 · 星期六", server-timezone authoritative) on the landing
  hero and the in-call header, so members always know which day they are
  reporting for
- **Continue-mode landing.** `/api/talk/session` now returns today's
  `date` and any existing `prior` record for this (task, member). When
  today's report is already submitted, the landing page shows the
  submitted summary card and switches to "继续补充" semantics — the
  conversation only starts when the member chooses to add more; an
  unsubmitted draft opens as "接着上次继续"

## [0.9.1] - 2026-07-19

### Fixed
- **Premature summary submission.** A hard submission gate in the agent
  instructions: submit only on an explicit end signal from the member
  (closing words or the end button) — never while the member is
  mid-answer, mid-correction, or has an unanswered question; when unsure,
  ask "还有要补充的吗？" first. The continuation overlay for
  already-submitted cycles now says an earlier submission is no license
  to wrap up early

## [0.9.0] - 2026-07-19

### Added
- **Text mode (文字模式).** Members in voice-unfriendly environments can
  switch to typing at any point in the call — a 文字/语音 toggle in the
  control row swaps the reply modality mid-session (`session.update`
  output_modalities), gates the mic feed, silences in-flight audio, and
  pins a composer (input + send) under the chat log. Replies stream back
  as text bubbles; typed messages render instantly (no ASR round-trip)
  and are archived in true order alongside spoken turns — one brain, one
  transcript, one summary across both modalities. A text-mode reconnect
  carries `mode=text` on the socket URL so the new session greets
  silently in text. The pause button hides in text mode (mic is already
  gated); switching back to voice restores it

## [0.8.3] - 2026-07-19

### Added
- **Pause / resume during a call.** A 暂停 button immediately silences Luna
  (cancels the in-flight reply, flushes playback, clears any half-spoken
  input) and stops the mic feed until 继续 is pressed; the orb dims and the
  waveform hides while paused. Mic capture stays alive so resume is instant

### Changed
- **Talk page control row redesign.** In-call controls now sit in one
  compact row under the orb — 暂停/继续 + 结束并提交 — in a single
  secondary-button family. During reconnection the row shows a disabled
  正在重连… button; after auto-retry gives up it shows 重新连接. The orb
  stays the page's visual anchor

## [0.8.2] - 2026-07-19

### Added
- **Auto-reconnect on the talk page.** An unexpected connection drop now
  retries automatically (3 attempts with backoff, spinner + "重连中" status,
  chat log retained); if all attempts fail a 重新连接 button appears. The
  mic and audio graph stay alive across reconnects
- **Same-cycle conversation continuation.** A new session whose cycle (day,
  for the daily standup) already has archived transcript — from a dropped
  connection, a page refresh, or a reopened finished call — feeds that
  transcript back to the agent, which greets with a brief "接着刚才的继续"
  and picks up where it left off instead of restarting the flow. If a
  summary was already submitted, the agent merges new content into a
  re-submit. Long transcripts inject only the most recent 4000 characters

## [0.8.1] - 2026-07-19

### Fixed
- **Talk page transcript ordering.** The user's speech transcription arrives
  asynchronously and routinely later than the agent's reply subtitle, which
  scrambled turn order both on screen and in the archived transcript. A slot
  is now reserved at the moment the user's turn is committed
  (`conversation.item.added`/`created`) — shown as a pending "…" bubble on
  the page — and the ASR result fills it in place; failed or empty
  transcriptions drop the slot. Archived transcripts keep true conversation
  order the same way
- **Talk page layout.** The in-call page is now a fixed single screen
  (`h-dvh` + `overflow-hidden`): the mic orb, waveform and end-call button
  stay put while the chat log below is the page's only scroll region,
  auto-scrolling to the latest message. Subtitles no longer push the page
  taller until the mic scrolls out of view; the submitted-summary card moved
  inside the scroll region

## [0.8.0] - 2026-07-19

### Added
- **Model provider framework (模型 Provider 框架).** Providers are now
  first-class entities: each holds a name, base URL, write-only API key and
  capability flags (Realtime voice / models listing), all accessed through
  the OpenAI-compatible protocol. The builtin "OpenAI 官方" provider replaces
  the old implicit global connection; an `OPENAI_API_KEY` in `.env` still
  overrides its key
- **Per-use-slot provider + model selection.** Voice conversation, profile
  updater (画像) and task digest (汇总) each pick a provider and model
  independently; the voice slot only accepts Realtime-capable providers.
  Unset slots fall back to the builtin — upgrading changes nothing
- **Model list refresh.** Providers supporting `/v1/models` get a one-click
  list refresh feeding the model input's suggestions; others take a free
  model name plus the connectivity test. The voice model whitelist is gone —
  the old three options remain as suggestions only
- **Settings page rework**: provider management card (add / edit / delete /
  connectivity probe; deleting a referenced or builtin provider is refused
  with the referencing slots named), voice and text model cards gain
  provider dropdowns and refresh buttons
- **API**: `GET/POST /api/providers`, `PUT/DELETE /api/providers/:slug`,
  `GET /api/providers/:slug/models`, `POST /api/providers/:slug/test`;
  `/api/settings` gains `{voice,profile,digest}_provider` (+`_effective`);
  `test-text-model` accepts a `provider` slug
- **CLI**: `provider list/add/set/remove/models/test`, plus
  `settings set --voice-provider/--profile-provider/--digest-provider`

### Changed
- DB migration v8: `providers` table seeded with the builtin; a legacy
  DB-stored OpenAI key migrates onto it (single source of truth)

## [0.7.3] - 2026-07-19

### Added
- **Configurable text models (文本模型) in Settings.** The profile updater
  (动态画像) and task digest (任务汇总) models are now configurable from the
  admin Settings page — free-text model name, per-field 测试 button (one
  minimal chat completion verifies the model answers), blank reverts to the
  default (digest follows the profile model when unset). Resolution layering
  matches model/voice: settings DB > config.json (`profileModel` /
  `digestModel`) > built-in default (`gpt-5.1`)
- **API**: `GET/PUT /api/settings` gains `profile_model` / `digest_model`
  (stored + `_default` / `_effective` views); new
  `POST /api/settings/test-text-model`
- **CLI**: `settings set --profile-model M --digest-model M` (`''` reverts)

## [0.7.2] - 2026-07-19

### Added
- **Member search on 成员管理.** Name filter (case-insensitive substring)
  next to the roster count; result count shown as "N / total 位成员",
  pagination follows the filtered set, empty-query state unchanged

## [0.7.1] - 2026-07-19

### Added
- **Per-task 追问指引 (probe instruction).** Optional free-text follow-up
  strategy on each task, layered on top of the global brain guidance in the
  voice-session instructions (`【本任务的追问指引】` section). Editable in the
  create form and via a dialog on the task detail page (works for the
  built-in daily task too), `probe_instruction` over the API, and
  `--probe-instruction` in the CLI. Migration v7

### Changed
- **成员管理 page layout.** The add-member entry moved to the top right of
  the roster; the list is paginated (10 per page) instead of growing
  unbounded; a member's task links collapse behind an "N 个任务链接" toggle
  when they hold more than two

## [0.7.0] - 2026-07-18

### Changed
- **Unified task model (统一任务模型).** Recurring is no longer hardcoded to
  the built-in daily report — any task can be recurring with a cadence of
  daily, weekly (pick a weekday), or every N days. The daily report remains a
  protected built-in recurring task (cannot be deleted, cadence fixed)
- **All links are now per-(task, member).** Permanent per-member links are
  abolished; the built-in daily report mints task links for every member on
  startup (idempotent). Old permanent tokens stop resolving — links must be
  re-distributed. Per-link reset via `POST
  /api/tasks/:id/members/:mid/reset-token` or `cli.js task reset-link`
- **Data is organized by cycle.** Conversations land in `cycle_records`
  keyed by the cycle the session started in; digests are per-cycle
  (`cycle_digests`) with a cycle switcher in the task detail UI. Cycle-end
  auto digest runs on a scheduler tick when the task's digest mode allows it
- **Admin SPA reorganized into 4 modules** — 任务 (home, absorbs 今日报告 +
  历史 into the built-in task's detail), 成员 (cross-task member entities
  with all their task links), 大脑, 设置. Legacy hashes `#/reports` and
  `#/report/:date` redirect into the daily task detail

### Added
- **Per-task digest instruction (汇总 instruction).** Free-text override of
  the default digest template, editable at creation and in task detail;
  digests are regenerated with the custom instruction and flagged in the UI
- **CLI cadence & cycle surface** — `task add --cadence daily|weekly|everyN
  --dow --every --anchor`, `--digest-instruction`, `task links`, `task
  cycles`, `task reset-link`, `digest --cycle`
- Migration v6 (cycle_records/cycle_digests, task_members token unification,
  legacy report backfill) with a data-migration test replaying v1→v5 schemas
  against real-shaped data

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
