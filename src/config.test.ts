import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { llmFromEnv } from "./llm/openai.js";

/**
 * The LLM resolution ladder is non-trivial enough (CLI flags > env >
 * config.json > OPENAI_API_KEY shortcut > Ollama default) that a few
 * focused tests are cheaper than re-deriving it from the source every
 * time someone touches the layering.
 */
describe("loadConfig + llmFromEnv layering", () => {
  let home: string;
  const ENV_KEYS = [
    "RECALLR_HOME",
    "RECALLR_DB",
    "RECALLR_EMBED_MODEL",
    "RECALLR_EMBED_DIM",
    "RECALLR_LLM_BASE_URL",
    "RECALLR_LLM_MODEL",
    "RECALLR_LLM_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "recallr-config-"));
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.RECALLR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function writeConfig(c: object): void {
    writeFileSync(join(home, "config.json"), JSON.stringify(c, null, 2));
  }

  it("falls back to Ollama when nothing is configured anywhere", async () => {
    const cfg = await loadConfig();
    expect(cfg.llm).toEqual({});
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "llama3.2",
    });
  });

  it("uses the config.json llm block when env+flags are empty", async () => {
    writeConfig({
      llm: {
        baseUrl: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-opus-4.7",
        apiKey: "sk-or-from-config",
      },
    });
    const cfg = await loadConfig();
    expect(cfg.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-opus-4.7",
      apiKey: "sk-or-from-config",
    });
  });

  it("env vars override config.json", async () => {
    writeConfig({
      llm: { baseUrl: "https://from-config/v1", model: "config-model" },
    });
    process.env.RECALLR_LLM_BASE_URL = "https://from-env/v1";
    process.env.RECALLR_LLM_MODEL = "env-model";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://from-env/v1",
      defaultModel: "env-model",
    });
  });

  it("CLI overrides beat env vars and config", async () => {
    writeConfig({
      llm: { baseUrl: "https://from-config/v1", model: "config-model" },
    });
    process.env.RECALLR_LLM_BASE_URL = "https://from-env/v1";
    const cfg = await loadConfig();
    const llm = llmFromEnv(
      { baseUrl: "https://from-flag/v1", model: "flag-model" },
      cfg.llm,
    );
    expect(llm).toMatchObject({
      baseUrl: "https://from-flag/v1",
      defaultModel: "flag-model",
    });
  });

  it("OPENAI_API_KEY shortcut still works when nothing else is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      defaultModel: "gpt-5.5-mini",
    });
  });

  it("OPENAI_API_KEY in env beats apiKey in config", async () => {
    writeConfig({
      llm: { apiKey: "sk-from-config" },
    });
    process.env.OPENAI_API_KEY = "sk-from-env";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-from-env",
    });
  });

  it("apiKey in config alone routes to OpenAI cloud", async () => {
    writeConfig({
      llm: { apiKey: "sk-cfg-only" },
    });
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-cfg-only",
      defaultModel: "gpt-5.5-mini",
    });
  });

  it("ANTHROPIC_API_KEY shortcut routes to Anthropic compat layer", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
      defaultModel: "claude-haiku-4-7-latest",
    });
  });

  it("GEMINI_API_KEY shortcut routes to Gemini compat layer", async () => {
    process.env.GEMINI_API_KEY = "AIza-test";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "AIza-test",
      defaultModel: "gemini-3.0-flash",
    });
  });

  it("GOOGLE_API_KEY is treated as a Gemini alias", async () => {
    process.env.GOOGLE_API_KEY = "AIza-google-test";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "AIza-google-test",
    });
  });

  it("OPENAI_API_KEY beats ANTHROPIC_API_KEY when both are set", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-ant-also";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai",
    });
  });

  it("ANTHROPIC_API_KEY beats GEMINI_API_KEY when both are set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.GEMINI_API_KEY = "AIza-also";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant",
    });
  });

  it("--llm-model overrides the provider's default model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = await loadConfig();
    const llm = llmFromEnv({ model: "claude-opus-4-7-latest" }, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-opus-4-7-latest",
    });
  });

  it("RECALLR_LLM_BASE_URL beats provider-shortcut env vars", async () => {
    // An explicit baseUrl means the user is taking control of the
    // endpoint. Provider-shortcut env vars (ANTHROPIC_API_KEY etc.)
    // intentionally don't leak in here — set RECALLR_LLM_API_KEY when
    // pinning the URL.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.RECALLR_LLM_BASE_URL = "https://custom.example.com/v1";
    process.env.RECALLR_LLM_MODEL = "custom-model";
    process.env.RECALLR_LLM_API_KEY = "sk-explicit";
    const cfg = await loadConfig();
    const llm = llmFromEnv({}, cfg.llm);
    expect(llm).toMatchObject({
      baseUrl: "https://custom.example.com/v1",
      defaultModel: "custom-model",
      apiKey: "sk-explicit",
    });
  });
});
