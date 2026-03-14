import assert from "node:assert/strict";
import test from "node:test";
import {formatTraceJson, formatTraceView, isTraceFilterKind} from "../src/cli/trace.ts";
import {BinaClawAgent} from "../src/core/agent.ts";
import {createAppConfig} from "../src/core/config.ts";
import type {SessionState} from "../src/core/types.ts";

test("formatTraceView renders reasoning steps and pending approval", () => {
  const session: SessionState = {
    messages: [],
    activeSkills: ["market-overview", "spot-account"],
    pendingApproval: {
      id: "1",
      toolId: "spot.placeOrder",
      summary: "confirm",
      riskLevel: "high",
      payloadPreview: "{\"symbol\":\"BTCUSDT\"}",
      expiresAt: new Date().toISOString(),
      toolCall: {
        toolId: "spot.placeOrder",
        input: { symbol: "BTCUSDT" },
        dangerous: true,
      },
    },
    scratchpad: [
      {
        timestamp: new Date().toISOString(),
        iteration: 0,
        kind: "intent",
        summary: "收到用户请求",
        detail: "分析 BTCUSDT",
      },
      {
        timestamp: new Date().toISOString(),
        iteration: 1,
        kind: "observation",
        summary: "工具 market.getTicker 执行成功",
        detail: "{\"price\":\"100000\"}",
      },
    ],
  };

  const view = formatTraceView(session);
  assert.ok(view.includes("Desk status"));
  assert.ok(view.includes("active skills: market-overview, spot-account"));
  assert.ok(view.includes("pending approval: spot.placeOrder"));
  assert.ok(view.includes("iter 1 · observation"));
});

test("formatTraceView supports filtering by reasoning kind", () => {
  const session: SessionState = {
    messages: [],
    activeSkills: ["market-overview"],
    scratchpad: [
      {
        timestamp: new Date().toISOString(),
        iteration: 0,
        kind: "plan",
        summary: "规划 market.getTicker",
      },
      {
        timestamp: new Date().toISOString(),
        iteration: 1,
        kind: "observation",
        summary: "ticker 返回成功",
      },
    ],
  };

  const view = formatTraceView(session, 12, "observation");
  assert.ok(view.includes("Recent reasoning (observation)"));
  assert.ok(view.includes("ticker 返回成功"));
  assert.ok(!view.includes("规划 market.getTicker"));
});

test("formatTraceJson renders structured trace payload", () => {
  const session: SessionState = {
    messages: [],
    activeSkills: ["market-overview"],
    scratchpad: [
      {
        timestamp: new Date().toISOString(),
        iteration: 0,
        kind: "plan",
        summary: "规划了 1 个工具",
        detail: "{\"tool\":\"market.getTicker\"}",
      },
    ],
  };

  const json = formatTraceJson(session);
  assert.ok(json.includes("\"activeSkills\""));
  assert.ok(json.includes("\"kind\": \"plan\""));
});

test("agent clearTrace removes scratchpad history", () => {
  const agent = new BinaClawAgent(createAppConfig({ BINACLAW_HOME: "/tmp/binaclaw-trace-test" }, process.cwd()), {
    skills: [],
  });
  agent.getSession().scratchpad.push({
    timestamp: new Date().toISOString(),
    iteration: 0,
    kind: "intent",
    summary: "demo",
  });

  agent.clearTrace();
  assert.equal(agent.getSession().scratchpad.length, 0);
});

test("isTraceFilterKind validates supported filter names", () => {
  assert.equal(isTraceFilterKind("plan"), true);
  assert.equal(isTraceFilterKind("observation"), true);
  assert.equal(isTraceFilterKind("json"), false);
});
