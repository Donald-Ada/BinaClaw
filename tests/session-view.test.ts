import assert from "node:assert/strict";
import test from "node:test";
import {formatSessionJson, formatSessionView} from "../src/cli/session.ts";
import type {SessionState} from "../src/core/types.ts";

test("formatSessionView renders topic state", () => {
  const session: SessionState = {
    id: "main",
    createdAt: "2026-03-14T10:00:00.000Z",
    updatedAt: "2026-03-14T10:10:00.000Z",
    messages: [
      { role: "user", content: "今天 BNB 能买吗" },
      { role: "assistant", content: "我先看短线信号。" },
    ],
    scratchpad: [],
    activeSkills: ["alpha", "spot"],
    conversationState: {
      currentSymbol: "BNBUSDT",
      currentTopic: "market",
      currentMarketType: "spot",
      summary: "延续 BNB 现货分析。",
    },
  };

  const view = formatSessionView(session);
  assert.match(view, /Session identity/);
  assert.match(view, /BNBUSDT/);
  assert.doesNotMatch(view, /Compaction/);
});

test("formatSessionJson renders structured session payload", () => {
  const session: SessionState = {
    messages: [],
    scratchpad: [],
    activeSkills: [],
  };

  const json = formatSessionJson(session);
  assert.equal(typeof json, "string");
  assert.match(json, /"messages": \[/);
});
