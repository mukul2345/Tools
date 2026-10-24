#!/usr/bin/env node
/**
 * ECS CloudWatch Alarms Script
 *
 * Reads ECS service names from a hardcoded array and creates CloudWatch alarms
 * for CPU and Memory utilization (average and max with anomaly detection).
 * Alarms use configurable fixed thresholds; they do not depend on scaling policies.
 *
 * Prerequisites:
 *   - AWS credentials configured (env vars, ~/.aws/credentials, or IAM role)
 *   - npm install (run from this folder)
 *   - Optional: .env file for AWS_REGION, ECS_CLUSTER_NAME, ALARM_SNS_TOPIC_ARN, etc.
 */

require("dotenv").config();

const {
  ECSClient,
  DescribeServicesCommand,
  DescribeClustersCommand,
} = require("@aws-sdk/client-ecs");
const {
  CloudWatchClient,
  PutMetricAlarmCommand,
  TagResourceCommand,
} = require("@aws-sdk/client-cloudwatch");

// ---------------------------------------------------------------------------
// Configuration – hardcoded ECS cluster and service names
// ---------------------------------------------------------------------------

const AWS_REGION = process.env.AWS_REGION || "eu-west-1";

const ECS_CLUSTER_NAME =
  process.env.ECS_CLUSTER_NAME || "cluster-production-common";

const ECS_SERVICE_NAMES = [
  // "alert-service-production-common",
  // "client-contract-service-production-common",
  "applicant-service-production-common",
  "partner-service-production-common",
  "jaya-vijaya-production-common",
  "kuber-production-common",
  "order-service-production-common",
  "campaign-service-production-common",
  "catalog-service-production-common",
  "applicant-portal-production-common",
  "client-portal-production-common",
  "partner-portal-production-common",
];

// Alarm thresholds for average CPU and Memory utilization (percent)
const DEFAULT_CPU_THRESHOLD_PERCENT = 70;
const DEFAULT_MEMORY_THRESHOLD_PERCENT = 70;

// Alarm evaluation: 3 periods, alarm when 3 out of 3 datapoints breach
const ALARM_EVALUATION_PERIODS = 3;
const ALARM_PERIOD_SECONDS = 300;
const ALARM_DATAPOINTS_TO_ALARM = 3;

// Anomaly detection: number of standard deviations for the band (threshold 2 = 2 sigma)
const ANOMALY_DETECTION_THRESHOLD = 2;

// SNS topic ARN for alarm actions (optional; set to null to skip notifications)
const ALARM_ACTION_ARN = process.env.ALARM_SNS_TOPIC_ARN || null;

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
      include: [
        "ATTACHMENTS",
        "CONFIGURATIONS",
        "SETTINGS",
        "STATISTICS",
        "TAGS",
      ],
    }),
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
    }),
  );
  const svc = services && services[0];
  if (!svc || svc.status !== "ACTIVE") return null;
  const tags = (svc.tags || [])
    .filter((t) => t.key == "Service Name")
    .map((t) => ({ Key: t.key, Value: t.value }));
  tags.push({ Key: "Team", Value: "Consumer App and Services" });
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
// Create or update a single CloudWatch alarm and tag it
// ---------------------------------------------------------------------------

async function putAlarm(params, tags, serviceArn) {
  const alarmName = params.AlarmName;
  try {
    await cloudWatchClient.send(new PutMetricAlarmCommand(params));
    console.log(`Created/updated alarm: ${alarmName}`);
    if (tags && tags.length > 0) {
      const alarmArn = getAlarmArn(alarmName, serviceArn);
      await cloudWatchClient.send(
        new TagResourceCommand({
          ResourceARN: alarmArn,
          Tags: tags,
        }),
      );
      console.log(`Tagged alarm: ${alarmName}`);
    }
  } catch (err) {
    console.error(`Failed to create alarm ${alarmName}:`, err.message);
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

async function createAlarmsForService(
  clusterName,
  serviceName,
  serviceArn,
  tags,
) {
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

  await putAlarm(
    {
      ...common,
      AlarmDescription: `ECS ${serviceName} - CPU Max utilization alarm`,
      AlarmName: `Critical-${serviceName}-MaxCPUUtilization`,
      MetricName: "CPUUtilization",
      Namespace: "AWS/ECS",
      Statistic: "Maximum",
      Threshold: DEFAULT_CPU_THRESHOLD_PERCENT,
    },
    tags,
    serviceArn,
  );

  await putAlarm(
    {
      ...common,
      AlarmDescription: `ECS ${serviceName} - Memory Max utilization alarm`,
      AlarmName: `Critical-${serviceName}-MaxMemoryUtilization`,
      MetricName: "MemoryUtilization",
      Namespace: "AWS/ECS",
      Statistic: "Maximum",
      Threshold: DEFAULT_MEMORY_THRESHOLD_PERCENT,
    },
    tags,
    serviceArn,
  );

  // Anomaly detection alarms: Max utilization above band (threshold 2 std dev), GreaterThanThreshold
  const anomalyCommon = {
    dimensions,
    periodSeconds: ALARM_PERIOD_SECONDS,
    evaluationPeriods: ALARM_EVALUATION_PERIODS,
    datapointsToAlarm: ALARM_DATAPOINTS_TO_ALARM,
    alarmActions: actions.length ? actions : undefined,
  };

  const cpuMaxAnomalyParams = buildAnomalyAlarmParams({
    ...anomalyCommon,
    alarmName: `Critical-${serviceName}-MaxCPUUtilization`,
    alarmDescription: `ECS ${serviceName} - CPU Max utilization anomaly (above ${ANOMALY_DETECTION_THRESHOLD} std dev band)`,
    namespace: "AWS/ECS",
    metricName: "CPUUtilization",
  });

  await putAlarm(cpuMaxAnomalyParams, tags, serviceArn);

  const memoryMaxAnomalyParams = buildAnomalyAlarmParams({
    ...anomalyCommon,
    alarmName: `Critical-${serviceName}-MaxMemoryUtilization`,
    alarmDescription: `ECS ${serviceName} - Memory Max utilization anomaly (above ${ANOMALY_DETECTION_THRESHOLD} std dev band)`,
    namespace: "AWS/ECS",
    metricName: "MemoryUtilization",
  });

  await putAlarm(memoryMaxAnomalyParams, tags, serviceArn);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
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
    await createAlarmsForService(
      ECS_CLUSTER_NAME,
      serviceName,
      serviceArn,
      tags,
    );
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
