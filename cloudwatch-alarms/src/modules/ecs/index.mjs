/**
 * ECS alarms module: CPU and Memory (anomaly + static + composite). Config-driven.
 */
import {
  ECSClient,
  DescribeClustersCommand,
  DescribeServicesCommand,
} from "@aws-sdk/client-ecs";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  putMetricAlarm,
  putCompositeAlarm,
  getAlarmArn,
  tagAlarm,
} from "../../core/cloudwatch.mjs";
import { runWithConcurrency } from "../../runtime/parallel.mjs";

const CONCURRENCY = 5;

function getAccountIdFromArn(arn) {
  const parts = (arn || "").split(":");
  return parts.length >= 5 ? parts[4] : "";
}

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
    anomalyThreshold,
  } = options;
  const metrics = [
    {
      Id: "m1",
      MetricStat: {
        Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions },
        Period: periodSeconds,
        Stat: "Maximum",
      },
      ReturnData: true,
    },
    {
      Id: "ad1",
      Expression: `ANOMALY_DETECTION_BAND(m1, ${anomalyThreshold})`,
      ReturnData: true,
    },
  ];
  return {
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
}

function ecsDimensions(clusterName, serviceName) {
  return [
    { Name: "ClusterName", Value: clusterName },
    { Name: "ServiceName", Value: serviceName },
  ];
}

export async function runEcsAlarms(config, { dryRun = false } = {}) {
  const res = config.resources?.ecs || {};
  const clusterName = res.clusterName;
  const serviceNames = res.serviceNames || [];
  if (!clusterName || !serviceNames.length) {
    console.log("ECS: no clusterName or serviceNames in config, skipping.");
    return 0;
  }

  const alarmCfg = config.alarms?.ecs || {};
  const alarmActionArn = alarmCfg.alarmActionArn || null;
  const evaluationPeriods = alarmCfg.evaluationPeriods ?? 3;
  const datapointsToAlarm = alarmCfg.datapointsToAlarm ?? 3;
  const periodSeconds = alarmCfg.periodSeconds ?? 300;
  const anomalyThreshold = alarmCfg.anomalyThreshold ?? 2;
  const cpuStaticPercent = alarmCfg.cpuStaticThresholdPercent ?? 70;
  const memoryStaticPercent = alarmCfg.memoryStaticThresholdPercent ?? 60;
  const severityPrefix = alarmCfg.severityPrefix ?? "Critical";

  const region = config.aws?.region || process.env.AWS_REGION || "eu-west-1";
  const profile = config.aws?.profile || process.env.AWS_PROFILE;
  const ecsClient = new ECSClient({
    region,
    credentials: fromIni({ profile }),
  });

  const { clusters } = await ecsClient.send(
    new DescribeClustersCommand({
      clusters: [clusterName],
      include: ["TAGS"],
    }),
  );
  const cluster = clusters?.[0];
  if (!cluster || cluster.status !== "ACTIVE") {
    throw new Error(`Cluster not found or not active: ${clusterName}`);
  }
  const clusterArn = cluster.clusterArn;

  const teamTag = config.tags?.find((t) => t.Key === "Team");
  const teamName = teamTag?.Value || "Unknown";

  let count = 0;
  const tasks = serviceNames.map((serviceName) => async () => {
    const { services } = await ecsClient.send(
      new DescribeServicesCommand({
        cluster: clusterArn,
        services: [serviceName],
        include: ["TAGS"],
      }),
    );
    const svc = services?.[0];
    if (!svc || svc.status !== "ACTIVE") {
      console.warn(`ECS: service not found or not active: ${serviceName}`);
      return 0;
    }
    const tags = (svc.tags || [])
      .filter((t) => t.key === "Service Name")
      .map((t) => ({ Key: t.key, Value: t.value }));
    tags.push({ Key: "Team", Value: teamName });
    const serviceArn = svc.serviceArn;
    const accountId = getAccountIdFromArn(serviceArn);
    const dimensions = ecsDimensions(clusterName, serviceName);
    const actions = alarmActionArn ? [alarmActionArn] : [];

    const common = {
      ActionsEnabled: true,
      EvaluationPeriods: evaluationPeriods,
      DatapointsToAlarm: datapointsToAlarm,
      Period: periodSeconds,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "breaching",
      Dimensions: dimensions,
    };
    const commonWithActions = { ...common, AlarmActions: actions };
    const childCommon = { ...common };

    if (dryRun) {
      console.log(`[DRY-RUN] Would create ECS alarms for: ${serviceName}`);
      return 6; // 2 anomaly + 2 static + 2 composite
    }

    const cpuAnomalyName = `ECS-${serviceName}-MaxCPUUtilization-Anomaly`;
    const cpuAnomalyParams = buildAnomalyAlarmParams({
      alarmName: cpuAnomalyName,
      alarmDescription: `ECS ${serviceName} - CPU Max utilization anomaly (above ${anomalyThreshold} std dev)`,
      namespace: "AWS/ECS",
      metricName: "CPUUtilization",
      dimensions,
      periodSeconds,
      evaluationPeriods,
      datapointsToAlarm,
      anomalyThreshold,
    });
    await putMetricAlarm(cpuAnomalyParams);
    const cpuAnomalyArn = await getAlarmArn(cpuAnomalyName);
    if (cpuAnomalyArn && tags.length) await tagAlarm(cpuAnomalyArn, tags);

    const cpuStaticName = `ECS-${serviceName}-MaxCPUUtilization-StaticThreshold`;
    await putMetricAlarm({
      ...childCommon,
      AlarmName: cpuStaticName,
      AlarmDescription: `ECS ${serviceName} - CPU Max static threshold`,
      MetricName: "CPUUtilization",
      Namespace: "AWS/ECS",
      Statistic: "Maximum",
      Threshold: cpuStaticPercent,
    });
    const cpuStaticArn = await getAlarmArn(cpuStaticName);
    if (cpuStaticArn && tags.length) await tagAlarm(cpuStaticArn, tags);

    const cpuCompositeName = `${severityPrefix}-${serviceName}-MaxCPUUtilization-Composite`;
    await putCompositeAlarm({
      AlarmName: cpuCompositeName,
      AlarmRule: `ALARM("${cpuAnomalyName}") AND ALARM("${cpuStaticName}")`,
      AlarmDescription: `ECS ${serviceName} - CPU Max: anomaly AND static > ${cpuStaticPercent}%`,
      ActionsEnabled: true,
      ...(actions.length && { AlarmActions: actions }),
    });
    const cpuCompositeArn = `arn:aws:cloudwatch:${region}:${accountId}:alarm:${cpuCompositeName}`;
    if (tags.length) await tagAlarm(cpuCompositeArn, tags);

    const memAnomalyName = `ECS-${serviceName}-MaxMemoryUtilization-Anomaly`;
    const memAnomalyParams = buildAnomalyAlarmParams({
      alarmName: memAnomalyName,
      alarmDescription: `ECS ${serviceName} - Memory Max utilization anomaly`,
      namespace: "AWS/ECS",
      metricName: "MemoryUtilization",
      dimensions,
      periodSeconds,
      evaluationPeriods,
      datapointsToAlarm,
      anomalyThreshold,
    });
    await putMetricAlarm(memAnomalyParams);
    const memAnomalyArn = await getAlarmArn(memAnomalyName);
    if (memAnomalyArn && tags.length) await tagAlarm(memAnomalyArn, tags);

    const memStaticName = `ECS-${serviceName}-MaxMemoryUtilization-StaticThreshold`;
    await putMetricAlarm({
      ...childCommon,
      AlarmName: memStaticName,
      AlarmDescription: `ECS ${serviceName} - Memory Max static threshold`,
      MetricName: "MemoryUtilization",
      Namespace: "AWS/ECS",
      Statistic: "Maximum",
      Threshold: memoryStaticPercent,
    });
    const memStaticArn = await getAlarmArn(memStaticName);
    if (memStaticArn && tags.length) await tagAlarm(memStaticArn, tags);

    const memCompositeName = `${severityPrefix}-${serviceName}-MaxMemoryUtilization-Composite`;
    await putCompositeAlarm({
      AlarmName: memCompositeName,
      AlarmRule: `ALARM("${memAnomalyName}") AND ALARM("${memStaticName}")`,
      AlarmDescription: `ECS ${serviceName} - Memory Max: anomaly AND static > ${memoryStaticPercent}%`,
      ActionsEnabled: true,
      ...(actions.length && { AlarmActions: actions }),
    });
    const memCompositeArn = `arn:aws:cloudwatch:${region}:${accountId}:alarm:${memCompositeName}`;
    if (tags.length) await tagAlarm(memCompositeArn, tags);

    console.log(`Created/updated ECS alarms for: ${serviceName}`);
    return 6;
  });

  const results = await runWithConcurrency(tasks, CONCURRENCY);
  return results.reduce((a, b) => a + b, 0);
}
