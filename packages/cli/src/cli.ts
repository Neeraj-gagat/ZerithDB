#!/usr/bin/env node

import { program } from "commander";
import chalk from "chalk";

import { initCommand } from "./commands/init.js";
import { signalCommand } from "./commands/signal.js";
import { lintCommand } from "./commands/lint.js";
import { formatCommand } from "./commands/format.js";
import { maintenanceCommand } from "./commands/maintenance.js";
import { purgeCommand } from "./purge.js";
import { generateCommand } from "./commands/generate.js";
import { inferCommand } from "./commands/infer.js";
import { migrateCommand } from "./commands/migrate.js";

import { checkConnectivity } from "./checkConnectivity.js";

const VERSION = "0.2.0";

console.log(
  chalk.cyan(`
  ███████╗███████╗██████╗ ██╗████████╗██╗  ██╗██████╗ ██████╗ 
  ╚══███╔╝██╔════╝██╔══██╗██║╚══██╔══╝██║  ██║██╔══██╗██╔══██╗
    ███╔╝ █████╗  ██████╔╝██║   ██║   ███████║██║  ██║██████╔╝
   ███╔╝  ██╔══╝  ██╔══██╗██║   ██║   ██╔══██║██║  ██║██╔══██╗
  ███████╗███████╗██║  ██║██║   ██║   ██║  ██║██████╔╝██████╔╝
  ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚═════╝ ╚═════╝ 
  `)
);

async function main() {
  console.log(chalk.cyan("Starting ZerithDB CLI...\n"));
  console.log(chalk.gray("Checking connectivity..."));

  await checkConnectivity();

  console.log(chalk.green("Connectivity check passed.\n"));

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

  program
    .command("generate")
    .description("Generate ZerithDB validation schemas from a Prisma schema")
    .option("-s, --schema <schema>", "Path to schema.prisma file", "./prisma/schema.prisma")
    .option("-o, --out <out>", "Path to output generated TypeScript file", "./src/zerith-schemas.ts")
    .action(generateCommand);

  // PURGE
  program
    .command("purge")
    .description("Purge all local ZerithDB data stored in the home directory")
    .action(purgeCommand);

  program
    .command("infer <path>")
    .description("Scan JSON and infer TypeScript & Zod schemas")
    .option("--out <dir>", "Output directory")
    .option("--name <schemaName>", "Schema name")
    .option("--zod-only", "Generate only Zod schemas")
    .option("--ts-only", "Generate only TypeScript interfaces")
    .option("--pretty", "Format output with Prettier")
    .action(inferCommand);

  program
    .command("migrate <source>")
    .description("Migrate database schema and records from legacy providers to ZerithDB local-first format")
    .option("-u, --url <url>", "Supabase URL / Firebase Project URL")
    .option("-k, --key <key>", "Supabase API key / service key")
    .option("-t, --table <tables>", "Specific table(s) to migrate, comma-separated")
    .option("-a, --app <appId>", "ZerithDB App ID to embed in snapshot", "zerithdb-migrated-app")
    .option("-o, --output <output>", "Output JSON file path", "zerithdb-migration-payload.json")
    .action(migrateCommand);

  program.parse(process.argv);
}

main().catch((err) => {
  console.error(chalk.red("\nUnexpected CLI error"));

  if (err instanceof Error) {
    console.error(chalk.red(err.message));
  } else {
    console.error(chalk.red(String(err)));
  }

  console.error(chalk.red("CLI Error:"), err);

  process.exit(1);
});
