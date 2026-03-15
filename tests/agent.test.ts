import assert from "node:assert/strict";
import {mkdir, mkdtemp, readdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {BinaClawAgent} from "../src/core/agent.ts";
import {createAppConfig, ensureAppDirectories} from "../src/core/config.ts";
import type {
  ConversationState,
  ConversationStateRequest,
  DirectResponseRequest,
  InstalledSkill,
  ModelPlanResult,
  PlanningRequest,
  SkillKnowledge,
  SkillReferenceSelectionRequest,
  SkillReferenceSelectionResult,
  SkillSelectionRequest,
  SkillSelectionResult,
  SummaryRequest,
  ToolDefinition,
} from "../src/core/types.ts";

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

class FakeProvider {
  isConfigured(): boolean {
    return false;
  }

  async selectSkills(_request: SkillSelectionRequest): Promise<SkillSelectionResult | null> {
    return null;
  }

  async selectSkillReferences(
    _request: SkillReferenceSelectionRequest,
  ): Promise<SkillReferenceSelectionResult | null> {
    return null;
  }

  async resolveConversationState(_request: ConversationStateRequest): Promise<ConversationState | null> {
    return null;
  }

  async plan(_request: PlanningRequest): Promise<ModelPlanResult | null> {
    return null;
  }

  async extractStableFacts(): Promise<string[] | null> {
    return null;
  }

  async composeDirectResponse(_request: DirectResponseRequest): Promise<string | null> {
    return null;
  }

  async summarize(_request: SummaryRequest): Promise<string> {
    return "summary";
  }
}

class NaturalDirectResponseProvider extends FakeProvider {
  override isConfigured(): boolean {
    return true;
  }

  override async plan(_request: PlanningRequest): Promise<ModelPlanResult | null> {
    return {
      directResponse: "先告诉我你想看哪个交易对，我再继续给你看最新行情。",
      selectedSkillNames: ["market-overview"],
    };
  }
}

class ModelPlanningProvider extends FakeProvider {
  seenRequests: PlanningRequest[] = [];

  override isConfigured(): boolean {
    return true;
  }

  override async selectSkillReferences(
    _request: SkillReferenceSelectionRequest,
  ): Promise<SkillReferenceSelectionResult | null> {
    return null;
  }

  override async plan(request: PlanningRequest): Promise<ModelPlanResult | null> {
    this.seenRequests.push(request);
    return {
      selectedSkillNames: ["news-signal"],
      toolCalls: [
        {
          toolId: "news.getSignal",
          input: { query: "btc news" },
        },
      ],
    };
  }
}

class MultiStepPlanningProvider extends FakeProvider {
  private turn = 0;

  override isConfigured(): boolean {
    return true;
  }

  override async selectSkillReferences(
    _request: SkillReferenceSelectionRequest,
  ): Promise<SkillReferenceSelectionResult | null> {
    return null;
  }

  override async plan(request: PlanningRequest): Promise<ModelPlanResult | null> {
    if (this.turn === 0) {
      this.turn += 1;
      return {
        selectedSkillNames: ["market-overview"],
        toolCalls: [{ toolId: "market.getTicker", input: { symbol: "BTCUSDT" } }],
      };
    }

    assert.equal(request.observations.some((item) => item.toolId === "market.getTicker"), true);
    this.turn += 1;
    return {
      selectedSkillNames: ["market-overview"],
      directResponse: "根据刚才的行情结果，BTC 当前波动较大，建议先轻仓。",
    };
  }
}

class MultiStepDangerProvider extends FakeProvider {
  private turn = 0;

  override isConfigured(): boolean {
    return true;
  }

  override async selectSkillReferences(
    _request: SkillReferenceSelectionRequest,
  ): Promise<SkillReferenceSelectionResult | null> {
    return null;
  }

  override async plan(request: PlanningRequest): Promise<ModelPlanResult | null> {
    if (this.turn === 0) {
      this.turn += 1;
      return {
        selectedSkillNames: ["spot-account"],
        toolCalls: [{ toolId: "spot.getAccount", input: {} }],
      };
    }

    assert.equal(request.observations.some((item) => item.toolId === "spot.getAccount"), true);
    this.turn += 1;
    return {
      selectedSkillNames: ["spot-account", "spot-trade"],
      toolCalls: [
        {
          toolId: "spot.placeOrder",
          input: { symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: 0.01 },
        },
      ],
    };
  }
}

class MemoryExtractionProvider extends FakeProvider {
  override isConfigured(): boolean {
    return true;
  }

  override async selectSkillReferences(
    _request: SkillReferenceSelectionRequest,
  ): Promise<SkillReferenceSelectionResult | null> {
    return null;
  }

  override async extractStableFacts(): Promise<string[] | null> {
    return ["用户长期关注交易对 SOLUSDT"];
  }
}

class FastAnalysisProvider extends FakeProvider {
  planCalls = 0;

  override isConfigured(): boolean {
    return true;
  }

  override async selectSkillReferences(
    _request: SkillReferenceSelectionRequest,
  ): Promise<SkillReferenceSelectionResult | null> {
    return null;
  }

  override async plan(_request: PlanningRequest): Promise<ModelPlanResult | null> {
    this.planCalls += 1;
    return {
      directResponse: "不应该走到这里",
    };
  }

  override async summarize(_request: SummaryRequest): Promise<string> {
    return "LTC 当前处于快速分析总结。";
  }
}

class ContinuationStateProvider extends FakeProvider {
  private turn = 0;

  override isConfigured(): boolean {
    return true;
  }

  override async plan(request: PlanningRequest): Promise<ModelPlanResult | null> {
    if (this.turn === 0) {
      this.turn += 1;
      return {
        selectedSkillNames: ["market-overview"],
        toolCalls: [{ toolId: "market.getTicker", input: { symbol: "BNBUSDT" } }],
      };
    }

    assert.equal(request.observations.some((item) => item.toolId === "market.getTicker"), true);
    return {
      selectedSkillNames: ["market-overview"],
      conversationStateUpdate: {
        currentSymbol: "BNBUSDT",
        currentTopic: "market",
        currentMarketType: "spot",
        summary: "继续沿用 BNB 现货分析。",
      },
      directResponse: "继续沿用 BNB 现货分析。",
    };
  }
}

class CallBudgetDirectProvider extends FakeProvider {
  planCalls = 0;
  summarizeCalls = 0;
  selectSkillCalls = 0;
  resolveConversationCalls = 0;
  composeCalls = 0;

  override isConfigured(): boolean {
    return true;
  }

  override async selectSkills(_request: SkillSelectionRequest): Promise<SkillSelectionResult | null> {
    this.selectSkillCalls += 1;
    return null;
  }

  override async resolveConversationState(_request: ConversationStateRequest): Promise<ConversationState | null> {
    this.resolveConversationCalls += 1;
    return null;
  }

  override async composeDirectResponse(_request: DirectResponseRequest): Promise<string | null> {
    this.composeCalls += 1;
    return null;
  }

  override async plan(_request: PlanningRequest): Promise<ModelPlanResult | null> {
    this.planCalls += 1;
    return {
      selectedSkillNames: ["market-overview"],
      directResponse: "先告诉我你想看哪个交易对，我再继续。",
    };
  }

  override async summarize(_request: SummaryRequest): Promise<string> {
    this.summarizeCalls += 1;
    return "summary";
  }
}

class CallBudgetToolProvider extends CallBudgetDirectProvider {
  override async plan(_request: PlanningRequest): Promise<ModelPlanResult | null> {
    this.planCalls += 1;
    return {
      selectedSkillNames: ["news-signal"],
      endpointDecision: {
        skillName: "news-signal",
        toolId: "news.getSignal",
        endpointId: "news.getSignal",
        operation: "news signal lookup",
        method: "GET",
        path: "/res/v1/news/search",
        transport: "builtin",
        rationale: "用户在看 BTC 最新新闻。",
      },
      toolCalls: [{ toolId: "news.getSignal", input: { query: "btc news" } }],
    };
  }

  override async summarize(_request: SummaryRequest): Promise<string> {
    this.summarizeCalls += 1;
    return "这是最终总结。";
  }
}

const stubSkills = [
  {
    name: "market-overview",
    dangerous: false,
    tools: ["market.getTicker", "market.getDepth", "market.getKlines"],
  },
  {
    name: "spot-account",
    dangerous: false,
    tools: ["spot.getAccount"],
  },
  {
    name: "spot-trade",
    dangerous: true,
    tools: ["spot.placeOrder"],
  },
  {
    name: "news-signal",
    dangerous: false,
    tools: ["news.getSignal"],
  },
  {
    name: "memory-helper",
    dangerous: false,
    tools: ["memory.getRecent", "memory.search"],
  },
].map(
  (entry) =>
    ({
      manifest: {
        name: entry.name,
        version: "1.0.0",
        description: entry.name,
        capabilities: [],
        requires_auth: false,
        dangerous: entry.dangerous,
        products: [],
        tools: entry.tools,
      },
      toolDefinitions: [],
      knowledge: createEmptyKnowledge(),
      instructions: "",
      sourcePath: `${entry.name}.md`,
      rootDir: process.cwd(),
      warnings: [],
    }) satisfies InstalledSkill,
);

function createTestRegistry(): Map<string, ToolDefinition> {
  const definitions: ToolDefinition[] = [
    {
      id: "market.getTicker",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: async () => ({ ok: true, toolId: "market.getTicker", data: { price: "100000" } }),
    },
    {
      id: "market.getDepth",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: async () => ({ ok: true, toolId: "market.getDepth", data: { bids: [] } }),
    },
    {
      id: "market.getKlines",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "array" },
      dangerous: false,
      authScope: "none",
      handler: async () => ({ ok: true, toolId: "market.getKlines", data: [] }),
    },
    {
      id: "news.getSignal",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "none",
      handler: async () => ({ ok: true, toolId: "news.getSignal", data: { headlines: [] } }),
    },
    {
      id: "spot.getAccount",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      dangerous: false,
      authScope: "spot",
      handler: async () => ({ ok: true, toolId: "spot.getAccount", data: { balances: [{ asset: "USDT", free: "1000" }] } }),
    },
    {
      id: "spot.placeOrder",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      dangerous: true,
      authScope: "spot",
      handler: async () => ({ ok: true, toolId: "spot.placeOrder", data: { status: "FILLED" } }),
    },
  ];
  return new Map(definitions.map((tool) => [tool.id, tool]));
}

test("agent creates approval flow for dangerous trades", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  await mkdir(join(home, "skills"), { recursive: true });
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("买 0.01 BTCUSDT");
  assert.equal(result.approval?.toolId, "spot.placeOrder");
  assert.ok(result.text.includes("CONFIRM"));
  assert.ok(result.text.includes("确认"));

  const confirmed = await agent.handleInput("确认");
  assert.ok(confirmed.text.includes("spot.placeOrder"));
  assert.equal(confirmed.toolResults[0]?.ok, true);
});

test("agent creates approval flow for spot market buys with quoteOrderQty", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  await mkdir(join(home, "skills"), { recursive: true });
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);

  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("BTCUSDT 现货，市价买入 20 USDT");
  assert.equal(result.approval?.toolId, "spot.placeOrder");
  assert.equal(result.approval?.toolCall.input.symbol, "BTCUSDT");
  assert.equal(result.approval?.toolCall.input.side, "BUY");
  assert.equal(result.approval?.toolCall.input.type, "MARKET");
  assert.equal(result.approval?.toolCall.input.quoteOrderQty, 20);
  assert.equal(result.approval?.toolCall.input.quantity, undefined);

  const confirmed = await agent.handleInput("确认下单");
  assert.ok(confirmed.text.includes("spot.placeOrder"));
  assert.equal(confirmed.toolResults[0]?.ok, true);
});

test("agent summarizes analysis requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("分析 BTCUSDT");
  assert.ok(result.toolResults.length > 0);
  assert.ok(result.text.includes("market-overview"));
});

test("agent uses model planning when provider is configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const provider = new ModelPlanningProvider();
  const agent = new BinaClawAgent(config, {
    provider,
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("看下最新 BTC 新闻");
  assert.equal(result.toolResults.some((item) => item.toolId === "news.getSignal"), true);
  assert.ok(provider.seenRequests.length > 0);
  assert.deepEqual(agent.getSession().activeSkills, ["news-signal"]);
  assert.equal(provider.seenRequests[0]?.candidateSkills.some((skill) => skill.manifest.name === "news-signal"), true);
});

test("agent supports multi-step planning before final response", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new MultiStepPlanningProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("先看行情再给建议");
  assert.equal(result.toolResults.some((item) => item.toolId === "market.getTicker"), true);
  assert.ok(result.text.includes("建议先轻仓"));
  const scratchpad = agent.getSession().scratchpad;
  assert.equal(scratchpad.some((item) => item.kind === "plan"), true);
  assert.equal(scratchpad.some((item) => item.kind === "observation"), true);
  assert.equal(scratchpad.some((item) => item.kind === "response"), true);
});

test("agent can request approval after prior model observations", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new MultiStepDangerProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("评估下余额后帮我买一点 BTC");
  assert.equal(result.toolResults.some((item) => item.toolId === "spot.getAccount"), true);
  assert.equal(result.approval?.toolId, "spot.placeOrder");
  assert.ok(result.text.includes("CONFIRM"));
});

test("agent uses fast analysis path for advisory market prompts", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const provider = new FastAnalysisProvider();
  const agent = new BinaClawAgent(config, {
    provider,
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("今天ltc能买吗");
  assert.equal(provider.planCalls, 0);
  assert.equal(result.toolResults.some((item) => item.toolId === "market.getTicker"), true);
  assert.equal(result.toolResults.some((item) => item.toolId === "market.getKlines"), true);
  assert.ok(result.text.includes("快速分析总结"));
});

test("agent uses one main planning call for direct replies without extra model helpers", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const provider = new CallBudgetDirectProvider();
  const agent = new BinaClawAgent(config, {
    provider,
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("最新的行情如何");
  assert.match(result.text, /哪个交易对/);
  assert.equal(provider.planCalls, 1);
  assert.equal(provider.summarizeCalls, 0);
  assert.equal(provider.selectSkillCalls, 1);
  assert.equal(provider.resolveConversationCalls, 0);
  assert.equal(provider.composeCalls, 0);
});

test("agent uses planning plus summary for tool-backed replies without extra helper calls", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const provider = new CallBudgetToolProvider();
  const agent = new BinaClawAgent(config, {
    provider,
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("看下最新 BTC 新闻");
  assert.equal(result.toolResults.some((item) => item.toolId === "news.getSignal"), true);
  assert.equal(provider.planCalls, 1);
  assert.equal(provider.summarizeCalls, 1);
  assert.equal(provider.selectSkillCalls, 1);
  assert.equal(provider.resolveConversationCalls, 0);
  assert.equal(provider.composeCalls, 0);
  assert.equal(
    agent.getSession().scratchpad.some((item) =>
      item.kind === "plan" && item.summary.includes("skill 接口决策") && item.detail?.includes("/res/v1/news/search")
    ),
    true,
  );
});

test("fast analysis path streams the final summary directly without a local early prelude", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const provider = new FastAnalysisProvider();
  const agent = new BinaClawAgent(config, {
    provider,
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });
  const deltas: string[] = [];
  const done: string[] = [];

  const result = await agent.handleInput("今天ltc能买吗", {
    onTextStart: () => {},
    onTextDelta: (delta) => {
      deltas.push(delta);
    },
    onTextDone: (text) => {
      done.push(text);
    },
  });

  assert.equal(deltas.join(""), "LTC 当前处于快速分析总结。");
  assert.equal(result.text, "LTC 当前处于快速分析总结。");
  assert.equal(done[0], "LTC 当前处于快速分析总结。");
});

test("fast analysis no longer prepends local ticker observations before summary", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const provider = new FastAnalysisProvider();
  const registry = createTestRegistry();
  registry.set("market.getTicker", {
    id: "market.getTicker",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async () => ({
      ok: true,
      toolId: "market.getTicker",
      data: { lastPrice: "70647.82", priceChangePercent: "1.23" },
    }),
  });
  const agent = new BinaClawAgent(config, {
    provider,
    skills: stubSkills,
    toolRegistry: registry,
  });
  const deltas: string[] = [];

  await agent.handleInput("今天ltc能买吗", {
    onTextStart: () => {},
    onTextDelta: (delta) => {
      deltas.push(delta);
    },
    onTextDone: () => {},
  });

  assert.equal(deltas.join(""), "LTC 当前处于快速分析总结。");
  assert.equal(deltas.join("").includes("当前价约"), false);
  assert.equal(deltas.join("").includes("24h 上涨"), false);
});

test("agent does not cache public readonly market tools across repeated fast analysis prompts", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const callCounts = {
    ticker: 0,
    klines: 0,
    depth: 0,
  };
  const registry = createTestRegistry();
  registry.set("market.getTicker", {
    id: "market.getTicker",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async () => {
      callCounts.ticker += 1;
      return { ok: true, toolId: "market.getTicker", data: { price: "101" } };
    },
  });
  registry.set("market.getKlines", {
    id: "market.getKlines",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "array" },
    dangerous: false,
    authScope: "none",
    handler: async () => {
      callCounts.klines += 1;
      return { ok: true, toolId: "market.getKlines", data: [] };
    },
  });
  registry.set("market.getDepth", {
    id: "market.getDepth",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async () => {
      callCounts.depth += 1;
      return { ok: true, toolId: "market.getDepth", data: { bids: [] } };
    },
  });

  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: registry,
  });

  await agent.handleInput("今天ltc能买吗");
  const second = await agent.handleInput("今天ltc能买吗");

  assert.equal(callCounts.ticker, 2);
  assert.equal(callCounts.klines, 2);
  assert.equal(callCounts.depth, 2);
  assert.equal(second.toolResults.some((item) => item.cached === true), false);
});

test("agent carries forward the previous symbol for continuation prompts", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const seenSymbols: string[] = [];
  const registry = createTestRegistry();
  registry.set("market.getTicker", {
    id: "market.getTicker",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getTicker", data: { lastPrice: "600.00", priceChangePercent: "1.00" } };
    },
  });
  registry.set("market.getKlines", {
    id: "market.getKlines",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "array" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getKlines", data: [] };
    },
  });
  registry.set("market.getDepth", {
    id: "market.getDepth",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getDepth", data: { bids: [], asks: [] } };
    },
  });
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: registry,
  });

  await agent.handleInput("今天BNB能买吗");
  await agent.handleInput("继续");

  assert.deepEqual(seenSymbols.slice(-3), ["BNBUSDT", "BNBUSDT", "BNBUSDT"]);
});

test("agent asks for a symbol instead of reusing prior context on generic market prompts", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const seenSymbols: string[] = [];
  const registry = createTestRegistry();
  registry.set("market.getTicker", {
    id: "market.getTicker",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getTicker", data: { lastPrice: "600.00", priceChangePercent: "1.00" } };
    },
  });
  registry.set("market.getKlines", {
    id: "market.getKlines",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "array" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getKlines", data: [] };
    },
  });
  registry.set("market.getDepth", {
    id: "market.getDepth",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getDepth", data: { bids: [], asks: [] } };
    },
  });
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: registry,
  });

  await agent.handleInput("今天BNB能买吗");
  const second = await agent.handleInput("最新的行情如何");

  assert.deepEqual(seenSymbols, ["BNBUSDT", "BNBUSDT", "BNBUSDT"]);
  assert.match(second.text, /哪个交易对/);
});

test("agent returns direct clarification from the main planning call when provider is available", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new NaturalDirectResponseProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("最新的行情如何");
  assert.equal(result.toolResults.length, 0);
  assert.equal(result.text, "先告诉我你想看哪个交易对，我再继续给你看最新行情。");
});

test("agent understands natural analysis wording like 分析下BNB without asking for another symbol", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("具体分析下BNB");
  assert.ok(result.toolResults.length > 0);
  assert.doesNotMatch(result.text, /哪个交易对/);
});

test("agent treats a bare symbol as a market request instead of returning an empty fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const result = await agent.handleInput("BNB");
  assert.ok(result.toolResults.length > 0);
  assert.doesNotMatch(result.text, /这轮没有调用工具/);
});

test("agent keeps approval lifecycle replies local and deterministic", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const approval = await agent.handleInput("买 0.01 BTCUSDT");
  assert.equal(approval.approval?.toolId, "spot.placeOrder");
  assert.match(approval.text, /CONFIRM/);
  assert.match(approval.text, /确认/);

  const reminder = await agent.handleInput("等等");
  assert.match(reminder.text, /确认/);

  const confirmed = await agent.handleInput("确认");
  assert.match(confirmed.text, /spot\.placeOrder/);
});

test("agent rebuilds approval tool resolution when the in-memory approval registry is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  const approval = await agent.handleInput("买 0.01 BTCUSDT");
  assert.equal(approval.approval?.toolId, "spot.placeOrder");

  (agent as unknown as { approvalToolRegistry?: Map<string, ToolDefinition> }).approvalToolRegistry = new Map();

  const confirmed = await agent.handleInput("确认");
  assert.match(confirmed.text, /spot\.placeOrder/);
  assert.equal(confirmed.toolResults[0]?.ok, true);
});

test("agent reloads persisted session context across agent instances", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const seenSymbols: string[] = [];
  const registry = createTestRegistry();
  registry.set("market.getTicker", {
    id: "market.getTicker",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getTicker", data: { lastPrice: "600.00", priceChangePercent: "1.00" } };
    },
  });
  registry.set("market.getKlines", {
    id: "market.getKlines",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "array" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getKlines", data: [] };
    },
  });
  registry.set("market.getDepth", {
    id: "market.getDepth",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getDepth", data: { bids: [], asks: [] } };
    },
  });

  const firstAgent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: registry,
  });
  await firstAgent.handleInput("今天BNB能买吗");

  const secondAgent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: registry,
  });
  await secondAgent.handleInput("继续");

  assert.deepEqual(seenSymbols.slice(-3), ["BNBUSDT", "BNBUSDT", "BNBUSDT"]);
});

test("agent uses AI conversation state for continuation prompts when provider is configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const seenSymbols: string[] = [];
  const registry = createTestRegistry();
  registry.set("market.getTicker", {
    id: "market.getTicker",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getTicker", data: { lastPrice: "700.00", priceChangePercent: "1.00" } };
    },
  });
  registry.set("market.getKlines", {
    id: "market.getKlines",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "array" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getKlines", data: [] };
    },
  });
  registry.set("market.getDepth", {
    id: "market.getDepth",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async (input) => {
      seenSymbols.push(String(input.symbol));
      return { ok: true, toolId: "market.getDepth", data: { bids: [], asks: [] } };
    },
  });
  const agent = new BinaClawAgent(config, {
    provider: new ContinuationStateProvider(),
    skills: stubSkills,
    toolRegistry: registry,
  });

  await agent.handleInput("今天BNB能买吗");
  await agent.handleInput("继续");

  assert.deepEqual(seenSymbols.slice(-3), ["BNBUSDT", "BNBUSDT", "BNBUSDT"]);
  assert.equal(agent.getSession().conversationState?.currentSymbol, "BNBUSDT");
});

test("agent writes workspace memory daily logs after a turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  await agent.handleInput("分析 BTCUSDT");

  const memoryDir = join(home, "workspace", "memory");
  const files = await readdir(memoryDir);
  assert.ok(files.length > 0);
  const content = await readFile(join(memoryDir, files[0] as string), "utf8");
  assert.ok(content.includes("分析 BTCUSDT"));
});

test("agent promotes stable user facts into USER.md", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  await agent.handleInput("请用中文回答，我主要看 ETH，偏好现货，风格稳健");

  const userContent = await readFile(join(home, "workspace", "USER.md"), "utf8");
  assert.ok(userContent.includes("用户偏好中文输出"));
  assert.ok(userContent.includes("用户长期关注交易对 ETHUSDT"));
});

test("agent can use model-extracted long-term facts for USER.md promotion", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home, OPENAI_API_KEY: "demo-key" }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new MemoryExtractionProvider(),
    skills: stubSkills,
    toolRegistry: createTestRegistry(),
  });

  await agent.handleInput("以后优先盯 SOL");

  const userContent = await readFile(join(home, "workspace", "USER.md"), "utf8");
  assert.ok(userContent.includes("用户长期关注交易对 SOLUSDT"));
});

test("agent auto-loads memory tools for preference/history prompts", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const registry = createTestRegistry();
  registry.set("memory.getRecent", {
    id: "memory.getRecent",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    dangerous: false,
    authScope: "none",
    handler: async () => ({ ok: true, toolId: "memory.getRecent", data: { recentEntries: [] } }),
  });
  registry.set("memory.search", {
    id: "memory.search",
    description: "",
    inputSchema: { type: "object" },
    outputSchema: { type: "array" },
    dangerous: false,
    authScope: "none",
    handler: async () => ({ ok: true, toolId: "memory.search", data: [] }),
  });

  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: stubSkills,
    toolRegistry: registry,
  });

  const result = await agent.handleInput("你还记得我之前关注什么币吗");
  assert.equal(result.toolResults.some((item) => item.toolId === "memory.getRecent"), true);
  assert.equal(result.toolResults.some((item) => item.toolId === "memory.search"), true);
});

test("agent lazily loads auth references for active official skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-ref-"));
  const skillRoot = join(home, "alpha");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(join(skillRoot, "references", "authentication.md"), "HMAC signing rules", "utf8");

  const alphaSkill = {
    manifest: {
      name: "alpha",
      version: "1.0.0",
      description: "alpha",
      capabilities: ["alpha"],
      requires_auth: true,
      dangerous: false,
      products: ["spot"],
      tools: [],
    },
    toolDefinitions: [],
    knowledge: {
      ...createEmptyKnowledge(),
      endpointHints: [
        {
          id: "alpha.ticker",
          operation: "Ticker",
          description: "Ticker",
          method: "GET",
          path: "/bapi/defi/v1/public/alpha-trade/ticker",
          authRequired: true,
          requiredParams: ["symbol"],
          optionalParams: [],
          transport: "binance-signed-http",
          dangerLevel: "readonly",
        },
      ],
      referenceFiles: [
        {
          relativePath: "references/authentication.md",
          absolutePath: join(skillRoot, "references", "authentication.md"),
        },
      ],
    },
    instructions: "",
    sourcePath: join(skillRoot, "SKILL.md"),
    rootDir: skillRoot,
    warnings: [],
  } satisfies InstalledSkill;

  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: [alphaSkill],
    toolRegistry: createTestRegistry(),
  });

  await agent.handleInput("alpha 的签名规则是什么");
  const referenceContext = agent.getSession().referenceContext ?? [];
  assert.equal(referenceContext.length, 1);
  assert.equal(referenceContext[0]?.relativePath, "references/authentication.md");
  assert.ok(referenceContext[0]?.content.includes("HMAC"));
});

test("agent loads auth, parameter and security references for trade prompts on selected skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-agent-"));
  const skillRoot = join(home, "skills", "spot");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(join(skillRoot, "references", "authentication.md"), "HMAC signing rules", "utf8");
  await writeFile(join(skillRoot, "references", "parameters.md"), "quoteOrderQty, minNotional, precision rules", "utf8");
  await writeFile(join(skillRoot, "references", "security.md"), "mainnet confirmation and approval policy", "utf8");

  const spotSkill = {
    manifest: {
      name: "spot",
      version: "1.0.0",
      description: "现货交易技能",
      capabilities: ["trade"],
      requires_auth: true,
      dangerous: true,
      products: ["spot"],
      tools: ["spot.placeOrder"],
    },
    toolDefinitions: [],
    knowledge: {
      ...createEmptyKnowledge(),
      endpointHints: [
        {
          id: "spot.placeOrder",
          operation: "place order",
          description: "提交现货订单",
          method: "POST",
          path: "/api/v3/order",
          authRequired: true,
          requiredParams: ["symbol", "side", "type"],
          optionalParams: ["quantity", "quoteOrderQty"],
          transport: "binance-signed-http",
          dangerLevel: "mutating",
        },
      ],
      referenceFiles: [
        {
          relativePath: "references/authentication.md",
          absolutePath: join(skillRoot, "references", "authentication.md"),
        },
        {
          relativePath: "references/parameters.md",
          absolutePath: join(skillRoot, "references", "parameters.md"),
        },
        {
          relativePath: "references/security.md",
          absolutePath: join(skillRoot, "references", "security.md"),
        },
      ],
    },
    instructions: "## When to use\n用于现货下单。\n\n## Instructions\n优先检查参数、认证和安全规则。",
    sourcePath: join(skillRoot, "SKILL.md"),
    rootDir: skillRoot,
    warnings: [],
  } satisfies InstalledSkill;

  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const agent = new BinaClawAgent(config, {
    provider: new FakeProvider(),
    skills: [spotSkill],
    toolRegistry: createTestRegistry(),
  });

  await agent.handleInput("BTCUSDT 现货，市价买入 20 USDT");
  const referenceContext = agent.getSession().referenceContext ?? [];
  assert.deepEqual(
    referenceContext.map((item) => item.relativePath),
    [
      "references/authentication.md",
      "references/parameters.md",
      "references/security.md",
    ],
  );
});
