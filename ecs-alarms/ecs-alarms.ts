#!/usr/bin/env node
/**
 * ECS CloudWatch Alarms Script
 *
 * Reads ECS service names from a hardcoded array and creates/updates CloudWatch alarms
 * for CPU and Memory utilization (anomaly + static threshold, composite).
 * Alarms use configurable fixed thresholds; they do not depend on scaling policies.
 *
 * If an alarm with the same name already exists, it is updated (PutMetricAlarm and
 * PutCompositeAlarm are upsert APIs).
 *
 * Prerequisites:
 *   - Required env vars (set in .env or export): AWS_REGION, ECS_CLUSTER_NAME,
 *     TEAM_NAME, ALARM_SNS_TOPIC_ARN
 *   - AWS credentials configured (env vars, ~/.aws/credentials, or IAM role)
 *   - npm install (run from this folder)
 */

require("dotenv").config();

// ---------------------------------------------------------------------------
// Startup: validate required environment variables
// ---------------------------------------------------------------------------

const REQUIRED_ENV_VARS = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "ECS_CLUSTER_NAME",
  "TEAM_NAME",
  "ALARM_SNS_TOPIC_ARN",
];

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === null || String(value).trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them in .env or export before running.`
    );
  }
}

// ---------------------------------------------------------------------------
// AWS SDK clients
// ---------------------------------------------------------------------------

const {
  ECSClient,
  DescribeServicesCommand,
  DescribeClustersCommand,
} = require("@aws-sdk/client-ecs");
const {
  CloudWatchClient,
  PutMetricAlarmCommand,
  PutCompositeAlarmCommand,
  TagResourceCommand,
} = require("@aws-sdk/client-cloudwatch");

// ---------------------------------------------------------------------------
// Configuration – hardcoded ECS cluster and service names
// ---------------------------------------------------------------------------

const AWS_REGION = process.env.AWS_REGION;
const ECS_CLUSTER_NAME = process.env.ECS_CLUSTER_NAME;
const TEAM_NAME = process.env.TEAM_NAME;

const ECS_SERVICE_NAMES = [
  "alert-service-production-common",
  "client-contract-service-production-common",
  "consumer-verification-request-production-common",
  "core-verification-data-structure-service-production-common",
  "document-generation-service-production-common",
  "document-management-service-production-common",
  "document-service-production-common",
  "migration-service-production-common",
  "narada-production-common",
  "payment-service-production-common",
  "poi-consumer-verification-workflow-engine-production-common",
  "poi-service-production-common",
  "rescue-consumer-verification-workflow-engine-production-common",
  "verification-initiation-service-production-common",
  "verification-request-production-common",
  "verification-workflow-engine-production-common",
];

// Alarm evaluation: 3 periods, alarm when 3 out of 3 datapoints breach
const ALARM_EVALUATION_PERIODS = 3;
const ALARM_PERIOD_SECONDS = 300;
const ALARM_DATAPOINTS_TO_ALARM = 3;

// Anomaly detection: number of standard deviations for the band (threshold 2 = 2 sigma)
const ANOMALY_DETECTION_THRESHOLD = 2;

// Static threshold for MaxMemoryUtilization composite (child alarm: Memory Max > this %)
const MEMORY_MAX_STATIC_THRESHOLD_PERCENT = 60;

// Static threshold for MaxCPUUtilization composite (child alarm: CPU Max > this %)
const CPU_MAX_STATIC_THRESHOLD_PERCENT = 70;

// SNS topic ARN for alarm actions
const ALARM_ACTION_ARN = process.env.ALARM_SNS_TOPIC_ARN;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const ecsClient = new ECSClient({ region: AWS_REGION });
const cloudWatchClient = new CloudWatchClient({ region: AWS_REGION });

// ---------------------------------------------------------------------------
// Resolve cluster ARN from name
// ---------------------------------------------------------------------------

async function getClusterArn(clusterName) {
  const { clusters } = await ecsClient.send(
    new DescribeClustersCommand({
      clusters: [clusterName],
      include: ["ATTACHMENTS", "CONFIGURATIONS", "SETTINGS", "STATISTICS", "TAGS"],
    })
  );
  const cluster = clusters && clusters[0];
  if (!cluster || cluster.status !== "ACTIVE") {
    throw new Error(`Cluster not found or not active: ${clusterName}`);
  }
  return cluster.clusterArn;
}

// ---------------------------------------------------------------------------
// Get ECS service ARN and tags by name (within cluster)
// ---------------------------------------------------------------------------

async function getServiceWithTags(clusterArn, serviceName) {
  const { services } = await ecsClient.send(
    new DescribeServicesCommand({
      cluster: clusterArn,
      services: [serviceName],
      include: ["TAGS"],
    })
  );
  const svc = services && services[0];
  if (!svc || svc.status !== "ACTIVE") return null;
  const tags = (svc.tags || []).filter((t) => t.key == "Service Name").map((t) => ({ Key: t.key, Value: t.value }));
  tags.push({ Key: "Team", Value: TEAM_NAME });
  return { serviceArn: svc.serviceArn, tags };
}

// ---------------------------------------------------------------------------
// Build dimension list for ECS metric (cluster + service name)
// ---------------------------------------------------------------------------

function ecsDimensions(clusterName, serviceName) {
  return [
    { Name: "ClusterName", Value: clusterName },
    { Name: "ServiceName", Value: serviceName },
  ];
}

// ---------------------------------------------------------------------------
// Get CloudWatch alarm ARN (account ID parsed from ECS service ARN)
// ---------------------------------------------------------------------------

function getAlarmArn(alarmName, serviceArn) {
  const parts = serviceArn.split(":");
  const accountId = parts.length >= 5 ? parts[4] : "";
  return `arn:aws:cloudwatch:${AWS_REGION}:${accountId}:alarm:${alarmName}`;
}

// ---------------------------------------------------------------------------
// Create or update a single CloudWatch metric alarm (upsert: same name = update)
// ---------------------------------------------------------------------------

async function putAlarm(params, tags, serviceArn) {
  const alarmName = params.AlarmName;
  try {
    // PutMetricAlarm is upsert: if alarm with this name exists, it is updated
    await cloudWatchClient.send(new PutMetricAlarmCommand(params));
    console.log(`Created/updated alarm: ${alarmName}`);
    if (tags && tags.length > 0) {
      const alarmArn = getAlarmArn(alarmName, serviceArn);
      await cloudWatchClient.send(
        new TagResourceCommand({
          ResourceARN: alarmArn,
          Tags: tags,
        })
      );
      console.log(`Tagged alarm: ${alarmName}`);
    }
  } catch (err) {
    console.error(`Failed to create alarm ${alarmName}:`, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Create or update a composite alarm (upsert: same name = update)
// ---------------------------------------------------------------------------

async function putCompositeAlarm(params, tags, serviceArn) {
  const alarmName = params.AlarmName;
  try {
    // PutCompositeAlarm is upsert: if composite alarm with this name exists, it is updated
    await cloudWatchClient.send(new PutCompositeAlarmCommand(params));
    console.log(`Created/updated composite alarm: ${alarmName}`);
    if (tags && tags.length > 0) {
      const alarmArn = getAlarmArn(alarmName, serviceArn);
      await cloudWatchClient.send(
        new TagResourceCommand({
          ResourceARN: alarmArn,
          Tags: tags,
        })
      );
      console.log(`Tagged composite alarm: ${alarmName}`);
    }
  } catch (err) {
    console.error(`Failed to create composite alarm ${alarmName}:`, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Build params for anomaly detection alarm (metric > upper band, 2 std dev)
// ---------------------------------------------------------------------------

function buildAnomalyAlarmParams(options) {
  const {
    alarmName,
    alarmDescription,
    namespace,
    metricName,
    dimensions,
    periodSeconds,
    evaluationPeriods,
    datapointsToAlarm,
    alarmActions,
  } = options;

  const metrics = [
    {
      Id: "m1",
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: metricName,
          Dimensions: dimensions,
        },
        Period: periodSeconds,
        Stat: "Maximum",
      },
      ReturnData: true,
    },
    {
      Id: "ad1",
      Expression: `ANOMALY_DETECTION_BAND(m1, ${ANOMALY_DETECTION_THRESHOLD})`,
      ReturnData: true,
    },
  ];

  const params = {
    AlarmName: alarmName,
    AlarmDescription: alarmDescription,
    Metrics: metrics,
    ThresholdMetricId: "ad1",
    ComparisonOperator: "GreaterThanUpperThreshold",
    EvaluationPeriods: evaluationPeriods,
    DatapointsToAlarm: datapointsToAlarm,
    TreatMissingData: "breaching",
    ActionsEnabled: true,
  };

  if (alarmActions && alarmActions.length) {
    params.AlarmActions = alarmActions;
  }

  return params;
}

// ---------------------------------------------------------------------------
// Create CPU and Memory alarms for one ECS service
// ---------------------------------------------------------------------------

async function createAlarmsForService(clusterName, serviceName, serviceArn, tags) {
  const dimensions = ecsDimensions(clusterName, serviceName);
  const actions = [];
  if (ALARM_ACTION_ARN) actions.push(ALARM_ACTION_ARN);

  const common = {
    ActionsEnabled: true,
    EvaluationPeriods: ALARM_EVALUATION_PERIODS,
    DatapointsToAlarm: ALARM_DATAPOINTS_TO_ALARM,
    Period: ALARM_PERIOD_SECONDS,
    ComparisonOperator: "GreaterThanThreshold",
    TreatMissingData: "breaching",
    Dimensions: dimensions,
  };

  if (actions.length) {
    common.AlarmActions = actions;
  }

  const { AlarmActions: _commonActions, ...commonWithoutActions } = common;

  // Anomaly detection alarms: Max utilization above band (threshold 2 std dev); no actions (used as composite children)
  const anomalyCommon = {
    dimensions,
    periodSeconds: ALARM_PERIOD_SECONDS,
    evaluationPeriods: ALARM_EVALUATION_PERIODS,
    datapointsToAlarm: ALARM_DATAPOINTS_TO_ALARM,
    alarmActions: actions.length ? actions : undefined,
  };

  // Composite alarm for CPU: ALARM when both (anomaly AND static > 70%) are in ALARM; actions on composite only
  const cpuAnomalyAlarmName = `ECS-${serviceName}-MaxCPUUtilization-Anomaly`;

  const cpuMaxAnomalyParams = buildAnomalyAlarmParams({
    ...anomalyCommon,
    alarmName: cpuAnomalyAlarmName,
    alarmDescription: `ECS ${serviceName} - CPU Max utilization anomaly (above ${ANOMALY_DETECTION_THRESHOLD} std dev band)`,
    namespace: "AWS/ECS",
    metricName: "CPUUtilization",
    alarmActions: undefined,
  });

  await putAlarm(cpuMaxAnomalyParams, tags, serviceArn);

  // Static threshold child alarm for MaxCPUUtilization composite (> 70%, no actions on child)
  const cpuStaticAlarmName = `ECS-${serviceName}-MaxCPUUtilization-StaticThreshold`;
  await putAlarm(
    {
      ...commonWithoutActions,
      AlarmDescription: `ECS ${serviceName} - CPU Max utilization static threshold`,
      AlarmName: cpuStaticAlarmName,
      MetricName: "CPUUtilization",
      Namespace: "AWS/ECS",
      Statistic: "Maximum",
      Threshold: CPU_MAX_STATIC_THRESHOLD_PERCENT,
    },
    tags,
    serviceArn
  );

  const cpuCompositeAlarmName = `Critical-${serviceName}-MaxCPUUtilization-Composite`;
  const cpuCompositeRule = `ALARM("${cpuAnomalyAlarmName}") AND ALARM("${cpuStaticAlarmName}")`;

  await putCompositeAlarm(
    {
      AlarmName: cpuCompositeAlarmName,
      AlarmRule: cpuCompositeRule,
      AlarmDescription: `ECS ${serviceName} - CPU Max: anomaly AND static > ${CPU_MAX_STATIC_THRESHOLD_PERCENT}%`,
      ActionsEnabled: true,
      ...(actions.length && {
        AlarmActions: actions,
      }),
    },
    tags,
    serviceArn
  );

  // Composite alarm for Memory: ALARM when both (anomaly AND static > 60%) are in ALARM; actions on composite only
  const memoryAnomalyAlarmName = `ECS-${serviceName}-MaxMemoryUtilization-Anomaly`;

  const memoryMaxAnomalyParams = buildAnomalyAlarmParams({
    ...anomalyCommon,
    alarmName: memoryAnomalyAlarmName,
    alarmDescription: `ECS ${serviceName} - Memory Max utilization anomaly (above ${ANOMALY_DETECTION_THRESHOLD} std dev band)`,
    namespace: "AWS/ECS",
    metricName: "MemoryUtilization",
    alarmActions: undefined,
  });

  await putAlarm(memoryMaxAnomalyParams, tags, serviceArn);

  // Static threshold child alarm for MaxMemoryUtilization composite (> 60%, no actions on child)
  const memoryStaticAlarmName = `ECS-${serviceName}-MaxMemoryUtilization-StaticThreshold`;
  await putAlarm(
    {
      ...commonWithoutActions,
      AlarmDescription: `ECS ${serviceName} - Memory Max utilization static threshold`,
      AlarmName: memoryStaticAlarmName,
      MetricName: "MemoryUtilization",
      Namespace: "AWS/ECS",
      Statistic: "Maximum",
      Threshold: MEMORY_MAX_STATIC_THRESHOLD_PERCENT,
    },
    tags,
    serviceArn
  );

  const compositeAlarmName = `Critical-${serviceName}-MaxMemoryUtilization-Composite`;
  const compositeRule = `ALARM("${memoryAnomalyAlarmName}") AND ALARM("${memoryStaticAlarmName}")`;

  await putCompositeAlarm(
    {
      AlarmName: compositeAlarmName,
      AlarmRule: compositeRule,
      AlarmDescription: `ECS ${serviceName} - Memory Max: anomaly AND static > ${MEMORY_MAX_STATIC_THRESHOLD_PERCENT}%`,
      ActionsEnabled: true,
      ...(actions.length && {
        AlarmActions: actions,
      }),
    },
    tags,
    serviceArn
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  validateEnv();

  console.log("ECS CloudWatch Alarms - starting");
  console.log("Cluster:", ECS_CLUSTER_NAME);
  console.log("Services:", ECS_SERVICE_NAMES.join(", "));
  console.log("Region:", AWS_REGION);

  const clusterArn = await getClusterArn(ECS_CLUSTER_NAME);
  console.log("Cluster ARN:", clusterArn);

  for (const serviceName of ECS_SERVICE_NAMES) {
    const serviceInfo = await getServiceWithTags(clusterArn, serviceName);
    if (!serviceInfo) {
      console.warn(`Service not found, skipping: ${serviceName}`);
      continue;
    }
    const { serviceArn, tags } = serviceInfo;
    console.log(`Creating alarms for service: ${serviceName}`);
    await createAlarmsForService(ECS_CLUSTER_NAME, serviceName, serviceArn, tags);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
