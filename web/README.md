# standup web frontend

Vite + React 18 + Tailwind + shadcn/ui (vendored components in `src/components/ui/`).

Two entries (multi-page build):

- `index.html` — admin SPA, served at the component root. Hash routing only
  (`#/` roster, `#/report/:date`, `#/reports`, `#/login`); all API calls use
  relative URLs, so it works behind any reverse-proxy prefix.
- `talk.html` — member talk page, served by the backend at `u/<token>`.
  Assets in this HTML are referenced with a `../` prefix (handled by
  `renderBuiltUrl` in `vite.config.js`) because the page sits one directory
  deeper than the asset root.

## Dev

Run the backend on `127.0.0.1:3478`, then:

```bash
npm install
npm run dev
```

- Admin SPA: http://localhost:5173/
- Talk page: http://localhost:5173/talk.html?token=<member-token>
  (in dev the token comes from the query string; in production it comes from
  the `u/<token>` path)

Vite proxies `/api` (HTTP) and `/ws` (WebSocket) to `127.0.0.1:3478`.

## Build

```bash
npm run build
```

Emits both entries into `../src/public/` (`emptyOutDir: true` — do not put
hand-written files there). The backend serves `src/public/index.html` at the
component root and `src/public/talk.html` for `u/:token` (after validating
the token; 404 page otherwise).

## Notes

- The talk-page audio pipeline (`src/talk/engine.js`) is a verbatim behavior
  port of the battle-tested MVP: device-native-rate capture, precise client
  downsample to 24k, playback scheduling, and `conversation.item.truncate`
  with real played milliseconds on barge-in. Do not simplify it.
- Design tokens live in `src/styles/globals.css` (light/dark via
  `prefers-color-scheme`, Tailwind `darkMode: 'media'`), ported from the
  approved MVP palette (indigo accent `#6366f1`).
- No external network resources at runtime: system font stack, all assets
  bundled, icons via lucide-react.
