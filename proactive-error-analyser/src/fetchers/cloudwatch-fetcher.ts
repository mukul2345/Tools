/**
 * CloudWatch Data Fetcher
 *
 * Fetches error metrics (API_COUNT with statusCode=500) and latency metrics (API_LATENCY p90)
 * from the DFG-Observability namespace. Implements batched queries and exponential backoff retry.
 */

import {
  CloudWatchClient,
  ListMetricsCommand,
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
  type Metric,
} from '@aws-sdk/client-cloudwatch';

import type {
  MetricsSnapshot,
  EndpointErrorMetric,
  EndpointLatencyMetric,
  HotEndpoint,
} from '../types/index.js';
import type { MetricFetchParams } from '../types/interfaces.js';

// --- Client ---

const client = new CloudWatchClient({
  profile: 'default',
  region: 'eu-west-1',
});

// --- Constants ---

const BATCH_SIZE = 500;
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;
const NAMESPACE = 'DFG-Observability';

// --- Retry Helpers ---

function sleep(ms: number): Promise<void> {
  const jitter = Math.random() * 0.3 * ms;
  return new Promise((resolve) => setTimeout(resolve, ms + jitter));
}

function isThrottlingError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (
      err.name === 'ThrottlingException' ||
      err.name === 'TooManyRequestsException'
    ) {
      return true;
    }
    const metadata = err.$metadata as Record<string, unknown> | undefined;
    if (metadata?.httpStatusCode === 429) {
      return true;
    }
  }
  return false;
}

async function executeWithRetry<T>(
  commandFn: () => { input: unknown },
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const command = commandFn();
      return (await client.send(command as never)) as T;
    } catch (error) {
      lastError = error;

      if (isThrottlingError(error) && attempt < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
        console.warn(
          `[cloudwatch-fetcher] Throttled, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await sleep(backoffMs);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

// --- Metric Listing ---

async function listMetricsPaginated(
  metricName: string,
  dimensions?: Array<{ Name: string; Value: string }>,
): Promise<Metric[]> {
  const allMetrics: Metric[] = [];
  let nextToken: string | undefined;

  do {
    const params: Record<string, unknown> = {
      Namespace: NAMESPACE,
      MetricName: metricName,
      NextToken: nextToken,
    };

    if (dimensions && dimensions.length > 0) {
      params.Dimensions = dimensions;
    }

    const response = await executeWithRetry<{
      Metrics?: Metric[];
      NextToken?: string;
    }>(() => new ListMetricsCommand(params as never));

    if (response.Metrics) {
      allMetrics.push(...response.Metrics);
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return allMetrics;
}

// --- Batched GetMetricData ---

async function getMetricDataBatched(
  queries: MetricDataQuery[],
  start: Date,
  end: Date,
): Promise<MetricDataResult[]> {
  const allResults: MetricDataResult[] = [];

  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    const batchResults = await getMetricDataPaginated(batch, start, end);
    allResults.push(...batchResults);
  }

  return allResults;
}

async function getMetricDataPaginated(
  queries: MetricDataQuery[],
  start: Date,
  end: Date,
): Promise<MetricDataResult[]> {
  const allResults: MetricDataResult[] = [];
  let nextToken: string | undefined;

  do {
    const response = await executeWithRetry<{
      MetricDataResults?: MetricDataResult[];
      NextToken?: string;
    }>(
      () =>
        new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: start,
          EndTime: end,
          ScanBy: 'TimestampDescending',
          NextToken: nextToken,
        }),
    );

    if (response.MetricDataResults) {
      if (allResults.length === 0) {
        allResults.push(...response.MetricDataResults);
      } else {
        // Merge paginated data points into existing results
        for (const newResult of response.MetricDataResults) {
          const existing = allResults.find((r) => r.Id === newResult.Id);
          if (existing && newResult.Values && newResult.Timestamps) {
            existing.Values = [...(existing.Values || []), ...newResult.Values];
            existing.Timestamps = [
              ...(existing.Timestamps || []),
              ...newResult.Timestamps,
            ];
          }
        }
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return allResults;
}

// --- Period Calculation ---

function calculatePeriod(timeRange: { start: Date; end: Date }): number {
  const timeRangeMs = timeRange.end.getTime() - timeRange.start.getTime();
  const timeRangeHours = timeRangeMs / (60 * 60 * 1000);

  // Choose period based on time range to get reasonable granularity:
  // - Up to 3h: 60s period (180 data points)
  // - Up to 12h: 300s / 5min period (144 data points)
  // - Up to 24h: 600s / 10min period (144 data points)
  // - Up to 3d: 1800s / 30min period (144 data points)
  // - Up to 7d: 3600s / 1h period (168 data points)
  if (timeRangeHours <= 3) return 60;
  if (timeRangeHours <= 12) return 300;
  if (timeRangeHours <= 24) return 600;
  if (timeRangeHours <= 72) return 1800;
  return 3600;
}

// --- Query Builders ---

function sanitizeId(raw: string): string {
  // CloudWatch metric IDs must match [a-z][a-zA-Z0-9_]*
  return raw
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^[^a-z]/, 'm')
    .substring(0, 255);
}

function buildErrorQuery(
  index: number,
  service: string,
  endpoint: string,
  period: number,
): MetricDataQuery {
  const id = sanitizeId(`err_${index}_${service}_${endpoint}`);
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: NAMESPACE,
        MetricName: 'API_COUNT',
        Dimensions: [
          { Name: 'serviceName', Value: service },
          { Name: 'endpoint', Value: endpoint },
          { Name: 'statusCode', Value: '500' },
          { Name: 'environment', Value: 'production' },
        ],
      },
      Period: period,
      Stat: 'Sum',
    },
    ReturnData: true,
  };
}

function buildLatencyQuery(
  index: number,
  service: string,
  endpoint: string,
  period: number,
): MetricDataQuery {
  const id = sanitizeId(`lat_${index}_${service}_${endpoint}`);
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: NAMESPACE,
        MetricName: 'API_LATENCY',
        Dimensions: [
          { Name: 'serviceName', Value: service },
          { Name: 'endpoint', Value: endpoint },
          { Name: 'environment', Value: 'production' },
        ],
      },
      Period: period,
      Stat: 'p90',
    },
    ReturnData: true,
  };
}

// --- Result Extraction ---

function extractErrorMetric(
  result: MetricDataResult,
  service: string,
  endpoint: string,
): EndpointErrorMetric | null {
  const timestamps = (result.Timestamps || []).map((t) =>
    t instanceof Date ? t : new Date(t),
  );
  const values = result.Values || [];

  if (values.length === 0) {
    return null;
  }

  const totalCount = values.reduce((sum, v) => sum + v, 0);

  // Find peak
  let peakCount = 0;
  let peakTimestamp = timestamps[0] || new Date();
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peakCount) {
      peakCount = values[i];
      peakTimestamp = timestamps[i];
    }
  }

  return {
    service,
    endpoint,
    statusCode: 500,
    totalCount,
    timestamps,
    values,
    peakCount,
    peakTimestamp,
  };
}

function extractLatencyMetric(
  result: MetricDataResult,
  service: string,
  endpoint: string,
): EndpointLatencyMetric | null {
  const values = result.Values || [];

  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const max = Math.max(...values);

  return {
    service,
    endpoint,
    p90Ms: p90,
    p99Ms: p99,
    avgMs: avg,
    maxMs: max,
  };
}

// --- Public API ---

/**
 * Fetch error metrics from CloudWatch for the given services.
 * Lists all API_COUNT metrics with statusCode=500, then fetches time-series data.
 */
export async function fetchCloudWatchErrors(
  params: MetricFetchParams,
): Promise<MetricsSnapshot[]> {
  const { services, timeRange, errorThreshold } = params;
  const period = calculatePeriod(timeRange);

  console.log(
    `[cloudwatch-fetcher] Fetching error metrics for ${services.length} services (period: ${period}s)`,
  );

  // Discover all API_COUNT metrics in the namespace
  const allMetrics = await listMetricsPaginated('API_COUNT');

  // Filter to relevant services and statusCode=500
  const errorMetrics = allMetrics.filter((metric) => {
    const dims = metric.Dimensions || [];
    const serviceDim = dims.find((d) => d.Name === 'serviceName');
    const statusDim = dims.find((d) => d.Name === 'statusCode');

    if (!serviceDim || !statusDim) return false;
    if (!services.includes(serviceDim.Value!)) return false;
    if (statusDim.Value !== '500') return false;

    return true;
  });

  console.log(
    `[cloudwatch-fetcher] Found ${errorMetrics.length} error metric series across ${services.length} services`,
  );

  if (errorMetrics.length === 0) {
    return services.map((service) => ({
      service,
      timeRange,
      errorMetrics: [],
      latencyMetrics: [],
      fetchedAt: new Date(),
    }));
  }

  // Build queries for each discovered metric
  const queries: MetricDataQuery[] = [];
  const queryMeta: Array<{ service: string; endpoint: string }> = [];

  for (let i = 0; i < errorMetrics.length; i++) {
    const metric = errorMetrics[i];
    const dims = metric.Dimensions || [];
    const service = dims.find((d) => d.Name === 'serviceName')!.Value!;
    const endpoint = dims.find((d) => d.Name === 'endpoint')?.Value || 'unknown';

    queries.push(buildErrorQuery(i, service, endpoint, period));
    queryMeta.push({ service, endpoint });
  }

  // Fetch data in batches
  const results = await getMetricDataBatched(queries, timeRange.start, timeRange.end);

  // Group results by service
  const serviceMap = new Map<string, EndpointErrorMetric[]>();
  for (const service of services) {
    serviceMap.set(service, []);
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const meta = queryMeta[i];

    if (!meta) continue;

    const errorMetric = extractErrorMetric(result, meta.service, meta.endpoint);
    if (errorMetric && errorMetric.totalCount >= errorThreshold) {
      const serviceErrors = serviceMap.get(meta.service);
      if (serviceErrors) {
        serviceErrors.push(errorMetric);
      }
    }
  }

  // Build snapshots
  const snapshots: MetricsSnapshot[] = [];
  for (const [service, errorMetricsList] of serviceMap) {
    snapshots.push({
      service,
      timeRange,
      errorMetrics: errorMetricsList,
      latencyMetrics: [],
      fetchedAt: new Date(),
    });
  }

  const totalErrors = snapshots.reduce((sum, s) => sum + s.errorMetrics.length, 0);
  console.log(
    `[cloudwatch-fetcher] Fetched ${totalErrors} endpoints exceeding threshold (${errorThreshold})`,
  );

  return snapshots;
}

/**
 * Fetch p90 latency metrics for hot endpoints that exceeded the error threshold.
 * Only queries endpoints present in the hotEndpoints list.
 */
export async function fetchCloudWatchLatency(
  params: MetricFetchParams,
  hotEndpoints: HotEndpoint[],
): Promise<MetricsSnapshot[]> {
  const { services, timeRange } = params;
  const period = calculatePeriod(timeRange);

  if (hotEndpoints.length === 0) {
    console.log('[cloudwatch-fetcher] No hot endpoints to fetch latency for');
    return services.map((service) => ({
      service,
      timeRange,
      errorMetrics: [],
      latencyMetrics: [],
      fetchedAt: new Date(),
    }));
  }

  console.log(
    `[cloudwatch-fetcher] Fetching p90 latency for ${hotEndpoints.length} hot endpoints (period: ${period}s)`,
  );

  // Build latency queries only for hot endpoints
  const queries: MetricDataQuery[] = [];
  const queryMeta: Array<{ service: string; endpoint: string }> = [];

  for (let i = 0; i < hotEndpoints.length; i++) {
    const { service, endpoint } = hotEndpoints[i];
    queries.push(buildLatencyQuery(i, service, endpoint, period));
    queryMeta.push({ service, endpoint });
  }

  // Fetch data in batches
  const results = await getMetricDataBatched(queries, timeRange.start, timeRange.end);

  // Group results by service
  const serviceMap = new Map<string, EndpointLatencyMetric[]>();
  for (const service of services) {
    serviceMap.set(service, []);
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const meta = queryMeta[i];

    if (!meta) continue;

    const latencyMetric = extractLatencyMetric(result, meta.service, meta.endpoint);
    if (latencyMetric) {
      const serviceLatencies = serviceMap.get(meta.service);
      if (serviceLatencies) {
        serviceLatencies.push(latencyMetric);
      }
    }
  }

  // Build snapshots
  const snapshots: MetricsSnapshot[] = [];
  for (const [service, latencyMetrics] of serviceMap) {
    snapshots.push({
      service,
      timeRange,
      errorMetrics: [],
      latencyMetrics,
      fetchedAt: new Date(),
    });
  }

  const totalLatency = snapshots.reduce((sum, s) => sum + s.latencyMetrics.length, 0);
  console.log(
    `[cloudwatch-fetcher] Fetched latency data for ${totalLatency} endpoints`,
  );

  return snapshots;
}
