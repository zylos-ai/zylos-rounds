# Standalone Deployment

Rounds runs on any server — no zylos installation required. The zylos
component install (`zylos add rounds`) is unchanged; this page covers the
standalone path: a self-contained server plus lightweight remote clients.

```
agent machine(s)                         your server
┌──────────────────────┐   HTTPS   ┌──────────────────────────┐
│ rounds-client skill  │──────────▶│ reverse proxy (TLS)      │
│ (cli.js + cli.json)  │           │   └─▶ rounds :3478       │
└──────────────────────┘           │        └─ /data volume   │
      members' browsers ──────────▶│  (config, SQLite, logs)  │
                                   └──────────────────────────┘
```

## 1. Run the server

### Docker (recommended)

```bash
git clone https://github.com/zylos-ai/zylos-rounds.git && cd zylos-rounds
docker compose up -d --build
docker compose logs rounds     # note the FIRST-START admin password + service token
```

Data persists in `./data` (bind-mounted to `/data`). Image details: Node 22
alpine, `ROUNDS_HOME=/data`, `ROUNDS_BIND=0.0.0.0`, port 3478.

### Bare metal

Node.js >= 22.13 required (`node:sqlite`).

```bash
git clone https://github.com/zylos-ai/zylos-rounds.git && cd zylos-rounds
npm ci --omit=dev
ROUNDS_HOME=/var/lib/rounds ROUNDS_BIND=0.0.0.0 node src/index.js
```

Example systemd unit (`/etc/systemd/system/rounds.service`):

```ini
[Unit]
Description=Rounds voice standup server
After=network.target

[Service]
Environment=ROUNDS_HOME=/var/lib/rounds
Environment=ROUNDS_BIND=127.0.0.1
WorkingDirectory=/opt/zylos-rounds
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
User=rounds

[Service] note: keep ROUNDS_BIND=127.0.0.1 when a reverse proxy runs on the
same host; only bind 0.0.0.0 when the port itself must be reachable.

[Install]
WantedBy=multi-user.target
```

## 2. First start

The server provisions itself on an empty data directory and prints once:

- **admin password** — for the web admin UI (`FIRST-START admin password`);
  rotate by writing a new plaintext value to `auth.password` in
  `config.json` (it is re-hashed on restart)
- **service token** — bearer key for the management API and remote clients
  (`FIRST-START service token`, persisted as `serviceToken` in config.json).
  v0.17+: this is the bootstrap credential — once running, mint *named* keys
  per client and rotate/revoke them without touching the server (see
  "API key management" below)

Then open the admin UI, set a provider API key in Settings (keys are stored
in the DB, never in files), and add members.

## 3. Reverse proxy + TLS

Members talk to the agent over WebRTC-less WebSocket audio — browsers
require HTTPS (and WSS) for microphone access, so a TLS-terminating reverse
proxy in front of port 3478 is effectively mandatory. WebSocket upgrade must
be forwarded.

Caddy (automatic TLS):

```
rounds.example.com {
    reverse_proxy 127.0.0.1:3478
}
```

Sub-path mounting works too (the app is prefix-agnostic and reads
`X-Forwarded-*`):

```
example.com {
    handle_path /rounds/* {
        reverse_proxy 127.0.0.1:3478
    }
}
```

nginx equivalent:

```nginx
location / {
    proxy_pass http://127.0.0.1:3478;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

If member links show the wrong origin, set `publicOrigin` in `config.json`
(e.g. `https://rounds.example.com`).

## 4. Outbound proxy (optional)

If the server needs a proxy to reach OpenAI/Gemini, set `proxy` in
`config.json` (e.g. `http://127.0.0.1:7890`) or the `HTTPS_PROXY`
environment variable. Docker compose has a commented example.

## 5. Connect agents (rounds-client)

Any agent runtime on any machine manages the server through the portable
client skill — a single-file, zero-dependency CLI. Install and setup:
[client/SKILL.md](../client/SKILL.md). Credentials go in `~/.rounds/cli.json`
(`{"url": ..., "apiKey": <key>}`, mode 600).

## 6. API key management (v0.17+)

Named bearer keys live in the DB (sha256 at rest; plaintext shown exactly
once at mint time) and can be managed remotely — no server access needed:

```bash
cli.js token list             # names + created/last-used; flags the legacy config key
cli.js token create ci        # mint a key per client — plaintext in the response, once
cli.js token rotate 2         # new secret, same key row; old plaintext dies immediately
cli.js token revoke 2         # revoke one client
cli.js token revoke legacy    # kill the shared config.serviceToken
```

The same operations are on the admin Settings page (API Keys card), which
also serves as the recovery path: if every key is lost, log in with the
admin password and mint a new one. Standard rotation: `token create` a new
key → move the client's `cli.json` to it → `token revoke` the old one.
If literally all bearer keys are revoked, a restart re-mints a bootstrap
`serviceToken` (printed once) — same as first start.

## Configuration reference

| Setting | Where | Default | Notes |
|---------|-------|---------|-------|
| Data directory | `ROUNDS_HOME` env | `~/zylos/components/rounds` | config.json, SQLite DB, logs |
| Bind address | `ROUNDS_BIND` env or `host` in config.json | `127.0.0.1` | `0.0.0.0` inside Docker |
| Port | `port` in config.json | `3478` | |
| Public origin | `publicOrigin` in config.json | derived from `X-Forwarded-*` | member-link base URL |
| Outbound proxy | `proxy` in config.json / `HTTPS_PROXY` env | none | for provider APIs |
| Admin password | `auth.password` in config.json | generated on first start | plaintext is auto-hashed |
| Service token | `serviceToken` in config.json | generated on first start | bootstrap bearer key; prefer named keys (`token create`) once running |
| Provider API keys | admin Settings page | — | stored in the DB only |
