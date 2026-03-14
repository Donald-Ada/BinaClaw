import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {BinanceClient} from "../src/core/binance.ts";
import {createAppConfig} from "../src/core/config.ts";
import {compileSkillRuntime} from "../src/core/runtime.ts";
import {parseSkillDocument, syncWorkspaceToolsIndex} from "../src/core/skill.ts";

const alphaSkillDocument = `---
name: "binance-alpha"
version: "1.0.0"
description: "Binance Alpha data skill"
capabilities: ["alpha", "ticker", "klines"]
requires_auth: true
dangerous: false
products: ["spot"]
tools: []
---

## When to use
When the user asks for Binance Alpha market data.

## Instructions
Use the Quick Reference table to decide which Alpha endpoint to call.

## Available APIs
See Quick Reference.

## Quick Reference
| Endpoint | Description | Required | Optional | Authentication |
| --- | --- | --- | --- | --- |
| \`/bapi/defi/v1/public/alpha-trade/ticker\` (GET) | Ticker (24hr Price Statistics) | symbol | None | No |
| \`/bapi/defi/v1/public/alpha-trade/agg-trades\` (GET) | Aggregated Trades | symbol | limit | No |
| \`/bapi/defi/v1/public/alpha-trade/get-exchange-info\` (GET) | Get Exchange Info | None | None | No |
| \`/bapi/defi/v1/public/alpha-trade/klines\` (GET) | Klines (Candlestick Data) | symbol, interval | limit | No |
| \`/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list\` (GET) | Token List | None | None | No |

## Parameters
| Name | Required | Description | Options |
| --- | --- | --- | --- |
| symbol | Yes | Trading pair | BTCUSDT, ETHUSDT |
| interval | Yes | Kline interval | 1m, 5m, 1h |
| limit | No | Maximum items | 10, 100 |

## Authentication
Use apiKey and secretKey. Add X-MBX-APIKEY and User-Agent: BinanceAlphaAgent/1.0.
Signing Requests: HMAC is supported. Base URL: https://www.binance.com

## Security
Mainnet actions must require explicit confirmation.

## Agent Behavior
Return result in JSON format and hide secret values.

## Output contract
Return concise JSON.

## Examples
- Check alpha ticker
`;

test("parseSkillDocument extracts Alpha-style endpoint hints and references", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "binaclaw-alpha-"));
  await mkdir(join(rootDir, "references"), { recursive: true });
  await writeFile(join(rootDir, "references", "authentication.md"), "# Auth details", "utf8");
  await mkdir(join(rootDir, "scripts"), { recursive: true });
  await writeFile(join(rootDir, "scripts", "inspect.sh"), "#!/bin/sh\necho alpha\n", "utf8");

  const parsed = (await parseSkillDocument(alphaSkillDocument, join(rootDir, "SKILL.md"), rootDir)).skill;
  assert.equal(parsed.knowledge.endpointHints.length, 5);
  assert.deepEqual(
    parsed.knowledge.endpointHints.map((item) => item.id),
    [
      "alpha.ticker",
      "alpha.aggTrades",
      "alpha.exchangeInfo",
      "alpha.klines",
      "alpha.tokenList",
    ],
  );
  assert.equal(parsed.knowledge.authHints.requiresApiKey, true);
  assert.equal(parsed.knowledge.authHints.signatureAlgorithms.includes("HMAC"), true);
  assert.equal(parsed.knowledge.referenceFiles[0]?.relativePath, "references/authentication.md");
  assert.equal(parsed.knowledge.executionHints[0]?.relativePath, "scripts/inspect.sh");
});

test("compileSkillRuntime executes dynamic Alpha endpoint without hardcoded market path", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "binaclaw-alpha-"));
  const parsed = (await parseSkillDocument(alphaSkillDocument, join(rootDir, "SKILL.md"), rootDir)).skill;
  const config = createAppConfig({ BINACLAW_HOME: rootDir }, process.cwd());
  let requestedUrl = "";
  const client = new BinanceClient(config.binance, (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch);

  const runtime = await compileSkillRuntime([parsed], new Map(), config, client);
  const tickerTool = runtime.toolRegistry.get("alpha.ticker");
  const result = await tickerTool?.handler({ symbol: "ALPHA_175USDT" }, { config, now: () => new Date() });

  assert.equal(result?.ok, true);
  assert.ok(requestedUrl.includes("/bapi/defi/v1/public/alpha-trade/ticker"));
  assert.ok(requestedUrl.includes("symbol=ALPHA_175USDT"));
});

test("syncWorkspaceToolsIndex writes OpenClaw-style TOOLS.md without secrets", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "binaclaw-tools-"));
  const config = createAppConfig(
    {
      BINACLAW_HOME: rootDir,
      BINANCE_API_KEY: "demo-key",
      BINANCE_API_SECRET: "demo-secret",
    },
    process.cwd(),
  );
  const parsed = (await parseSkillDocument(alphaSkillDocument, join(rootDir, "SKILL.md"), rootDir)).skill;

  await syncWorkspaceToolsIndex(config, [parsed]);
  const content = await readFile(config.workspaceToolsFile, "utf8");
  assert.ok(content.includes("# TOOLS"));
  assert.ok(content.includes("binance-alpha"));
  assert.ok(!content.includes("demo-secret"));
});

test("parseSkillDocument extracts API Endpoint blocks used by official web3 skills", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "binaclaw-web3-"));
  const document = `---
name: "query-token-info"
description: "Query token details by keyword."
---

# Query Token Info Skill

## API 1: Token Search

### Method: POST

### URL:
\`\`\`
https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/web/token/search
\`\`\`

## Parameters

* **keyword**: token keyword

## Authentication
User-Agent: binance-web3/1.0 (Skill)
`;

  const parsed = (await parseSkillDocument(document, join(rootDir, "SKILL.md"), rootDir)).skill;
  assert.equal(parsed.knowledge.endpointHints.length, 1);
  assert.equal(parsed.knowledge.endpointHints[0]?.id, "info.tokenSearch");
  assert.equal(parsed.knowledge.endpointHints[0]?.method, "POST");
  assert.equal(parsed.knowledge.endpointHints[0]?.transport, "binance-public-http");
});

test("parseSkillDocument keeps readonly POST asset query endpoints out of approval flow", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "binaclaw-assets-"));
  const document = `---
name: "assets"
description: "Assets skill"
---

## When to use
Use when users ask about wallet balances and assets.

## Instructions
Use asset endpoints.

## Available APIs
See Quick Reference.

## Quick Reference
| Endpoint | Description | Required | Optional | Authentication |
| --- | --- | --- | --- | --- |
| \`/sapi/v3/asset/getUserAsset\` (POST) | User Asset (USER_DATA) | None | asset, needBtcValuation, recvWindow | Yes |
| \`/sapi/v1/asset/get-funding-asset\` (POST) | Funding Wallet (USER_DATA) | None | asset, needBtcValuation, recvWindow | Yes |
| \`/sapi/v1/asset/transfer\` (POST) | User Universal Transfer (USER_DATA) | type, asset, amount | recvWindow | Yes |

## Authentication
Use apiKey and secretKey.

## Output contract
Return JSON.

## Examples
- Query assets
`;

  const parsed = (await parseSkillDocument(document, join(rootDir, "SKILL.md"), rootDir)).skill;
  const runtime = await compileSkillRuntime([parsed], new Map(), createAppConfig({ BINACLAW_HOME: rootDir }, process.cwd()));

  assert.equal(parsed.knowledge.endpointHints.find((item) => item.id === "assets.userAsset")?.dangerLevel, "readonly");
  assert.equal(parsed.knowledge.endpointHints.find((item) => item.id === "assets.fundingWallet")?.dangerLevel, "readonly");
  assert.equal(parsed.knowledge.endpointHints.find((item) => item.id === "assets.userUniversalTransfer")?.dangerLevel, "mutating");
  assert.equal(runtime.toolRegistry.get("assets.userAsset")?.dangerous, false);
  assert.equal(runtime.toolRegistry.get("assets.fundingWallet")?.dangerous, false);
  assert.equal(runtime.toolRegistry.get("assets.userUniversalTransfer")?.dangerous, true);
});
