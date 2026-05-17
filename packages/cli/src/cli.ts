#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";

import { initCommand } from "./commands/init.js";
import { signalCommand } from "./commands/signal.js";
import { lintCommand } from "./commands/lint.js";
import { formatCommand } from "./commands/format.js";
import { maintenanceCommand } from "./commands/maintenance.js";
import { purgeCommand } from "./purge.js";

import { checkConnectivity } from "./checkConnectivity.js";

const VERSION = "0.1.0";

console.log(
  chalk.cyan(`
  ██████╗ ███████╗███████╗██████╗ ██████╗  █████╗ ███████╗███████╗
  ██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔════╝
  ██████╔╝█████╗  █████╗  ██████╔╝██████╔╝███████║███████╗█████╗
  ██╔═══╝ ██╔══╝  ██╔══╝  ██╔══██╗██╔══██╗██╔══██║╚════██║██╔══╝
  ██║     ███████╗███████╗██║  ██║██████╔╝██║  ██║███████║███████╗
  ╚═╝     ╚══════╝╚══════╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝
`)
);

console.log(chalk.gray(`  Build full-stack apps with ZERO backend. v${VERSION}\n`));

async function main() {
  await checkConnectivity();

  program
    .name("zerithdb")
    .description("ZerithDB CLI — scaffold and manage local-first P2P apps")
    .version(VERSION);

  // INIT
  program
    .command("init [app-name]")
    .description("Scaffold a new ZerithDB application")
    .option("-t, --template <template>", "Starter template", "todo")
    .option("--no-install", "Skip dependency installation")
    .action(initCommand);

  // SIGNAL SERVER
  program
    .command("signal")
    .description("Start a local WebSocket signaling server for development")
    .option("-p, --port <port>", "Port to listen on", "4000")
    .action(signalCommand);

  // LINT
  program
    .command("lint [schema-path]")
    .description("Lint the db schema for anti-patterns and missing indexes")
    .action(lintCommand);

  // FORMAT
  program
    .command("format [schema-path]")
    .description("Format the db schema using Prettier")
    .action(formatCommand);

  // MAINTENANCE
  program
    .command("maintenance <status>")
    .description("Toggle maintenance mode for the signaling server (on/off)")
    .action(maintenanceCommand);

  // PURGE
  program
    .command("purge")
    .description("Purge all local ZerithDB data stored in the home directory")
    .action(purgeCommand);

  program.parse(process.argv);
}

main().catch((err) => {
  console.error(chalk.red("CLI Error:"), err);
  process.exit(1);
});
