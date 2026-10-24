/**
 * CloudWatch client and alarm operations (self-contained, no dependency on cloudwatch-metrics-reports)
 */

import {
  CloudWatchClient,
  ListMetricsCommand,
  GetMetricDataCommand,
  PutMetricAlarmCommand,
  PutCompositeAlarmCommand,
  DescribeAlarmsCommand,
  TagResourceCommand,
  ListTagsForResourceCommand,
  DeleteAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import { fromIni } from "@aws-sdk/credential-providers";

const profile = process.env.AWS_PROFILE || "default";
const region = process.env.AWS_REGION || "eu-west-1";

let client = new CloudWatchClient({
  region,
  credentials: fromIni({ profile }),
});

export function initCloudWatch(options = {}) {
  const p = options.profile ?? process.env.AWS_PROFILE ?? profile;
  const r = options.region ?? process.env.AWS_REGION ?? region;
  client = new CloudWatchClient({
    region: r,
    credentials: fromIni({ profile: p }),
  });
}

function sleep(ms) {
  const jitter = Math.random() * 0.3 * ms;
  return new Promise((resolve) => setTimeout(resolve, ms + jitter));
}

async function executeWithRetry(commandFn, maxRetries = 5) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.send(commandFn());
    } catch (error) {
      lastError = error;
      const message = String(error.message || "").toLowerCase();
      const isThrottling =
        error.name === "ThrottlingException" ||
        error.name === "Throttling" ||
        error.name === "ThrottledException" ||
        error.name === "TooManyRequestsException" ||
        error.name === "LimitExceededException" ||
        error.name === "LimitExceededFault" ||
        error.$metadata?.httpStatusCode === 429 ||
        error.$metadata?.httpStatusCode === 400 ||
        message.includes("rate exceeded") ||
        message.includes("throttl") ||
        message.includes("too many requests") ||
        message.includes("limit exceeded");
      if (isThrottling && attempt < maxRetries) {
        const backoffMs = Math.min(1500 * Math.pow(2, attempt), 30000);
        await sleep(backoffMs);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function listMetricsAll({ namespace, metricName, dimensions }) {
  const allMetrics = [];
  let nextToken;
  do {
    const params = { Namespace: namespace, NextToken: nextToken };
    if (metricName) params.MetricName = metricName;
    if (dimensions?.length) params.Dimensions = dimensions;
    const response = await executeWithRetry(() => new ListMetricsCommand(params));
    if (response.Metrics) allMetrics.push(...response.Metrics);
    nextToken = response.NextToken;
  } while (nextToken);
  return allMetrics;
}

export async function getMetricDataBatched({ queries, start, end, period }) {
  const BATCH_SIZE = 500;
  const allResults = [];
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    let nextToken;
    do {
      const params = {
        MetricDataQueries: batch,
        StartTime: start,
        EndTime: end,
        ScanBy: "TimestampDescending",
        NextToken: nextToken,
      };
      const response = await executeWithRetry(() => new GetMetricDataCommand(params));
      if (response.MetricDataResults) {
        if (allResults.length === 0) allResults.push(...response.MetricDataResults);
        else {
          response.MetricDataResults.forEach((nr) => {
            const ex = allResults.find((r) => r.Id === nr.Id);
            if (ex && nr.Values) {
              ex.Values.push(...(nr.Values || []));
              ex.Timestamps.push(...(nr.Timestamps || []));
            }
          });
        }
      }
      nextToken = response.NextToken;
    } while (nextToken);
  }
  return allResults;
}

export function buildMetricQuery({ id, namespace, metricName, dimensions, stat, period }) {
  return {
    Id: id,
    MetricStat: {
      Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions },
      Period: period,
      Stat: stat,
    },
    ReturnData: true,
  };
}

export async function putMetricAlarm(params) {
  await executeWithRetry(() => new PutMetricAlarmCommand(params));
}

export async function putCompositeAlarm(params) {
  await executeWithRetry(() => new PutCompositeAlarmCommand(params));
}

export async function getAlarmArn(alarmName) {
  const response = await executeWithRetry(() =>
    new DescribeAlarmsCommand({ AlarmNames: [alarmName] }),
  );
  return response.MetricAlarms?.[0]?.AlarmArn ?? null;
}

export async function tagAlarm(resourceArn, tags) {
  if (!tags?.length) return;
  await executeWithRetry(() =>
    new TagResourceCommand({ ResourceARN: resourceArn, Tags: tags }),
  );
}

export async function putAlarmWithTagSync(params, tags) {
  await putMetricAlarm(params);
  const arn = await getAlarmArn(params.AlarmName);
  if (arn && tags?.length) await tagAlarm(arn, tags);
}

export async function putCompositeAlarmWithTagSync(params, tags, accountId, regionName) {
  await putCompositeAlarm(params);
  const arn = `arn:aws:cloudwatch:${regionName}:${accountId}:alarm:${params.AlarmName}`;
  if (tags?.length) await tagAlarm(arn, tags);
}

/** List all metric alarms with pagination */
export async function listAllMetricAlarms() {
  const alarms = [];
  let nextToken;
  do {
    const params = { NextToken: nextToken };
    const response = await executeWithRetry(() => new DescribeAlarmsCommand(params));
    if (response.MetricAlarms) alarms.push(...response.MetricAlarms);
    nextToken = response.NextToken;
  } while (nextToken);
  return alarms;
}

/** List all composite alarms with pagination */
export async function listAllCompositeAlarms() {
  const alarms = [];
  let nextToken;
  do {
    const params = { NextToken: nextToken };
    const response = await executeWithRetry(() => new DescribeAlarmsCommand(params));
    if (response.CompositeAlarms) alarms.push(...response.CompositeAlarms);
    nextToken = response.NextToken;
  } while (nextToken);
  return alarms;
}

export async function listAlarmTags(resourceArn) {
  const response = await executeWithRetry(() =>
    new ListTagsForResourceCommand({ ResourceARN: resourceArn }),
  );
  return response.Tags ?? [];
}

export async function deleteAlarms(alarmNames) {
  if (!alarmNames.length) return;
  await executeWithRetry(() => new DeleteAlarmsCommand({ AlarmNames: alarmNames }));
}
