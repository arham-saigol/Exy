import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ExyPaths {
  configDir: string;
  dataDir: string;
  workspaceDir: string;
  configFile: string;
  secretsFile: string;
  databaseFile: string;
  piAgentDir: string;
  piAuthFile: string;
  sessionsDir: string;
  heartbeatFile: string;
  skillsDir: string;
}

function defaultConfigDir(): string {
  if (process.platform === "linux" && process.getuid?.() === 0) return "/etc/exy";
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "exy");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "exy");
}

function defaultDataDir(): string {
  if (process.platform === "linux" && process.getuid?.() === 0) return "/var/lib/exy";
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "exy");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "exy");
}

export function resolveExyPaths(env: NodeJS.ProcessEnv = process.env): ExyPaths {
  const configDir = resolve(env.EXY_CONFIG_DIR ?? defaultConfigDir());
  const dataDir = resolve(env.EXY_DATA_DIR ?? defaultDataDir());
  const workspaceDir = resolve(env.EXY_WORKSPACE_DIR ?? join(dataDir, "workspace"));
  const piAgentDir = join(dataDir, "pi-agent");
  return {
    configDir,
    dataDir,
    workspaceDir,
    configFile: join(configDir, "config.json"),
    secretsFile: join(configDir, "secrets.json"),
    databaseFile: join(dataDir, "exy.sqlite"),
    piAgentDir,
    piAuthFile: join(piAgentDir, "auth.json"),
    sessionsDir: join(dataDir, "sessions"),
    heartbeatFile: join(workspaceDir, "HEARTBEAT.md"),
    skillsDir: join(workspaceDir, ".agents", "skills"),
  };
}

export function testPaths(root = join(tmpdir(), `exy-test-${process.pid}`)): ExyPaths {
  return resolveExyPaths({
    EXY_CONFIG_DIR: join(root, "config"),
    EXY_DATA_DIR: join(root, "data"),
  });
}
