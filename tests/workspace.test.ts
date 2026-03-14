import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createAppConfig, ensureAppDirectories} from "../src/core/config.ts";
import {MemoryStore} from "../src/core/memory.ts";
import {getWorkspaceDocumentPaths, ensureWorkspaceBootstrapFiles} from "../src/core/workspace.ts";

test("ensureWorkspaceBootstrapFiles creates OpenClaw-style workspace docs", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-workspace-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  await ensureAppDirectories(config);
  await ensureWorkspaceBootstrapFiles(config);

  const agents = await readFile(config.workspaceAgentsFile, "utf8");
  const soul = await readFile(config.workspaceSoulFile, "utf8");
  const user = await readFile(config.workspaceUserFile, "utf8");
  const identity = await readFile(config.workspaceIdentityFile, "utf8");
  const heartbeat = await readFile(config.workspaceHeartbeatFile, "utf8");
  const bootstrap = await readFile(config.workspaceBootstrapFile, "utf8");
  const memory = await readFile(config.workspaceLongTermMemoryFile, "utf8");

  assert.match(agents, /AGENTS\.md/);
  assert.match(soul, /SOUL\.md/);
  assert.match(user, /USER\.md/);
  assert.match(identity, /IDENTITY\.md/);
  assert.match(heartbeat, /HEARTBEAT\.md/);
  assert.match(bootstrap, /BOOTSTRAP\.md/);
  assert.match(memory, /BinaClaw Memory/);

  const memoryStore = new MemoryStore(
    config.memoryFile,
    config.workspaceMemoryDir,
    config.workspaceLongTermMemoryFile,
    getWorkspaceDocumentPaths(config),
  );
  const context = await memoryStore.getWorkspaceContext(1);
  assert.match(context.workspaceDocs?.agents ?? "", /优先使用已安装 skill/);
  assert.match(context.workspaceDocs?.identity ?? "", /BinaClaw/);
});
