import {ensureAppDirectories} from "../core/config.ts";
import {getLocalGatewayUrl, startManagedService, stopManagedService} from "../core/service-manager.ts";
import {runOnboardingWizard} from "./config-wizard.ts";
import {ensureWorkspaceBootstrapFiles} from "../core/workspace.ts";
import {createSpinnerController, formatOnboardingCompletion, formatOnboardingServiceCard} from "./ui.ts";

export async function runOnboard(): Promise<void> {
  const config = await runOnboardingWizard();
  await ensureAppDirectories(config);
  await ensureWorkspaceBootstrapFiles(config);
  const spinner = createSpinnerController((chunk) => process.stdout.write(chunk), Boolean(process.stdout.isTTY));

  const startedFresh: Array<"gateway" | "telegram"> = [];

  try {
    spinner.update("正在清理旧的后台服务...");
    await stopManagedService(config, "telegram");
    await stopManagedService(config, "gateway");

    spinner.update("正在启动后台 Gateway...");
    const gateway = await startManagedService(config, "gateway");
    startedFresh.push("gateway");
    spinner.update("正在启动后台 Telegram provider...");

    const telegram = await startManagedService(config, "telegram");
    startedFresh.push("telegram");
    spinner.stop();

    process.stdout.write(
      formatOnboardingServiceCard(
        "Gateway Online",
        [
          `STATUS      ${gateway.alreadyRunning ? "reused existing process" : `started fresh · pid ${gateway.pid}`}`,
          `URL         ${getLocalGatewayUrl(config)}`,
          `LOG         ${gateway.logFile}`,
        ],
      ),
    );
    process.stdout.write(
      formatOnboardingServiceCard(
        "Telegram Online",
        [
          `STATUS      ${telegram.alreadyRunning ? "reused existing process" : `started fresh · pid ${telegram.pid}`}`,
          `ACCESS      allowed users ${config.telegram.allowedUserIds.join(", ") || "not set"}`,
          `LOG         ${telegram.logFile}`,
        ],
      ),
    );
    process.stdout.write(formatOnboardingCompletion(config, gateway.logFile, telegram.logFile));
  } catch (error) {
    spinner.stop();
    for (const serviceName of startedFresh.reverse()) {
      await stopManagedService(config, serviceName);
    }
    throw error;
  }
}
