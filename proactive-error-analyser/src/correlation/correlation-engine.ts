// ============================================================
// Correlation Engine
// Links error signals across data sources (metrics, logs, runtime errors, anomalies)
// ============================================================

import { randomUUID } from 'crypto';

import type {
  AnomalyResult,
  CollectedData,
  CorrelatedErrorGroup,
  CorrelationMethod,
  EndpointErrorMetric,
  NormalizedLogEntry,
  RuntimeErrorDetail,
  TimeRange,
} from '../types/index.js';
import type { ICorrelationEngine } from '../types/interfaces.js';

// --- Constants ---

export const CORRELATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// --- Utility ---

/**
 * Checks whether a timestamp falls within ±windowMs of any reference timestamp.
 */
export function isWithinTimeWindow(
  timestamp: Date,
  referenceTimestamps: Date[],
  windowMs: number
): boolean {
  const ts = timestamp.getTime();
  return referenceTimestamps.some(
    (ref) => Math.abs(ts - ref.getTime()) <= windowMs
  );
}

// --- Correlation Engine ---

export class CorrelationEngine implements ICorrelationEngine {
  correlate(data: CollectedData): CorrelatedErrorGroup[] {
    const groups: CorrelatedErrorGroup[] = [];

    // Track which signals have been assigned to avoid duplicates
    const assignedLogEntries = new Set<NormalizedLogEntry>();
    const assignedRuntimeErrors = new Set<RuntimeErrorDetail>();

    // Flatten all error metrics from all snapshots
    const allErrorMetrics: EndpointErrorMetric[] = data.metrics.flatMap(
      (snapshot) => snapshot.errorMetrics
    );

    // Flatten all log entries
    const allLogEntries: NormalizedLogEntry[] = data.logs.flatMap(
      (snapshot) => snapshot.entries
    );

    // Flatten all runtime error details
    const allRuntimeErrors: RuntimeErrorDetail[] =
      data.runtimeErrors.errors.flatMap((group) => group.details ?? []);

    // Flatten anomalies
    const allAnomalies: AnomalyResult[] = data.anomalies?.anomalies ?? [];

    // ============================================================
    // Phase 1: Endpoint-based correlation (strongest signal)
    // ============================================================

    for (const metric of allErrorMetrics) {
      // Find matching logs by service + endpoint
      const matchedLogs = allLogEntries.filter(
        (log) =>
          !assignedLogEntries.has(log) &&
          log.service === metric.service &&
          log.endpoint === metric.endpoint
      );

      // Collect trace IDs from matched logs
      const logTraceIds = new Set<string>();
      for (const log of matchedLogs) {
        if (log.traceId) {
          logTraceIds.add(log.traceId);
        }
      }

      // Find matching runtime errors:
      // - endpoint mention in error message OR
      // - trace ID match with logs
      const matchedRuntimeErrors = allRuntimeErrors.filter(
        (err) =>
          !assignedRuntimeErrors.has(err) &&
          (err.errorMessage.includes(metric.endpoint) ||
            (err.traceId != null && logTraceIds.has(err.traceId)))
      );

      // Find matching anomalies by service + endpoint
      const matchedAnomalies = allAnomalies.filter(
        (anomaly) =>
          anomaly.service === metric.service &&
          anomaly.endpoint === metric.endpoint
      );

      // ============================================================
      // Phase 2: Time-window correlation
      // ============================================================

      const metricTimestamps = metric.timestamps;

      // Filter logs to those within ±5 min of any metric timestamp
      const timeCorrelatedLogs = matchedLogs.filter((log) =>
        isWithinTimeWindow(log.timestamp, metricTimestamps, CORRELATION_WINDOW_MS)
      );

      const hasTimeWindowMatch = timeCorrelatedLogs.length > 0;

      // Check for trace ID match between logs and runtime errors
      const hasTraceIdMatch = matchedRuntimeErrors.some(
        (err) => err.traceId != null && logTraceIds.has(err.traceId)
      );

      // ============================================================
      // Confidence assignment
      // ============================================================

      let correlationConfidence: 'high' | 'medium' | 'low';
      const correlationMethods: CorrelationMethod[] = ['endpoint_match'];

      if (hasTraceIdMatch) {
        correlationConfidence = 'high';
        correlationMethods.push('trace_id');
      } else if (hasTimeWindowMatch) {
        correlationConfidence = 'medium';
        correlationMethods.push('time_window');
      } else {
        correlationConfidence = 'low';
      }

      // Mark signals as assigned
      for (const log of matchedLogs) {
        assignedLogEntries.add(log);
      }
      for (const err of matchedRuntimeErrors) {
        assignedRuntimeErrors.add(err);
      }

      // Build time range from metric timestamps
      const timestamps = metric.timestamps.map((t) => t.getTime());
      const timeRange: TimeRange = {
        start: new Date(Math.min(...timestamps)),
        end: new Date(Math.max(...timestamps)),
      };

      // Create the correlated group
      const group: CorrelatedErrorGroup = {
        id: randomUUID(),
        service: metric.service,
        endpoint: metric.endpoint,
        errorCount: metric.totalCount,
        timeRange,
        metrics: [metric],
        logEntries: matchedLogs,
        runtimeErrors: matchedRuntimeErrors,
        anomalies: matchedAnomalies,
        correlationConfidence,
        correlationMethod: correlationMethods,
      };

      groups.push(group);
    }

    // ============================================================
    // Phase 3: Orphan handling
    // ============================================================

    // Runtime errors not matched to any metric group get their own groups
    const orphanedRuntimeErrors = allRuntimeErrors.filter(
      (err) => !assignedRuntimeErrors.has(err)
    );

    for (const orphan of orphanedRuntimeErrors) {
      const timeRange: TimeRange = {
        start: orphan.timestamp,
        end: orphan.timestamp,
      };

      const group: CorrelatedErrorGroup = {
        id: randomUUID(),
        service: orphan.stage, // best available service identifier
        endpoint: '', // no endpoint info for orphans
        errorCount: 1,
        timeRange,
        metrics: [],
        logEntries: [],
        runtimeErrors: [orphan],
        anomalies: [],
        correlationConfidence: 'low',
        correlationMethod: ['error_message'],
      };

      groups.push(group);
    }

    return groups;
  }
}

// --- Standalone function export ---

/**
 * Standalone correlation function for convenience.
 */
export function correlate(data: CollectedData): CorrelatedErrorGroup[] {
  const engine = new CorrelationEngine();
  return engine.correlate(data);
}
