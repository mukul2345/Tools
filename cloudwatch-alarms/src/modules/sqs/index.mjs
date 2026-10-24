/**
 * SQS alarms module with separate source and DLQ settings.
 * Source queues can independently enable age and visible alarms.
 * DLQs currently support visible alarms with their own thresholds and naming.
 * Per-queue overrides remain keyed by queue name.
 */
import { putAlarmWithTagSync } from "../../core/cloudwatch.mjs";
import { runWithConcurrency } from "../../runtime/parallel.mjs";

const CONCURRENCY = 2;
const MAX_ALARM_NAME_LENGTH = 255;
const SQS_NAMESPACE = "AWS/SQS";

function safeAlarmName(prefix, serviceName, queueName, suffix) {
  const name = `${prefix}-SQS-${serviceName}-${queueName}-${suffix}`;
  return name.length > MAX_ALARM_NAME_LENGTH
    ? name.slice(0, MAX_ALARM_NAME_LENGTH)
    : name;
}

function getQueueOpts(typeConfig, overrides, queueName, kind) {
  const d = typeConfig || {};
  const o = (overrides && overrides[queueName]) || {};
  return {
    enabled: o.enabled ?? d.enabled ?? true,
    namePrefix: o.namePrefix ?? d.namePrefix ?? (kind === "dlq" ? "Warning" : "Critical"),
    periodSeconds: o.periodSeconds ?? d.periodSeconds ?? (kind === "dlq" ? 60 : 300),
    evaluationPeriods: o.evaluationPeriods ?? d.evaluationPeriods ?? (kind === "dlq" ? 1 : 3),
    datapointsToAlarm: o.datapointsToAlarm ?? d.datapointsToAlarm ?? (kind === "dlq" ? 1 : 3),
    ageAlarmEnabled: kind === "source" ? (o.ageAlarmEnabled ?? d.ageAlarmEnabled ?? true) : false,
    visibleAlarmEnabled: o.visibleAlarmEnabled ?? d.visibleAlarmEnabled ?? true,
    ageThresholdSeconds: o.ageThresholdSeconds ?? d.ageThresholdSeconds ?? 900,
    visibleThresholdCount:
      o.visibleThresholdCount ?? d.visibleThresholdCount ?? (kind === "dlq" ? 1 : 500),
    treatMissingData: o.treatMissingData ?? d.treatMissingData ?? "notBreaching",
  };
}

function buildAlarmParams({
  alarmName,
  alarmDescription,
  metricName,
  queueName,
  periodSeconds,
  evaluationPeriods,
  datapointsToAlarm,
  threshold,
  comparisonOperator,
  statistic,
  treatMissingData,
  alarmActionArn,
}) {
  const params = {
    AlarmName: alarmName,
    AlarmDescription: alarmDescription,
    Namespace: SQS_NAMESPACE,
    MetricName: metricName,
    Dimensions: [{ Name: "QueueName", Value: queueName }],
    Period: periodSeconds,
    EvaluationPeriods: evaluationPeriods,
    DatapointsToAlarm: datapointsToAlarm,
    Threshold: threshold,
    ComparisonOperator: comparisonOperator,
    Statistic: statistic,
    TreatMissingData: treatMissingData ?? "notBreaching",
    ActionsEnabled: true,
  };
  if (alarmActionArn) params.AlarmActions = [alarmActionArn];
  return params;
}

export async function runSqsAlarms(config, { dryRun = false } = {}) {
  const resources = config.resources?.sqs || {};
  const queues = resources.queues || [];
  if (!queues.length) {
    console.log("SQS: no queues in config, skipping.");
    return 0;
  }

  const alarmCfg = config.alarms?.sqs || {};
  const alarmActionArn = alarmCfg.alarmActionArn || null;
  const sourceConfig = alarmCfg.source || {};
  const dlqConfig = alarmCfg.dlq || {};
  const overrides = alarmCfg.overrides || {};
  const baseTags = config.tags || [];

  const tasks = [];
  for (const queue of queues) {
    const { queueName, serviceName, kind = "source" } = queue;
    if (!queueName) continue;
    const typeConfig = kind === "dlq" ? dlqConfig : sourceConfig;
    const opts = getQueueOpts(typeConfig, overrides, queueName, kind);
    if (!opts.enabled) continue;

    const alarmTags = [
      ...baseTags,
      { Key: "Service", Value: serviceName || queueName },
      { Key: "AlarmType", Value: "sqs" },
    ];

    if (kind === "dlq") {
      if (!opts.visibleAlarmEnabled) continue;
      const alarmName = safeAlarmName(opts.namePrefix, serviceName || "dlq", queueName, "Visible");
      const params = buildAlarmParams({
        alarmName,
        alarmDescription: `SQS DLQ ${queueName} - messages visible`,
        metricName: "ApproximateNumberOfMessagesVisible",
        queueName,
        periodSeconds: opts.periodSeconds,
        evaluationPeriods: opts.evaluationPeriods,
        datapointsToAlarm: opts.datapointsToAlarm,
        threshold: opts.visibleThresholdCount,
        comparisonOperator: "GreaterThanThreshold",
        statistic: "Maximum",
        treatMissingData: opts.treatMissingData,
        alarmActionArn,
      });
      tasks.push(async () => {
        if (dryRun) {
          console.log(`[DRY-RUN] Would create SQS alarm: ${alarmName}`);
          return 1;
        }
        await putAlarmWithTagSync(params, alarmTags);
        console.log(`Created/updated SQS alarm: ${alarmName}`);
        return 1;
      });
      continue;
    }

    // Source queue: independently enable age and visible backlog alarms.
    const period = opts.periodSeconds;
    const evalPeriods = opts.evaluationPeriods;
    const datapoints = opts.datapointsToAlarm;
    const treatMissing = opts.treatMissingData;

    if (opts.ageAlarmEnabled) {
      const ageName = safeAlarmName(opts.namePrefix, serviceName, queueName, "Age");
      tasks.push(async () => {
        if (dryRun) {
          console.log(`[DRY-RUN] Would create SQS alarm: ${ageName}`);
          return 1;
        }
        await putAlarmWithTagSync(
          buildAlarmParams({
            alarmName: ageName,
            alarmDescription: `SQS ${queueName} - oldest message age (${opts.ageThresholdSeconds}s)`,
            metricName: "ApproximateAgeOfOldestMessage",
            queueName,
            periodSeconds: period,
            evaluationPeriods: evalPeriods,
            datapointsToAlarm: datapoints,
            threshold: opts.ageThresholdSeconds,
            comparisonOperator: "GreaterThanThreshold",
            statistic: "Maximum",
            treatMissingData: treatMissing,
            alarmActionArn,
          }),
          alarmTags
        );
        console.log(`Created/updated SQS alarm: ${ageName}`);
        return 1;
      });
    }

    if (opts.visibleAlarmEnabled) {
      const visibleName = safeAlarmName(opts.namePrefix, serviceName, queueName, "Visible");
      tasks.push(async () => {
        if (dryRun) {
          console.log(`[DRY-RUN] Would create SQS alarm: ${visibleName}`);
          return 1;
        }
        await putAlarmWithTagSync(
          buildAlarmParams({
            alarmName: visibleName,
            alarmDescription: `SQS ${queueName} - visible backlog (${opts.visibleThresholdCount})`,
            metricName: "ApproximateNumberOfMessagesVisible",
            queueName,
            periodSeconds: period,
            evaluationPeriods: evalPeriods,
            datapointsToAlarm: datapoints,
            threshold: opts.visibleThresholdCount,
            comparisonOperator: "GreaterThanThreshold",
            statistic: "Average",
            treatMissingData: treatMissing,
            alarmActionArn,
          }),
          alarmTags
        );
        console.log(`Created/updated SQS alarm: ${visibleName}`);
        return 1;
      });
    }
  }

  const results = await runWithConcurrency(tasks, CONCURRENCY);
  return results.reduce((a, b) => a + b, 0);
}
