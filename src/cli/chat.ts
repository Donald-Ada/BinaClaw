import {createInterface} from "node:readline/promises";
import {stdin as input, stdout as output} from "node:process";
import {createChatAgent, type ChatAgentLike} from "./chat-agent.ts";
import {runInteractiveConfigWizard} from "./config-wizard.ts";
import {formatSessionJson, formatSessionView} from "./session.ts";
import {formatTraceJson, formatTraceView, isTraceFilterKind} from "./trace.ts";
import {
  createTextStreamRenderer,
  createSpinnerController,
  formatAgentBlock,
  formatAgentStreamChunk,
  formatAgentStreamEnd,
  formatAgentStreamStart,
  formatApprovalCard,
  formatInfoBlock,
  formatSkillsTable,
  formatUserPrompt,
  renderWelcomeBanner,
} from "./ui.ts";

export async function runChat(): Promise<void> {
  const rl = createInterface({ input, output });
  const spinner = createSpinnerController((chunk) => output.write(chunk));
  const textRenderer = createTextStreamRenderer();
  let agent = createChatAgent();
  await agent.initialize();
  output.write(renderWelcomeBanner(agent.config, await loadDeskPulse(agent)));

  while (true) {
    const line = await rl.question(formatUserPrompt());
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }
    if (trimmed === "/exit") {
      break;
    }
    if (trimmed === "/help") {
      output.write(
        formatInfoBlock(
          "Commands",
          [
          "可用命令:",
          "- /exit: 退出",
          "- /config: 配置 OpenAI / Brave / Telegram 与本地运行参数；Binance key 仅支持环境变量",
          "- /skills: 重新加载并查看已安装 skills",
          "- /session: 查看当前会话状态和主题",
          "- /session json: 以 JSON 查看完整 session",
          "- /session clear: 清空当前会话与待确认状态",
          "- /trace: 查看最近的多轮推理轨迹和工具调用",
          "- /trace <kind>: 按 intent/plan/observation/approval/response/fallback 过滤",
          "- /trace json: 以 JSON 查看完整 trace",
          "- /trace clear: 清空当前会话 trace",
          "- 直接输入任务，例如: 分析 BTCUSDT, 查询现货余额, 买 0.01 BTCUSDT",
        ].join("\n"),
          "help",
        ),
      );
      continue;
    }
    if (trimmed === "/config") {
      spinner.stop();
      await runInteractiveConfigWizard(rl);
      agent = createChatAgent();
      await agent.initialize();
      output.write(formatInfoBlock("Config", "已重新加载配置并刷新当前 agent。", "success"));
      output.write(renderWelcomeBanner(agent.config, await loadDeskPulse(agent)));
      continue;
    }
    if (trimmed === "/skills") {
      spinner.stop();
      const skills = await agent.reloadSkills();
      output.write(formatSkillsTable(skills));
      continue;
    }
    if (trimmed === "/session") {
      spinner.stop();
      output.write(formatInfoBlock("Session", formatSessionView(agent.getSession()), "session"));
      continue;
    }
    if (trimmed === "/session clear") {
      spinner.stop();
      await agent.clearSession();
      output.write(formatInfoBlock("Session", "当前会话已清空。", "success"));
      continue;
    }
    if (trimmed === "/session json") {
      spinner.stop();
      output.write(formatInfoBlock("Session JSON", formatSessionJson(agent.getSession()), "json"));
      continue;
    }
    if (trimmed === "/trace") {
      spinner.stop();
      output.write(formatInfoBlock("Trace", formatTraceView(agent.getSession()), "trace"));
      continue;
    }
    if (trimmed.startsWith("/trace ")) {
      const arg = trimmed.slice("/trace ".length).trim();
      if (arg === "json") {
        spinner.stop();
        output.write(formatInfoBlock("Trace JSON", formatTraceJson(agent.getSession()), "json"));
        continue;
      }
      if (arg === "clear") {
        spinner.stop();
        agent.clearTrace();
        output.write(formatInfoBlock("Trace", "当前会话 trace 已清空。", "success"));
        continue;
      }
      if (isTraceFilterKind(arg)) {
        spinner.stop();
        output.write(formatInfoBlock("Trace", formatTraceView(agent.getSession(), 12, arg), "trace"));
        continue;
      }
      spinner.stop();
      output.write(
        formatInfoBlock(
          "Trace",
          "未知的 /trace 子命令。可用值: json, clear, intent, plan, observation, approval, response, fallback",
          "warning",
        ),
      );
      continue;
    }
    if (trimmed === "/trace json") {
      spinner.stop();
      output.write(formatInfoBlock("Trace JSON", formatTraceJson(agent.getSession()), "json"));
      continue;
    }
    if (trimmed === "/trace clear") {
      spinner.stop();
      agent.clearTrace();
      output.write(formatInfoBlock("Trace", "当前会话 trace 已清空。", "success"));
      continue;
    }

    let streamed = false;
    let streamedBuffer = "";
    let streamedVisible = false;
    let textPhaseStarted = false;

    const result = await agent.handleInput(trimmed, {
      onStatus: (status) => {
        if (textPhaseStarted) {
          return;
        }
        spinner.update(status);
      },
      onTextStart: () => {
        textPhaseStarted = true;
        spinner.stop();
        streamed = true;
        streamedBuffer = "";
        textRenderer.reset();
        output.write(formatAgentStreamStart());
      },
      onTextDelta: (delta) => {
        const chunk = textRenderer.append(delta);
        streamedBuffer = textRenderer.current();
        if (chunk) {
          streamedVisible = true;
          output.write(formatAgentStreamChunk(chunk));
        }
      },
      onTextDone: (fullText) => {
        const flushed = textRenderer.flush();
        if (flushed) {
          streamedVisible = true;
          output.write(formatAgentStreamChunk(flushed));
        }
        if (!streamedVisible && fullText) {
          const chunk = textRenderer.append(fullText);
          streamedBuffer = textRenderer.current();
          if (chunk) {
            streamedVisible = true;
            output.write(formatAgentStreamChunk(chunk));
          }
        } else {
          streamedBuffer = textRenderer.current() || fullText;
        }
        output.write(formatAgentStreamEnd());
      },
    });

    spinner.stop();

    if (!streamed) {
      if (result.approval) {
        output.write(formatApprovalCard(result.approval));
        continue;
      }
      output.write(formatAgentBlock(result.text));
      continue;
    }

    if (result.approval) {
      output.write(formatApprovalCard(result.approval));
      continue;
    }

    if (!streamedVisible && result.text !== streamedBuffer) {
      output.write(formatAgentBlock(result.text));
    }
  }

  rl.close();
}

async function loadDeskPulse(agent: ChatAgentLike) {
  try {
    return await agent.getDeskMarketPulse();
  } catch {
    return [];
  }
}
