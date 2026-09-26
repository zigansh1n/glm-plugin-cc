import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FAKE_HOME = join(tmpdir(), `glm-home-${process.pid}-${Date.now()}`);
const KEY_FILE = join(FAKE_HOME, ".config", "zai", "api-key");
let keyFileExists = false;
let keyFileContent = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => FAKE_HOME,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: (p) => {
      if (typeof p === "string" && p === KEY_FILE) return keyFileExists;
      return actual.existsSync(p);
    },
    readFileSync: (p, enc) => {
      if (typeof p === "string" && p === KEY_FILE) return keyFileContent;
      return actual.readFileSync(p, enc);
    },
  };
});

beforeEach(() => {
  vi.unstubAllEnvs();
  delete process.env.ZAI_API_KEY;
  delete process.env.ZA_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.GLM_ANTHROPIC_BASE_URL;
  keyFileExists = false;
  keyFileContent = "";
  mkdirSync(FAKE_HOME, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.ZAI_API_KEY;
  delete process.env.ZA_API_KEY;
  if (existsSync(FAKE_HOME)) rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("config", () => {
  it("resolveApiKey prefers ZAI_API_KEY env var", async () => {
    const { resolveApiKey } = await import("../plugins/glm/scripts/config.mjs");
    vi.stubEnv("ZAI_API_KEY", "env-zai-key");
    vi.stubEnv("ZA_API_KEY", "env-za-key");
    expect(resolveApiKey()).toBe("env-zai-key");
  });

  it("resolveApiKey falls back to ZA_API_KEY", async () => {
    const { resolveApiKey } = await import("../plugins/glm/scripts/config.mjs");
    vi.stubEnv("ZA_API_KEY", "env-za-key");
    expect(resolveApiKey()).toBe("env-za-key");
  });

  it("resolveApiKey reads from KEY_FILE when no env var", async () => {
    const { resolveApiKey } = await import("../plugins/glm/scripts/config.mjs");
    keyFileExists = true;
    keyFileContent = "  file-key-123  \n";
    expect(resolveApiKey()).toBe("file-key-123");
  });

  it("resolveApiKey returns null when nothing available", async () => {
    const { resolveApiKey } = await import("../plugins/glm/scripts/config.mjs");
    expect(resolveApiKey()).toBeNull();
  });

  it("isReady mirrors resolveApiKey null check", async () => {
    const { isReady } = await import("../plugins/glm/scripts/config.mjs");
    expect(isReady()).toBe(false);
    vi.stubEnv("ZAI_API_KEY", "k");
    expect(isReady()).toBe(true);
  });

  it("buildZaiEnv sets anthropic vars and clears ANTHROPIC_API_KEY", async () => {
    const { buildZaiEnv, ZAI_ANTHROPIC_BASE_URL } = await import(
      "../plugins/glm/scripts/config.mjs"
    );
    vi.stubEnv("ZAI_API_KEY", "my-key");
    const env = buildZaiEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe(ZAI_ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("my-key");
    expect(env.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("glm-5.3");
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("buildZaiEnv uses provided model override", async () => {
    const { buildZaiEnv } = await import("../plugins/glm/scripts/config.mjs");
    vi.stubEnv("ZAI_API_KEY", "my-key");
    expect(buildZaiEnv("glm-custom").ANTHROPIC_MODEL).toBe("glm-custom");
  });

  it("buildZaiEnv throws when no key available", async () => {
    const { buildZaiEnv } = await import("../plugins/glm/scripts/config.mjs");
    expect(() => buildZaiEnv()).toThrow(/API key/i);
  });

  it("default model is glm-5.3", async () => {
    const { DEFAULT_MODEL } = await import("../plugins/glm/scripts/config.mjs");
    expect(DEFAULT_MODEL).toBe("glm-5.3");
  });

  it("z.ai anthropic base url is correct", async () => {
    const { ZAI_ANTHROPIC_BASE_URL } = await import("../plugins/glm/scripts/config.mjs");
    expect(ZAI_ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
  });

  it("readSettings returns default when no settings file", async () => {
    const { readSettings } = await import("../plugins/glm/scripts/config.mjs");
    expect(readSettings()).toEqual({ reviewGate: false });
  });

  it("writeSettings/readSettings roundtrip persists patch", async () => {
    const config = await import("../plugins/glm/scripts/config.mjs");
    const next = config.writeSettings({ reviewGate: true });
    expect(next.reviewGate).toBe(true);
    const reread = config.readSettings();
    expect(reread.reviewGate).toBe(true);
  });

  it("writeSettings merges with existing settings", async () => {
    const config = await import("../plugins/glm/scripts/config.mjs");
    config.writeSettings({ reviewGate: true });
    const next = config.writeSettings({ extraField: "x" });
    expect(next.reviewGate).toBe(true);
    expect(next.extraField).toBe("x");
  });

  it("DashScope key wins and points at the DashScope Anthropic endpoint", async () => {
    const { buildZaiEnv, resolveProvider, DASHSCOPE_ANTHROPIC_BASE_URL } = await import("../plugins/glm/scripts/config.mjs");
    vi.stubEnv("DASHSCOPE_API_KEY", "ds-key");
    vi.stubEnv("ZAI_API_KEY", "zai-key");
    expect(resolveProvider().name).toBe("dashscope");
    const env = buildZaiEnv("glm-5.3");
    expect(env.ANTHROPIC_BASE_URL).toBe(DASHSCOPE_ANTHROPIC_BASE_URL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ds-key");
  });

  it("GLM_ANTHROPIC_BASE_URL overrides the endpoint", async () => {
    const { buildZaiEnv } = await import("../plugins/glm/scripts/config.mjs");
    vi.stubEnv("DASHSCOPE_API_KEY", "ds-key");
    vi.stubEnv("GLM_ANTHROPIC_BASE_URL", "https://ws.ap-southeast-1.maas.aliyuncs.com/apps/anthropic");
    expect(buildZaiEnv().ANTHROPIC_BASE_URL).toBe("https://ws.ap-southeast-1.maas.aliyuncs.com/apps/anthropic");
  });

  it("drops Claude Desktop host variables from the child env", async () => {
    const { buildZaiEnv } = await import("../plugins/glm/scripts/config.mjs");
    vi.stubEnv("ZAI_API_KEY", "k");
    vi.stubEnv("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/sock");
    vi.stubEnv("CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "1");
    vi.stubEnv("CLAUDE_CODE_EFFORT_LEVEL", "high");
    const env = buildZaiEnv();
    expect(env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
    expect(env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH).toBeUndefined();
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
  });
});
