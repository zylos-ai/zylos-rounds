<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-standup</h1>

<p align="center">
  Voice daily standup — team members talk to an AI agent, the team gets a structured daily digest
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

---

- **Voice-first reporting** — each member gets a permanent personal link and
  talks to the agent for 3–5 minutes (昨天 / 今天 / 卡点 / 日会待议); no
  account, no forms
- **Structured + verbatim** — reports are stored as structured summaries
  (via realtime function calling) with the full conversation transcript kept
  alongside
- **Team digest** — per-day digest puts suggested meeting topics first, then
  per-member cards and who hasn't reported; multi-day history included
- **Self-hosted relay** — browser ↔ server ↔ OpenAI Realtime (works behind a
  proxy); device-adaptive audio capture that survives mobile browsers
- **Admin auth** — scrypt-hashed password (generated at install), session
  cookies, login rate limiting

## Install

```bash
zylos add standup
```

The generated admin password is printed once during install.

## Configuration

`~/zylos/components/standup/config.json` (see [SKILL.md](./SKILL.md) for all
keys):

```json
{
  "enabled": true,
  "port": 3478,
  "model": "gpt-realtime-2.1",
  "voice": "marin",
  "auth": { "enabled": true, "password": "<scrypt hash>" }
}
```

`OPENAI_API_KEY` (and optional `HTTPS_PROXY`) are read from `~/zylos/.env`.

## Usage

| URL | Who |
|-----|-----|
| `https://<host>/standup/` | admin — roster, add/remove members, copy links |
| `https://<host>/standup/#/report/2026-07-17` | admin — daily digest |
| `https://<host>/standup/u/<token>` | member — voice conversation |

## Development

Backend: `npm test` / `npm run check`. Frontend lives in `web/` (Vite + React
+ Tailwind + shadcn/ui) and builds into `src/public/` (committed). See
[CLAUDE.md](./CLAUDE.md) for architecture and the relay invariants.

## Design Notes

Project design docs live in [docs/project/](./docs/project/).

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
