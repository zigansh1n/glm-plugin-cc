# glm-plugin-cc

> **DashScope fork.** Uses Alibaba Model Studio (DashScope) when a DashScope key is set
> (`DASHSCOPE_API_KEY` or `~/.config/dashscope/api-key`), endpoint
> `https://dashscope.aliyuncs.com/apps/anthropic`; falls back to z.ai otherwise.
> `GLM_ANTHROPIC_BASE_URL` overrides the endpoint for other regions. Claude Desktop host
> variables are stripped from the child `claude -p` env. Install:
> `/plugin marketplace add zigansh1n/glm-plugin-cc`, then `/plugin install glm@glm-dashscope`.


> Use [GLM-5.3](https://z.ai/model-api) (z.ai) from inside [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using GLM-5.3 from the workflow they already have — without leaving Claude Code, and without pointing their primary Claude session away from Anthropic.

`glm-plugin-cc` is **directly inspired by** [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), which lets Claude Code delegate to OpenAI Codex. This plugin does the same thing, but delegates to GLM-5.3 via z.ai's Anthropic-compatible endpoint. The command surface (`review`, `adversarial-review`, `rescue`, `transfer`, `status`, `result`, `cancel`, `setup`), the review-gate hook, and the plugin layout all mirror the original. See [Credit & inspiration](#credit--inspiration).

## What you get

| Command | What it does |
|---|---|
| `/glm:review` | Read-only, non-destructive code-quality review of local git state. |
| `/glm:adversarial-review` | Steerable, skeptical design review that challenges the approach, tradeoffs, auth, and reliability. |
| `/glm:rescue` | Delegate active debugging, multi-file refactors, or implementation loops to GLM with full edit/test permissions. |
| `/glm:transfer` | Hand the current Claude Code session off to a resumable GLM thread. |
| `/glm:status` | Check the status of a GLM job (or list recent jobs). |
| `/glm:result` | Fetch the final result of a GLM job, including the resumable session id. |
| `/glm:cancel` | Abort a running GLM job. |
| `/glm:setup` | Check readiness and toggle the review gate. |

You also get the `glm:glm-rescue` subagent in `/agents`, the `glm-5-2-prompting` skill, and an optional Stop-hook review gate.

## Requirements

- A **z.ai GLM Coding Plan** (recommended) **or** a **z.ai API key**. Usage counts against your plan or key balance.
- **Node.js 18.18 or later.**
- The **`claude` CLI** installed and logged in normally. This plugin reuses that same binary, run headless, redirected at z.ai. (If you can run `claude` today, you're already set.)

## Auth setup

GLM needs a z.ai API key. Provide it via **one** of:

- an environment variable:

  ```sh
  export ZAI_API_KEY=...
  ```

  (`ZA_API_KEY` is also accepted as a fallback), **or**

- a key file:

  ```sh
  mkdir -p ~/.config/zai && echo -n 'YOUR_KEY' > ~/.config/zai/api-key
  chmod 600 ~/.config/zai/api-key
  ```

Then run `/glm:setup` to confirm the key and `claude` binary are detected.

## Install

```text
/plugin marketplace add radityasurya/glm-plugin-cc
/plugin install glm@radityasurya-glm
/reload-plugins
/glm:setup
```

`/glm:setup` prints whether the key and `claude` binary were found, and offers a small readiness probe. If the plugin isn't picking up your key, re-export the env var in the shell that launched Claude Code, or write the key file.

A simple first run:

```text
/glm:review --background
/glm:status
/glm:result
```

## How it works

`glm-plugin-cc` does **not** call the z.ai HTTP API itself. Instead, the broker (`glm-broker.mjs`) spawns a **headless `claude -p` subprocess** whose environment is redirected to z.ai's Anthropic-compatible endpoint:

| Variable | Value |
|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.z.ai/api/anthropic` |
| `ANTHROPIC_AUTH_TOKEN` | your z.ai key |
| `ANTHROPIC_MODEL` | `glm-5.3` |
| `ANTHROPIC_SMALL_FAST_MODEL` | `glm-5.3` (prevents a Claude-side haiku fallback) |
| `ANTHROPIC_API_KEY` | cleared (so the auth token wins) |

Because z.ai speaks the **Anthropic Messages** wire protocol, the headless `claude` loop — including tool use, file edits, and bash — works against GLM unchanged. Your primary Claude session keeps running against Anthropic; only the delegated subprocess talks to z.ai.

- Reviews run in **plan mode** (read-only: Read, Grep, Glob, non-mutating Bash).
- `/glm:rescue` runs with **full permissions** so GLM can edit, run tests, and run lint.

For the full design, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Usage

### `/glm:review`

A normal, read-only GLM review of your current work — the same kind of review you'd get by asking GLM directly.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text — use `/glm:adversarial-review` when you want to challenge a specific decision.

Examples:

```text
/glm:review
/glm:review --base main
/glm:review --background
```

This command is read-only and will not change anything. When run in the background, use `/glm:status` to check progress and `/glm:cancel` to abort.

### `/glm:adversarial-review`

A **steerable** review that questions the chosen implementation and design.

Use it when you want:

- a pre-ship review that challenges the direction, not just the code details
- focus on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing of specific risk areas like auth, data loss, rollback, race conditions, or reliability

Same target selection as `/glm:review` (including `--base <ref>`), plus `--wait` / `--background`. Unlike `/glm:review`, it takes extra focus text after the flags.

Examples:

```text
/glm:adversarial-review
/glm:adversarial-review --base main challenge whether this was the right caching and retry design
/glm:adversarial-review --background look for race conditions and question the chosen approach
```

Read-only. It does not fix code.

### `/glm:rescue`

Hands a task to GLM through the `glm:glm-rescue` subagent / broker.

Use it when you want GLM to:

- investigate a bug
- try a fix
- continue a previous GLM rescue task
- take a cheaper/faster pass

Supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit both `--resume` and `--fresh`, the broker continues the most recent finished rescue session for this repo, if it ran on the same model and finished in the last 6 hours. Otherwise it starts a fresh session.

Examples:

```text
/glm:rescue investigate why the tests started failing
/glm:rescue fix the failing test with the smallest safe patch
/glm:rescue --resume apply the top fix from the last run
/glm:rescue --background investigate the regression
```

Notes:

- `/glm:rescue` runs GLM with full file/bash permissions. It will edit your repo. Run it on a clean working tree or a branch you don't mind touching.
- Follow-up rescue requests continue the latest GLM rescue thread in the repo by default. A session that z.ai no longer has is replaced by a fresh one instead of failing the job.

### `/glm:transfer`

Creates a GLM session seeded from the current Claude Code transcript and prints a `/glm:rescue --resume <session-id>` command you can use to continue.

Use it when you started a conversation in Claude Code and want to keep going on GLM.

```text
/glm:transfer
/glm:transfer --source ~/.claude/projects/<proj>/<session>.jsonl
```

The SessionStart hook captures the current transcript path automatically; `--source` is a manual override. The source must be a Claude JSONL transcript.

### `/glm:status`

Shows running and recent GLM jobs for the current repo.

```text
/glm:status
/glm:status glm-<id>
```

### `/glm:result`

Shows the final stored GLM output for a finished job. Includes the GLM session id so you can reopen that run with `/glm:rescue --resume <session-id>`.

```text
/glm:result
/glm:result glm-<id>
```

### `/glm:cancel`

Cancels an active background GLM job.

```text
/glm:cancel
/glm:cancel glm-<id>
```

### `/glm:setup`

Checks whether GLM is reachable and manages the optional review gate.

```text
/glm:setup
/glm:setup --check          # non-interactive readiness probe
/glm:setup --enable-review-gate
/glm:setup --disable-review-gate
```

## Typical flows

### Review before shipping

```text
/glm:review
```

### Hand a problem to GLM

```text
/glm:rescue investigate why the build is failing in CI
```

### Start something long-running

```text
/glm:adversarial-review --background
/glm:rescue --background investigate the flaky test
```

Then check in with:

```text
/glm:status
/glm:result
```

## Review gate

```text
/glm:setup --enable-review-gate
/glm:setup --disable-review-gate
```

When enabled, a **Stop hook** runs a targeted GLM review based on Claude's response. If that review finds blocking issues, the stop is denied so Claude can address them first.

> **Warning: feedback loops.** The review gate runs GLM at every stop. If GLM and Claude disagree, the session can iterate for many turns and rack up z.ai cost quickly. It's off by default. Enable it only when you plan to actively watch the session. This mirrors the same warning on `codex-plugin-cc`'s review gate.

## GLM integration

The plugin talks to GLM via the `claude` binary you already have, redirected to z.ai. Configuration is resolved in this order:

1. `~/.glm-plugin/settings.json` (plugin-managed)
2. z.ai key from `ZAI_API_KEY` / `ZA_API_KEY` env var or `~/.config/zai/api-key`
3. `--model <id>` flag per command (default `glm-5.3`)

### Common configurations

To change the default model, set it via the `--model` flag, or edit `~/.glm-plugin/settings.json`. To change where the plugin looks for the key, set `ZAI_API_KEY` in the shell that launches Claude Code.

### Moving the work over to GLM

Delegated tasks and any review-gate run can be resumed directly on GLM by passing the session id you got from `/glm:result` or `/glm:status` to `/glm:rescue --resume <session-id>`.

## Config reference

| Setting | Default | Where |
|---|---|---|
| Model | `glm-5.3` | per-call `--model`, or `~/.glm-plugin/settings.json` |
| z.ai endpoint | `https://api.z.ai/api/anthropic` | hardcoded (Anthropic Messages protocol) |
| Job state | `~/.glm-plugin/jobs/` | JSON per job + stream JSONL |
| Settings | `~/.glm-plugin/settings.json` | review gate toggle, etc. |
| Transcript capture | `~/.glm-plugin/state/current-transcript.json` | written by SessionStart hook |

## Troubleshooting

- **`No z.ai API key found`** — set `ZAI_API_KEY` in the shell that *launches* Claude Code, or write `~/.config/zai/api-key`. Re-run `/glm:setup`.
- **Reviews come back empty** — make sure you have uncommitted changes (`git status`) or pass `--base <ref>` for a branch diff. Untracked files are included.
- **`claude exited 1`** — usually means the headless subprocess couldn't reach z.ai. Run `/glm:setup --check` and confirm your key is valid at `z.ai/manage-apikey/apikey-list`.
- **Background job shows `(not responding)`** — the detached worker crashed. Run the same task with `--wait` to see the error inline.
- **Review gate won't stop arguing** — disable it with `/glm:setup --disable-review-gate`.

## FAQ

### Do I need a separate account?
No — if you already have a z.ai API key or GLM Coding Plan, that's all you need. This plugin uses your key directly.

### Does the plugin use a separate runtime?
No. It delegates through your local `claude` CLI, run headless against z.ai. Same install, same machine, same repo checkout.

### Will it use my existing Claude login?
Your primary Claude session is untouched. The broker constructs a **separate environment** for the subprocess that points only at z.ai; it never touches your Anthropic credentials.

### Is this an official z.ai / Anthropic / OpenAI product?
No. `glm-plugin-cc` is an independent community plugin. GLM and z.ai are products of Z.ai. Claude Code is a product of Anthropic. Codex and `codex-plugin-cc` are products of OpenAI. This project is not endorsed by any of them.

### How is this different from just setting `ANTHROPIC_BASE_URL` to z.ai?
Setting `ANTHROPIC_BASE_URL` globally makes GLM your **primary** model — Claude itself runs on GLM. This plugin keeps Claude on Anthropic and uses GLM only for delegated work (reviews, rescues). You get two models in one session.

## Credit & inspiration

This project is closely modeled on [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) by OpenAI (Apache-2.0). The following were adapted directly:

- The command surface and file layout (`commands/`, `agents/`, `hooks/`, `prompts/`, `schemas/`, `skills/`).
- The two-tier review concept (`review` vs `adversarial-review`).
- The `rescue` / `transfer` / `status` / `result` / `cancel` delegation model.
- The Stop-hook review gate.

The core difference is the broker. `codex-plugin-cc` wraps the Codex CLI / Codex app-server (an OpenAI-built agent runtime). GLM ships no equivalent CLI, so `glm-plugin-cc`'s broker instead spawns the existing `claude` CLI, run headless, with its environment redirected to z.ai's Anthropic-compatible endpoint. z.ai speaking the Anthropic Messages protocol is what makes this work without a custom agent loop.

See [NOTICE](NOTICE) for attribution details.

## Development

```sh
pnpm install
pnpm test          # vitest, no network
pnpm run setup     # glm-broker.mjs setup --check
```

Tests stub `spawn`/`spawnSync` and never hit the network. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
