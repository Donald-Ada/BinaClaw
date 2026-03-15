import {ensureAppDirectories} from "../core/config.ts";
import {getLocalGatewayUrl, startManagedService, stopManagedService} from "../core/service-manager.ts";
import {runOnboardingWizard} from "./config-wizard.ts";
import {ensureWorkspaceBootstrapFiles} from "../core/workspace.ts";

export async function runOnboard(): Promise<void> {
  const config = await runOnboardingWizard();
  await ensureAppDirectories(config);
  await ensureWorkspaceBootstrapFiles(config);

  const startedFresh: Array<"gateway" | "telegram"> = [];

  try {
    await stopManagedService(config, "telegram");
    await stopManagedService(config, "gateway");

    console.log("正在启动后台 Gateway...");
    const gateway = await startManagedService(config, "gateway");
    startedFresh.push("gateway");
    console.log(`已启动 Gateway，PID ${gateway.pid}`);

    console.log("正在启动后台 Telegram provider...");
    const telegram = await startManagedService(config, "telegram");
    startedFresh.push("telegram");
    console.log(`已启动 Telegram provider，PID ${telegram.pid}`);

    console.log("");
    console.log("配置完成。");
    console.log(`Gateway: ${getLocalGatewayUrl(config)}`);
    console.log(`Gateway log: ${gateway.logFile}`);
    console.log(`Telegram log: ${telegram.logFile}`);
    console.log(`Local env: ${config.localEnvFile}`);
    if (!config.binance.apiKey || !config.binance.apiSecret) {
      console.log("提示: 当前 Binance 仍是只读模式。你可以稍后重新运行 binaclaw onboard 补充 Binance 私钥。");
    } else {
      console.log("Binance 私有接口密钥已写入本机环境文件，不会出现在 config.json 中。");
    }
    console.log("现在你可以直接在 Telegram 中和你的 AI Agent 对话了。");
  } catch (error) {
    for (const serviceName of startedFresh.reverse()) {
      await stopManagedService(config, serviceName);
    }
    throw error;
  }
}
