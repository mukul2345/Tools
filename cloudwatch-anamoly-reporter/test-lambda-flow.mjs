#!/usr/bin/env node
/**
 * Test Lambda Flow Locally
 * Simulates the Lambda orchestrator execution to test all dashboards
 * Usage: node test-lambda-flow.mjs
 */

import { handler as orchestratorHandler } from "./src/lambdas/orchestratorHandler.mjs";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config({ path: path.join(__dirname, ".env") });

/**
 * Test Lambda orchestrator flow
 */
async function testLambdaFlow() {
  console.log("🧪 Testing Lambda Orchestrator Flow");
  console.log("=".repeat(60));
  console.log("");

  // Simulate EventBridge cron event (empty event = process all dashboards)
  const event = {};
  
  console.log("📋 Simulating EventBridge cron trigger (empty event)");
  console.log("   This will process ALL enabled dashboards");
  console.log("");

  try {
    const startTime = Date.now();
    
    // Call the orchestrator handler (same as Lambda would)
    const result = await orchestratorHandler(event);
    
    const durationMs = Date.now() - startTime;
    const response = JSON.parse(result.body);

    console.log("");
    console.log("=".repeat(60));
    console.log("✅ Lambda Flow Test Completed");
    console.log("=".repeat(60));
    console.log("");
    console.log(`📊 Status: ${response.status}`);
    console.log(`📈 Dashboards Processed: ${response.dashboardsProcessed}`);
    console.log(`⏱️  Total Duration: ${(durationMs / 1000).toFixed(2)}s`);
    console.log("");

    if (response.status === "success") {
      console.log("📋 Results Summary:");
      console.log("");
      response.results.forEach((r, idx) => {
        console.log(`  ${idx + 1}. ${r.dashboardName || r.dashboard}`);
        console.log(`     Status: ${r.status}`);
        if (r.status === "success") {
          console.log(`     Anomalies: ${r.anomaliesFound} / ${r.totalMetrics} metrics`);
          console.log(`     S3 Key: ${r.s3Key}`);
          console.log(`     Duration: ${(r.durationMs / 1000).toFixed(2)}s`);
        } else {
          console.log(`     Error: ${r.error}`);
        }
        console.log("");
      });

      console.log("=".repeat(60));
      console.log("✅ All reports generated successfully!");
      console.log("   Reports uploaded to S3 and Google Chat notifications sent");
      console.log("");
    } else {
      console.error("❌ Test failed:");
      console.error(`   Error: ${response.error}`);
      console.log("");
      process.exit(1);
    }
  } catch (error) {
    console.error("");
    console.error("=".repeat(60));
    console.error("❌ Lambda Flow Test Failed");
    console.error("=".repeat(60));
    console.error(`Error: ${error.message}`);
    console.error(error.stack);
    console.error("");
    process.exit(1);
  }
}

// Run the test
testLambdaFlow();

