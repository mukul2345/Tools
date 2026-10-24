#!/usr/bin/env node
/**
 * CloudWatch Alarms CLI – config-driven apply (upsert) and delete by tags.
 * Usage:
 *   node src/cli/index.mjs apply [--config=path] [--dry-run]
 *   node src/cli/index.mjs delete [--config=path] [--yes]
 */
import { loadConfig } from "../config/load.mjs";
import { applyAlarms } from "../operations/apply.mjs";
import { deleteAlarmsByTags } from "../operations/delete.mjs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(__dirname, "..", "..", "alarms.config.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  let config = DEFAULT_CONFIG;
  let dryRun = false;
  let yes = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--yes") yes = true;
    else if (args[i].startsWith("--config=")) config = args[i].slice(9).trim();
  }
  return { cmd, config, dryRun, yes };
}

async function main() {
  const { cmd, config, dryRun, yes } = parseArgs();

  if (!cmd || (cmd !== "apply" && cmd !== "delete")) {
    console.error("Usage: cloudwatch-alarms apply [--config=path] [--dry-run]");
    console.error("       cloudwatch-alarms delete [--config=path] [--yes]");
    process.exit(1);
  }

  let configObj;
  try {
    configObj = loadConfig(config);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (cmd === "apply") {
    console.log("CloudWatch Alarms – apply (config: " + config + ")");
    if (dryRun) console.log("DRY-RUN: no alarms will be created/updated.");
    const results = await applyAlarms(configObj, { dryRun });
    const total = (results.ecs || 0) + (results["api-5xx"] || 0) + (results["api-traffic"] || 0) + (results.sqs || 0);
    console.log("\nDone. Total alarms created/updated:", total, "(ecs:", results.ecs, "| api-5xx:", results["api-5xx"], "| api-traffic:", results["api-traffic"], "| sqs:", results.sqs, ")");
    return;
  }

  if (cmd === "delete") {
    console.log("CloudWatch Alarms – delete by tags (config: " + config + ")");
    const result = await deleteAlarmsByTags(configObj, { confirm: !yes });
    console.log(result.message ?? `Deleted ${result.deleted} alarm(s).`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
