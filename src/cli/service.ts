import { commandExists, runCommand } from "../core/process.js";
import { SERVICE_NAME } from "../setup/systemd.js";

async function requireSystemd(): Promise<void> {
  if (process.platform !== "linux" || !(await commandExists("systemctl"))) {
    throw new Error("Exy lifecycle commands require systemd on the supported Ubuntu deployment path");
  }
}

async function systemctl(action: "start" | "stop" | "restart"): Promise<void> {
  await requireSystemd();
  const result = await runCommand("systemctl", [action, SERVICE_NAME], { inherit: true });
  if (result.exitCode !== 0) throw new Error(`Unable to ${action} ${SERVICE_NAME}`);
}

export const startService = () => systemctl("start");
export const stopService = () => systemctl("stop");
export const restartService = () => systemctl("restart");

export async function printServiceStatus(): Promise<number> {
  await requireSystemd();
  const result = await runCommand("systemctl", ["status", SERVICE_NAME, "--no-pager", "--full"], { inherit: true });
  return result.exitCode;
}

export async function printServiceLogs(follow: boolean): Promise<number> {
  await requireSystemd();
  const args = ["-u", SERVICE_NAME, "--no-pager", "-n", "100"];
  if (follow) args.push("-f");
  const result = await runCommand("journalctl", args, { inherit: true });
  return result.exitCode;
}
