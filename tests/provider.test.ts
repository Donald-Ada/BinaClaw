import assert from "node:assert/strict";
import test from "node:test";
import {OpenAICompatibleProvider} from "../src/core/provider.ts";
import type {
  PlanningRequest,
  SessionCompactionRequest,
  SkillKnowledge,
  SkillReferenceSelectionRequest,
  SkillSelectionRequest,
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

function createFakeClient(
  handler: (params: {
    model: string;
    input: Array<{ role: string; content: Array<{ type: "input_text"; text: string }> }>;
    tools?: Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }>;
  }) => Promise<{ output_text?: string; output?: Array<{ type?: string; name?: string; arguments?: string }> }>,
) {
  return {
    responses: {
      create: handler,
      stream: async () => (async function* () {})(),
    },
  };
}

function createStreamingFakeClient(
  events: Array<{ type?: string; delta?: string; response?: { output_text?: string } }>,
) {
  return {
    responses: {
      create: async () => ({ output_text: "" }),
      stream: async () =>
        (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
    },
  };
}

test("OpenAICompatibleProvider selects skills from semantic descriptions", async () => {
  let seenParams:
    | {
        model: string;
        input: Array<{ role: string; content: Array<{ type: "input_text"; text: string }> }>;
        tools?: Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }>;
      }
    | undefined;
  const provider = new OpenAICompatibleProvider(
    {
      apiKey: "demo-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
    },
    createFakeClient(async (params) => {
      seenParams = params;
      return {
        output_text: JSON.stringify({
          skillNames: ["market-overview", "news-signal"],
          rationale: "先看行情，再结合新闻。",
        }),
      };
    }),
  );

  const request: SkillSelectionRequest = {
    input: "给我分析 BTC 现在能不能买",
    skills: [
      {
        manifest: {
          name: "market-overview",
          version: "1.0.0",
          description: "现货与合约的行情分析技能",
          capabilities: ["ticker", "depth"],
          requires_auth: false,
          dangerous: false,
          products: ["spot"],
          tools: ["market.getTicker"],
        },
        toolDefinitions: [],
        knowledge: createEmptyKnowledge(),
        instructions: "## When to use\n分析行情时使用。\n\n## Instructions\n先看价格、深度和K线。",
        sourcePath: "market.md",
        rootDir: process.cwd(),
        warnings: [],
      },
      {
        manifest: {
          name: "news-signal",
          version: "1.0.0",
          description: "热点资讯技能",
          capabilities: ["news"],
          requires_auth: false,
          dangerous: false,
          products: ["content"],
          tools: ["news.getSignal"],
        },
        toolDefinitions: [],
        knowledge: createEmptyKnowledge(),
        instructions: "## When to use\n需要看热点时使用。\n\n## Instructions\n补充新闻语境。",
        sourcePath: "news.md",
        rootDir: process.cwd(),
        warnings: [],
      },
    ],
    session: {
      messages: [
        { role: "user", content: "今天 BNB 能买吗" },
        { role: "assistant", content: "可以继续看 BNB 的实时信号。" },
        { role: "user", content: "继续" },
      ],
      scratchpad: [],
      activeSkills: [],
    },
    authAvailable: false,
    memoryContext: {
      longTermMemory: "",
      recentEntries: [],
      workspaceDocs: {
        agents: "# AGENTS.md\n优先使用 skill。",
        soul: "# SOUL.md\n冷静专业。",
        user: "# USER.md\n默认中文。",
        identity: "# IDENTITY.md\nBinaClaw。",
        heartbeat: "# HEARTBEAT.md\n检查 session。",
        bootstrap: "# BOOTSTRAP.md\n首次运行检查。",
        tools: "# TOOLS.md\nalpha, spot",
      },
    },
  };

  const result = await provider.selectSkills(request);
  assert.deepEqual(result?.skillNames, ["market-overview", "news-signal"]);
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("最近会话:"));
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("workspace docs 摘要:"));
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("AGENTS"));
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("今天 BNB 能买吗"));
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("继续"));
});

test("OpenAICompatibleProvider selects references from active skills", async () => {
  const provider = new OpenAICompatibleProvider(
    {
      apiKey: "demo-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
    },
    createFakeClient(async () => ({
      output_text: JSON.stringify({
        references: [
          {
            skillName: "alpha",
            relativePath: "references/authentication.md",
          },
        ],
        rationale: "当前问题涉及签名和认证，需要读 authentication reference。",
      }),
    })),
  );

  const request: SkillReferenceSelectionRequest = {
    input: "alpha 的签名规则是什么",
    activeSkills: [
      {
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
          referenceFiles: [
            {
              relativePath: "references/authentication.md",
              absolutePath: "/tmp/authentication.md",
            },
          ],
        },
        instructions: "",
        sourcePath: "alpha/SKILL.md",
        rootDir: process.cwd(),
        warnings: [],
      },
    ],
    session: {
      messages: [],
      scratchpad: [],
      activeSkills: ["alpha"],
    },
    authAvailable: true,
  };

  const result = await provider.selectSkillReferences(request);
  assert.deepEqual(result?.references, [
    {
      skillName: "alpha",
      relativePath: "references/authentication.md",
    },
  ]);
});

test("OpenAICompatibleProvider resolves conversation state from recent session", async () => {
  const provider = new OpenAICompatibleProvider(
    {
      apiKey: "demo-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
    },
    createFakeClient(async () => ({
      output_text: JSON.stringify({
        currentSymbol: "BNBUSDT",
        currentTopic: "market",
        currentMarketType: "spot",
        summary: "用户仍在延续 BNB 的现货行情分析。",
      }),
    })),
  );

  const result = await provider.resolveConversationState?.({
    input: "继续",
    session: {
      messages: [
        { role: "user", content: "今天 BNB 能买吗" },
        { role: "assistant", content: "我先看 BNB 的实时信号。" },
        { role: "user", content: "继续" },
      ],
      scratchpad: [],
      activeSkills: ["market-overview"],
    },
  });

  assert.deepEqual(result, {
    currentSymbol: "BNBUSDT",
    currentTopic: "market",
    currentMarketType: "spot",
    summary: "用户仍在延续 BNB 的现货行情分析。",
  });
});

test("OpenAICompatibleProvider compacts session context into summary and durable facts", async () => {
  const provider = new OpenAICompatibleProvider(
    {
      apiKey: "demo-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
    },
    createFakeClient(async () => ({
      output_text: JSON.stringify({
        summary: "此前会话主要围绕 BNB 现货短线判断。",
        durableFacts: ["用户长期关注交易对 BNBUSDT"],
        conversationState: {
          currentSymbol: "BNBUSDT",
          currentTopic: "market",
          currentMarketType: "spot",
          summary: "延续 BNB 现货分析。",
        },
      }),
    })),
  );

  const result = await provider.compactSession?.({
    session: {
      messages: [
        { role: "user", content: "今天 BNB 能买吗" },
        { role: "assistant", content: "我先看 BNB 的实时信号。" },
      ],
      scratchpad: [],
      activeSkills: [],
      compactionSummary: "此前曾分析过 BNB。",
    },
    messagesToCompact: [
      { role: "user", content: "今天 BNB 能买吗" },
      { role: "assistant", content: "我先看 BNB 的实时信号。" },
    ],
    scratchpadToCompact: [],
    trigger: "messages",
  } satisfies SessionCompactionRequest);

  assert.equal(result?.conversationState?.currentSymbol, "BNBUSDT");
  assert.deepEqual(result?.durableFacts, ["用户长期关注交易对 BNBUSDT"]);
  assert.match(result?.summary ?? "", /BNB 现货短线判断/);
});

test("OpenAICompatibleProvider parses official responses tool output", async () => {
  let seenParams:
    | {
        model: string;
        input: Array<{ role: string; content: Array<{ type: "input_text"; text: string }> }>;
        tools?: Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }>;
      }
    | undefined;

  const provider = new OpenAICompatibleProvider(
    {
      apiKey: "demo-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
    },
    createFakeClient(async (params) => {
      seenParams = params;
      return {
        output_text: "先查新闻再决定。",
        output: [
          {
            type: "function_call",
            name: "news__getSignal",
            arguments: JSON.stringify({ query: "btc news" }),
          },
        ],
      };
    }),
  );

  const request: PlanningRequest = {
    input: "看下 BTC 新闻",
    candidateSkills: [
      {
        manifest: {
          name: "news-signal",
          version: "1.0.0",
          description: "news",
          capabilities: [],
          requires_auth: false,
          dangerous: false,
          products: [],
          tools: ["news.getSignal"],
        },
        toolDefinitions: [],
        knowledge: createEmptyKnowledge(),
        instructions: "",
        sourcePath: "news.md",
        rootDir: process.cwd(),
        warnings: [],
      },
    ],
    session: {
      messages: [
        { role: "user", content: "今天 BNB 能买吗" },
        { role: "assistant", content: "我先看 BNB 的实时价格和盘口。" },
        { role: "user", content: "继续" },
      ],
      scratchpad: [],
      activeSkills: ["news-signal"],
    },
    authAvailable: false,
    tools: [
      {
        id: "news.getSignal",
        description: "获取资讯",
        dangerous: false,
        authScope: "none",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
    ],
    observations: [],
    iteration: 0,
    memoryContext: {
      longTermMemory: "# BinaClaw Memory\n\n用户偏好中文。",
      recentEntries: [],
    },
    referenceContext: [
      {
        skillName: "news-signal",
        relativePath: "references/news.md",
        content: "Latest news endpoint and auth policy.",
      },
    ],
  };

  const result = await provider.plan(request);
  assert.equal(seenParams?.model, "gpt-5.4");
  assert.ok((seenParams?.tools?.length ?? 0) > 0);
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("最近会话:"));
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("今天 BNB 能买吗"));
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("继续"));
  assert.ok(seenParams?.input[1]?.content[0]?.text.includes("候选 skills:"));
  assert.equal(result?.toolCalls?.[0]?.toolId, "news.getSignal");
  assert.deepEqual(result?.toolCalls?.[0]?.input, { query: "btc news" });
});

test("OpenAICompatibleProvider extracts stable memory facts", async () => {
  const provider = new OpenAICompatibleProvider(
    {
      apiKey: "demo-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
    },
    createFakeClient(async () => ({
      output_text: JSON.stringify({
        facts: ["用户偏好中文输出", "用户长期关注交易对 SOLUSDT"],
      }),
    })),
  );

  const facts = await provider.extractStableFacts("以后优先看 SOL，请用中文回答");
  assert.deepEqual(facts, ["用户偏好中文输出", "用户长期关注交易对 SOLUSDT"]);
});

test("OpenAICompatibleProvider streams summary deltas", async () => {
  const provider = new OpenAICompatibleProvider(
    {
      apiKey: "demo-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
    },
    createStreamingFakeClient([
      { type: "response.output_text.delta", delta: "BTC " },
      { type: "response.output_text.delta", delta: "短线波动较大。" },
      { type: "response.completed", response: { output_text: "BTC 短线波动较大。" } },
    ]),
  );

  const deltas: string[] = [];
  const text = await provider.streamSummary!(
    {
      input: "分析 BTC",
      activeSkills: [],
      toolResults: [],
      session: {
        messages: [],
        scratchpad: [],
        activeSkills: [],
      },
    },
    (delta) => {
      deltas.push(delta);
    },
  );

  assert.deepEqual(deltas, ["BTC ", "短线波动较大。"]);
  assert.equal(text, "BTC 短线波动较大。");
});
