#!/usr/bin/env node
import { resolveExyPaths } from "../config/paths.js";
import { runDoctor } from "../doctor/doctor.js";
import { runSetup } from "../setup/wizard.js";
import { runLogin } from "./login.js";
import {
  printServiceLogs,
  printServiceStatus,
  restartService,
  startService,
  stopService,
} from "./service.js";

const HELP = `Exy — self-hosted specialist agent for X/Twitter growth

Usage: exy <command>

Commands:
  setup       Configure providers, Discord, storage, and the Ubuntu service
  login       Configure OpenCode Go or ChatGPT/Codex through Pi
  start       Start the Exy gateway service
  stop        Stop the Exy gateway service
  restart     Restart the Exy gateway service
  status      Show gateway service status
  logs [-f]   Show the last 100 gateway log lines; -f follows
  doctor      Check configuration, dependencies, auth, providers, paths, and service
  help        Show this help
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "help";
  const paths = resolveExyPaths();
  switch (command) {
    case "setup":
      await runSetup(paths);
      return 0;
    case "login":
      await runLogin(paths);
      return 0;
    case "start":
      await startService();
      return 0;
    case "stop":
      await stopService();
      return 0;
    case "restart":
      await restartService();
      return 0;
    case "status":
      return printServiceStatus();
    case "logs":
      return printServiceLogs(argv.includes("-f") || argv.includes("--follow"));
    case "doctor":
      return (await runDoctor(paths)) ? 0 : 1;
    case "gateway": {
      const { runGateway } = await import("../gateway/main.js");
      return runGateway(paths);
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`exy: ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.EXY_DEBUG === "1" && error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
}
