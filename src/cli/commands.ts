import {access} from "node:fs/promises";
import {constants} from "node:fs";
import {createAppConfig, ensureAppDirectories} from "../core/config.ts";
import {formatConfigSummary, runInteractiveConfigWizard} from "./config-wizard.ts";
import {runOnboard} from "./onboard.ts";
import {SessionManager} from "../core/session.ts";
import {MemoryStore} from "../core/memory.ts";
import {installSkillsFromSource, loadInstalledSkills, syncWorkspaceToolsIndex} from "../core/skill.ts";
import {stopManagedService} from "../core/service-manager.ts";
import {formatSessionView} from "./session.ts";
import {formatSkillsTable} from "./ui.ts";
import {ensureWorkspaceBootstrapFiles, getWorkspaceDocumentPaths} from "../core/workspace.ts";

export async function runCommand(argv: string[]): Promise<void> {
  const [command, subcommand, source] = argv;
  const config = createAppConfig();
  await ensureAppDirectories(config);
  await ensureWorkspaceBootstrapFiles(config);

  switch (command) {
    case "gateway":
      if (subcommand === "stop") {
        const telegramStopped = await stopManagedService(config, "telegram");
        const gatewayStopped = await stopManagedService(config, "gateway");
        if (gatewayStopped && telegramStopped) {
          console.log("后台 Gateway 和 Telegram provider 已停止。");
          return;
        }
        if (gatewayStopped) {
          console.log("后台 Gateway 已停止。");
          return;
        }
        if (telegramStopped) {
          console.log("Gateway 未在运行，已顺带停止 Telegram provider。");
          return;
        }
        console.log("后台 Gateway 未在运行。");
        return;
      }
      return (await import("../gateway/server.ts")).runGatewayServer(config);
    case "telegram":
      if (subcommand === "stop") {
        const stopped = await stopManagedService(config, "telegram");
        console.log(stopped ? "后台 Telegram provider 已停止。" : "后台 Telegram provider 未在运行。");
        return;
      }
      return (await import("../gateway/providers/telegram.ts")).runTelegramProvider(config);
    case "chat":
      return (await import("./chat.ts")).runChat();
    case "skills":
      if (subcommand === "add") {
        if (!source) {
          console.log("用法: binaclaw skills add <本地路径、SKILL.md URL 或 GitHub repo URL>");
          return;
        }
        const skills = await installSkillsFromSource(source, config);
        await syncWorkspaceToolsIndex(config, await loadInstalledSkills(config));
        console.log(`已安装 ${skills.length} 个 skills:`);
        console.log(formatSkillsTable(skills).trimEnd());
        const warnings = skills.flatMap((skill) => skill.warnings.map((warning) => `${skill.manifest.name}: ${warning}`));
        if (warnings.length > 0) {
          console.log("Warnings:");
          console.log(warnings.map((item) => `- ${item}`).join("\n"));
        }
        return;
      }
      if (subcommand === "list") {
        const skills = await loadInstalledSkills(config);
        await syncWorkspaceToolsIndex(config, skills);
        if (skills.length === 0) {
          console.log("当前没有已安装的 skills。");
          return;
        }
        console.log(formatSkillsTable(skills).trimEnd());
        return;
      }
      console.log("可用子命令: add, list");
      return;
    case "auth":
      if (subcommand !== "status") {
        console.log("用法: binaclaw auth status");
        return;
      }
      console.log(formatConfigSummary(config));
      console.log(`Network: ${config.binance.useTestnet ? "testnet" : "mainnet"}`);
      return;
    case "config":
      await runInteractiveConfigWizard();
      return;
    case "onboard":
      await runOnboard();
      return;
    case "session": {
      const sessionManager = new SessionManager(
        config.workspaceSessionsIndexFile,
        config.workspaceSessionTranscriptsDir,
      );
      if (subcommand === "clear") {
        await sessionManager.clear();
        console.log("当前会话已清空。");
        return;
      }
      const session = await sessionManager.load();
      console.log(formatSessionView(session));
      return;
    }
    case "doctor": {
      const skills = await loadInstalledSkills(config);
      await syncWorkspaceToolsIndex(config, skills);
      const checks = [
        `Node runtime: ${process.version}`,
        `App home: ${config.appHome}`,
        `Config file: ${config.configFile}`,
        `Local env file: ${config.localEnvFile}`,
        `Gateway URL: ${config.gateway.url ?? "disabled"}`,
        `Gateway listen: ws://${config.gateway.host}:${config.gateway.port}`,
        `Telegram bot: ${config.telegram.botToken ? "configured" : "disabled"}`,
        `Bundled skills dir: ${config.bundledSkillsDir}`,
        `Global skills dir: ${config.globalSkillsDir}`,
        `Local skills dir: ${config.localSkillsDir}`,
        `Loaded skills: ${skills.length}`,
        `Workspace TOOLS.md: ${config.workspaceToolsFile}`,
        `Workspace sessions index: ${config.workspaceSessionsIndexFile}`,
        `Workspace session transcripts dir: ${config.workspaceSessionTranscriptsDir}`,
        `Binance auth: ${config.binance.apiKey && config.binance.apiSecret ? "ready" : "read-only mode"}`,
        `Brave Search: ${config.brave.apiKey ? "configured" : "disabled"}`,
        `LLM provider: ${config.provider.apiKey ? "configured" : "fallback summaries only"}`,
      ];

      try {
        await access(config.localSkillsDir, constants.R_OK);
        checks.push("Local skills directory: readable");
      } catch {
        checks.push("Local skills directory: not found (this is okay)");
      }

      console.log(checks.join("\n"));
      if (skills.some((skill) => skill.warnings.length > 0)) {
        console.log("Warnings:");
        console.log(
          skills
            .filter((skill) => skill.warnings.length > 0)
            .map((skill) => `${skill.manifest.name}: ${skill.warnings.join("; ")}`)
            .join("\n"),
        );
      }
      return;
    }
    default:
      console.log([
        "BinaClaw CLI",
        "用法:",
        "- binaclaw gateway",
        "- binaclaw gateway stop",
        "- binaclaw telegram",
        "- binaclaw telegram stop",
        "- binaclaw chat",
        "- binaclaw config",
        "- binaclaw onboard",
        "- binaclaw session",
        "- binaclaw session clear",
        "- binaclaw skills add <source>",
        "- binaclaw skills list",
        "- binaclaw auth status",
        "- binaclaw doctor",
      ].join("\n"));
  }
}
