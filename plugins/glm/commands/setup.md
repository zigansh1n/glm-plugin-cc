---
name: setup
description: Check GLM plugin readiness and toggle the stop-time review gate. Run after install to confirm the GLM key (DashScope or z.ai) and claude binary are available.
---

# /glm:setup

Verifies that the GLM API key (DashScope or z.ai) and `claude` CLI are present, prints the configured plugin directory, and optionally enables/disables the review gate.

## Usage

```
/glm:setup [--check] [--enable-review-gate] [--disable-review-gate]
```

- `--check` — readiness check only; do not exit non-zero if the key is missing.
- `--enable-review-gate` — install the Stop hook that has GLM review Claude's output before each stop.
- `--disable-review-gate` — remove the Stop review hook.

Behind the scenes this calls:

```
${CLAUDE_PLUGIN_ROOT}/scripts/glm-broker.mjs setup [--check|--enable-review-gate|--disable-review-gate]
```
