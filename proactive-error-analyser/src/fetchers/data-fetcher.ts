/**
 * DataFetcher Facade
 *
 * Orchestrates all data fetching with graceful degradation. Implements the IDataFetcher
 * interface and delegates to specialised fetchers (CloudWatch, Workflow MCP, Logs).
 * The higher-level `fetchAll` method runs fetches in parallel using Promise.allSettled
 * and records any failures in a `failedSources` array.
 */

import { fetchCloudWatchErrors, fetchCloudWatchLatency } from './cloudwatch-fetcher.js';
import {
  fetchRuntimeErrors,
  fetchRuntimeErrorDetails,
  type WorkflowMCPClient,
} from './workflow-mcp-fetcher.js';
import { fetchApplicationLogs } from './log-fetcher.js';

import type {
  AnalysisConfig,
  CollectedData,
  HotEndpoint,
  LogSnapshot,
  MetricsSnapshot,
  RuntimeErrorDetail,
  RuntimeErrorSnapshot,
} from '../types/index.js';
import type {
  IDataFetcher,
  LogFetchParams,
  MetricFetchParams,
  RuntimeErrorFilter,
} from '../types/interfaces.js';

// --- Helper: Identify Hot Endpoints ---

/**
 * Extracts endpoints where totalCount >= threshold from all snapshots.
 * Deduplicates by service+endpoint, sorts by totalCount descending,
 * and includes errorTimestamps for pinpointed log fetching.
 */
export function identifyHotEndpoints(
  snapshots: MetricsSnapshot[],
  threshold: number,
): HotEndpoint[] {
  const endpointMap = new Map<string, HotEndpoint>();

  for (const snapshot of snapshots) {
    for (const metric of snapshot.errorMetrics) {
      if (metric.totalCount < threshold) continue;

      const key = `${metric.service}::${metric.endpoint}`;
      const existing = endpointMap.get(key);

      if (existing) {
        // Merge: accumulate error count and timestamps
        existing.errorCount += metric.totalCount;
        existing.errorTimestamps.push(...metric.timestamps);
      } else {
        endpointMap.set(key, {
          service: metric.service,
          endpoint: metric.endpoint,
          errorCount: metric.totalCount,
          errorTimestamps: [...metric.timestamps],
        });
      }
    }
  }

  // Sort by errorCount descending
  return Array.from(endpointMap.values()).sort(
    (a, b) => b.errorCount - a.errorCount,
  );
}

// --- DataFetcher Class ---

export class DataFetcher implements IDataFetcher {
  private readonly client: WorkflowMCPClient;

  constructor(client: WorkflowMCPClient) {
    this.client = client;
  }

  // --- IDataFetcher Implementation ---

  async fetchCloudWatchErrors(params: MetricFetchParams): Promise<MetricsSnapshot[]> {
    return fetchCloudWatchErrors(params);
  }

  async fetchCloudWatchLatency(params: MetricFetchParams): Promise<MetricsSnapshot[]> {
    // Latency fetching requires hot endpoints — fetch errors first to identify them
    const errorSnapshots = await fetchCloudWatchErrors(params);
    const hotEndpoints = identifyHotEndpoints(errorSnapshots, params.errorThreshold);
    return fetchCloudWatchLatency(params, hotEndpoints);
  }

  async fetchRuntimeErrors(): Promise<RuntimeErrorSnapshot> {
    return fetchRuntimeErrors(this.client);
  }

  async fetchRuntimeErrorDetails(filter: RuntimeErrorFilter): Promise<RuntimeErrorDetail[]> {
    return fetchRuntimeErrorDetails(this.client, filter);
  }

  async fetchApplicationLogs(params: LogFetchParams): Promise<LogSnapshot> {
    return fetchApplicationLogs(this.client, params);
  }

  // --- Higher-Level Orchestration ---

  /**
   * Fetch all data sources in parallel with graceful degradation.
   *
   * 1. Fetches CloudWatch errors and runtime errors in parallel (Promise.allSettled)
   * 2. Identifies hot endpoints from the error results
   * 3. Fetches logs only for hot endpoints using pinpointed timestamps
   * 4. Returns a CollectedData object plus any failedSources
   */
  async fetchAll(config: AnalysisConfig): Promise<CollectedData & { failedSources: string[] }> {
    const failedSources: string[] = [];

    const metricParams: MetricFetchParams = {
      namespace: config.namespace,
      services: config.services,
      timeRange: config.timeRange,
      errorThreshold: config.errorThreshold,
    };

    // Phase 1: Fetch CloudWatch errors and runtime errors in parallel
    const [metricsResult, runtimeResult] = await Promise.allSettled([
      fetchCloudWatchErrors(metricParams),
      fetchRuntimeErrors(this.client),
    ]);

    // Extract metrics (or default to empty)
    let metrics: MetricsSnapshot[] = [];
    if (metricsResult.status === 'fulfilled') {
      metrics = metricsResult.value;
    } else {
      failedSources.push('cloudwatch_errors');
      console.warn(
        `[data-fetcher] CloudWatch errors fetch failed: ${metricsResult.reason}`,
      );
    }

    // Extract runtime errors (or default to empty)
    let runtimeErrors: RuntimeErrorSnapshot = { errors: [], fetchedAt: new Date() };
    if (runtimeResult.status === 'fulfilled') {
      runtimeErrors = runtimeResult.value;
    } else {
      failedSources.push('runtime_errors');
      console.warn(
        `[data-fetcher] Runtime errors fetch failed: ${runtimeResult.reason}`,
      );
    }

    // Phase 2: Identify hot endpoints from error metrics
    const hotEndpoints = identifyHotEndpoints(metrics, config.errorThreshold);

    console.log(
      `[data-fetcher] Identified ${hotEndpoints.length} hot endpoints for log fetching`,
    );

    // Phase 3: Fetch logs for each hot endpoint using pinpointed timestamps
    const logs: LogSnapshot[] = [];

    const logFetchPromises = hotEndpoints.map((hot) => {
      const logParams: LogFetchParams = {
        service: hot.service,
        endpoint: hot.endpoint,
        timeRange: config.timeRange,
        maxEntries: config.maxLogEntries,
        errorTimestamps: hot.errorTimestamps,
      };
      return fetchApplicationLogs(this.client, logParams);
    });

    const logResults = await Promise.allSettled(logFetchPromises);

    for (let i = 0; i < logResults.length; i++) {
      const result = logResults[i];
      if (result.status === 'fulfilled') {
        logs.push(result.value);
      } else {
        const hot = hotEndpoints[i];
        failedSources.push(`logs:${hot.service}/${hot.endpoint}`);
        console.warn(
          `[data-fetcher] Log fetch failed for ${hot.service}/${hot.endpoint}: ${result.reason}`,
        );
      }
    }

    // Phase 4: Optionally fetch latency data
    if (config.includeLatencyAnalysis && hotEndpoints.length > 0) {
      try {
        const latencySnapshots = await fetchCloudWatchLatency(metricParams, hotEndpoints);
        // Merge latency data into existing metric snapshots
        for (const latencySnapshot of latencySnapshots) {
          const existing = metrics.find((m) => m.service === latencySnapshot.service);
          if (existing) {
            existing.latencyMetrics = latencySnapshot.latencyMetrics;
          } else {
            metrics.push(latencySnapshot);
          }
        }
      } catch (error) {
        failedSources.push('cloudwatch_latency');
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[data-fetcher] CloudWatch latency fetch failed: ${message}`);
      }
    }

    if (failedSources.length > 0) {
      console.warn(
        `[data-fetcher] Completed with ${failedSources.length} failed source(s): ${failedSources.join(', ')}`,
      );
    } else {
      console.log('[data-fetcher] All data sources fetched successfully');
    }

    return {
      metrics,
      runtimeErrors,
      logs,
      failedSources,
    };
  }
}

export default DataFetcher;
