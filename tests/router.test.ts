import assert from "node:assert/strict";
import test from "node:test";
import {inferIntent, retrieveCandidateSkills, selectSkills} from "../src/core/router.ts";
import type {InstalledSkill, SkillKnowledge} from "../src/core/types.ts";

function createEmptyKnowledge(): SkillKnowledge {
  return {
    sections: {
      whenToUse: "",
      instructions: "",
      availableApis: "",
      outputContract: "",
      examples: "",
      quickReference: "",
      parameters: "",
      authentication: "",
      security: "",
      agentBehavior: "",
    },
    endpointHints: [],
    authHints: {
      requiresApiKey: false,
      requiresSecretKey: false,
      signatureAlgorithms: [],
      headerNames: [],
      baseUrls: [],
      confirmOnTransactions: false,
    },
    referenceFiles: [],
    executionHints: [],
    policyRules: [],
  };
}

const skills = [
  {
    name: "alpha",
    description: "Binance Alpha market data skill",
    capabilities: ["alpha", "ticker", "klines"],
    whenToUse: "Use for alpha ticker, exchange info and klines.",
  },
  {
    name: "spot",
    description: "Binance spot trading and account skill",
    capabilities: ["spot", "trade", "account"],
    whenToUse: "Use for spot trading, spot balances and spot orders.",
  },
  {
    name: "derivatives-trading-usds-futures",
    description: "USDS futures trading skill",
    capabilities: ["futures", "trade", "positions"],
    whenToUse: "Use for futures positions, orders and perpetual trading.",
  },
  {
    name: "trading-signal",
    description: "Market signal and ranking skill",
    capabilities: ["signal", "market", "news"],
    whenToUse: "Use for trading signals and market heat.",
  },
  {
    name: "query-token-info",
    description: "Token info query skill",
    capabilities: ["token", "web3"],
    whenToUse: "Use for token info and chain data.",
  },
].map(
  (entry) =>
    ({
      manifest: {
        name: entry.name,
        version: "1.0.0",
        description: entry.description,
        capabilities: entry.capabilities,
        requires_auth: false,
        dangerous: false,
        products: [],
        tools: [],
      },
      toolDefinitions: [],
      knowledge: {
        ...createEmptyKnowledge(),
        sections: {
          ...createEmptyKnowledge().sections,
          whenToUse: entry.whenToUse,
        },
      },
      instructions: entry.whenToUse,
      sourcePath: `${entry.name}/SKILL.md`,
      rootDir: process.cwd(),
      warnings: [],
    }) satisfies InstalledSkill,
);

test("inferIntent detects analysis and trade symbols", () => {
  const intent = inferIntent("给我分析 BTC 现在能不能买");
  assert.equal(intent.symbol, "BTCUSDT");
  assert.ok(intent.categories.includes("trade"));
  assert.ok(intent.categories.includes("market"));
});

test("inferIntent detects standalone coin mentions in natural analysis prompts", () => {
  const intent = inferIntent("今天ltc能买吗");
  assert.equal(intent.symbol, "LTCUSDT");
  assert.ok(intent.categories.includes("market"));
});

test("inferIntent treats a bare symbol as a market prompt", () => {
  const intent = inferIntent("BNB");
  assert.equal(intent.symbol, "BNBUSDT");
  assert.ok(intent.categories.includes("market"));
});

test("inferIntent does not hallucinate a symbol for generic market prompts", () => {
  const intent = inferIntent("最新的行情如何");
  assert.equal(intent.symbol, undefined);
  assert.ok(intent.categories.includes("market"));
});

test("inferIntent detects sell-all spot phrasing", () => {
  const intent = inferIntent("卖出全部 BTC 为 USDT，按市价");
  assert.equal(intent.symbol, "BTCUSDT");
  assert.equal(intent.side, "SELL");
  assert.equal(intent.sellAll, true);
  assert.ok(intent.categories.includes("trade"));
});

test("selectSkills enables market, account and news for analysis", () => {
  const selected = selectSkills("给我分析 BTC 现在能不能买", skills);
  const names = selected.map((skill) => skill.manifest.name);
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("trading-signal"));
});

test("selectSkills enables futures trade when futures keywords exist", () => {
  const selected = selectSkills("合约买 0.01 BTCUSDT", skills);
  assert.ok(selected.map((skill) => skill.manifest.name).includes("derivatives-trading-usds-futures"));
});

test("selectSkills enables spot skill for spot trade prompts", () => {
  const selected = selectSkills("买 0.01 BTCUSDT", skills);
  assert.ok(selected.map((skill) => skill.manifest.name).includes("spot"));
});

test("retrieveCandidateSkills keeps relevant skills in top-k when the catalog grows", () => {
  const expandedSkills = [
    ...skills,
    ...Array.from({ length: 16 }, (_, index) => ({
      manifest: {
        name: `noise-skill-${index}`,
        version: "1.0.0",
        description: "Generic unrelated skill",
        capabilities: ["misc"],
        requires_auth: false,
        dangerous: false,
        products: [],
        tools: [],
      },
      toolDefinitions: [],
      knowledge: createEmptyKnowledge(),
      instructions: "",
      sourcePath: `noise-${index}/SKILL.md`,
      rootDir: process.cwd(),
      warnings: [],
    }) satisfies InstalledSkill),
  ];

  const candidates = retrieveCandidateSkills("查一下 alpha ticker", expandedSkills, inferIntent("查一下 alpha ticker"), 8);
  assert.ok(candidates.some((entry) => entry.skill.manifest.name === "alpha"));
  assert.ok(candidates.length <= 8);
});
