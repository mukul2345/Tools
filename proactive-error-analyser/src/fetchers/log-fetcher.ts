/**
 * Application Log Fetcher
 *
 * Fetches application logs using the Workflow MCP server's log search with error time pinpointing.
 * The MCP log search has a 10-minute max window, so this module:
 * 1. Creates 10-minute windows centered on each error timestamp (±5 min)
 * 2. Merges overlapping windows to avoid duplicate queries
 * 3. Queries each window separately and merges results
 * 4. Normalizes raw log entries into a consistent format
 */

import type { LogSnapshot, NormalizedLogEntry } from '../types/index.js';
import type { LogFetchParams } from '../types/interfaces.js';
import type { WorkflowMCPClient, LogSearchParams } from './workflow-mcp-fetcher.js';

// --- Constants ---

const WINDOW_HALF_MS = 5 * 60 * 1000; // 5 minutes in ms
const DEFAULT_PAGE_SIZE = 5000;

// --- Internal Types ---

interface TimeWindow {
  start: Date;
  end: Date;
}

// --- Window Calculation ---

/**
 * Create 10-minute windows centered on each error timestamp (±5 min).
 */
function createWindows(errorTimestamps: Date[]): TimeWindow[] {
  return errorTimestamps.map((ts) => ({
    start: new Date(ts.getTime() - WINDOW_HALF_MS),
    end: new Date(ts.getTime() + WINDOW_HALF_MS),
  }));
}

/**
 * Merge overlapping time windows to avoid duplicate queries.
 * Windows are sorted by start time, then adjacent/overlapping windows are combined.
 */
function mergeOverlappingWindows(windows: TimeWindow[]): TimeWindow[] {
  if (windows.length === 0) return [];

  // Sort by start time
  const sorted = [...windows].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );

  const merged: TimeWindow[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.start.getTime() <= last.end.getTime()) {
      // Overlapping or adjacent — extend the end if needed
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
    } else {
      merged.push(current);
    }
  }

  return merged;
}

// --- Log Normalization ---

/**
 * Parse a log level string into a normalized level enum value.
 */
function parseLogLevel(raw: unknown): NormalizedLogEntry['level'] {
  const level = String(raw || '').toUpperCase();
  if (level === 'ERROR' || level === 'ERR') return 'ERROR';
  if (level === 'WARN' || level === 'WARNING') return 'WARN';
  if (level === 'DEBUG') return 'DEBUG';
  return 'INFO';
}

/**
 * Attempt to parse a timestamp from a raw log entry.
 * Returns null if the timestamp is missing or unparseable.
 */
function parseTimestamp(raw: unknown): Date | null {
  if (!raw) return null;

  if (raw instanceof Date) return raw;

  const parsed = new Date(String(raw));
  if (isNaN(parsed.getTime())) return null;

  return parsed;
}

/**
 * Normalize a raw log entry into the standard NormalizedLogEntry format.
 * Returns null if the entry is malformed (missing timestamp or message).
 */
function normalizeLogEntry(
  raw: Record<string, unknown>,
  service: string,
): NormalizedLogEntry | null {
  const timestamp = parseTimestamp(
    raw.timestamp || raw['@timestamp'] || raw.date || raw.time,
  );
  const message = raw.message || raw.msg || raw.log;

  // Skip malformed entries — timestamp and message are required
  if (!timestamp || !message) {
    return null;
  }

  return {
    timestamp,
    level: parseLogLevel(raw.level || raw.logLevel || raw.severity),
    message: String(message),
    traceId: raw.traceId ? String(raw.traceId) : undefined,
    requestId: (raw.requestId || raw.requestID) ? String(raw.requestId || raw.requestID) : undefined,
    service,
    endpoint: raw.endpoint ? String(raw.endpoint) : undefined,
    statusCode: raw.statusCode ? Number(raw.statusCode) : undefined,
    errorType: raw.errorType ? String(raw.errorType) : undefined,
    stackTrace: raw.stackTrace ? String(raw.stackTrace) : undefined,
    raw,
  };
}

// --- Public API ---

/**
 * Fetch application logs using error-time-pinpointed windows.
 *
 * Creates 10-minute search windows centered on each error timestamp,
 * merges overlapping windows, queries each separately, and normalizes results.
 */
export async function fetchApplicationLogs(
  client: WorkflowMCPClient,
  params: LogFetchParams,
): Promise<LogSnapshot> {
  const { service, errorTimestamps, maxEntries } = params;

  if (errorTimestamps.length === 0) {
    console.log(
      `[log-fetcher] No error timestamps provided for ${service}. Returning empty snapshot.`,
    );
    return {
      service,
      entries: [],
      fetchedAt: new Date(),
    };
  }

  // Step 1: Create 10-minute windows centered on each error timestamp
  const rawWindows = createWindows(errorTimestamps);

  // Step 2: Merge overlapping windows
  const windows = mergeOverlappingWindows(rawWindows);

  console.log(
    `[log-fetcher] Querying ${windows.length} time windows for ${service} (from ${errorTimestamps.length} error timestamps)`,
  );

  // Step 3: Query each window and collect results
  const allEntries: NormalizedLogEntry[] = [];
  let skippedCount = 0;

  for (const window of windows) {
    // Stop early if we've already hit the cap
    if (allEntries.length >= maxEntries) {
      console.log(
        `[log-fetcher] Reached maxEntries cap (${maxEntries}). Skipping remaining windows.`,
      );
      break;
    }

    try {
      const searchParams: LogSearchParams = {
        serviceName: service,
        startTime: window.start.toISOString(),
        endTime: window.end.toISOString(),
        searchTerm: 'error',
        pageSize: DEFAULT_PAGE_SIZE,
      };

      const response = await client.searchApplicationLogs(searchParams);

      // Step 4: Normalize each entry
      for (const rawEntry of response.entries) {
        if (allEntries.length >= maxEntries) break;

        const normalized = normalizeLogEntry(rawEntry, service);
        if (normalized) {
          allEntries.push(normalized);
        } else {
          skippedCount++;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[log-fetcher] Failed to fetch logs for window ${window.start.toISOString()} - ${window.end.toISOString()}: ${message}`,
      );
      // Continue with remaining windows
    }
  }

  if (skippedCount > 0) {
    console.warn(
      `[log-fetcher] Skipped ${skippedCount} malformed log entries (missing timestamp or message)`,
    );
  }

  console.log(
    `[log-fetcher] Fetched ${allEntries.length} normalized log entries for ${service}`,
  );

  return {
    service,
    entries: allEntries,
    fetchedAt: new Date(),
  };
}
