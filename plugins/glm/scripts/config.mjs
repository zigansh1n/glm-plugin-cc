import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
// Alibaba Model Studio, China (Beijing) region. Other regions use workspace-specific
// hosts; set GLM_ANTHROPIC_BASE_URL for those.
export const DASHSCOPE_ANTHROPIC_BASE_URL = "https://dashscope.aliyuncs.com/apps/anthropic";
export const ZAI_OPENAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
export const DEFAULT_MODEL = "glm-5.3";
export const DEFAULT_EFFORT = "medium";

export const PLUGIN_DIR = join(homedir(), ".glm-plugin");
export const JOBS_DIR = join(PLUGIN_DIR, "jobs");
export const CONFIG_PATH = join(PLUGIN_DIR, "config.json");
export const SETTINGS_PATH = join(PLUGIN_DIR, "settings.json");

export const KEY_FILE = join(homedir(), ".config", "zai", "api-key");
export const DASHSCOPE_KEY_FILE = join(homedir(), ".config", "dashscope", "api-key");

/**
 * First match wins: DashScope (env, then key file), then z.ai (env, then key file).
 * GLM_ANTHROPIC_BASE_URL overrides the endpoint of whichever key was found.
 */
export function resolveProvider() {
  const candidates = [
    ["dashscope", DASHSCOPE_ANTHROPIC_BASE_URL, process.env.DASHSCOPE_API_KEY, "DASHSCOPE_API_KEY"],
    ["dashscope", DASHSCOPE_ANTHROPIC_BASE_URL, readKeyFile(DASHSCOPE_KEY_FILE), "~/.config/dashscope/api-key"],
    ["zai", ZAI_ANTHROPIC_BASE_URL, process.env.ZAI_API_KEY, "ZAI_API_KEY"],
    ["zai", ZAI_ANTHROPIC_BASE_URL, process.env.ZA_API_KEY, "ZA_API_KEY"],
    ["zai", ZAI_ANTHROPIC_BASE_URL, readKeyFile(KEY_FILE), "~/.config/zai/api-key"],
  ];
  for (const [name, baseUrl, key, source] of candidates) {
    if (key && key.trim()) {
      return { name, baseUrl: process.env.GLM_ANTHROPIC_BASE_URL || baseUrl, key: key.trim(), source };
    }
  }
  return null;
}

function readKeyFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function resolveApiKey() {
  return resolveProvider()?.key ?? null;
}

// Set by the Claude Desktop host for its own session. A child `claude -p` that
// inherits them tries to attach to the host's socket and auth instead of the
// GLM endpoint.
const HOST_ENV = /^(?:CLAUDE_CODE_(?:HOST_|MESSAGING_|SESSION_|CHILD_|SDK_|ENTRYPOINT|DESKTOP_|OAUTH_)|USE_(?:STAGING|LOCAL)_OAUTH$)/;

export function isReady() {
  return resolveApiKey() !== null;
}

export function buildZaiEnv(model = DEFAULT_MODEL) {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      "No GLM API key found. Set DASHSCOPE_API_KEY or ZAI_API_KEY, or create " +
        "~/.config/dashscope/api-key or ~/.config/zai/api-key. Run: /glm:setup"
    );
  }
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOST_ENV.test(k)));
  return {
    ...inherited,
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: provider.key,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_API_KEY: "",
  };
}

export function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return { reviewGate: false };
  try {
    return { reviewGate: false, ...JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) };
  } catch {
    return { reviewGate: false };
  }
}

export function writeSettings(patch) {
  const cur = readSettings();
  const next = { ...cur, ...patch };
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}
