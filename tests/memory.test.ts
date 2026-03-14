import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {MemoryStore} from "../src/core/memory.ts";
import {getWorkspaceDocumentPaths} from "../src/core/workspace.ts";
import {createAppConfig} from "../src/core/config.ts";

test("MemoryStore appends daily log and reads recent workspace context", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-memory-"));
  const workspaceDir = join(home, "workspace");
  const workspaceMemoryDir = join(workspaceDir, "memory");
  const longTermFile = join(workspaceDir, "MEMORY.md");
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const store = new MemoryStore(join(home, "memory.json"), workspaceMemoryDir, longTermFile, getWorkspaceDocumentPaths(config));

  await store.appendDailyLog("user", "我最近重点关注 BTCUSDT");
  await store.appendLongTermMemory("Preferences", "用户偏好中文输出，偏好现货市场。");

  const context = await store.getWorkspaceContext(2);
  assert.ok(context.longTermMemory.includes("偏好中文输出"));
  assert.equal(context.recentEntries.length, 1);
  assert.ok(context.recentEntries[0]?.content.includes("BTCUSDT"));
});

test("MemoryStore searchWorkspaceMemory returns matching snippets", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-memory-"));
  const workspaceDir = join(home, "workspace");
  const workspaceMemoryDir = join(workspaceDir, "memory");
  const longTermFile = join(workspaceDir, "MEMORY.md");
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const store = new MemoryStore(join(home, "memory.json"), workspaceMemoryDir, longTermFile, getWorkspaceDocumentPaths(config));

  await store.appendDailyLog("assistant", "用户询问 ETHUSDT 是否值得继续关注。");
  const matches = await store.searchWorkspaceMemory("ETHUSDT");
  assert.equal(matches.length, 1);
  assert.ok(matches[0]?.snippet.includes("ETHUSDT"));
});

test("MemoryStore promotes stable user profile facts into USER.md without duplicate spam", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-memory-"));
  const workspaceDir = join(home, "workspace");
  const workspaceMemoryDir = join(workspaceDir, "memory");
  const longTermFile = join(workspaceDir, "MEMORY.md");
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const store = new MemoryStore(join(home, "memory.json"), workspaceMemoryDir, longTermFile, getWorkspaceDocumentPaths(config));

  const promoted = await store.promoteStableFactsFromText("请用中文回答，我主要看 BTC，偏好现货，风格稳健。");
  await store.promoteStableFactsFromText("请用中文回答，我主要看 BTC，偏好现货，风格稳健。");

  const userProfile = await readFile(config.workspaceUserFile, "utf8");
  assert.ok(promoted.includes("用户偏好中文输出"));
  assert.ok(userProfile.includes("用户长期关注交易对 BTCUSDT"));
  assert.equal((userProfile.match(/用户偏好中文输出/g) ?? []).length, 1);
});
