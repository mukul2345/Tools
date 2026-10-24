#!/usr/bin/env node
/**
 * Orchestrator Lambda Handler - Reads S3 config and invokes workers sequentially
 */

import { loadDashboardsConfig } from "../core/configLoader.mjs";
import { handler as workerHandler } from "./workerHandler.mjs";

/**
 * Lambda handler for orchestrating dashboard processing
 * Triggered by EventBridge schedule
 * @param {Object} event - Lambda event (from EventBridge)
 * @returns {Promise<Object>} Lambda response
 */
export async function handler(event) {
  const runId = `orchestrator-${Date.now()}`;
  const startTime = Date.now();

  try {
    console.log(`[${runId}] Starting orchestrator run`);

    // Load dashboard configuration from S3 or local
    const config = await loadDashboardsConfig();
    
    // Filter dashboards based on event parameters or config
    // When cron executes (no event filters), process ALL enabled dashboards
    let dashboards = config.dashboards.filter((d) => d.enabled !== false);
    
    // Support filtering by group from event (e.g., from EventBridge input transformer)
    // Only apply filter if explicitly provided - cron execution will have no filters
    if (event && event.group) {
      dashboards = dashboards.filter(
        (d) => d.groups && d.groups.includes(event.group)
      );
      console.log(`[${runId}] Filtering by group: ${event.group}`);
    }
    
    // Support filtering by dashboard names from event
    // Only apply filter if explicitly provided - cron execution will have no filters
    if (event && event.dashboards && Array.isArray(event.dashboards)) {
      dashboards = dashboards.filter((d) => event.dashboards.includes(d.name));
      console.log(`[${runId}] Filtering by dashboard names: ${event.dashboards.join(", ")}`);
    }
    
    // Log when processing all dashboards (cron execution)
    if (!event || (!event.group && !event.dashboards)) {
      console.log(`[${runId}] Cron execution: Processing ALL ${dashboards.length} enabled dashboard(s)`);
    }

    console.log(`[${runId}] Found ${dashboards.length} enabled dashboard(s) to process`);

    const results = [];

    // Process dashboards sequentially
    for (const dashboard of dashboards) {
      console.log(`[${runId}] Processing dashboard: ${dashboard.name}`);

      const workerEvent = {
        runId: `${runId}-${dashboard.name}`,
        dashboardName: dashboard.name,
        overrides: {
          // detectionWindowMinutes: 5 is too short (5 minutes vs 300 minutes/5 hours in local configs)
          // Only use if it's a reasonable value (>= 60 minutes)
          windowMinutes: dashboard.detectionWindowMinutes && dashboard.detectionWindowMinutes >= 60
            ? dashboard.detectionWindowMinutes
            : undefined, // Use default from config (300 minutes/5 hours)
          // baselineWindowMinutes: 300 = 0.2 days is WAY TOO SHORT for baseline (need 3-7 days)
          // Local configs use baselineDays: 7 (7 days)
          // Ignore baselineWindowMinutes and use default from config (7 days)
          baselineDays: undefined, // Always use default from config (7 days from configuration.json)
        },
      };

      const workerResult = await workerHandler(workerEvent);
      results.push({
        dashboard: dashboard.name,
        ...JSON.parse(workerResult.body),
      });

      // Small delay between dashboards to avoid throttling
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const durationMs = Date.now() - startTime;

    console.log(`[${runId}] Orchestrator run completed in ${durationMs}ms`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        runId,
        status: "success",
        dashboardsProcessed: results.length,
        results,
        durationMs,
      }),
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    console.error(`[${runId}] Orchestrator error: ${error.message}`);
    console.error(error.stack);

    return {
      statusCode: 500,
      body: JSON.stringify({
        runId,
        status: "error",
        error: error.message,
        durationMs,
      }),
    };
  }
}

