#!/usr/bin/env node

/**
 * CloudWatch Metrics Reports CLI
 *
 * Generates Markdown tables for latency and error metrics from CloudWatch
 */

import { getConfig } from "./config.mjs";
import { normalizeTimeRange, validatePeriod } from "./time.mjs";
import {
  discoverEndpointsForServices,
  fetchLatencyData,
  fetchErrorData,
  fetchECSResourceData,
  fetchSQSAgeData,
  fetchLambdaPerformanceData,
  fetchTopApisByVolume,
} from "./discovery.mjs";
import {
  renderLatencyTable,
  renderErrorTable,
  renderLatencyCSV,
  renderErrorCSV,
  renderECSResourceTable,
  renderECSResourceCSV,
  renderSQSAgeTable,
  renderSQSAgeCSV,
  renderLambdaPerformanceTable,
  renderLambdaPerformanceCSV,
  renderTopApisTable,
  renderTopApisCSV,
  combineReports,
} from "./markdown.mjs";
import {
  runTrafficTrendModule,
  renderTrafficTrendTable,
  renderTrafficTrendCSV,
} from "./traffic-trend.mjs";
import { generateFilename, writeFile, generateFileSummary } from "./output.mjs";
import { logger } from "./logger.mjs";

/**
 * Parse command line arguments
 * @returns {Object} - Parsed arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    config: "./config.json",
    modules: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--config") {
      parsed.config = args[++i];
      continue;
    }

    if (arg === "--start") {
      parsed.startISO = args[++i];
      continue;
    }

    if (arg === "--end") {
      parsed.endISO = args[++i];
      continue;
    }

    if (arg === "--period") {
      parsed.periodSeconds = parseInt(args[++i], 10);
      continue;
    }

    if (arg === "--latencyThresholdMs") {
      parsed.latencyThresholdMs = parseFloat(args[++i]);
      continue;
    }

    if (arg === "--errorThreshold") {
      parsed.errorThreshold = parseFloat(args[++i]);
      continue;
    }

    if (arg === "--module") {
      const module = args[++i];
      if (
        ![
          "latency",
          "errors",
          "ecs-resources",
          "sqs-age",
          "lambda-performance",
          "top-apis",
          "traffic-trend",
        ].includes(module)
      ) {
        console.error(
          `Invalid module: ${module}. Must be 'latency', 'errors', 'ecs-resources', 'sqs-age', 'lambda-performance', 'top-apis', or 'traffic-trend'.`
        );
        process.exit(1);
      }
      parsed.modules.push(module);
      continue;
    }

    if (arg === "--weeks") {
      parsed.trendWeeks = parseInt(args[++i], 10);
      continue;
    }

    if (arg === "--trend-services") {
      parsed.trendServices = args[++i].split(",").map((s) => s.trim());
      continue;
    }

    if (arg === "--namespace") {
      parsed.customNamespace = args[++i];
      continue;
    }

    if (arg === "--services") {
      parsed.services = args[++i].split(",").map((s) => s.trim());
      continue;
    }

    if (arg === "--latencyFilterMode") {
      parsed.latencyFilterMode = args[++i];
      continue;
    }

    if (arg === "--errorFilterMode") {
      parsed.errorFilterMode = args[++i];
      continue;
    }
  }

  // Default to modules from config if none specified via CLI
  if (parsed.modules.length === 0 && !parsed.modulesSpecified) {
    // Will use config.modules later
    parsed.useConfigModules = true;
  }

  return parsed;
}

/**
 * Print help message
 */
function printHelp() {
  console.log(`
CloudWatch Metrics Reports CLI

Usage:
  node src/index.mjs [options]

Options:
  --config <path>              Path to config JSON file (default: ./config.json)
  --start <iso-datetime>       Start time (ISO format with timezone)
  --end <iso-datetime>         End time (ISO format with timezone)
  --period <seconds>           Period in seconds
  --latencyThresholdMs <ms>    Latency threshold in milliseconds (default: 100)
  --latencyFilterMode <mode>   Filter mode: 'below' or 'above' (default: below)
  --errorThreshold <count>     Error count threshold (default: 10)
  --errorFilterMode <mode>     Filter mode: 'below' or 'above' (default: below)
  --module <module>            Module to run: 'latency', 'errors', 'ecs-resources', 'sqs-age', or 'lambda-performance' (can be repeated, default: from config)
  --namespace <namespace>      CloudWatch namespace
  --services <svc1,svc2>       Comma-separated service list
  --help, -h                   Show this help message

Environment Variables:
  LOG_LEVEL                    Logging level: error, warn, info, debug (default: info)
  AWS_REGION                   AWS region (defaults to AWS SDK default)
  AWS_PROFILE                  AWS profile to use

Examples:
  # Run all modules with default config
  node src/index.mjs

  # Run only latency module with custom time range
  node src/index.mjs --module latency --start "2025-11-02T00:00:00+05:30" --end "2025-11-02T23:59:59+05:30"

  # Run only ECS resources module
  node src/index.mjs --module ecs-resources

  # Run only SQS age module
  node src/index.mjs --module sqs-age

  # Run latency and ECS modules
  node src/index.mjs --module latency --module ecs-resources

  # Override threshold values
  node src/index.mjs --latencyThresholdMs 200 --errorThreshold 5
  
  # Find slow APIs (p90 > 300ms)
  node src/index.mjs --module latency --latencyFilterMode above --latencyThresholdMs 300

Output:
  - Markdown files (for Confluence) written to ./output/ directory
  - CSV files (for Excel analysis) written to ./output/ directory
  - Filenames include module, filter mode, and timestamp
  - Example: latency-above-2025-11-03-14-30-45.md
  - Logs are printed to stderr
`);
}

/**
 * Run latency module
 * @param {Object} config
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<{rows: Array, filterMode: string}>}
 */
async function runLatencyModule(config, start, end) {
  logger.info("Running Latency Module...");

  // Discover endpoints
  const serviceEndpoints = await discoverEndpointsForServices({
    namespace: config.customNamespace,
    services: config.services,
    metricName: "API_LATENCY",
    statusCodes: config.statusCodesForLatency,
  });

  // Fetch data
  const latencyRows = await fetchLatencyData({
    namespace: config.customNamespace,
    serviceEndpoints,
    successCodes: config.statusCodesForLatency,
    start,
    end,
    period: config.periodSeconds,
    thresholdMs: config.latencyThresholdMs,
    filterMode: config.latencyFilterMode,
  });

  return {
    rows: latencyRows,
    filterMode: config.latencyFilterMode,
  };
}

/**
 * Run errors module
 * @param {Object} config
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<{rows: Array, filterMode: string}>}
 */
async function runErrorsModule(config, start, end) {
  logger.info("Running Errors Module...");

  // Discover endpoints
  const serviceEndpoints = await discoverEndpointsForServices({
    namespace: config.customNamespace,
    services: config.services,
    metricName: "API_COUNT",
    // No status code filter - we need all endpoints
  });

  // Fetch data
  const errorRows = await fetchErrorData({
    namespace: config.customNamespace,
    serviceEndpoints,
    errorCodes: config.statusCodesForErrors,
    start,
    end,
    period: config.periodSeconds,
    errorThreshold: config.errorThreshold,
    filterMode: config.errorFilterMode,
  });

  return {
    rows: errorRows,
    filterMode: config.errorFilterMode,
  };
}

/**
 * Run ECS resources module
 * @param {Object} config
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<{rows: Array}>}
 */
async function runECSResourcesModule(config, start, end) {
  logger.info("Running ECS Resources Module...");

  // Fetch data
  const ecsRows = await fetchECSResourceData({
    clusterName: config.ecsClusterName,
    services: config.services,
    start,
    end,
    period: config.ecsPeriodSeconds,
  });

  return {
    rows: ecsRows,
  };
}

/**
 * Run SQS age module
 * @param {Object} config
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<{rows: Array}>}
 */
async function runSQSAgeModule(config, start, end) {
  logger.info("Running SQS Age Module...");

  // Fetch data
  const sqsRows = await fetchSQSAgeData({
    queues: config.sqsQueueNames,
    start,
    end,
    period: config.sqsPeriodSeconds,
  });

  return {
    rows: sqsRows,
  };
}

/**
 * Run Lambda performance module
 * @param {Object} config
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<{rows: Array}>}
 */
async function runLambdaPerformanceModule(config, start, end) {
  logger.info("Running Lambda Performance Module...");

  // Fetch data
  const lambdaRows = await fetchLambdaPerformanceData({
    functions: config.lambdaFunctionNames,
    start,
    end,
    periods: config.lambdaPeriods,
  });

  return {
    rows: lambdaRows,
  };
}

/**
 * Run top APIs module
 * @param {Object} config
 * @param {Date} start
 * @param {Date} end
 * @returns {Promise<{rows: Array}>}
 */
async function runTopApisModule(config, start, end) {
  logger.info("Running Top APIs Module...");

  const serviceEndpoints = await discoverEndpointsForServices({
    namespace: config.customNamespace,
    services: config.services,
    metricName: "API_COUNT",
  });

  const rows = await fetchTopApisByVolume({
    namespace: config.customNamespace,
    serviceEndpoints,
    start,
    end,
    period: config.periodSeconds,
    topN: config.topApisLimit ?? 20,
  });

  return { rows };
}

/**
 * Main execution
 */
async function main() {
  try {
    const cliArgs = parseArgs();
    const config = getConfig(cliArgs.config, cliArgs);

    // Use modules from config if none specified via CLI
    const modulesToRun = cliArgs.useConfigModules
      ? config.modules
      : cliArgs.modules;

    // Validate and normalize time range
    const { start, end } = normalizeTimeRange(config.startISO, config.endISO);
    validatePeriod(config.periodSeconds);

    logger.info("CloudWatch Metrics Report Generator");
    logger.info(`Namespace: ${config.customNamespace}`);
    logger.info(`Services: ${config.services.join(", ")}`);
    logger.info(`Time range: ${start.toISOString()} to ${end.toISOString()}`);
    logger.info(`Period: ${config.periodSeconds}s`);
    logger.info(`Modules: ${modulesToRun.join(", ")}`);

    const writtenFiles = [];

    // Run selected modules
    for (const module of modulesToRun) {
      if (module === "latency") {
        const { rows, filterMode } = await runLatencyModule(config, start, end);

        // Generate Markdown
        const markdown = renderLatencyTable(rows, filterMode);
        const mdFilename = generateFilename("latency", filterMode, "md.txt");
        const mdPath = writeFile(mdFilename, markdown);
        writtenFiles.push({ type: "Latency Markdown", path: mdPath });

        // Generate CSV
        const csv = renderLatencyCSV(rows, filterMode);
        const csvFilename = generateFilename("latency", filterMode, "csv");
        const csvPath = writeFile(csvFilename, csv);
        writtenFiles.push({ type: "Latency CSV", path: csvPath });
      } else if (module === "errors") {
        const { rows, filterMode } = await runErrorsModule(config, start, end);

        // Generate Markdown
        const markdown = renderErrorTable(rows, filterMode);
        const mdFilename = generateFilename("errors", filterMode, "md.txt");
        const mdPath = writeFile(mdFilename, markdown);
        writtenFiles.push({ type: "Errors Markdown", path: mdPath });

        // Generate CSV
        const csv = renderErrorCSV(rows, filterMode);
        const csvFilename = generateFilename("errors", filterMode, "csv");
        const csvPath = writeFile(csvFilename, csv);
        writtenFiles.push({ type: "Errors CSV", path: csvPath });
      } else if (module === "ecs-resources") {
        const { rows } = await runECSResourcesModule(config, start, end);

        // Generate Markdown
        const markdown = renderECSResourceTable(rows);
        const mdFilename = generateFilename("ecs-resources", "all", "md.txt");
        const mdPath = writeFile(mdFilename, markdown);
        writtenFiles.push({ type: "ECS Resources Markdown", path: mdPath });

        // Generate CSV
        const csv = renderECSResourceCSV(rows);
        const csvFilename = generateFilename("ecs-resources", "all", "csv");
        const csvPath = writeFile(csvFilename, csv);
        writtenFiles.push({ type: "ECS Resources CSV", path: csvPath });
      } else if (module === "sqs-age") {
        const { rows } = await runSQSAgeModule(config, start, end);

        // Generate Markdown
        const markdown = renderSQSAgeTable(rows);
        const mdFilename = generateFilename("sqs-age", "all", "md.txt");
        const mdPath = writeFile(mdFilename, markdown);
        writtenFiles.push({ type: "SQS Age Markdown", path: mdPath });

        // Generate CSV
        const csv = renderSQSAgeCSV(rows);
        const csvFilename = generateFilename("sqs-age", "all", "csv");
        const csvPath = writeFile(csvFilename, csv);
        writtenFiles.push({ type: "SQS Age CSV", path: csvPath });
      } else if (module === "lambda-performance") {
        const { rows } = await runLambdaPerformanceModule(config, start, end);

        // Generate Markdown
        const markdown = renderLambdaPerformanceTable(rows);
        const mdFilename = generateFilename(
          "lambda-performance",
          "all",
          "md.txt"
        );
        const mdPath = writeFile(mdFilename, markdown);
        writtenFiles.push({
          type: "Lambda Performance Markdown",
          path: mdPath,
        });

        // Generate CSV
        const csv = renderLambdaPerformanceCSV(rows);
        const csvFilename = generateFilename(
          "lambda-performance",
          "all",
          "csv"
        );
        const csvPath = writeFile(csvFilename, csv);
        writtenFiles.push({ type: "Lambda Performance CSV", path: csvPath });
      } else if (module === "top-apis") {
        const { rows } = await runTopApisModule(config, start, end);

        // Generate Markdown
        const markdown = renderTopApisTable(rows);
        const mdFilename = generateFilename("top-apis", "all", "md.txt");
        const mdPath = writeFile(mdFilename, markdown);
        writtenFiles.push({ type: "Top APIs Markdown", path: mdPath });

        // Generate CSV
        const csv = renderTopApisCSV(rows);
        const csvFilename = generateFilename("top-apis", "all", "csv");
        const csvPath = writeFile(csvFilename, csv);
        writtenFiles.push({ type: "Top APIs CSV", path: csvPath });
      } else if (module === "traffic-trend") {
        const trendServices = config.trendServices || config.services;
        const numWeeks = config.trendWeeks || 12;

        const trendData = await runTrafficTrendModule({
          namespace: config.customNamespace,
          services: trendServices,
          startDate: start,
          numWeeks,
        });

        // Generate Markdown
        const markdown = renderTrafficTrendTable(trendData);
        const mdFilename = generateFilename("traffic-trend", "all", "md.txt");
        const mdPath = writeFile(mdFilename, markdown);
        writtenFiles.push({ type: "Traffic Trend Markdown", path: mdPath });

        // Generate CSV
        const csv = renderTrafficTrendCSV(trendData);
        const csvFilename = generateFilename("traffic-trend", "all", "csv");
        const csvPath = writeFile(csvFilename, csv);
        writtenFiles.push({ type: "Traffic Trend CSV", path: csvPath });
      }
    }

    // Print summary
    const summary = generateFileSummary(writtenFiles);
    console.log(summary);

    logger.info("✅ Report generation completed successfully");
  } catch (error) {
    logger.error("Fatal error:", error.message);
    if (error.stack && process.env.LOG_LEVEL === "debug") {
      logger.debug(error.stack);
    }
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main };
