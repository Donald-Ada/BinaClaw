import assert from "node:assert/strict";
import test from "node:test";
import {createAppConfig} from "../src/core/config.ts";
import {
  createSpinnerController,
  createTextStreamRenderer,
  formatAgentBlock,
  formatApprovalCard,
  formatInfoBlock,
  formatOnboardingCompletion,
  formatOnboardingSavedSummary,
  formatOnboardingSection,
  formatOnboardingWelcome,
  formatSkillsTable,
  renderPanel,
  renderMarkdownForTerminal,
  renderStatusBar,
  renderWelcomeBanner,
  resolveStatusPhase,
} from "../src/cli/ui.ts";
import type {InstalledSkill, SkillKnowledge} from "../src/core/types.ts";

test("renderWelcomeBanner shows trading-desk style header", () => {
  const config = createAppConfig(
    {
      BINACLAW_HOME: "/tmp/binaclaw-ui",
      OPENAI_MODEL: "gpt-5.4",
      BINANCE_API_KEY: "demo",
      BINANCE_API_SECRET: "demo-secret",
    },
    "/Users/demo/workspace",
  );

  const banner = renderWelcomeBanner(config, [
    { symbol: "BTCUSDT", priceText: "70,647.82", changeText: "+1.23%", direction: "up" },
    { symbol: "ETHUSDT", priceText: "3,802.10", changeText: "-0.41%", direction: "down" },
  ]);
  assert.ok(banner.includes("BinaClaw"));
  assert.ok(banner.includes("Trading Desk"));
  assert.ok(banner.includes("BinaClaw: Trading Desk"));
  assert.ok(banner.includes("MODEL"));
  assert.ok(banner.includes("gpt-5.4"));
  assert.ok(banner.includes("RUNTIME"));
  assert.ok(banner.includes("NETWORK"));
  assert.ok(banner.includes("local runtime"));
  assert.ok(banner.includes("pulse:"));
  assert.ok(banner.includes("tip:"));
  assert.ok(banner.includes("pulse"));
  assert.ok(banner.includes("BTC"));
  assert.ok(banner.includes("/Users/demo/workspace"));
});

test("onboarding panels show grouped first-run flow", () => {
  const config = createAppConfig(
    {
      BINACLAW_HOME: "/tmp/binaclaw-onboard",
      OPENAI_API_KEY: "demo-openai",
      OPENAI_MODEL: "gpt-5.4",
      TELEGRAM_BOT_TOKEN: "demo-telegram",
      BRAVE_SEARCH_API_KEY: "demo-brave",
      BINANCE_API_KEY: "demo-binance",
      BINANCE_API_SECRET: "demo-binance-secret",
      TELEGRAM_ALLOWED_USER_IDS: "123456",
    },
    "/Users/demo/workspace",
  );

  const welcome = formatOnboardingWelcome(config);
  const section = formatOnboardingSection(
    3,
    5,
    "Telegram",
    "配置 Bot Token 和允许访问的 Telegram 用户 ID。",
    ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"],
  );
  const summary = formatOnboardingSavedSummary(config);
  const complete = formatOnboardingCompletion(config, "/tmp/gateway.log", "/tmp/telegram.log");

  assert.ok(welcome.includes("BinaClaw: First Run"));
  assert.ok(welcome.includes("CONFIG"));
  assert.ok(welcome.includes("LOCAL ENV"));
  assert.ok(welcome.includes("TIP"));
  assert.ok(section.includes("Onboard 3/5: Telegram"));
  assert.ok(section.includes("TELEGRAM_BOT_TOKEN"));
  assert.ok(section.includes("TELEGRAM_ALLOWED_USER_IDS"));
  assert.ok(summary.includes("Onboard Snapshot"));
  assert.ok(summary.includes("stored in local env"));
  assert.ok(complete.includes("Desk Online"));
  assert.ok(complete.includes("binaclaw gateway stop"));
  assert.ok(complete.includes("Telegram"));
});

test("renderPanel keeps border width stable for CJK content", () => {
  const panel = renderPanel(
    "BinaClaw: First Run",
    [
      "把本地交易台、模型、Telegram Bot 和 Binance 本机密钥一次配好。",
      "TIP         Gateway Port 一般保持默认即可，只有端口冲突时再改",
    ],
    "brand",
    { useColor: true },
  );

  const widths = panel
    .split("\n")
    .map((line) => terminalWidth(stripAnsi(line)));

  assert.ok(widths.length > 2);
  assert.ok(widths.every((width) => width === widths[0]));
});

test("renderMarkdownForTerminal removes common markdown source markers", () => {
  const rendered = renderMarkdownForTerminal([
    "# Analysis",
    "",
    "- **BTC** looks strong",
    "- See [docs](https://example.com)",
    "",
    "```ts",
    "const price = 1;",
    "```",
  ].join("\n"));

  assert.ok(rendered.includes("Analysis"));
  assert.ok(rendered.includes("• BTC looks strong"));
  assert.ok(rendered.includes("See docs (https://example.com)"));
  assert.ok(rendered.includes("const price = 1;"));
  assert.ok(!rendered.includes("```"));
  assert.ok(!rendered.includes("**BTC**"));
});

test("formatAgentBlock wraps rendered response with analyst block chrome", () => {
  const block = formatAgentBlock("## Summary\n- done");
  assert.ok(block.includes("ANALYST"));
  assert.ok(block.includes("ANALYST: BinaClaw"));
  assert.ok(block.includes("Summary"));
  assert.ok(block.includes("• done"));
});

test("createSpinnerController renders a single-line tty spinner", async () => {
  const writes: string[] = [];
  const spinner = createSpinnerController((chunk) => {
    writes.push(chunk);
  }, true);

  spinner.update("正在规划技能与工具...");
  await new Promise((resolve) => setTimeout(resolve, 120));
  spinner.stop();

  assert.ok(writes.some((chunk) => chunk.includes("\r\u001b[2K")));
  assert.ok(writes.some((chunk) => chunk.includes("WORKING")));
  assert.ok(writes.some((chunk) => chunk.includes("规划行动")));
  assert.ok(writes.some((chunk) => chunk.includes("/trace 查看过程")));
});

test("renderStatusBar maps runtime phases into desk labels", () => {
  const line = renderStatusBar(7, "正在快速获取 3 个市场信号...");
  assert.ok(line.includes("WORKING"));
  assert.ok(line.includes("获取实时行情"));
  assert.equal(resolveStatusPhase("正在加载技能参考..."), "references");
});

test("formatInfoBlock renders boxed panel variants", () => {
  const block = formatInfoBlock("Trace", "Desk status\n- active skills: alpha", "trace");
  assert.ok(block.includes("Trace"));
  assert.ok(block.includes("Desk status"));
  assert.ok(block.includes("active skills"));
});

test("formatSkillsTable renders compact trading-desk grid", () => {
  const table = formatSkillsTable([
    createSkill("alpha", {
      version: "1.0.0",
      requiresAuth: false,
      dangerous: false,
      capabilities: ["alpha", "ticker", "klines"],
      endpointCount: 5,
    }),
    createSkill("spot", {
      version: "1.4.2",
      requiresAuth: true,
      dangerous: true,
      capabilities: ["spot", "orders"],
      endpointCount: 12,
      warnings: ["missing examples"],
    }),
  ]);

  assert.ok(table.includes("Skill Deck"));
  assert.ok(table.includes("SKILL"));
  assert.ok(table.includes("AUTH"));
  assert.ok(table.includes("alpha"));
  assert.ok(table.includes("spot"));
  assert.ok(table.includes("HOLD"));
  assert.ok(table.includes("warnings 1"));
});

test("formatApprovalCard renders confirmation panel without payload preview", () => {
  const approval = {
    id: "approval-1",
    toolId: "spot.placeOrder",
    summary: [
      "当前操作需要确认。",
      "操作: spot.placeOrder",
      "风险等级: 高",
      "账户摘要: 可用余额充足",
      "请在 5 分钟内输入 CONFIRM 确认，或输入 CANCEL 取消。",
    ].join("\n"),
    riskLevel: "high" as const,
    payloadPreview: "{\"symbol\":\"BTCUSDT\"}",
    expiresAt: "2026-03-15T10:00:00.000Z",
    toolCall: {
      toolId: "spot.placeOrder",
      input: {symbol: "BTCUSDT", quantity: "0.01"},
      dangerous: true,
    },
  };

  const card = formatApprovalCard(approval);
  assert.ok(card.includes("Execution Hold"));
  assert.ok(card.includes("spot.placeOrder"));
  assert.ok(card.includes("CONFIRM"));
  assert.ok(card.includes("可用余额充足"));
  assert.ok(!card.includes("BTCUSDT"));
});

test("createTextStreamRenderer only emits new suffixes during streaming", () => {
  const renderer = createTextStreamRenderer();
  const chunks = [
    renderer.append("可以，基于你当前这批 Binance 实时数据，我给你做一个**今天 BTC"),
    renderer.append(" 和 ETH 的盘面简析，偏短线/合约交易视角。\n\n总结先看\n- BTC：整体是**高位震"),
    renderer.append("荡偏弱**，情绪不算差。"),
    renderer.flush(),
  ];

  const combined = chunks.join("");
  assert.equal(combined.includes("可以，基于你当前这批 Binance 实时数据"), true);
  assert.equal(combined.match(/可以，基于你当前这批 Binance 实时数据/g)?.length, 1);
  assert.equal(renderer.current().includes("高位震荡偏弱"), true);
});

test("createTextStreamRenderer does not duplicate split price fragments", () => {
  const renderer = createTextStreamRenderer();
  const chunks = [
    renderer.append("BTC 最新价格 70647."),
    renderer.append("82"),
    renderer.flush(),
  ];

  const combined = chunks.join("");
  assert.equal(combined.includes("70647.70647.82"), false);
  assert.equal(combined.match(/70647\.82/g)?.length, 1);
  assert.equal(renderer.current().includes("70647.82"), true);
});

function createSkill(
  name: string,
  options: {
    version: string;
    requiresAuth: boolean;
    dangerous: boolean;
    capabilities: string[];
    endpointCount: number;
    warnings?: string[];
  },
): InstalledSkill {
  const knowledge: SkillKnowledge = {
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
    endpointHints: Array.from({ length: options.endpointCount }, (_, index) => ({
      id: `${name}.${index + 1}`,
      operation: `op-${index + 1}`,
      description: "",
      method: "GET",
      path: "",
      authRequired: options.requiresAuth,
      requiredParams: [],
      optionalParams: [],
      transport: options.requiresAuth ? "binance-signed-http" : "binance-public-http",
      dangerLevel: options.dangerous ? "mutating" : "readonly",
    })),
    authHints: {
      requiresApiKey: options.requiresAuth,
      requiresSecretKey: options.requiresAuth,
      signatureAlgorithms: [],
      headerNames: [],
      baseUrls: [],
      confirmOnTransactions: options.dangerous,
    },
    referenceFiles: [],
    executionHints: [],
    policyRules: [],
  };

  return {
    manifest: {
      name,
      version: options.version,
      description: `${name} description`,
      capabilities: options.capabilities,
      requires_auth: options.requiresAuth,
      dangerous: options.dangerous,
      products: [],
      tools: [],
    },
    toolDefinitions: [],
    knowledge,
    instructions: "",
    sourcePath: `/tmp/${name}/SKILL.md`,
    rootDir: `/tmp/${name}`,
    warnings: options.warnings ?? [],
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function terminalWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width += characterWidth(character);
  }
  return width;
}

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0);
  if (!codePoint) {
    return 0;
  }
  if (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x300 && codePoint <= 0x36f)
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }
  return 1;
}
