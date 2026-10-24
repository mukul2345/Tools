/**
 * API 5xx alarms module: static-threshold 5xx % alarms. Config-driven.
 */
import { createHash } from "crypto";
import {
  getMetricDataBatched,
  putAlarmWithTagSync,
} from "../../core/cloudwatch.mjs";
import {
  discoverEndpointsForServices,
  fetchTopApisByVolumeFromStatusCodes,
} from "../api-common.mjs";
import { runWithConcurrency } from "../../runtime/parallel.mjs";

const METRIC_NAME = "API_STATUS_CODE";
const CONCURRENCY = 3;

function safeAlarmName(
  prefix,
  serviceName,
  endpoint,
  severityPrefix = "Critical",
) {
  const hash = createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
  return `${severityPrefix}-${prefix}-${serviceName}-${endpoint}-${hash}`.slice(
    0,
    255,
  );
}

function calculatePercentile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(rank, sorted.length - 1));
  return sorted[index];
}

function buildTimestampValueMap(result) {
  const map = new Map();
  if (!result?.Timestamps || !result?.Values) return map;
  result.Timestamps.forEach((ts, i) => {
    const v = result.Values[i];
    if (typeof v === "number" && !Number.isNaN(v))
      map.set(new Date(ts).toISOString(), v);
  });
  return map;
}

function build5xxPercentAlarmMetrics(
  namespace,
  serviceName,
  endpoint,
  environment,
  period,
  minimumRequestCount,
) {
  const dims = [
    { Name: "endpoint", Value: endpoint },
    { Name: "environment", Value: environment },
    { Name: "serviceName", Value: serviceName },
  ];
  const floor = 20; //Math.max(1, Math.round(minimumRequestCount || 1));
  const metrics = [
    {
      Id: "m1",
      ReturnData: false,
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: METRIC_NAME,
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
          MetricName: METRIC_NAME,
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
          MetricName: METRIC_NAME,
          Dimensions: [...dims, { Name: "statusCode", Value: "4xx" }],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    {
      Id: "e1",
      Expression: `IF((m1+m2+m3)>=${floor}, IF((m1+m2+m3)>0, (m1/(m1+m2+m3))*100, 0), 0)`,
      Label: "5xx %",
      ReturnData: true,
    },
  ];
  return metrics;
}

/**
 * Fetches historical 5xx/2xx/4xx data and returns:
 * - thresholds: per-API percentile-based 5xx % threshold
 * - minimumRequestCountByApi: per-API average total traffic (m1+m2+m3) per period over lookback
 */
async function fetch5xxThresholdsAndBaselines({
  namespace,
  apis,
  environment,
  period,
  lookbackDays,
  minThresholdPercent,
  defaultThresholdPercent,
  thresholdPercentile,
  fallbackMinimumRequestCount,
}) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - lookbackDays);
  const thresholds = new Map();
  const minimumRequestCountByApi = new Map();
  const APIS_PER_BATCH = 125;

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
      ["5xx", "2xx", "4xx"].forEach((sc, j) => {
        batchQueries.push({
          Id: `${prefix}m${j + 1}`,
          ReturnData: true,
          MetricStat: {
            Metric: {
              Namespace: namespace,
              MetricName: METRIC_NAME,
              Dimensions: [...dims, { Name: "statusCode", Value: sc }],
            },
            Period: period,
            Stat: "Sum",
          },
        });
      });
    });

    const batchResults = await getMetricDataBatched({
      queries: batchQueries,
      start,
      end,
      period,
    });
    const byId = new Map(batchResults.map((r) => [r.Id, r]));

    batchApis.forEach((api, i) => {
      const idx = batchStart + i;
      const prefix = `e5xx${idx}_`;
      const m1 = buildTimestampValueMap(byId.get(`${prefix}m1`));
      const m2 = buildTimestampValueMap(byId.get(`${prefix}m2`));
      const m3 = buildTimestampValueMap(byId.get(`${prefix}m3`));
      const timestamps = new Set([...m1.keys(), ...m2.keys(), ...m3.keys()]);
      const periodTotals = [];
      const periodRates = [];
      for (const ts of timestamps) {
        const fiveXx = m1.get(ts) ?? 0;
        const total = fiveXx + (m2.get(ts) ?? 0) + (m3.get(ts) ?? 0);
        periodTotals.push(total);
        periodRates.push(total > 0 ? (fiveXx / total) * 100 : 0);
      }
      const avgTraffic =
        periodTotals.length > 0
          ? periodTotals.reduce((a, b) => a + b, 0) / periodTotals.length
          : fallbackMinimumRequestCount;
      const key = `${api.serviceName}|${api.endpoint}`;
      minimumRequestCountByApi.set(key, Math.max(1, Math.round(avgTraffic)));
      const floor = Math.max(1, avgTraffic);
      const eligibleRatesAboveFloor = periodTotals
        .map((total, j) => (total >= floor ? periodRates[j] : null))
        .filter((r) => r !== null);
      if (eligibleRatesAboveFloor.length > 0) {
        const pVal = calculatePercentile(
          eligibleRatesAboveFloor,
          thresholdPercentile,
        );
        const threshold = Math.max(pVal, minThresholdPercent);
        thresholds.set(key, Math.ceil(Math.round(threshold * 100) / 100));
      }
    });
  }

  for (const api of apis) {
    const key = `${api.serviceName}|${api.endpoint}`;
    if (!thresholds.has(key)) {
      thresholds.set(
        key,
        Math.max(defaultThresholdPercent, minThresholdPercent),
      );
    }
    if (!minimumRequestCountByApi.has(key)) {
      minimumRequestCountByApi.set(
        key,
        Math.max(1, fallbackMinimumRequestCount),
      );
    }
  }
  return { thresholds, minimumRequestCountByApi };
}

export async function runApi5xxAlarms(config, { dryRun = false } = {}) {
  const alarmCfg = config.alarms?.["api-5xx"] || {};
  const res = config.resources?.["api-5xx"] || {};
  const services = res.services || [];
  const apiSelection = res.apiSelection || {};
  const mode = (apiSelection.mode || "all").toLowerCase();
  const topN = apiSelection.topN ?? 20;
  const lookbackDays = apiSelection.lookbackDays ?? 14;

  if (!services.length) {
    console.log("API 5xx: no services in config, skipping.");
    return 0;
  }

  const namespace = alarmCfg.namespace || "DFG-Observability";
  const environment = alarmCfg.environment || "production";
  const period = alarmCfg.periodSeconds ?? 300;
  const baseTags = config.tags || [];
  const alarmActionArn =
    alarmCfg.alarmActionArn || config.alarms?.ecs?.alarmActionArn || null;

  const serviceEndpoints = await discoverEndpointsForServices({
    namespace,
    services,
  });
  let allAPIs = [];

  if (mode === "top-apis") {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - lookbackDays);
    const periodVol = Math.max(apiSelection.periodSeconds || 3600, 3600);
    const rows = await fetchTopApisByVolumeFromStatusCodes({
      namespace,
      serviceEndpoints,
      start,
      end,
      period: periodVol,
      topN,
      environment,
    });
    for (const row of rows) {
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
  if (allAPIs.length === 0) {
    console.log("API 5xx: no APIs found.");
    return 0;
  }

  const { thresholds: fiveXxThresholds, minimumRequestCountByApi } =
    await fetch5xxThresholdsAndBaselines({
      namespace,
      apis: allAPIs,
      environment,
      period,
      lookbackDays: alarmCfg.lookbackDays ?? 14,
      minThresholdPercent: alarmCfg.minThresholdPercent ?? 1,
      defaultThresholdPercent: alarmCfg.defaultThresholdPercent ?? 5,
      thresholdPercentile: alarmCfg.thresholdPercentile ?? 90,
      fallbackMinimumRequestCount: alarmCfg.minimumRequestCount ?? 20,
    });

  const namePrefix = alarmCfg.namePrefix ?? "Critical";
  const evaluationPeriods = alarmCfg.evaluationPeriods ?? 3;
  const datapointsToAlarm = alarmCfg.datapointsToAlarm ?? 3;

  let created = 0;
  const tasks = allAPIs.map((api) => async () => {
    const key = `${api.serviceName}|${api.endpoint}`;
    const threshold = Math.max(
      fiveXxThresholds.get(key) ?? alarmCfg.defaultThresholdPercent ?? 5,
      alarmCfg.minThresholdPercent ?? 1,
    );
    const minRequestCount = minimumRequestCountByApi.get(key) ?? 1;
    const alarmTags = [
      ...baseTags,
      { Key: "Service", Value: api.serviceName },
      { Key: "AlarmType", Value: "5xx-percent" },
    ];
    const alarmName = safeAlarmName(
      "API-5xx",
      api.serviceName,
      api.endpoint,
      namePrefix,
    );

    const params = {
      TreatMissingData: "ignore",
      ActionsEnabled: true,
      EvaluationPeriods: evaluationPeriods,
      DatapointsToAlarm: datapointsToAlarm,
      AlarmName: alarmName,
      AlarmDescription: `API ${api.serviceName} ${api.endpoint} - 5xx % threshold ${threshold}%`,
      Metrics: build5xxPercentAlarmMetrics(
        namespace,
        api.serviceName,
        api.endpoint,
        environment,
        period,
        minRequestCount,
      ),
      Threshold: threshold,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    };
    if (alarmActionArn) params.AlarmActions = [alarmActionArn];

    if (dryRun) {
      console.log(`[DRY-RUN] Would create 5xx alarm: ${alarmName}`);
      return 1;
    }
    await putAlarmWithTagSync(params, alarmTags);
    console.log(
      `Created/updated 5xx alarm: ${alarmName} with Threshold: ${threshold}`,
    );
    return 1;
  });

  const results = await runWithConcurrency(tasks, CONCURRENCY);
  return results.reduce((a, b) => a + b, 0);
}
