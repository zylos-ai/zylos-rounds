---
name: standup
version: 0.1.0
description: >
  AI-assisted async daily standup tool. Use when ...
  (Include trigger patterns: what user requests should activate this component)
type: capability  # communication | capability | utility

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

# For HTTP services exposed through Zylos Caddy, prefer a root-internal app:
# - The component listens on localhost and serves internal routes at /.
# - Caddy exposes it at /standup/*, strips that prefix, and forwards
#   X-Forwarded-Prefix. Browser URLs should be relative by default and should
#   use X-Forwarded-Prefix when present.
# http_routes:
#   - path: /standup/*
#     type: reverse_proxy
#     target: localhost:3000
#     strip_prefix: /standup

upgrade:
  repo: zylos-ai/zylos-standup
  branch: main

config:
  required:
    # Values are collected by zylos and passed to lifecycle.hooks.configure as stdin JSON.
    # The configure hook decides how to store them in config.json.
    # - name: STANDUP_API_KEY
    #   description: API key for standup
    #   sensitive: true
  optional:
    # - name: STANDUP_DEBUG
    #   description: Enable debug mode
    #   default: "false"

dependencies: []
---

# Standup

```bash
# Example usage commands here
```

Run `node ~/zylos/.claude/skills/standup/scripts/<script>.js --help` for all options.
