#!/usr/bin/env node
// glm-broker.mjs — bridges Claude Code to GLM-5.3 via headless `claude -p` pointed at z.ai.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildZaiEnv,
  resolveApiKey,
  resolveProvider,
  isReady,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  readSettings,
  writeSettings,
  PLUGIN_DIR,
} from "./config.mjs";
import {
  createJob,
  getJob,
  listJobs,
  updateJob,
  appendStream,
  ensureDirs,
  jobPath,
  jobStreamPath,
  isJobProcessAlive,
  killTree,
} from "./state.mjs";

// Auto-resume only continues a session that finished within this window. z.ai expires
// sessions; a resumed id it no longer knows is retried as a fresh session (runWorker).
export const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// How `claude -p --resume` reports a session id the backend no longer has.
const STALE_SESSION = /No conversation found with session ID/i;

// ---------- helpers ----------

function parseArgs(argv) {
  const out = { _: [], flags: {}, values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        out.values[k] = v;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) out.flags[key] = true;
        else {
          out.values[key] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function findClaude() {
  const r = spawnSync("which", ["claude"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  return "claude";
}

// Run headless claude against z.ai. Returns { result, sessionId, costUsd, raw }.
// onEvent(optional) called per parsed stream-json line; onSpawn(optional) gets the claude pid.
export function runClaude({
  prompt,
  model = DEFAULT_MODEL,
  resume,
  sessionId,
  readWrite = false,
  onEvent,
  onSpawn,
  cwd,
}) {
  const env = buildZaiEnv(model);
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (resume) args.push("--resume", resume);
  // Note: do not pass --session-id for fresh runs; claude requires UUID format and
  // mints its own. We capture the generated id from the stream result instead.
  if (readWrite) args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "plan");

  return new Promise((resolve, reject) => {
    const proc = spawn(findClaude(), args, {
      env,
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (onSpawn && proc.pid) onSpawn(proc.pid);
    let buf = "";
    let lastResult = null;
    const events = [];

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          events.push(evt);
          if (onEvent) onEvent(evt);
          if (evt.type === "result") lastResult = evt;
        } catch {
          // non-json line, ignore
        }
      }
    });

    let errBuf = "";
    proc.stderr.on("data", (c) => {
      errBuf += c.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (lastResult) {
        resolve({
          result: lastResult.result,
          sessionId: lastResult.session_id || sessionId || null,
          costUsd: lastResult.total_cost_usd ?? null,
          isError: lastResult.is_error || false,
          raw: lastResult,
          events,
        });
      } else if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${errBuf.trim() || "no result"}`));
      } else {
        resolve({
          result: "",
          sessionId: sessionId || null,
          costUsd: null,
          isError: false,
          raw: null,
          events,
        });
      }
    });
  });
}

// A cancelled job stays cancelled: cmdCancel marks it before stopping the processes,
// and the dying worker must not overwrite that with "failed".
function finishJob(jobId, patch) {
  if (getJob(jobId)?.status === "cancelled") return;
  updateJob(jobId, { ...patch, finishedAt: Date.now() });
}

// True when a thrown message or a result event reports an unknown --resume id. claude
// returns it as an error_during_execution result with the text in `errors`.
export const isStaleSession = (x) => STALE_SESSION.test(typeof x === "string" ? x : JSON.stringify(x ?? ""));

// Worker: runs a job inline (used by both --wait and detached background worker).
async function runWorker(jobId, promptFile, opts) {
  const prompt = readFileSync(promptFile, "utf8");
  let childPid = null;

  // Killing the worker itself (Ctrl-C on --wait, or a plain `kill`) must not leave
  // claude and the shells it started running on their own.
  const stop = (code) => () => {
    killTree([childPid], { graceMs: 2000 }).finally(() => process.exit(code));
  };
  process.once("SIGTERM", stop(143));
  process.once("SIGINT", stop(130));

  const onEvent = (evt) => {
    try {
      appendStream(jobId, JSON.stringify(evt));
    } catch {
      /* ignore stream errors */
    }
    if (evt.type === "result" && evt.session_id) {
      updateJob(jobId, { sessionId: evt.session_id });
    }
  };
  const onSpawn = (pid) => {
    childPid = pid;
    updateJob(jobId, { childPid: pid });
  };
  const run = (resume) =>
    runClaude({
      prompt,
      model: opts.model,
      resume,
      sessionId: opts.sessionId,
      readWrite: opts.readWrite,
      onEvent,
      onSpawn,
      cwd: opts.cwd,
    });

  try {
    let res = null;
    try {
      res = await run(opts.resume);
    } catch (err) {
      if (!opts.resume || !isStaleSession(err.message)) throw err;
    }
    if (opts.resume && (!res || (res.isError && isStaleSession(res.raw)))) {
      appendStream(
        jobId,
        JSON.stringify({
          type: "system",
          subtype: "glm-broker",
          message: `session ${opts.resume} no longer exists; starting a fresh session`,
        })
      );
      res = await run(undefined);
    }
    finishJob(jobId, {
      status: res.isError ? "failed" : "finished",
      result: res.result,
      sessionId: res.sessionId,
      costUsd: res.costUsd,
    });
    return res;
  } catch (err) {
    finishJob(jobId, { status: "failed", error: err.message });
    throw err;
  }
}

// ---------- commands ----------

function writeTempPrompt(text) {
  const dir = join(tmpdir(), "glm-plugin");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `prompt-${randomUUID()}.md`);
  writeFileSync(f, text);
  return f;
}

async function cmdRun(args) {
  const kind = args.values.kind || "rescue";
  const prompt = args.values.prompt;
  const promptFile = args.values["prompt-file"];
  const background = args.flags.background;
  const wait = args.flags.wait || !background;
  const resume = args.values.resume;
  const fresh = args.flags.fresh;
  const model = args.values.model;
  const readWrite = kind === "rescue" || args.flags["read-write"];

  if (!prompt && !promptFile) {
    console.error("error: --prompt or --prompt-file required");
    process.exit(2);
  }

  const promptText = promptFile ? readFileSync(promptFile, "utf8") : prompt;
  const promptPath = promptFile || writeTempPrompt(promptText);

  const id = args.values["session-id"] || `glm-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  // Continue the latest session for this repo and model unless --fresh or an explicit id is given.
  let resumeId = resume;
  if (!resumeId && !fresh && kind === "rescue") {
    resumeId = pickResumable(listJobs(50), { cwd: process.cwd(), model: model || DEFAULT_MODEL });
    if (args.flags.resume && !resumeId) {
      console.error("no recent GLM rescue session for this repo and model; starting a fresh one");
    }
  }

  if (background) {
    const job = createJob({
      id,
      kind,
      prompt: promptText.slice(0, 4000),
      model: model || DEFAULT_MODEL,
      cwd: process.cwd(),
      sessionId: resumeId,
    });
    // spawn detached worker
    const workerArgs = [
      "_worker",
      id,
      promptPath,
      JSON.stringify({
        model,
        resume: resumeId,
        sessionId: resumeId || id,
        readWrite,
        cwd: process.cwd(),
      }),
    ];
    const child = spawn(process.execPath, [workerScript(), ...workerArgs], {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
    });
    child.unref();
    updateJob(id, { pid: child.pid });
    console.log(JSON.stringify({ id, pid: child.pid, status: "running", background: true }));
    return;
  }

  // foreground / wait
  const job = createJob({
    id,
    kind,
    pid: process.pid,
    prompt: promptText.slice(0, 4000),
    model: model || DEFAULT_MODEL,
    cwd: process.cwd(),
    sessionId: resumeId,
  });
  try {
    const res = await runWorker(id, promptPath, {
      model,
      resume: resumeId,
      sessionId: resumeId || id,
      readWrite,
      cwd: process.cwd(),
    });
    console.log(res.result || "");
  } catch (err) {
    console.error(`glm job ${id} failed: ${err.message}`);
    process.exit(1);
  }
}

function workerScript() {
  return process.argv[1];
}

// The session auto-resume continues: the newest finished rescue job from the same
// repo, on the same model, that finished within RESUME_MAX_AGE_MS. Jobs recorded
// before `cwd` was stored never match. `jobs` is newest-first (listJobs order).
export function pickResumable(jobs, { cwd, model, now = Date.now() }) {
  const match = jobs.find(
    (j) =>
      j.kind === "rescue" &&
      j.status === "finished" &&
      j.sessionId &&
      j.cwd === cwd &&
      (j.model || DEFAULT_MODEL) === model &&
      now - (j.finishedAt ?? 0) <= RESUME_MAX_AGE_MS
  );
  return match ? match.sessionId : null;
}

async function cmdStatus(args) {
  const id = args._[0];
  if (id) {
    const job = getJob(id);
    if (!job) {
      console.error(`no job ${id}`);
      process.exit(1);
    }
    console.log(formatJob(job));
    return;
  }
  const jobs = listJobs(20);
  if (!jobs.length) {
    console.log("(no glm jobs yet)");
    return;
  }
  console.log(jobs.map(formatJob).join("\n\n"));
}

function formatJob(j) {
  const lines = [`job: ${j.id}`, `kind: ${j.kind}`, `status: ${j.status}`];
  if (j.status === "running") {
    lines.push(`process: ${isJobProcessAlive(j) ? "alive" : "(not responding — may have crashed)"}`);
  }
  if (j.model) lines.push(`model: ${j.model}`);
  if (j.sessionId) lines.push(`session: ${j.sessionId}`);
  if (j.costUsd != null) lines.push(`cost_usd: ${j.costUsd.toFixed(4)}`);
  lines.push(`created: ${new Date(j.createdAt).toISOString()}`);
  if (j.finishedAt) lines.push(`finished: ${new Date(j.finishedAt).toISOString()}`);
  if (j.error) lines.push(`error: ${j.error}`);
  if (j.prompt) lines.push(`prompt: ${j.prompt.slice(0, 200)}${j.prompt.length > 200 ? "..." : ""}`);
  return lines.join("\n");
}

async function cmdResult(args) {
  const id = args._[0];
  const job = id ? getJob(id) : listJobs(1)[0];
  if (!job) {
    console.error("no job found");
    process.exit(1);
  }
  const out = { id: job.id, status: job.status, result: job.result };
  if (job.sessionId) out.sessionId = job.sessionId;
  if (job.costUsd != null) out.costUsd = job.costUsd;
  if (job.error) out.error = job.error;
  console.log(JSON.stringify(out, null, 2));
}

async function cmdCancel(args) {
  const id = args._[0];
  const job = id ? getJob(id) : listJobs(1)[0];
  if (!job) {
    console.error("no job found");
    process.exit(1);
  }
  if (job.status !== "running") {
    console.log(`${job.id} is not running (${job.status})`);
    return;
  }
  // Mark first, so the dying worker cannot record "failed" over it (finishJob).
  updateJob(job.id, { status: "cancelled", finishedAt: Date.now() });
  // The worker, its claude child, and every shell and command claude started. The
  // child is a root of its own: if the worker is already gone, it was re-parented.
  const survivors = await killTree([job.pid, job.childPid]);
  if (survivors.length) {
    console.error(`cancelled ${job.id}, but these processes are still running: ${survivors.join(", ")}`);
    process.exit(1);
  }
  console.log(`cancelled ${job.id}`);
}

async function cmdTransfer(args) {
  const source = args.values.source;
  if (!source || !existsSync(source)) {
    console.error("--source <path> required (must be a claude transcript jsonl under ~/.claude/projects)");
    process.exit(2);
  }
  const transcript = readFileSync(source, "utf8");
  const turns = transcript
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const rendered = turns
    .filter((t) => t.type === "user" || t.type === "assistant")
    .map((t) => {
      const role = t.type === "user" ? "User" : "Assistant";
      const text = extractText(t);
      return text ? `### ${role}\n${text}` : null;
    })
    .filter(Boolean)
    .join("\n\n");

  const prompt =
    `The following is a transcript from a prior Claude Code session. ` +
    `Continue this work using GLM-5.3. Pick up where it left off.\n\n${rendered}`;
  const promptPath = writeTempPrompt(prompt);
  const id = `glm-transfer-${Date.now().toString(36)}`;
  console.error(`Transfer prompt written (${turns.length} turns). Starting GLM session ${id}...`);
  const res = await runClaude({
    prompt,
    model: DEFAULT_MODEL,
    readWrite: false,
    cwd: process.cwd(),
  });
  console.log(`\nGLM session ready: ${res.sessionId}`);
  console.log(`Resume with: /glm:rescue --resume ${res.sessionId}`);
}

function extractText(turn) {
  const m = turn.message || turn;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_use") return `[tool_use: ${b.name}]`;
        if (b.type === "tool_result") return `[tool_result]`;
        return null;
      })
      .filter(Boolean)
      .join("\n");
  }
  return null;
}

async function cmdSetup(args) {
  const check = args.flags.check;
  const enableGate = args.flags["enable-review-gate"];
  const disableGate = args.flags["disable-review-gate"];

  const key = resolveApiKey();
  const claudeBin = findClaude();

  if (enableGate) {
    writeSettings({ reviewGate: true });
    console.log("Review gate ENABLED. GLM will review Claude's output before each stop.");
    return;
  }
  if (disableGate) {
    writeSettings({ reviewGate: false });
    console.log("Review gate DISABLED.");
    return;
  }

  console.log("GLM Plugin Setup");
  console.log("================");
  console.log(`claude binary: ${claudeBin}`);
  const provider = resolveProvider();
  console.log(`api key: ${provider ? `found (${provider.source})` : "NOT FOUND"}`);
  console.log(`endpoint: ${provider ? provider.baseUrl : "-"}`);
  console.log(`plugin dir: ${PLUGIN_DIR}`);
  console.log(`review gate: ${readSettings().reviewGate ? "ENABLED" : "disabled"}`);
  if (!key) {
    console.log("\nTo get ready:");
    console.log("  DashScope: export DASHSCOPE_API_KEY=...  or put it in ~/.config/dashscope/api-key");
    console.log("  z.ai:      export ZAI_API_KEY=...        or put it in ~/.config/zai/api-key");
    if (!check) process.exit(1);
  } else if (!check) {
    console.log("\nRunning readiness check...");
    const res = await runClaude({ prompt: "Reply with exactly: GLM_READY", readWrite: false });
    console.log(res.result === "GLM_READY" ? "READY" : `Unexpected reply: ${res.result}`);
  }
}

async function cmdEnv() {
  const key = resolveApiKey();
  console.log(JSON.stringify({
    ANTHROPIC_BASE_URL: resolveProvider()?.baseUrl ?? null,
    ANTHROPIC_AUTH_TOKEN: key ? "***" : null,
    ANTHROPIC_MODEL: DEFAULT_MODEL,
    DEFAULT_EFFORT,
  }, null, 2));
}

// ---------- entry ----------

import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);

  // internal detached worker entrypoint
  if (sub === "_worker") {
    const jobId = process.argv[3];
    const promptFile = process.argv[4];
    const opts = JSON.parse(process.argv[5] || "{}");
    ensureDirs();
    runWorker(jobId, promptFile, opts)
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`worker failed: ${err.message}`);
        process.exit(1);
      });
  } else {
    const args = parseArgs(rest);
    const cmds = {
      run: cmdRun,
      status: cmdStatus,
      result: cmdResult,
      cancel: cmdCancel,
      transfer: cmdTransfer,
      setup: cmdSetup,
      env: cmdEnv,
    };
    const fn = cmds[sub];
    if (!fn) {
      console.error(`usage: glm-broker <run|status|result|cancel|transfer|setup|env> [...flags]`);
      process.exit(2);
    }
    Promise.resolve(fn(args)).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  }
}
