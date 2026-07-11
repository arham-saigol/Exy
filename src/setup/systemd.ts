import { chmod, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { commandExists, runCommand } from "../core/process.js";
import type { ExyPaths } from "../config/paths.js";

export const SERVICE_NAME = "exy.service";
export const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}`;
export const RESTART_EXIT_CODE = 75;

function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderSystemdUnit(paths: ExyPaths, executable = process.execPath, cliPath = process.argv[1]): string {
  if (!cliPath) throw new Error("Cannot determine the Exy CLI entry point");
  return `[Unit]
Description=Exy X growth agent gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=exy
Group=exy
WorkingDirectory=${paths.workspaceDir}
Environment=EXY_CONFIG_DIR=${paths.configDir}
Environment=EXY_DATA_DIR=${paths.dataDir}
Environment=EXY_WORKSPACE_DIR=${paths.workspaceDir}
ExecStart=${quoteSystemdArgument(resolve(executable))} ${quoteSystemdArgument(resolve(cliPath))} gateway
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${paths.dataDir} ${paths.configDir}

[Install]
WantedBy=multi-user.target
`;
}

async function requireSuccess(command: string, args: string[]): Promise<void> {
  const result = await runCommand(command, args, { inherit: true });
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.exitCode}`);
}

export async function installRuntimeDependencies(): Promise<void> {
  if (process.platform !== "linux") return;
  const missing: string[] = [];
  if (!(await commandExists("git"))) missing.push("git");
  if (!(await commandExists("curl"))) missing.push("curl", "ca-certificates");
  if (missing.length === 0) return;
  if (process.getuid?.() !== 0) {
    throw new Error(`Missing runtime dependencies (${missing.join(", ")}); rerun setup with sudo`);
  }
  if (!(await commandExists("apt-get"))) throw new Error("Automatic dependency installation requires apt-get");
  await requireSuccess("apt-get", ["update"]);
  await requireSuccess("apt-get", ["install", "-y", ...new Set(missing)]);
}

export async function installSystemdService(paths: ExyPaths): Promise<void> {
  if (process.platform !== "linux") return;
  if (process.getuid?.() !== 0) throw new Error("System service installation requires sudo/root");
  if (!(await commandExists("systemctl"))) throw new Error("systemd is required on the supported Ubuntu VPS path");

  const cliPath = process.argv[1];
  if (!cliPath) throw new Error("Cannot determine the installed Exy CLI path");
  const executableTarget = await realpath(process.execPath);
  const cliTarget = await realpath(cliPath);
  for (const [label, target] of [["Node.js", executableTarget], ["Exy CLI", cliTarget]] as const) {
    if (target === "/root" || target.startsWith("/root/") || target === "/home" || target.startsWith("/home/")) {
      throw new Error(`${label} resolves inside a home directory blocked by the service sandbox. Run scripts/bootstrap-ubuntu.sh and install Exy globally from /opt/exy`);
    }
  }

  const group = await runCommand("getent", ["group", "exy"]);
  const id = await runCommand("id", ["-u", "exy"]);
  if (id.exitCode !== 0) {
    const groupArgs = group.exitCode === 0 ? ["--gid", "exy"] : ["--user-group"];
    await requireSuccess("useradd", ["--system", ...groupArgs, "--home", paths.dataDir, "--shell", "/usr/sbin/nologin", "exy"]);
  } else {
    if (group.exitCode !== 0) await requireSuccess("groupadd", ["--system", "exy"]);
    await requireSuccess("usermod", ["--gid", "exy", "exy"]);
  }

  const nodeAccess = await runCommand("runuser", ["-u", "exy", "--", "/usr/bin/test", "-x", executableTarget]);
  const cliAccess = await runCommand("runuser", ["-u", "exy", "--", "/usr/bin/test", "-r", cliTarget]);
  if (nodeAccess.exitCode !== 0 || cliAccess.exitCode !== 0) {
    throw new Error("The exy service user cannot read the installed Node.js runtime or Exy CLI");
  }

  await requireSuccess("chown", ["-R", "exy:exy", paths.configDir, paths.dataDir]);
  await writeFile(SERVICE_FILE, renderSystemdUnit(paths), { mode: 0o644 });
  await chmod(SERVICE_FILE, 0o644);
  await requireSuccess("systemctl", ["daemon-reload"]);
  await requireSuccess("systemctl", ["enable", SERVICE_NAME]);
}
