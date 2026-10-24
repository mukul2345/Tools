/**
 * CloudWatch client helpers with pagination and exponential backoff
 */

import {
  CloudWatchClient,
  ListMetricsCommand,
  GetMetricDataCommand,
  PutMetricAlarmCommand,
  DescribeAlarmsCommand,
  TagResourceCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-cloudwatch";
import { fromIni } from "@aws-sdk/credential-providers";
import { logger } from "./logger.mjs";

const profile = process.env.AWS_PROFILE || "prod";
const region = process.env.AWS_REGION || "eu-west-1";

let client = new CloudWatchClient({
  region,
  credentials: fromIni({ profile }),
});

/**
 * Reinitialize the CloudWatch client with explicit profile/region (e.g. from config).
 * Call this before any other exports when the script has loaded config and set env.
 * @param {Object} [options]
 * @param {string} [options.profile]
 * @param {string} [options.region]
 */
export function initCloudWatch(options = {}) {
  const p = options.profile ?? process.env.AWS_PROFILE ?? profile;
  const r = options.region ?? process.env.AWS_REGION ?? region;
  client = new CloudWatchClient({
    region: r,
    credentials: fromIni({ profile: p }),
  });
}

/**
 * Sleep for a given duration with jitter
 * @param {number} ms - Base milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  const jitter = Math.random() * 0.3 * ms; // Up to 30% jitter
  return new Promise((resolve) => setTimeout(resolve, ms + jitter));
}

/**
 * Execute CloudWatch command with exponential backoff retry
 * @param {Function} commandFn - Function that returns a Command object
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<any>}
 */
async function executeWithRetry(commandFn, maxRetries = 5) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const command = commandFn();
      return await client.send(command);
    } catch (error) {
      lastError = error;

      // Check if it's a throttling error
      const isThrottling =
        error.name === "ThrottlingException" ||
        error.name === "TooManyRequestsException" ||
        error.$metadata?.httpStatusCode === 429;

      if (isThrottling && attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30s
        logger.warn(
          `Throttled, retrying in ${backoffMs}ms (attempt ${
            attempt + 1
          }/${maxRetries})`,
        );
        await sleep(backoffMs);
        continue;
      }

      // For other errors or max retries reached, throw
      throw error;
    }
  }

  throw lastError;
}

/**
 * List all metrics matching criteria with pagination
 * @param {Object} params
 * @param {string} params.namespace - CloudWatch namespace
 * @param {string} [params.metricName] - Optional metric name filter
 * @param {Array<{Name: string, Value: string}>} [params.dimensions] - Optional dimension filters
 * @returns {Promise<Array>} - Array of metric objects
 */
export async function listMetricsAll({ namespace, metricName, dimensions }) {
  const allMetrics = [];
  let nextToken = undefined;

  logger.info(
    `Listing metrics in namespace: ${namespace}${
      metricName ? `, metric: ${metricName}` : ""
    }`,
  );

  do {
    const params = {
      Namespace: namespace,
      NextToken: nextToken,
    };

    if (metricName) {
      params.MetricName = metricName;
    }

    if (dimensions && dimensions.length > 0) {
      params.Dimensions = dimensions;
    }

    const response = await executeWithRetry(
      () => new ListMetricsCommand(params),
    );

    if (response.Metrics) {
      allMetrics.push(...response.Metrics);
      logger.debug(
        `Fetched ${response.Metrics.length} metrics (total: ${allMetrics.length})`,
      );
    }

    nextToken = response.NextToken;
  } while (nextToken);

  logger.info(`Total metrics found: ${allMetrics.length}`);
  return allMetrics;
}

/**
 * Get metric data in batches (respects 500 query limit)
 * @param {Object} params
 * @param {Array} params.queries - MetricDataQuery array
 * @param {Date} params.start - Start time
 * @param {Date} params.end - End time
 * @param {number} params.period - Period in seconds
 * @returns {Promise<Array>} - Array of MetricDataResult objects
 */
export async function getMetricDataBatched({ queries, start, end, period }) {
  const BATCH_SIZE = 500;
  const allResults = [];

  logger.info(
    `Fetching metric data for ${
      queries.length
    } queries from ${start.toISOString()} to ${end.toISOString()}`,
  );

  // Process in batches
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    logger.debug(
      `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(
        queries.length / BATCH_SIZE,
      )} (${batch.length} queries)`,
    );

    const batchResults = await getMetricDataPaginated({
      queries: batch,
      start,
      end,
      period,
    });

    allResults.push(...batchResults);
  }

  logger.info(`Fetched data for ${allResults.length} metric queries`);
  return allResults;
}

/**
 * Get metric data with pagination for a single batch
 * @param {Object} params
 * @param {Array} params.queries - MetricDataQuery array (max 500)
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {number} params.period
 * @returns {Promise<Array>}
 */
async function getMetricDataPaginated({ queries, start, end, period }) {
  const allResults = [];
  let nextToken = undefined;

  do {
    const params = {
      MetricDataQueries: queries,
      StartTime: start,
      EndTime: end,
      ScanBy: "TimestampDescending", // Most recent first
      NextToken: nextToken,
    };

    const response = await executeWithRetry(
      () => new GetMetricDataCommand(params),
    );

    if (response.MetricDataResults) {
      // On first iteration, add all results
      if (allResults.length === 0) {
        allResults.push(...response.MetricDataResults);
      } else {
        // Merge additional data points from pagination
        response.MetricDataResults.forEach((newResult) => {
          const existing = allResults.find((r) => r.Id === newResult.Id);
          if (existing && newResult.Values) {
            existing.Values.push(...newResult.Values);
            existing.Timestamps.push(...newResult.Timestamps);
          }
        });
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return allResults;
}

/**
 * Build a MetricDataQuery for GetMetricData
 * @param {Object} params
 * @param {string} params.id - Unique query ID
 * @param {string} params.namespace
 * @param {string} params.metricName
 * @param {Array<{Name: string, Value: string}>} params.dimensions
 * @param {string} params.stat - Statistic (Average, Sum, etc.) or ExtendedStatistic (p90)
 * @param {number} params.period
 * @returns {Object} - MetricDataQuery
 */
export function buildMetricQuery({
  id,
  namespace,
  metricName,
  dimensions,
  stat,
  period,
}) {
  const query = {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: dimensions,
      },
      Period: period,
      Stat: stat,
    },
    ReturnData: true,
  };

  return query;
}

/**
 * Create or update a CloudWatch alarm
 * @param {Object} params - PutMetricAlarm parameters
 * @returns {Promise<void>}
 */
export async function putMetricAlarm(params) {
  await executeWithRetry(() => new PutMetricAlarmCommand(params));
}

/**
 * Get alarm ARN by name (via DescribeAlarms)
 * @param {string} alarmName
 * @returns {Promise<string|null>} - Alarm ARN or null if not found
 */
export async function getAlarmArn(alarmName) {
  const response = await executeWithRetry(() =>
    new DescribeAlarmsCommand({ AlarmNames: [alarmName] }),
  );
  const alarm = response.MetricAlarms?.[0];
  return alarm?.AlarmArn ?? null;
}

/**
 * Apply tags to a CloudWatch alarm (merge; does not remove existing tags)
 * @param {string} resourceArn - Alarm ARN
 * @param {Array<{Key: string, Value: string}>} tags
 * @returns {Promise<void>}
 */
export async function tagAlarm(resourceArn, tags) {
  if (!tags?.length) return;
  await executeWithRetry(() =>
    new TagResourceCommand({ ResourceARN: resourceArn, Tags: tags }),
  );
}

/**
 * List tags for a CloudWatch alarm
 * @param {string} resourceArn - Alarm ARN
 * @returns {Promise<Array<{Key: string, Value: string}>>}
 */
export async function listAlarmTags(resourceArn) {
  const response = await executeWithRetry(() =>
    new ListTagsForResourceCommand({ ResourceARN: resourceArn }),
  );
  return response.Tags ?? [];
}

/**
 * Create or update a CloudWatch alarm and sync tags (apply desired tags after put).
 * On reruns, tags are re-applied so they stay in sync with config.
 * @param {Object} params - PutMetricAlarm parameters
 * @param {Array<{Key: string, Value: string}>} tags - Desired tags to apply
 * @returns {Promise<void>}
 */
export async function putAlarmWithTagSync(params, tags) {
  await putMetricAlarm(params);
  const alarmArn = await getAlarmArn(params.AlarmName);
  if (alarmArn && tags?.length) {
    await tagAlarm(alarmArn, tags);
    logger.debug(`Tagged alarm: ${params.AlarmName}`);
  }
}
