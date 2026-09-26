---
name: glm-5-2-prompting
description: Guidance for prompting GLM-5.3 effectively when delegating review, rescue, or adversarial-review work via the glm plugin. Use when constructing prompts sent to GLM through glm-broker.mjs.
---

# Prompting GLM-5.3 via the glm Plugin

Use this skill when constructing prompts that the `glm` plugin forwards to GLM-5.3 through `glm-broker.mjs`. GLM is reached via headless `claude -p` pointed at `https://api.z.ai/api/anthropic`, so it inherits Claude Code's tool-calling format (Anthropic Messages API). Prompts that work well with Claude's tool format generally work with GLM; the notes below cover GLM-5.3-specific behavior.

## Model Identity

- **Model**: GLM-5.3, Z.ai's coding model.
- **Endpoint**: DashScope `https://dashscope.aliyuncs.com/apps/anthropic` when a DashScope key is configured, otherwise z.ai `https://api.z.ai/api/anthropic` (both Anthropic Messages compatible).
- **Access path**: invoked through the headless `claude` subprocess, so tool calls are formatted as Anthropic `tool_use` blocks. GLM emits these correctly.
- **Context window**: up to ~1M input tokens.
- **Output window**: ~32k tokens (verify current cap before relying on it for very long generations).
- **Tool support**: Read, Grep, Glob, Bash, Edit all work. For read-only review the broker runs in plan mode (no edits). For rescue it runs with full permissions.

## reasoning_effort

`reasoning_effort` (`none|minimal|low|medium|high`) is a GLM-side concept controlling how much internal reasoning the model does before answering. Because we delegate through the `claude` subprocess rather than calling the z.ai API directly, reasoning depth is governed by the model's own defaults unless config explicitly sets it. Treat reasoning as a GLM concept: do not assume the subprocess exposes it as a flag. If a task needs deeper reasoning, say so in the prompt itself ("think step by step before answering") rather than relying on a parameter.

## Prompting Best Practices

- **Be explicit and structured.** GLM follows numbered, step-by-step instructions well. Prefer "1. Read the diff. 2. List findings. 3. Return JSON." over prose.
- **For code review**: inline the diff, name the scope, and ask for JSON matching the review-output schema (`verdict`, `summary`, `findings[]`). See `references/review-prompt-template.md`.
- **For rescue tasks**: state the goal, constraints, and a concrete definition of done. GLM performs materially better with an explicit success criterion. See `references/rescue-prompt-template.md`.
- **Prefer concrete over vague.** "Fix the off-by-one in the loop at `foo.rs:42`" beats "fix the bug." Include file paths and line numbers.
- **GLM tends to be thorough.** If you want concise output, say so: "respond in under 200 words" or "list at most 5 findings."
- **When asking for JSON**: show the exact schema and say "respond ONLY with JSON, no prose."
- **Long context is fine.** GLM-5.3 handles large inputs well, so don't over-truncate diffs. But avoid dumping unrelated files — relevance still matters for quality.

## Tool Use

GLM emits Anthropic-style `tool_use` blocks correctly. It works well with the standard Claude Code tool set. Behavior by mode:

- **Review / adversarial-review**: plan mode, read-only. GLM can Read/Grep/Glob/Bash(non-mutating) but cannot Edit.
- **Rescue**: full permissions. GLM can Edit, run tests, run lint.

## Known Quirks / Things to Avoid

- **No Claude-specific features.** Don't ask GLM for artifacts, computer use, or MCP tools that aren't in its tool set — it won't implement them.
- **Thinking blocks are advisory.** GLM may emit thinking/reasoning blocks; treat them as advisory context, not as a contract. Signatures and format may differ from Claude's.
- **No `cache_control` assumptions.** Prompt caching is handled server-side at z.ai; don't rely on `cache_control` breakpoints carrying over.
- **Cost awareness.** Each delegated call is billed against the z.ai GLM Coding Plan. Batch related questions when possible, and prefer foreground for small reviews to avoid paying background-job overhead.

## Effort / Cost Guidance

| Workload | Mode |
|---|---|
| Small single-file review, quick lint pass | foreground (`--wait`) |
| Multi-file review, investigation, adversarial review | background |
| Long refactor, multi-step fix loop | `rescue --background` |

Foreground is cheaper and lower-latency for small jobs; background avoids blocking the main session for long-running work.
