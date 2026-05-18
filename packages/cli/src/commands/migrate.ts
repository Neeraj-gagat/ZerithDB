import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import ora from "ora";

interface MigrationOptions {
  url?: string;
  key?: string;
  table?: string;
  app?: string;
  output?: string;
}

export async function migrateCommand(
  source: string,
  options: MigrationOptions
): Promise<void> {
  const normalizedSource = source.toLowerCase();

  if (normalizedSource !== "supabase") {
    console.log(
      chalk.red(`\nError: Unsupported migration source "${source}". Currently only "supabase" is supported.\n`)
    );
    process.exit(1);
  }

  const supabaseUrl = options.url || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = options.key || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const appId = options.app || "zerithdb-migrated-app";
  const outputFileName = options.output || "zerithdb-migration-payload.json";

  if (!supabaseUrl) {
    console.log(
      chalk.red("\nError: Supabase URL is required. Provide it via --url or the NEXT_PUBLIC_SUPABASE_URL env variable.\n")
    );
    process.exit(1);
  }

  if (!supabaseKey) {
    console.log(
      chalk.red("\nError: Supabase API Key is required. Provide it via --key or the NEXT_PUBLIC_SUPABASE_ANON_KEY env variable.\n")
    );
    process.exit(1);
  }

  console.log(chalk.cyan(`\n🚀 Initializing migration from ${chalk.bold("Supabase")} to ${chalk.bold("ZerithDB")} local-first snapshot...\n`));

  const spinner = ora("Connecting to Supabase endpoint and retrieving schema metadata...").start();

  try {
    // ── Step 1: Query OpenAPI schema to detect available tables ───────────────────
    const schemaUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/`;
    const schemaResponse = await fetch(schemaUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (!schemaResponse.ok) {
      throw new Error(`Failed to query Supabase REST API schema (${schemaResponse.status} ${schemaResponse.statusText})`);
    }

    const schemaData = (await schemaResponse.json()) as any;
    const detectedPaths = Object.keys(schemaData.paths || {});
    
    let detectedTables = detectedPaths
      .filter((p) => p !== "/" && !p.startsWith("/rpc/"))
      .map((p) => p.replace(/^\//, ""));

    if (detectedTables.length === 0) {
      throw new Error("No tables found in the database REST schema.");
    }

    // Filter tables if user specified a subset
    if (options.table) {
      const targetTables = options.table.split(",").map((t) => t.trim());
      detectedTables = detectedTables.filter((t) => targetTables.includes(t));
      
      if (detectedTables.length === 0) {
        throw new Error(`None of the specified tables [${options.table}] were found in the database REST schema.`);
      }
    }

    spinner.succeed(`Discovered ${chalk.bold(detectedTables.length)} table(s) in Supabase schema`);

    // ── Step 2: Fetch and map records for each table ──────────────────────────────
    const collections: Record<string, any[]> = {};
    const summary: { table: string; recordsFetched: number; status: string }[] = [];

    for (const table of detectedTables) {
      const tableSpinner = ora(`Migrating records from table "${chalk.yellow(table)}"...`).start();
      
      try {
        const queryUrl = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/${table}?select=*`;
        const queryResponse = await fetch(queryUrl, {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        });

        if (!queryResponse.ok) {
          throw new Error(`Failed to query table "${table}" (${queryResponse.status} ${queryResponse.statusText})`);
        }

        const rows = (await queryResponse.json()) as any[];
        
        // Map records to ZerithDB Document format
        const mappedRows = rows.map((row) => {
          // Identify potential primary key mapping
          const idVal = row.id || row.uuid || row._id || randomUUID();
          
          // Parse created/updated timestamps
          const createdAtVal = row.created_at || row.createdAt || row._createdAt;
          const updatedAtVal = row.updated_at || row.updatedAt || row._updatedAt;
          
          const createdAtMs = createdAtVal ? new Date(createdAtVal).getTime() : Date.now();
          const updatedAtMs = updatedAtVal ? new Date(updatedAtVal).getTime() : createdAtMs;

          // Strip standard raw primary key/timestamps to replace with ZerithDB internal structure
          const cleanRow = { ...row };
          delete cleanRow.id;
          delete cleanRow.uuid;
          delete cleanRow._id;
          delete cleanRow.created_at;
          delete cleanRow.createdAt;
          delete cleanRow._createdAt;
          delete cleanRow.updated_at;
          delete cleanRow.updatedAt;
          delete cleanRow._updatedAt;

          return {
            ...cleanRow,
            _id: String(idVal),
            _createdAt: createdAtMs,
            _updatedAt: updatedAtMs,
          };
        });

        collections[table] = mappedRows;
        summary.push({ table, recordsFetched: rows.length, status: "OK" });
        tableSpinner.succeed(`Successfully migrated ${chalk.bold(rows.length)} records from table "${chalk.green(table)}"`);
      } catch (err: any) {
        summary.push({ table, recordsFetched: 0, status: "Failed" });
        tableSpinner.fail(`Failed to migrate table "${chalk.red(table)}": ${err.message}`);
      }
    }

    // ── Step 3: Construct BackupSnapshot and write file ──────────────────────────
    const outputSpinner = ora(`Writing migration snapshot to "${chalk.yellow(outputFileName)}"...`).start();
    
    const snapshot = {
      format: "zerithdb.local-backup.v1",
      appId,
      generatedAt: new Date().toISOString(),
      collections,
    };

    const targetPath = path.resolve(process.cwd(), outputFileName);
    await fs.writeFile(targetPath, JSON.stringify(snapshot, null, 2), "utf-8");
    
    outputSpinner.succeed(`Saved migration snapshot to ${chalk.green(targetPath)}`);

    // ── Step 4: Display Summary ─────────────────────────────────────────────
    console.log(chalk.cyan(`\n📊 ${chalk.bold("MIGRATION LEDGER REPORT")}`));
    console.log(chalk.gray("═".repeat(60)));
    console.log(
      chalk.bold(
        "  " +
        "Table Name".padEnd(25) +
        "Records Migrated".padEnd(20) +
        "Status"
      )
    );
    console.log(chalk.gray("-".repeat(60)));

    for (const item of summary) {
      const recordsStr = item.recordsFetched.toString();
      const statusColor = item.status === "OK" ? chalk.green(item.status) : chalk.red(item.status);
      console.log(
        `  ${item.table.padEnd(25)}${recordsStr.padEnd(20)}${statusColor}`
      );
    }
    console.log(chalk.gray("═".repeat(60)));

    console.log(`
${chalk.green("✔")} ${chalk.bold("Database Migration Complete!")}

  ${chalk.gray("To seed your local-first ZerithDB application instantly, load this payload in your app:")}
  ${chalk.cyan(`import migrationPayload from "./${outputFileName}";`)}
  ${chalk.cyan("await app.db.importSnapshot(migrationPayload);")}

  ${chalk.gray("Ready to sync offline-first across your WebRTC mesh network! 🕸️")}
`);
  } catch (err: any) {
    spinner.fail(chalk.red("Migration sequence aborted due to schema resolution errors:"));
    console.error(err);
    process.exit(1);
  }
}
