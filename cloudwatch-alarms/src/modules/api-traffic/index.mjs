/**
 * API traffic alarms module: anomaly alarm for total traffic outside band. Config-driven.
 */
import { createHash } from "crypto";
import { putAlarmWithTagSync } from "../../core/cloudwatch.mjs";
import { discoverEndpointsForServices, fetchTopApisByVolumeFromStatusCodes } from "../api-common.mjs";
import { runWithConcurrency } from "../../runtime/parallel.mjs";

const CONCURRENCY = 8;

function safeAlarmName(prefix, serviceName, endpoint, severityPrefix = "Warning") {
  const hash = createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
  return `${severityPrefix}-${prefix}-${serviceName}-${endpoint}-${hash}`.slice(0, 255);
}

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
  const codes = statusCodes || [];
  const sumExpr = codes.map((_, i) => `m${i + 1}`).join("+");
  metrics.push({ Id: "e1", Expression: sumExpr, Label: "Total API Count", ReturnData: true });
  const threshold = anomalyThreshold ?? 2;
  metrics.push({
    Id: "ad1",
    Expression: `ANOMALY_DETECTION_BAND(e1, ${threshold})`,
    ReturnData: true,
  });
  return metrics;
}

export async function runApiTrafficAlarms(config, { dryRun = false } = {}) {
  const alarmCfg = config.alarms?.["api-traffic"] || {};
  const res = config.resources?.["api-traffic"] || {};
  const services = res.services || [];
  const apiSelection = res.apiSelection || {};
  const mode = (apiSelection.mode || "all").toLowerCase();
  const topN = apiSelection.topN ?? 20;
  const lookbackDays = apiSelection.lookbackDays ?? 14;

  if (!services.length) {
    console.log("API traffic: no services in config, skipping.");
    return 0;
  }

  const namespace = alarmCfg.namespace || "DFG-Observability";
  const environment = alarmCfg.environment || "production";
  const period = alarmCfg.periodSeconds ?? 300;
  const metricName = alarmCfg.metricName || "API_COUNT";
  const statusCodes = alarmCfg.statusCodes || ["200", "201", "400", "401", "403", "404", "409", "412", "500"];
  const anomalyThreshold = alarmCfg.anomalyThreshold ?? 2;
  const baseTags = config.tags || [];
  const alarmActionArn = alarmCfg.alarmActionArn || config.alarms?.ecs?.alarmActionArn || null;

  const serviceEndpoints = await discoverEndpointsForServices({ namespace, services });
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

  allAPIs.sort((a, b) => a.serviceName.localeCompare(b.serviceName) || a.endpoint.localeCompare(b.endpoint));
  if (allAPIs.length === 0) {
    console.log("API traffic: no APIs found.");
    return 0;
  }

  const namePrefix = alarmCfg.namePrefix ?? "Warning";
  const evaluationPeriods = alarmCfg.evaluationPeriods ?? 3;
  const datapointsToAlarm = alarmCfg.datapointsToAlarm ?? 3;

  let created = 0;
  const tasks = allAPIs.map((api) => async () => {
    const alarmTags = [...baseTags, { Key: "Service", Value: api.serviceName }, { Key: "AlarmType", Value: "total-traffic" }];
    const alarmName = safeAlarmName("API-TotalTraffic", api.serviceName, api.endpoint, namePrefix);
    const metrics = buildTotalTrafficAlarmMetrics(
      namespace,
      api.serviceName,
      api.endpoint,
      environment,
      period,
      metricName,
      statusCodes,
      anomalyThreshold,
    );
    const params = {
      TreatMissingData: "ignore",
      ActionsEnabled: true,
      EvaluationPeriods: evaluationPeriods,
      DatapointsToAlarm: datapointsToAlarm,
      AlarmName: alarmName,
      AlarmDescription: `API ${api.serviceName} ${api.endpoint} - ${metricName} anomaly outside band`,
      Metrics: metrics,
      ThresholdMetricId: "ad1",
      ComparisonOperator: "LessThanLowerOrGreaterThanUpperThreshold",
    };
    if (alarmActionArn) params.AlarmActions = [alarmActionArn];

    if (dryRun) {
      console.log(`[DRY-RUN] Would create traffic alarm: ${alarmName}`);
      return 1;
    }
    await putAlarmWithTagSync(params, alarmTags);
    console.log(`Created/updated traffic alarm: ${alarmName}`);
    return 1;
  });

  const results = await runWithConcurrency(tasks, CONCURRENCY);
  return results.reduce((a, b) => a + b, 0);
}
