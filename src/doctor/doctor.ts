import { access, open, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { ConfigStore } from "../config/store.js";
import type { ExyPaths } from "../config/paths.js";
import { commandExists, runCommand } from "../core/process.js";
import { PiModelService } from "../agent/model-service.js";
import { checkAllProviders, type CheckResult } from "./connectivity.js";

type DoctorStatus = "pass" | "warn" | "fail";

interface DoctorResult {
  name: string;
  status: DoctorStatus;
  detail: string;
}

function versionAtLeast(current: string, required: [number, number, number]): boolean {
  const parts = current.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < required.length; index++) {
    const actual = parts[index] ?? 0;
    const wanted = required[index] ?? 0;
    if (actual > wanted) return true;
    if (actual < wanted) return false;
  }
  return true;
}

async function writable(path: string): Promise<DoctorResult> {
  try {
    if (process.platform === "linux") {
      if (process.getuid?.() !== 0) {
        return { name: `Writable ${path}`, status: "fail", detail: "run sudo exy doctor to test as the exy service user" };
      }
      const readable = await runCommand("runuser", ["-u", "exy", "--", "/usr/bin/test", "-r", path]);
      const writableByService = await runCommand("runuser", ["-u", "exy", "--", "/usr/bin/test", "-w", path]);
      return readable.exitCode === 0 && writableByService.exitCode === 0
        ? { name: `Writable ${path}`, status: "pass", detail: "exy service user has read/write access" }
        : { name: `Writable ${path}`, status: "fail", detail: "exy service user lacks read or write access" };
    }
    await access(path, constants.R_OK | constants.W_OK);
    const probe = `${path}/.exy-doctor-${process.pid}`;
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
    await rm(probe, { force: true });
    return { name: `Writable ${path}`, status: "pass", detail: "read/write available" };
  } catch (error) {
    return { name: `Writable ${path}`, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function privateServiceFile(path: string, name: string, serviceUid: number | undefined): Promise<DoctorResult> {
  try {
    const info = await stat(path);
    const privateMode = process.platform === "win32" || (info.mode & 0o077) === 0;
    const owned = serviceUid === undefined || info.uid === serviceUid;
    return {
      name,
      status: privateMode && owned ? "pass" : "fail",
      detail: !privateMode
        ? "group/other permissions must be removed"
        : !owned
          ? "file is not owned by the exy service user"
          : "present, private, and service-owned",
    };
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function dependency(name: string): Promise<DoctorResult> {
  const ok = await commandExists(name);
  return { name: `Dependency ${name}`, status: ok ? "pass" : "fail", detail: ok ? "available" : "not found" };
}

function providerResult(check: CheckResult): DoctorResult {
  return { name: check.name, status: check.ok ? "pass" : "fail", detail: check.detail };
}

export async function runDoctor(paths: ExyPaths): Promise<boolean> {
  const results: DoctorResult[] = [];
  let serviceUid: number | undefined;
  if (process.platform === "linux") {
    const uid = await runCommand("id", ["-u", "exy"]);
    if (uid.exitCode === 0 && /^\d+$/u.test(uid.stdout.trim())) serviceUid = Number(uid.stdout.trim());
    else results.push({ name: "Service user exy", status: "fail", detail: "not installed; rerun sudo exy setup" });
  }
  results.push({
    name: "Node.js",
    status: versionAtLeast(process.version, [22, 19, 0]) ? "pass" : "fail",
    detail: `${process.version}; Exy requires >=22.19.0`,
  });
  for (const command of ["git", ...(process.platform === "linux" ? ["systemctl", "journalctl"] : [])]) {
    results.push(await dependency(command));
  }

  const store = new ConfigStore(paths);
  let config;
  let secrets;
  try {
    config = await store.readConfig();
    results.push(await privateServiceFile(paths.configFile, "Configuration", serviceUid));
  } catch (error) {
    results.push({ name: "Configuration", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    secrets = await store.readSecrets();
    results.push(await privateServiceFile(paths.secretsFile, "Secret storage", serviceUid));
  } catch (error) {
    results.push({ name: "Secret storage", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }

  for (const path of [paths.configDir, paths.dataDir, paths.workspaceDir, paths.sessionsDir, paths.skillsDir]) {
    results.push(await writable(path));
  }

  try {
    const pi = new PiModelService(paths.piAuthFile);
    const authenticated = await pi.validateCodexAuthentication();
    results.push({
      name: "Pi OpenAI Codex authentication",
      status: authenticated ? "pass" : "fail",
      detail: authenticated ? "credential available and refreshable" : "run exy login",
    });
    if (authenticated && config?.model) {
      results.push(await privateServiceFile(paths.piAuthFile, "Pi OAuth credential file", serviceUid));
      const model = pi.resolvePreference(config.model);
      results.push({
        name: "Pi model/reasoning",
        status: "pass",
        detail: `${model.provider}/${model.id} (${config.model.reasoning})`,
      });
    } else if (!config?.model) {
      results.push({ name: "Pi model/reasoning", status: "fail", detail: "run exy login to select defaults" });
    }
  } catch (error) {
    results.push({ name: "Pi", status: "fail", detail: error instanceof Error ? error.message : String(error) });
  }

  if (config && secrets) {
    results.push(...(await checkAllProviders(config, secrets)).map(providerResult));
    if (!config.providers.zernioXAnalyticsEnabled) {
      results.push({ name: "Zernio X analytics", status: "warn", detail: "disabled by setup consent; analytics tools are unavailable" });
    }
  }

  if (process.platform === "linux" && (await commandExists("systemctl"))) {
    const installed = await runCommand("systemctl", ["cat", "exy.service"]);
    results.push({
      name: "systemd unit",
      status: installed.exitCode === 0 ? "pass" : "fail",
      detail: installed.exitCode === 0 ? "installed" : "not installed; rerun sudo exy setup",
    });
    if (installed.exitCode === 0) {
      const active = await runCommand("systemctl", ["is-active", "exy.service"]);
      results.push({
        name: "Gateway service",
        status: active.exitCode === 0 ? "pass" : "warn",
        detail: active.stdout.trim() || "inactive",
      });
    }
  } else {
    results.push({ name: "Gateway service", status: "warn", detail: "systemd check is only available on Ubuntu/Linux" });
  }

  console.log("Exy doctor\n");
  for (const result of results) {
    const marker = result.status === "pass" ? "✓" : result.status === "warn" ? "!" : "✗";
    console.log(`${marker} ${result.name}: ${result.detail}`);
  }
  const failures = results.filter((result) => result.status === "fail").length;
  console.log(failures === 0 ? "\nDoctor found no blocking problems." : `\nDoctor found ${failures} blocking problem(s).`);
  return failures === 0;
}
