---
description: Hand a task to GLM-5.3 (DashScope or z.ai) to investigate or fix
argument-hint: '[--wait|--background] [--resume|--fresh] [--model <m>] <task>'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(mktemp:*), Write
---

Hand a task to GLM-5.3 through the glm broker. GLM runs with full file/bash permissions and can edit the repo.

Raw slash-command arguments (the task text plus optional flags):
`$ARGUMENTS`

Parse the flags from `$ARGUMENTS`:
- `--wait` → foreground
- `--background` → run as a Claude background task
- `--resume` → continue the latest GLM rescue session for this repo and model (broker also auto-continues if neither `--resume` nor `--fresh` is given)
- `--fresh` → start a new session, do not continue
- `--model <m>` → override the model (default glm-5.3)
- Everything else is the task description.

Default mode: if neither `--wait` nor `--background` is given, prefer `--background` for non-trivial tasks (investigations, refactors, anything multi-file) and `--wait` for tiny lookups. When unsure, choose background.

Construct a clear task prompt. Include:
- The goal stated concretely.
- Any constraints (minimal patch, don't touch X, match existing style).
- A definition of done (e.g. "tests in X pass", "lint clean").
Write the prompt to a temp file: `PROMPT=$(mktemp)`.

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/glm-broker.mjs" run --kind rescue --prompt-file "$PROMPT" --wait [other flags]
```
Return stdout verbatim.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/glm-broker.mjs" run --kind rescue --prompt-file "$PROMPT" --background [other flags]`,
  description: "GLM rescue",
  run_in_background: true
})
```
Tell the user: "GLM rescue started in the background. Check `/glm:status`, then `/glm:result`. Use `/glm:rescue --resume` to continue the same thread."

To continue a prior rescue: pass `--resume`. When neither `--resume` nor `--fresh` is given, the broker continues the most recent finished rescue session automatically, but only one from this repo, on the same model, that finished in the last 6 hours. If z.ai no longer has that session, the job starts a fresh one.
