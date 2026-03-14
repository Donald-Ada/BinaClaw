import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createAppConfig, ensureAppDirectories, saveStoredConfig} from "../src/core/config.ts";

test("createAppConfig loads persisted config from app home while keeping Binance secrets env-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-config-"));
  await mkdir(home, { recursive: true });
  await saveStoredConfig(join(home, "config.json"), {
    provider: {
      apiKey: "openai-from-file",
      baseUrl: "https://example.com/v1",
      model: "demo-model",
    },
    brave: {
      apiKey: "brave-from-file",
      baseUrl: "https://search.example.com",
    },
    binance: {
      apiKey: "binance-key-from-file",
      apiSecret: "binance-secret-from-file",
      useTestnet: true,
      recvWindow: 7000,
    },
    session: {
      messageCompactionLimit: 24,
      scratchpadCompactionLimit: 36,
      charCompactionLimit: 7200,
      retainRecentMessages: 10,
      retainRecentScratchpad: 18,
      maxCompactionRecords: 9,
    },
    gateway: {
      url: "http://127.0.0.1:9999",
      host: "0.0.0.0",
      port: 9999,
    },
    telegram: {
      botToken: "telegram-token",
      apiBaseUrl: "https://telegram.example.com",
      pollingTimeoutSeconds: 25,
      allowedUserIds: ["1", "2"],
      allowedChatIds: ["3"],
    },
  });

  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  assert.equal(config.provider.apiKey, "openai-from-file");
  assert.equal(config.provider.baseUrl, "https://example.com/v1");
  assert.equal(config.provider.model, "demo-model");
  assert.equal(config.brave.apiKey, "brave-from-file");
  assert.equal(config.brave.baseUrl, "https://search.example.com");
  assert.equal(config.binance.apiKey, undefined);
  assert.equal(config.binance.apiSecret, undefined);
  assert.equal(config.binance.useTestnet, true);
  assert.equal(config.binance.recvWindow, 7000);
  assert.equal(config.session.messageCompactionLimit, 24);
  assert.equal(config.session.scratchpadCompactionLimit, 36);
  assert.equal(config.session.charCompactionLimit, 7200);
  assert.equal(config.session.retainRecentMessages, 10);
  assert.equal(config.session.retainRecentScratchpad, 18);
  assert.equal(config.session.maxCompactionRecords, 9);
  assert.equal(config.gateway.url, "http://127.0.0.1:9999");
  assert.equal(config.gateway.host, "0.0.0.0");
  assert.equal(config.gateway.port, 9999);
  assert.equal(config.telegram.botToken, "telegram-token");
  assert.equal(config.telegram.apiBaseUrl, "https://telegram.example.com");
  assert.equal(config.telegram.pollingTimeoutSeconds, 25);
  assert.deepEqual(config.telegram.allowedUserIds, ["1", "2"]);
  assert.deepEqual(config.telegram.allowedChatIds, ["3"]);
});

test("createAppConfig prefers environment variables over persisted values", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-config-"));
  await mkdir(home, { recursive: true });
  await saveStoredConfig(join(home, "config.json"), {
    provider: {
      apiKey: "openai-from-file",
      model: "from-file-model",
    },
    binance: {
      apiKey: "binance-key-from-file",
      useTestnet: false,
    },
    brave: {
      apiKey: "brave-from-file",
      baseUrl: "https://search.example.com",
    },
    telegram: {
      botToken: "telegram-token-from-file",
      pollingTimeoutSeconds: 22,
    },
  });

  const config = createAppConfig(
    {
      BINACLAW_HOME: home,
      OPENAI_API_KEY: "openai-from-env",
      BINANCE_API_KEY: "binance-key-from-env",
      BINANCE_API_SECRET: "binance-secret-from-env",
      BRAVE_SEARCH_API_KEY: "brave-from-env",
      TELEGRAM_BOT_TOKEN: "telegram-token-from-env",
      BINANCE_USE_TESTNET: "true",
      BINACLAW_SESSION_MESSAGE_LIMIT: "30",
      BINACLAW_GATEWAY_PORT: "9001",
      TELEGRAM_ALLOWED_USER_IDS: "42,43",
    },
    process.cwd(),
  );

  assert.equal(config.provider.apiKey, "openai-from-env");
  assert.equal(config.provider.model, "from-file-model");
  assert.equal(config.binance.apiKey, "binance-key-from-env");
  assert.equal(config.binance.apiSecret, "binance-secret-from-env");
  assert.equal(config.brave.apiKey, "brave-from-env");
  assert.equal(config.telegram.botToken, "telegram-token-from-env");
  assert.equal(config.binance.useTestnet, true);
  assert.equal(config.session.messageCompactionLimit, 30);
  assert.equal(config.gateway.port, 9001);
  assert.deepEqual(config.telegram.allowedUserIds, ["42", "43"]);
});

test("saveStoredConfig strips Binance secret values before writing config.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-config-"));
  const configFile = join(home, "config.json");

  await saveStoredConfig(configFile, {
    provider: {
      apiKey: "openai-secret",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
    },
    brave: {
      apiKey: "brave-secret",
      baseUrl: "https://api.search.brave.com/res/v1",
    },
    telegram: {
      botToken: "telegram-secret",
      pollingTimeoutSeconds: 20,
    },
    binance: {
      apiKey: "binance-key",
      apiSecret: "binance-secret",
      useTestnet: true,
    },
  });

  const raw = await readFile(configFile, "utf8");
  assert.equal(raw.includes("openai-secret"), true);
  assert.equal(raw.includes("brave-secret"), true);
  assert.equal(raw.includes("telegram-secret"), true);
  assert.equal(raw.includes("binance-key"), false);
  assert.equal(raw.includes("binance-secret"), false);
  assert.equal(raw.includes("\"apiKey\": \"openai-secret\""), true);
  assert.equal(raw.includes("\"useTestnet\": true"), true);
});

test("ensureAppDirectories purges only legacy Binance secret values from existing config.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-config-"));
  const configFile = join(home, "config.json");
  await mkdir(home, { recursive: true });
  await writeFile(
    configFile,
    `${JSON.stringify(
      {
        provider: {
          apiKey: "legacy-openai-secret",
          model: "gpt-5.4",
        },
        binance: {
          apiKey: "legacy-binance-key",
          apiSecret: "legacy-binance-secret",
          useTestnet: true,
        },
        telegram: {
          botToken: "legacy-telegram-secret",
          pollingTimeoutSeconds: 18,
        },
      },
      null,
      2,
    )}\n`,
  );

  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const raw = await readFile(configFile, "utf8");
  assert.equal(raw.includes("legacy-openai-secret"), true);
  assert.equal(raw.includes("legacy-binance-key"), false);
  assert.equal(raw.includes("legacy-binance-secret"), false);
  assert.equal(raw.includes("legacy-telegram-secret"), true);
  assert.equal(raw.includes("\"model\": \"gpt-5.4\""), true);
  assert.equal(raw.includes("\"useTestnet\": true"), true);
});
