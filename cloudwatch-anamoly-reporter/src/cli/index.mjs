#!/usr/bin/env node
/**
 * CLI Entry Point - Local report generation
 * Usage: 
 *   Single dashboard: node src/cli/index.mjs --dashboard=<name>
 *   Multiple dashboards: node src/cli/index.mjs --dashboard=<name1>,<name2>,<name3>
 *   By group: node src/cli/index.mjs --group=<group-name>
 *   List all: node src/cli/index.mjs --list
 */

import { generateReport } from "../core/generateReport.mjs";
import { loadDashboardsConfig } from "../core/configLoader.mjs";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config({ path: path.join(__dirname, "../../.env") });

// Parse command line arguments
const args = process.argv.slice(2);
const dashboardArg = args.find((arg) => arg.startsWith("--dashboard="));
const dashboardNames = dashboardArg ? dashboardArg.split("=")[1].split(",").map(d => d.trim()) : null;

const groupArg = args.find((arg) => arg.startsWith("--group="));
const groupName = groupArg ? groupArg.split("=")[1] : null;

const listArg = args.includes("--list");

const endISOArg = args.find((arg) => arg.startsWith("--end="));
const endISO = endISOArg ? endISOArg.split("=")[1] : null;

const windowMinutesArg = args.find((arg) => arg.startsWith("--window-minutes="));
const windowMinutes = windowMinutesArg ? parseInt(windowMinutesArg.split("=")[1]) : null;

const baselineDaysArg = args.find((arg) => arg.startsWith("--baseline-days="));
const baselineDays = baselineDaysArg ? parseInt(baselineDaysArg.split("=")[1]) : null;

// List all available dashboards
if (listArg) {
  (async () => {
    try {
      const config = await loadDashboardsConfig();
      console.log("\n📊 Available Dashboards:\n");
      config.dashboards.forEach((d) => {
        const groups = d.groups ? d.groups.join(", ") : "none";
        const status = d.enabled !== false ? "✅ enabled" : "❌ disabled";
        console.log(`  • ${d.name}`);
        console.log(`    Groups: ${groups}`);
        console.log(`    Status: ${status}\n`);
      });
    } catch (error) {
      console.error(`❌ Error loading dashboards: ${error.message}`);
      process.exit(1);
    }
  })();
  process.exit(0);
}

// Validate arguments
if (!dashboardNames && !groupName) {
  console.error("Usage:");
  console.error("  Single dashboard:  npm run report -- --dashboard=<name>");
  console.error("  Multiple dashboards: npm run report -- --dashboard=<name1>,<name2>,<name3>");
  console.error("  By group:           npm run report -- --group=<group-name>");
  console.error("  List all:          npm run report -- --list");
  console.error("\nOptions:");
  console.error("  --end=ISO_DATE        End time for analysis");
  console.error("  --window-minutes=N    Analysis window in minutes");
  console.error("  --baseline-days=N     Baseline period in days");
  process.exit(1);
}

/**
 * Map folder name to dashboard name (e.g., "Verification" -> "Verification_Platform_Performance")
 */
function mapFolderNameToDashboardName(folderName, config) {
  // First try exact match
  const exactMatch = config.dashboards.find(d => d.name === folderName);
  if (exactMatch) return folderName;
  
  // Try to find by folder name pattern (first part of dashboard name)
  const match = config.dashboards.find(d => {
    const parts = d.name.split("_");
    return parts[0] === folderName || d.name.toLowerCase().startsWith(folderName.toLowerCase());
  });
  
  if (match) {
    return match.name;
  }
  
  return folderName; // Return as-is if no match found
}

async function getDashboardsToProcess() {
  if (groupName) {
    // Get dashboards by group
    const config = await loadDashboardsConfig();
    const dashboards = config.dashboards.filter(
      (d) => d.enabled !== false && d.groups && d.groups.includes(groupName)
    );
    
    if (dashboards.length === 0) {
      throw new Error(`No enabled dashboards found for group: ${groupName}`);
    }
    
    return dashboards.map((d) => d.name);
  } else {
    // Map folder names to dashboard names
    const config = await loadDashboardsConfig();
    return dashboardNames.map(name => mapFolderNameToDashboardName(name, config));
  }
}

async function main() {
  try {
    const dashboardsToProcess = await getDashboardsToProcess();
    
    console.log(`📊 Generating reports for ${dashboardsToProcess.length} dashboard(s): ${dashboardsToProcess.join(", ")}`);
    
    const overrides = {};
    if (windowMinutes) overrides.windowMinutes = windowMinutes;
    if (baselineDays) overrides.baselineDays = baselineDays;

    const results = [];
    
    // Process each dashboard
    for (const dashboardName of dashboardsToProcess) {
      console.log(`\n🔄 Processing: ${dashboardName}`);
      
      const result = await generateReport({
        dashboardName,
        overrides,
        outputMode: "local",
        endISO,
      });

      results.push(result);
      
      console.log(`   ✅ ${dashboardName}: ${result.anomaliesFound} anomalies / ${result.totalMetrics} metrics`);
      console.log(`   📄 Saved to: ${result.localPath}`);
    }

    // Summary
    const totalAnomalies = results.reduce((sum, r) => sum + r.anomaliesFound, 0);
    const totalMetrics = results.reduce((sum, r) => sum + r.totalMetrics, 0);
    
    console.log(`\n✅ All reports generated successfully!`);
    console.log(`   Dashboards: ${results.length}`);
    console.log(`   Total Anomalies: ${totalAnomalies}`);
    console.log(`   Total Metrics: ${totalMetrics}`);
    
    // Note: Google Chat notifications are only sent when running in Lambda
    // Local CLI execution does not send notifications to avoid spam
  } catch (error) {
    console.error(`❌ Error generating report: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

