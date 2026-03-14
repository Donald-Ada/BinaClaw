import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createAppConfig} from "../src/core/config.ts";
import type {AgentTurnCallbacks} from "../src/core/agent.ts";
import type {InstalledSkill, SessionState} from "../src/core/types.ts";
import type {GatewayEventEnvelope, GatewayRequestEnvelope} from "../src/gateway/protocol.ts";
import {GatewayRuntime, type GatewayAgentLike} from "../src/gateway/runtime.ts";

test("GatewayRuntime handles health, session, and streaming chat requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-gateway-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());

  const session: SessionState = {
    id: "test-session",
    key: "cli:main",
    type: "main",
    transcriptFile: join(home, "workspace", "sessions", "test-session.jsonl"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    scratchpad: [],
    activeSkills: [],
  };

  const fakeAgent: GatewayAgentLike = {
    config,
    async initialize() {
      return;
    },
    async handleInput(input: string, callbacks?: AgentTurnCallbacks) {
      session.messages.push({ role: "user", content: input });
      callbacks?.onStatus?.("正在生成回复");
      callbacks?.onTextStart?.();
      callbacks?.onTextDelta?.("收到");
      callbacks?.onTextDelta?.("了");
      callbacks?.onTextDone?.("收到了");
      session.messages.push({ role: "assistant", content: "收到了" });
      session.updatedAt = new Date().toISOString();
      return {
        text: "收到了",
        toolResults: [],
      };
    },
    async reloadSkills(): Promise<InstalledSkill[]> {
      return [];
    },
    async getDeskMarketPulse() {
      return [];
    },
    getSession() {
      return session;
    },
    clearTrace() {
      session.scratchpad = [];
    },
    async clearSession() {
      session.messages = [];
      session.scratchpad = [];
      session.activeSkills = [];
      session.updatedAt = new Date().toISOString();
      return session;
    },
    async compactSessionNow() {
      return session;
    },
  };

  const runtime = new GatewayRuntime(config, async () => fakeAgent);

  const health = await runtime.handleRequest({
    kind: "request",
    requestId: "health-1",
    type: "health",
  });
  assert.deepEqual(health, { ok: true, name: "BinaClaw Gateway" });

  const pulse = await runtime.handleRequest({
    kind: "request",
    requestId: "pulse-1",
    type: "desk.pulse",
  });
  assert.equal("pulse" in pulse, true);
  if (!("pulse" in pulse)) {
    throw new Error("expected desk pulse response");
  }
  assert.deepEqual(pulse.pulse, []);

  const sessionResponse = await runtime.handleRequest({
    kind: "request",
    requestId: "session-1",
    type: "session.get",
    payload: { sessionKey: "cli:main" },
  });
  assert.equal("session" in sessionResponse, true);
  if (!("session" in sessionResponse)) {
    throw new Error("expected session response");
  }
  assert.equal(sessionResponse.session.key, "cli:main");

  const events: GatewayEventEnvelope[] = [];
  const chatRequest: GatewayRequestEnvelope = {
    kind: "request",
    requestId: "chat-1",
    type: "chat.send",
    payload: {
      input: "你好",
      sessionKey: "cli:main",
    },
  };
  const chatResponse = await runtime.handleRequest(chatRequest, {
    emit: (event) => events.push(event),
  });

  assert.equal("result" in chatResponse, true);
  if (!("result" in chatResponse) || !("session" in chatResponse)) {
    throw new Error("expected chat response");
  }
  assert.equal(chatResponse.result.text, "收到了");
  assert.equal(chatResponse.session.messages.at(-1)?.content, "收到了");
  assert.deepEqual(
    events.map((event) => event.type),
    ["chat.status", "chat.text_start", "chat.text_delta", "chat.text_delta", "chat.text_done", "chat.result"],
  );
});
