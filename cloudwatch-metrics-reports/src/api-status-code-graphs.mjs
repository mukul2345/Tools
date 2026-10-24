#!/usr/bin/env node

/**
 * API Status Code Graph Lister
 *
 * 1. Fetches list of services from CloudWatch (dimension: serviceName)
 * 2. For each service, gets list of APIs from API_STATUS_CODE metrics
 * 3. Lists APIs and outputs graph metric format: (m1/(m1+m2+m3))*100 per API
 *
 * No alarms created. Outputs to console.
 *
 * Usage:
 *   node src/api-status-code-graphs.mjs [--namespace=DFG-Observability] [--environment=production] [--profile=production]
 *   npm run api-status-graphs
 */

import { logger } from "./logger.mjs";
import { getConfig } from "./config.mjs";
import { normalizeTimeRange, validatePeriod } from "./time.mjs";
import {
  discoverEndpointsForServices,
  fetchTopApisByVolume,
} from "./discovery.mjs";

const METRIC_NAME = "API_STATUS_CODE";

// Allowed services (CloudWatch serviceName dimension values)
const ALLOWED_SERVICES = new Set([
  // "core-verification-data-structure-service",
  // "client-contract-service",
  "verification-request",
  // "verification-workflow-engine",
  // "verification-initiation-service",
  // "poi-service",
  // "payment-service",
  // "document-generation-service",
  // "document-management-service",
  // "document-service",
  // "narada",
  // "migration-service",
]);

/**
 * Parse CLI arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    namespace: "DFG-Observability",
    environment: "production",
    module: null,
    config: "./config.json",
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(`
API Status Code Graph Lister

Lists APIs and graph metric format (m1/(m1+m2+m3))*100 for 5xx Error % per API

Usage: node src/api-status-code-graphs.mjs [options]

Options:
  --namespace=NAME       CloudWatch namespace (default: DFG-Observability)
  --environment=ENV      Environment dimension (default: production)
  --profile=NAME         AWS profile (default: production, or AWS_PROFILE env)
  --module=top-apis      Use top APIs only (from config, top N by volume per service)
  --config=PATH          Config file for top-apis (default: ./config.json)
  --help, -h             Show this help
`);
      process.exit(0);
    }
    if (arg.startsWith("--namespace=")) {
      parsed.namespace = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--environment=")) {
      parsed.environment = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--profile=")) {
      parsed.profile = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--module=")) {
      parsed.module = arg.split("=").slice(1).join("=");
    } else if (arg.startsWith("--config=")) {
      parsed.config = arg.split("=").slice(1).join("=");
    }
  }
  return parsed;
}

/**
 * Discover unique services from API_STATUS_CODE metrics (dimension: serviceName)
 */
async function discoverServices(namespace, listMetricsAll) {
  logger.info(`Discovering services from ${namespace}/${METRIC_NAME}...`);

  const metrics = await listMetricsAll({
    namespace,
    metricName: METRIC_NAME,
  });

  const services = new Set();
  for (const metric of metrics) {
    const dims = metric.Dimensions || [];
    const serviceNameDim = dims.find(
      (d) => d.Name === "serviceName" || d.Name === "ServiceName",
    );
    if (serviceNameDim) {
      services.add(serviceNameDim.Value);
    }
  }

  logger.info(`Found ${services.size} services`);
  return services;
}

/**
 * Discover APIs (endpoints) per service from API_STATUS_CODE metrics
 * @returns {Map<string, Set<string>>} serviceName -> Set of endpoints
 */
async function discoverAPIsPerService(
  namespace,
  listMetricsAll,
  services = null,
) {
  const { serviceAPIs } = await discoverAPIsWithStatusCodes(
    namespace,
    listMetricsAll,
    services,
  );
  return serviceAPIs;
}

/**
 * Discover APIs with status codes (2xx, 4xx, 5xx) per endpoint
 * @returns {{ serviceAPIs: Map<string, Set<string>>, endpointStatusCodes: Map<string, Set<string>> }}
 *   - serviceAPIs: serviceName -> Set of endpoints
 *   - endpointStatusCodes: "serviceName|endpoint" -> Set of statusCodes (2xx, 4xx, 5xx)
 */
async function discoverAPIsWithStatusCodes(
  namespace,
  listMetricsAll,
  services = null,
) {
  logger.info(
    `Discovering APIs with status codes from ${namespace}/${METRIC_NAME}...`,
  );

  const metrics = await listMetricsAll({
    namespace,
    metricName: METRIC_NAME,
  });

  const serviceAPIs = new Map();
  const endpointStatusCodes = new Map();

  for (const metric of metrics) {
    const dims = metric.Dimensions || [];
    const serviceNameDim = dims.find(
      (d) => d.Name === "serviceName" || d.Name === "ServiceName",
    );
    const endpointDim = dims.find(
      (d) => d.Name === "endpoint" || d.Name === "Endpoint",
    );
    const statusCodeDim = dims.find(
      (d) => d.Name === "statusCode" || d.Name === "StatusCode",
    );

    if (!serviceNameDim || !endpointDim) continue;

    const serviceName = serviceNameDim.Value;
    const endpoint = endpointDim.Value;
    const statusCode = statusCodeDim?.Value;

    if (services && !services.has(serviceName)) continue;

    if (!serviceAPIs.has(serviceName)) {
      serviceAPIs.set(serviceName, new Set());
    }
    serviceAPIs.get(serviceName).add(endpoint);

    if (statusCode) {
      const key = `${serviceName}|${endpoint}`;
      if (!endpointStatusCodes.has(key)) {
        endpointStatusCodes.set(key, new Set());
      }
      endpointStatusCodes.get(key).add(statusCode);
    }
  }

  let totalAPIs = 0;
  for (const [svc, endpoints] of serviceAPIs) {
    totalAPIs += endpoints.size;
  }
  logger.info(
    `Found ${totalAPIs} unique APIs across ${serviceAPIs.size} services`,
  );

  return { serviceAPIs, endpointStatusCodes };
}

/**
 * Build CloudWatch dashboard metric row
 * Format: [namespace, metricName, dim1, val1, dim2, val2, ..., { id, visible }]
 */
function buildMetricRow(
  namespace,
  metricName,
  dimensions,
  id,
  visible = false,
) {
  const order = ["endpoint", "environment", "serviceName", "statusCode"];
  const dimPairs = [];
  for (const name of order) {
    if (dimensions[name] !== undefined) {
      dimPairs.push(name, dimensions[name]);
    }
  }
  return [namespace, metricName, ...dimPairs, { id, visible }];
}

/**
 * Build graph metrics for a single API
 * 5xx % = (5xx sum / (5xx sum + 4xx sum + 2xx sum)) * 100
 * CloudWatch metrics format: each element in metrics array is itself an array
 */
function buildGraphMetrics(namespace, serviceName, endpoint, environment) {
  const baseDims = {
    endpoint,
    environment,
    serviceName,
  };

  return [
    [{ expression: "(m1/(m1+m2+m3))*100", label: "5xx Error %", id: "e1" }],
    buildMetricRow(
      namespace,
      METRIC_NAME,
      { ...baseDims, statusCode: "5xx" },
      "m1",
      false,
    ),
    buildMetricRow(
      namespace,
      METRIC_NAME,
      { ...baseDims, statusCode: "2xx" },
      "m2",
      false,
    ),
    buildMetricRow(
      namespace,
      METRIC_NAME,
      { ...baseDims, statusCode: "4xx" },
      "m3",
      false,
    ),
  ];
}

/**
 * Build full widget JSON for CloudWatch dashboard (single API)
 */
function buildWidgetJson(
  namespace,
  serviceName,
  endpoint,
  environment,
  region,
  period,
) {
  const metrics = buildGraphMetrics(
    namespace,
    serviceName,
    endpoint,
    environment,
  );
  return {
    metrics,
    view: "timeSeries",
    stacked: false,
    region: region || "eu-west-1",
    stat: "Sum",
    period: period || 300,
  };
}

/**
 * Build one widget per service with all APIs for that service.
 * Uses unique IDs per API within the service (m1_0, m2_0, m3_0, e1_0 for API 0, etc.)
 */
function buildServiceWidgetJson(
  serviceAPIs,
  serviceName,
  namespace,
  environment,
  region,
  period,
) {
  const endpoints = [...serviceAPIs.get(serviceName)].sort();
  const metrics = [];

  endpoints.forEach((endpoint, i) => {
    const baseDims = { endpoint, environment, serviceName };
    const m1 = `m1_${i}`;
    const m2 = `m2_${i}`;
    const m3 = `m3_${i}`;
    const e1 = `e1_${i}`;
    const total = `total_${i}`;

    // 5xx Error %
    metrics.push([
      {
        expression: `(${m1}/(${m1}+${m2}+${m3}))*100`,
        label: `${endpoint} - 5xx %`,
        id: e1,
      },
    ]);
    // Total API traffic: e1_total_i = 2xx + 4xx + 5xx, then ANOMALY_DETECTION_BAND(e1_total_i, 2)
    const e1Total = `e1_total_${i}`;
    metrics.push([
      {
        expression: `${m1}+${m2}+${m3}`,
        label: `${endpoint} - Total Traffic`,
        id: e1Total,
        visible: false,
      },
    ]);
    metrics.push([
      {
        expression: `ANOMALY_DETECTION_BAND(${e1Total}, 2)`,
        label: `${endpoint} - Total Traffic (Anomaly Band)`,
        id: total,
      },
    ]);
    metrics.push(
      buildMetricRow(
        namespace,
        METRIC_NAME,
        { ...baseDims, statusCode: "5xx" },
        m1,
        false,
      ),
      buildMetricRow(
        namespace,
        METRIC_NAME,
        { ...baseDims, statusCode: "2xx" },
        m2,
        false,
      ),
      buildMetricRow(
        namespace,
        METRIC_NAME,
        { ...baseDims, statusCode: "4xx" },
        m3,
        false,
      ),
    );
  });

  return {
    title: `5xx Error % - ${serviceName} (${endpoints.length} APIs)`,
    metrics,
    view: "timeSeries",
    stacked: false,
    region: region || "eu-west-1",
    stat: "Sum",
    period: period || 300,
  };
}

/**
 * Main execution
 */
async function main() {
  try {
    const opts = parseArgs();

    // Set AWS profile before loading cloudwatch
    if (opts.profile) {
      process.env.AWS_PROFILE = opts.profile;
    } else if (!process.env.AWS_PROFILE) {
      process.env.AWS_PROFILE = "production";
    }

    const { listMetricsAll } = await import("./cloudwatch.mjs");

    logger.info("API Status Code Graph Lister");
    logger.info(`Namespace: ${opts.namespace}`);
    logger.info(`Environment: ${opts.environment}`);
    logger.info(`AWS Profile: ${process.env.AWS_PROFILE}`);

    let serviceAPIs;
    let endpointStatusCodes;
    let sortedServices;
    let allAPIs;

    if (opts.module === "top-apis") {
      // Top APIs mode: get top N APIs by volume from config
      const config = getConfig(opts.config, {});
      opts.namespace = config.customNamespace;
      const { start, end } = normalizeTimeRange(config.startISO, config.endISO);
      validatePeriod(config.periodSeconds);

      logger.info(
        `Module: top-apis (top ${config.topApisLimit ?? 20} per service)`,
      );
      logger.info(`Time range: ${start.toISOString()} to ${end.toISOString()}`);

      const serviceEndpoints = await discoverEndpointsForServices({
        namespace: config.customNamespace,
        services: config.services,
        metricName: "API_COUNT",
      });

      const topApisRows = await fetchTopApisByVolume({
        namespace: config.customNamespace,
        serviceEndpoints,
        start,
        end,
        period: config.periodSeconds,
        topN: config.topApisLimit ?? 20,
      });

      // Build allAPIs from top APIs
      allAPIs = [];
      for (const row of topApisRows) {
        for (const { endpoint } of row.topApis) {
          allAPIs.push({ serviceName: row.service, endpoint });
        }
      }
      allAPIs.sort(
        (a, b) =>
          a.serviceName.localeCompare(b.serviceName) ||
          a.endpoint.localeCompare(b.endpoint),
      );

      // Build serviceAPIs and get endpointStatusCodes for top APIs only
      serviceAPIs = new Map();
      for (const { serviceName, endpoint } of allAPIs) {
        if (!serviceAPIs.has(serviceName))
          serviceAPIs.set(serviceName, new Set());
        serviceAPIs.get(serviceName).add(endpoint);
      }
      sortedServices = [...serviceAPIs.keys()].sort();

      const servicesSet = new Set(config.services);
      const { endpointStatusCodes: allEndpointStatusCodes } =
        await discoverAPIsWithStatusCodes(
          config.customNamespace,
          listMetricsAll,
          servicesSet,
        );
      endpointStatusCodes = allEndpointStatusCodes;
    } else {
      // Default: all allowed services
      const allServices = await discoverServices(
        opts.namespace,
        listMetricsAll,
      );
      const services = new Set(
        [...allServices].filter((s) => ALLOWED_SERVICES.has(s)),
      );

      if (services.size === 0) {
        logger.warn(
          "No allowed services found. Check ALLOWED_SERVICES and namespace.",
        );
        process.exit(0);
      }

      logger.info(
        `Filtered to ${services.size} allowed services: ${[...services].sort().join(", ")}`,
      );

      const result = await discoverAPIsWithStatusCodes(
        opts.namespace,
        listMetricsAll,
        services,
      );
      serviceAPIs = result.serviceAPIs;
      endpointStatusCodes = result.endpointStatusCodes;

      if (serviceAPIs.size === 0) {
        logger.warn("No APIs found.");
        process.exit(0);
      }

      sortedServices = [...serviceAPIs.keys()].sort();
      allAPIs = [];
      for (const [serviceName, endpoints] of serviceAPIs) {
        for (const endpoint of [...endpoints].sort()) {
          allAPIs.push({ serviceName, endpoint });
        }
      }
      allAPIs.sort(
        (a, b) =>
          a.serviceName.localeCompare(b.serviceName) ||
          a.endpoint.localeCompare(b.endpoint),
      );
    }

    if (allAPIs.length === 0) {
      logger.warn("No APIs found.");
      process.exit(0);
    }

    // 1. Allowed services
    console.log("\n--- Allowed services ---\n");
    for (const svc of sortedServices) {
      console.log(`  ${svc}`);
    }
    console.log(`\n  Total: ${sortedServices.length} services`);

    // 2. Graph metrics - one widget per service (CloudWatch widget JSON)
    const region = process.env.AWS_REGION || "eu-west-1";
    const period = 300;

    console.log("\n--- Graph metrics: One widget per service ---\n");
    for (const serviceName of sortedServices) {
      const widget = buildServiceWidgetJson(
        serviceAPIs,
        serviceName,
        opts.namespace,
        opts.environment,
        region,
        period,
      );
      console.log(`# ${serviceName}`);
      console.log(JSON.stringify(widget, null, 2));
      console.log("");
    }

    console.log(
      `\n✅ Summary: ${sortedServices.length} service widgets, ${allAPIs.length} APIs total`,
    );
  } catch (error) {
    logger.error("Fatal error:", error.message);
    if (error.stack && process.env.LOG_LEVEL === "debug") {
      logger.debug(error.stack);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  METRIC_NAME,
  ALLOWED_SERVICES,
  discoverServices,
  discoverAPIsPerService,
  discoverAPIsWithStatusCodes,
  buildGraphMetrics,
  buildWidgetJson,
  buildServiceWidgetJson,
};
