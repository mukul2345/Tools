#!/usr/bin/env node

/**
 * API Status Code CloudWatch Alarms Script
 *
 * Creates CloudWatch alarms for 5xx % and Total Traffic per API using anomaly detection.
 * Configured via a single config file (default: api-alarms.config.json).
 *
 * Prerequisites:
 *   - AWS credentials (profile/region in config or env)
 *   - Config file with services list, alarm settings, and optional SNS ARN
 *
 * Usage:
 *   node src/api-status-code-alarms.mjs [options]
 *   node src/api-status-code-alarms.mjs --config=./api-alarms.config.json --dry-run
 *   node src/api-status-code-alarms.mjs --create-alarms
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.mjs";
import { normalizeTimeRange } from "./time.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, "..", "api-alarms.config.json");

const METRIC_NAME = "API_STATUS_CODE";
// ---------------------------------------------------------------------------
// API Alarms config: load and validate (single source of truth)
// ---------------------------------------------------------------------------

const DEFAULT_API_ALARMS_CONFIG = {
  aws: { profile: "production", region: "eu-west-1" },
  metrics: { namespace: "DFG-Observability", environment: "production" },
  services: [],
  alarms: {
    fiveXxPercent: {
      enabled: true,
      namePrefix: "Critical",
      lookbackDays: 14,
      defaultThresholdPercent: 5,
      minThresholdPercent: 1,
      minimumRequestCount: 20,
      thresholdPercentile: 90,
      periodSeconds: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
    },
    totalTrafficAnomaly: {
      enabled: true,
      namePrefix: "Warning",
      metricName: "API_COUNT",
      periodSeconds: 300,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      anomalyThreshold: 2,
      statusCodes: [
        "200",
        "201",
        "400",
        "401",
        "403",
        "404",
        "409",
        "412",
        "500",
      ],
    },
  },
  notifications: { alarmActionArn: null },
  tags: [{ Key: "Team", Value: "Verification Platform" }],
  apiSelection: {
    mode: "all",
    topN: 20,
    lookbackDays: 14,
    startISO: null,
    endISO: null,
    periodSeconds: 3600,
  },
};

function loadApiAlarmsConfig(configPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`API alarms config not found: ${configPath}`);
    }
    throw new Error(`Failed to load API alarms config: ${err.message}`);
  }
  const config = {
    aws: { ...DEFAULT_API_ALARMS_CONFIG.aws, ...raw.aws },
    metrics: { ...DEFAULT_API_ALARMS_CONFIG.metrics, ...raw.metrics },
    services: Array.isArray(raw.services)
      ? raw.services
      : DEFAULT_API_ALARMS_CONFIG.services,
    alarms: {
      fiveXxPercent: {
        ...DEFAULT_API_ALARMS_CONFIG.alarms.fiveXxPercent,
        ...raw.alarms?.fiveXxPercent,
      },
      totalTrafficAnomaly: {
        ...DEFAULT_API_ALARMS_CONFIG.alarms.totalTrafficAnomaly,
        ...raw.alarms?.totalTrafficAnomaly,
      },
    },
    notifications: {
      ...DEFAULT_API_ALARMS_CONFIG.notifications,
      ...raw.notifications,
    },
    tags: Array.isArray(raw.tags) ? raw.tags : DEFAULT_API_ALARMS_CONFIG.tags,
    apiSelection: {
      ...DEFAULT_API_ALARMS_CONFIG.apiSelection,
      ...raw.apiSelection,
    },
  };
  if (!config.services.length) {
    throw new Error("config.services must be a non-empty array");
  }
  if (!config.metrics.namespace) {
    throw new Error("config.metrics.namespace is required");
  }
  return config;
}

// ---------------------------------------------------------------------------
// Parse CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    createAlarms: false,
    dryRun: false,
    config: DEFAULT_CONFIG_PATH,
  };
  for (const arg of args) {
    if (arg === "--create-alarms") parsed.createAlarms = true;
    if (arg === "--dry-run") parsed.dryRun = true;
    if (arg.startsWith("--config="))
      parsed.config = arg.split("=").slice(1).join("=").trim();
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Build alarm name: Critical-{prefix}-{serviceName}-{endpoint}-{hash}
// Uses actual endpoint (no sluggifying). Hash ensures uniqueness. Max 255 chars.
// ---------------------------------------------------------------------------

function safeAlarmName(prefix, serviceName, endpoint, severityPrefix = "Critical") {
  const hash = createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
  const name = `${severityPrefix}-${prefix}-${serviceName}-${endpoint}-${hash}`.slice(
    0,
    255,
  );
  return name;
}

function calculatePercentile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(rank, sorted.length - 1));
  return sorted[index];
}

function buildTimestampValueMap(result) {
  const valuesByTimestamp = new Map();
  if (!result?.Timestamps || !result?.Values) return valuesByTimestamp;

  result.Timestamps.forEach((timestamp, idx) => {
    const value = result.Values[idx];
    if (typeof value === "number" && !Number.isNaN(value)) {
      valuesByTimestamp.set(new Date(timestamp).toISOString(), value);
    }
  });

  return valuesByTimestamp;
}

// ---------------------------------------------------------------------------
// Build Metrics array for 5xx % static threshold alarm
// Threshold = max(5xx %) from last 2 weeks; alarm when GreaterThanOrEqualToThreshold
// ---------------------------------------------------------------------------

function build5xxPercentAlarmMetrics(
  namespace,
  serviceName,
  endpoint,
  environment,
  period,
) {
  const dims = [
    { Name: "endpoint", Value: endpoint },
    { Name: "environment", Value: environment },
    { Name: "serviceName", Value: serviceName },
  ];

  return [
    {
      Id: "m1",
      ReturnData: false,
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: "API_STATUS_CODE",
          Dimensions: [...dims, { Name: "statusCode", Value: "5xx" }],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    {
      Id: "m2",
      ReturnData: false,
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: "API_STATUS_CODE",
          Dimensions: [...dims, { Name: "statusCode", Value: "2xx" }],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    {
      Id: "m3",
      ReturnData: false,
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: "API_STATUS_CODE",
          Dimensions: [...dims, { Name: "statusCode", Value: "4xx" }],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    {
      Id: "e1",
      Expression: "(m1/(m1+m2+m3))*100",
      Label: "5xx %",
      ReturnData: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Fetch 5xx % for last N days and derive threshold from p90 of eligible buckets
// ---------------------------------------------------------------------------

async function fetch5xxPercentMaxForApis({
  namespace,
  apis,
  environment = "production",
  period = 300,
  lookbackDays = 14,
  minThresholdPercent = 1,
  defaultThresholdPercent = 5,
  minimumRequestCount = 20,
  thresholdPercentile = 90,
  getMetricDataBatched,
}) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - lookbackDays);

  logger.info(
    `Fetching 5xx % for last ${lookbackDays} days (${apis.length} APIs) to compute p${thresholdPercentile} threshold with minimum ${minimumRequestCount} requests per bucket...`,
  );

  const APIS_PER_BATCH = 125; // 3 queries per API, comfortably under 500 per batch
  const thresholds = new Map();

  for (
    let batchStart = 0;
    batchStart < apis.length;
    batchStart += APIS_PER_BATCH
  ) {
    const batchApis = apis.slice(batchStart, batchStart + APIS_PER_BATCH);
    const batchQueries = [];

    batchApis.forEach((api, i) => {
      const idx = batchStart + i;
      const { serviceName, endpoint } = api;
      const dims = [
        { Name: "endpoint", Value: endpoint },
        { Name: "environment", Value: environment },
        { Name: "serviceName", Value: serviceName },
      ];
      const prefix = `e5xx${idx}_`;
      batchQueries.push({
        Id: `${prefix}m1`,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: namespace,
            MetricName: METRIC_NAME,
            Dimensions: [...dims, { Name: "statusCode", Value: "5xx" }],
          },
          Period: period,
          Stat: "Sum",
        },
      });
      batchQueries.push({
        Id: `${prefix}m2`,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: namespace,
            MetricName: METRIC_NAME,
            Dimensions: [...dims, { Name: "statusCode", Value: "2xx" }],
          },
          Period: period,
          Stat: "Sum",
        },
      });
      batchQueries.push({
        Id: `${prefix}m3`,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: namespace,
            MetricName: METRIC_NAME,
            Dimensions: [...dims, { Name: "statusCode", Value: "4xx" }],
          },
          Period: period,
          Stat: "Sum",
        },
      });
    });

    const batchResults = await getMetricDataBatched({
      queries: batchQueries,
      start,
      end,
      period,
    });

    const resultsById = new Map(
      batchResults.map((result) => [result.Id, result]),
    );

    batchApis.forEach((api, i) => {
      const idx = batchStart + i;
      const prefix = `e5xx${idx}_`;
      const fiveXxValues = buildTimestampValueMap(
        resultsById.get(`${prefix}m1`),
      );
      const twoXxValues = buildTimestampValueMap(
        resultsById.get(`${prefix}m2`),
      );
      const fourXxValues = buildTimestampValueMap(
        resultsById.get(`${prefix}m3`),
      );
      const timestamps = new Set([
        ...fiveXxValues.keys(),
        ...twoXxValues.keys(),
        ...fourXxValues.keys(),
      ]);

      const eligibleRates = [];
      for (const timestamp of timestamps) {
        const fiveXxCount = fiveXxValues.get(timestamp) ?? 0;
        const totalCount =
          fiveXxCount +
          (twoXxValues.get(timestamp) ?? 0) +
          (fourXxValues.get(timestamp) ?? 0);

        if (totalCount < minimumRequestCount) continue;
        eligibleRates.push((fiveXxCount / totalCount) * 100);
      }

      if (!eligibleRates.length) return;

      const percentileValue = calculatePercentile(
        eligibleRates,
        thresholdPercentile,
      );
      const threshold = Math.max(percentileValue, minThresholdPercent);
      thresholds.set(
        `${api.serviceName}|${api.endpoint}`,
        Math.round(threshold * 100) / 100,
      );
    });
  }

  // Set default for APIs with no data (at least min)
  for (const api of apis) {
    const key = `${api.serviceName}|${api.endpoint}`;
    if (!thresholds.has(key)) {
      thresholds.set(
        key,
        Math.max(defaultThresholdPercent, minThresholdPercent),
      );
    }
  }

  logger.info(`Computed 5xx % thresholds for ${thresholds.size} APIs`);
  return thresholds;
}

// ---------------------------------------------------------------------------
// Build Metrics array for Total Traffic anomaly alarm
// Uses configured metric source with ANOMALY_DETECTION_BAND(e1, threshold)
// ---------------------------------------------------------------------------

function buildTotalTrafficAlarmMetrics(
  namespace,
  serviceName,
  endpoint,
  environment,
  period,
  metricName,
  statusCodes,
  anomalyThreshold,
) {
  const dims = [
    { Name: "endpoint", Value: endpoint },
    { Name: "environment", Value: environment },
    { Name: "serviceName", Value: serviceName },
  ];

  const metrics = [];

  (statusCodes || []).forEach((statusCode, i) => {
    metrics.push({
      Id: `m${i + 1}`,
      ReturnData: false,
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: metricName,
          Dimensions: [...dims, { Name: "statusCode", Value: statusCode }],
        },
        Period: period,
        Stat: "Sum",
      },
    });
  });

  // e1 = total API count from the configured status-code metric buckets
  const codes = statusCodes || [];
  const sumExpr = codes.map((_, i) => `m${i + 1}`).join("+");
  metrics.push({
    Id: "e1",
    Expression: sumExpr,
    Label: "Total API Count",
    ReturnData: true,
  });

  const threshold = anomalyThreshold ?? 2;
  metrics.push({
    Id: "ad1",
    Expression: `ANOMALY_DETECTION_BAND(e1, ${threshold})`,
    ReturnData: true,
  });

  return metrics;
}

// ---------------------------------------------------------------------------
// Create alarms for one API
// ---------------------------------------------------------------------------

async function createAlarmsForApi(api, opts) {
  const { serviceName, endpoint } = api;
  const {
    namespace,
    environment,
    createAlarms,
    dryRun,
    fiveXxThreshold,
    alarmActionArn,
    baseTags,
    fiveXxConfig,
    trafficConfig,
    putAlarmWithTagSync,
  } = opts;

  const period5xx = fiveXxConfig.periodSeconds;
  const periodTraffic = trafficConfig.periodSeconds;

  const alarmActions = alarmActionArn ? [alarmActionArn] : [];
  const alarmTags = [
    ...(baseTags || []),
    { Key: "Service", Value: serviceName },
  ];
  const baseAlarmParams = {
    TreatMissingData: "ignore",
    ActionsEnabled: true,
  };
  if (alarmActions.length) baseAlarmParams.AlarmActions = alarmActions;

  const default5xx = fiveXxConfig.defaultThresholdPercent;
  const min5xx = fiveXxConfig.minThresholdPercent;
  const threshold = Math.max(fiveXxThreshold ?? default5xx, min5xx);
  let createdForApi = 0;

  // 1. 5xx % static threshold alarm
  if (fiveXxConfig.enabled !== false) {
    const alarm5xxName = safeAlarmName(
      "API-5xx",
      serviceName,
      endpoint,
      fiveXxConfig.namePrefix,
    );
    const params5xx = {
      ...baseAlarmParams,
      EvaluationPeriods: fiveXxConfig.evaluationPeriods,
      DatapointsToAlarm: fiveXxConfig.datapointsToAlarm,
      AlarmName: alarm5xxName,
      AlarmDescription: `API ${serviceName} ${endpoint} - 5xx % static threshold ${threshold}% (max from last ${fiveXxConfig.lookbackDays} days, ${fiveXxConfig.datapointsToAlarm}/${fiveXxConfig.evaluationPeriods} datapoints, ${period5xx}s)`,
      Metrics: build5xxPercentAlarmMetrics(
        namespace,
        serviceName,
        endpoint,
        environment,
        period5xx,
      ),
      Threshold: threshold,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    };

    if (dryRun) {
      logger.info(
        `[DRY-RUN] Would create alarm: ${alarm5xxName} (threshold ${threshold}%)`,
      );
    } else if (createAlarms) {
      await putAlarmWithTagSync(params5xx, [
        ...alarmTags,
        { Key: "AlarmType", Value: "5xx-percent" },
      ]);
      logger.info(`Created/updated alarm: ${alarm5xxName}`);
    }
    createdForApi++;
  }

  // 2. Total Traffic anomaly alarm - outside the band
  if (trafficConfig.enabled !== false) {
    const trafficMetrics = buildTotalTrafficAlarmMetrics(
      namespace,
      serviceName,
      endpoint,
      environment,
      periodTraffic,
      trafficConfig.metricName,
      trafficConfig.statusCodes,
      trafficConfig.anomalyThreshold,
    );
    const trafficBaseParams = {
      ...baseAlarmParams,
      EvaluationPeriods: trafficConfig.evaluationPeriods,
      DatapointsToAlarm: trafficConfig.datapointsToAlarm,
      Metrics: trafficMetrics,
      ThresholdMetricId: "ad1",
    };

    const alarmTotalTrafficName = safeAlarmName(
      "API-TotalTraffic",
      serviceName,
      endpoint,
      trafficConfig.namePrefix,
    );
    const paramsTotalTraffic = {
      ...trafficBaseParams,
      AlarmName: alarmTotalTrafficName,
      AlarmDescription: `API ${serviceName} ${endpoint} - ${trafficConfig.metricName} anomaly outside the band (threshold ${trafficConfig.anomalyThreshold}, ${trafficConfig.datapointsToAlarm}/${trafficConfig.evaluationPeriods} datapoints, ${periodTraffic}s)`,
      ComparisonOperator: "LessThanLowerOrGreaterThanUpperThreshold",
    };
    if (dryRun) {
      logger.info(`[DRY-RUN] Would create alarm: ${alarmTotalTrafficName}`);
    } else if (createAlarms) {
      await putAlarmWithTagSync(paramsTotalTraffic, [
        ...alarmTags,
        { Key: "AlarmType", Value: "total-traffic" },
      ]);
      logger.info(`Created/updated alarm: ${alarmTotalTrafficName}`);
    }
    createdForApi++;
  }

  return createdForApi;
}

// ---------------------------------------------------------------------------
// Fetch top N APIs by volume using API_STATUS_CODE (2xx+4xx+5xx) - 3 queries per endpoint
// ---------------------------------------------------------------------------

async function fetchTopApisByVolumeFromStatusCodes({
  namespace,
  serviceEndpoints,
  start,
  end,
  period,
  topN,
  environment = "production",
  buildMetricQuery,
  getMetricDataBatched,
}) {
  const queries = [];
  const queryMap = new Map();
  const statusCodes = ["2xx", "4xx", "5xx"];
  let queryId = 0;

  for (const [service, endpoints] of serviceEndpoints) {
    for (const endpoint of endpoints) {
      for (const statusCode of statusCodes) {
        const qId = `top_${queryId}`;
        queries.push(
          buildMetricQuery({
            id: qId,
            namespace,
            metricName: METRIC_NAME,
            dimensions: [
              { Name: "serviceName", Value: service },
              { Name: "endpoint", Value: endpoint },
              { Name: "statusCode", Value: statusCode },
              { Name: "environment", Value: environment },
            ],
            stat: "Sum",
            period,
          }),
        );
        queryMap.set(qId, { service, endpoint, statusCode });
        queryId++;
      }
    }
  }

  logger.info(
    `Fetching top APIs volume: ${queries.length} queries (3 status codes × ${queryId / 3} endpoints)`,
  );

  const results = await getMetricDataBatched({ queries, start, end, period });

  const endpointTotals = new Map();
  for (const result of results) {
    const meta = queryMap.get(result.Id);
    if (!meta || !result.Values || result.Values.length === 0) continue;

    const key = `${meta.service}|${meta.endpoint}`;
    if (!endpointTotals.has(key)) {
      endpointTotals.set(key, {
        service: meta.service,
        endpoint: meta.endpoint,
        requestCount: 0,
      });
    }
    const sum = result.Values.reduce((acc, v) => acc + v, 0);
    endpointTotals.get(key).requestCount += sum;
  }

  const serviceMap = new Map();
  for (const service of serviceEndpoints.keys()) {
    serviceMap.set(service, []);
  }
  for (const data of endpointTotals.values()) {
    if (serviceMap.has(data.service)) {
      serviceMap.get(data.service).push({
        endpoint: data.endpoint,
        requestCount: Math.round(data.requestCount),
      });
    }
  }

  const rows = [];
  for (const [service, apis] of serviceMap) {
    apis.sort((a, b) => b.requestCount - a.requestCount);
    rows.push({ service, topApis: apis.slice(0, topN) });
  }
  rows.sort((a, b) => a.service.localeCompare(b.service));
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  let config;
  try {
    config = loadApiAlarmsConfig(opts.config);
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  const cloudwatch = await import("./cloudwatch.mjs");
  cloudwatch.initCloudWatch(config.aws);
  const discovery = await import("./discovery.mjs");

  const { namespace, environment } = config.metrics;
  const services = config.services;
  const fiveXxConfig = config.alarms.fiveXxPercent;
  const trafficConfig = config.alarms.totalTrafficAnomaly;
  const alarmActionArn = config.notifications.alarmActionArn ?? null;
  const baseTags = config.tags || [];

  console.log("API Status Code CloudWatch Alarms");
  console.log("Config:", opts.config);
  console.log("Namespace:", namespace);
  console.log("Environment:", environment);
  console.log("Region:", config.aws.region);
  console.log("Services:", services.join(", "));
  console.log(
    "Enabled alarms:",
    [
      fiveXxConfig.enabled !== false ? "5xx" : null,
      trafficConfig.enabled !== false ? "api-traffic" : null,
    ]
      .filter(Boolean)
      .join(", ") || "(none)",
  );
  console.log(
    "5xx alarm: static threshold (max from last",
    fiveXxConfig.lookbackDays,
    "days),",
    fiveXxConfig.datapointsToAlarm + "/" + fiveXxConfig.evaluationPeriods,
    "datapoints",
  );
  console.log(
    "Traffic alarm:",
    trafficConfig.datapointsToAlarm + "/" + trafficConfig.evaluationPeriods,
    "datapoints, anomaly threshold",
    trafficConfig.anomalyThreshold,
  );
  console.log("SNS topic:", alarmActionArn || "(none)");
  if (opts.dryRun) console.log("DRY-RUN: no alarms will be created");
  if (!opts.createAlarms && !opts.dryRun) {
    console.log(
      "\nUse --create-alarms to create alarms, or --dry-run to preview",
    );
    process.exit(0);
  }

  logger.info(
    `Discovering endpoints for ${services.length} services: ${services.join(", ")}`,
  );
  const serviceEndpoints = await discovery.discoverEndpointsForServices({
    namespace,
    services,
    metricName: METRIC_NAME,
  });

  let allAPIs = [];
  const sel = config.apiSelection || {};
  const mode = (sel.mode || "all").toLowerCase();
  const topN = sel.topN ?? 20;

  if (mode === "top-apis") {
    let start;
    let end;
    if (sel.startISO && sel.endISO) {
      const range = normalizeTimeRange(sel.startISO, sel.endISO);
      start = range.start;
      end = range.end;
    } else {
      const lookbackDays = sel.lookbackDays ?? 14;
      end = new Date();
      start = new Date(end);
      start.setDate(start.getDate() - lookbackDays);
      logger.info(
        `Top APIs: no startISO/endISO in config, using last ${lookbackDays} days for volume ranking`,
      );
    }
    const volumePeriod = Math.max(sel.periodSeconds || 3600, 3600);
    logger.info(
      `Top APIs: fetching top ${topN} by volume per service (period=${volumePeriod}s)...`,
    );
    const topApisRows = await fetchTopApisByVolumeFromStatusCodes({
      namespace,
      serviceEndpoints,
      start,
      end,
      period: volumePeriod,
      topN,
      environment,
      buildMetricQuery: cloudwatch.buildMetricQuery,
      getMetricDataBatched: cloudwatch.getMetricDataBatched,
    });
    for (const row of topApisRows) {
      for (const { endpoint } of row.topApis) {
        allAPIs.push({ serviceName: row.service, endpoint });
      }
    }
  } else {
    for (const [serviceName, endpoints] of serviceEndpoints) {
      for (const endpoint of [...endpoints].sort()) {
        allAPIs.push({ serviceName, endpoint });
      }
    }
  }

  allAPIs.sort(
    (a, b) =>
      a.serviceName.localeCompare(b.serviceName) ||
      a.endpoint.localeCompare(b.endpoint),
  );

  const serviceCount = new Set(allAPIs.map((a) => a.serviceName)).size;
  console.log(`\nFound ${allAPIs.length} APIs across ${serviceCount} services`);
  if (allAPIs.length === 0) {
    console.warn("No APIs found. Check config.services and namespace.");
    process.exit(0);
  }

  // Recompute 5xx thresholds from last N days on every run (create or update)
  const fiveXxThresholds =
    fiveXxConfig.enabled !== false
      ? await fetch5xxPercentMaxForApis({
          namespace,
          apis: allAPIs,
          environment,
          period: fiveXxConfig.periodSeconds,
          lookbackDays: fiveXxConfig.lookbackDays,
          minThresholdPercent: fiveXxConfig.minThresholdPercent,
          defaultThresholdPercent: fiveXxConfig.defaultThresholdPercent,
          minimumRequestCount: fiveXxConfig.minimumRequestCount,
          thresholdPercentile: fiveXxConfig.thresholdPercentile,
          getMetricDataBatched: cloudwatch.getMetricDataBatched,
        })
      : new Map();

  const alarmOpts = {
    namespace,
    environment,
    createAlarms: opts.createAlarms,
    dryRun: opts.dryRun,
    alarmActionArn,
    baseTags,
    fiveXxConfig,
    trafficConfig,
    putAlarmWithTagSync: cloudwatch.putAlarmWithTagSync,
  };

  let created = 0;
  let failed = 0;

  for (const api of allAPIs) {
    const fiveXxThreshold = fiveXxThresholds.get(
      `${api.serviceName}|${api.endpoint}`,
    );
    try {
      const alarmsForApi = await createAlarmsForApi(api, {
        ...alarmOpts,
        fiveXxThreshold,
      });
      if (opts.createAlarms && !opts.dryRun) created += alarmsForApi;
      if (opts.dryRun) created += alarmsForApi;
    } catch (err) {
      failed++;
      logger.error(
        `Failed for ${api.serviceName} ${api.endpoint}: ${err.message}`,
      );
    }
    if (opts.createAlarms && !opts.dryRun) {
      await new Promise((r) => setTimeout(r, 200)); // Avoid throttling
    }
  }

  if (opts.dryRun) {
    console.log(
      `\nDone. Dry run complete. No alarms created. ${created} alarms would be created with --create-alarms.${failed ? ` Failed: ${failed}` : ""}`,
    );
  } else {
    console.log(
      `\nDone. Created: ${created} alarms.${failed ? ` Failed: ${failed}` : ""}`,
    );
  }
}

main().catch((err) => {
  logger.error("Fatal error:", err.message);
  process.exit(1);
});
