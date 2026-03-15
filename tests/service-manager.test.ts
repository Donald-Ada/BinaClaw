import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createAppConfig} from "../src/core/config.ts";
import {getLocalGatewayUrl, getManagedServicePaths, markManagedServiceReady, stopManagedService} from "../src/core/service-manager.ts";

test("getManagedServicePaths resolves pid, ready, and log files under app home", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-services-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());

  const paths = getManagedServicePaths(config, "gateway");
  assert.equal(paths.pidFile, join(home, "run", "gateway.pid"));
  assert.equal(paths.readyFile, join(home, "run", "gateway.ready.json"));
  assert.equal(paths.logFile, join(home, "logs", "gateway.log"));
});

test("getLocalGatewayUrl normalizes wildcard hosts for local clients", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-services-"));
  const config = createAppConfig(
    {
      BINACLAW_HOME: home,
      BINACLAW_GATEWAY_HOST: "0.0.0.0",
      BINACLAW_GATEWAY_PORT: "9009",
    },
    process.cwd(),
  );

  assert.equal(getLocalGatewayUrl(config), "ws://127.0.0.1:9009");
});

test("markManagedServiceReady writes readiness metadata when requested", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-services-"));
  const readyFile = join(home, "telegram.ready.json");
  const previous = process.env.BINACLAW_SERVICE_READY_FILE;
  process.env.BINACLAW_SERVICE_READY_FILE = readyFile;

  try {
    await markManagedServiceReady("telegram", { username: "demo_bot" });
    const raw = await readFile(readyFile, "utf8");
    const parsed = JSON.parse(raw) as {name: string; pid: number; username: string};
    assert.equal(parsed.name, "telegram");
    assert.equal(parsed.pid, process.pid);
    assert.equal(parsed.username, "demo_bot");
  } finally {
    if (previous === undefined) {
      delete process.env.BINACLAW_SERVICE_READY_FILE;
    } else {
      process.env.BINACLAW_SERVICE_READY_FILE = previous;
    }
  }
});

test("stopManagedService clears stale runtime files when no process is running", async () => {
  const home = await mkdtemp(join(tmpdir(), "binaclaw-services-"));
  const config = createAppConfig({ BINACLAW_HOME: home }, process.cwd());
  const paths = getManagedServicePaths(config, "gateway");

  await mkdir(config.runtimeDir, { recursive: true });
  await writeFile(paths.pidFile, "999999\n", "utf8");
  await writeFile(paths.readyFile, "{\"name\":\"gateway\"}\n", "utf8");

  const stopped = await stopManagedService(config, "gateway");
  assert.equal(stopped, true);
  await assert.rejects(() => readFile(paths.pidFile, "utf8"));
  await assert.rejects(() => readFile(paths.readyFile, "utf8"));
});
