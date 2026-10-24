#!/usr/bin/env npx tsx
/**
 * Live Analysis Script — Two-Phase Approach
 * 
 * Phase 1: Uses the existing cloudwatch-metrics-reports tool to get the error summary
 * Phase 2: Pinpoints exact timestamps (5-min granularity)
 * Phase 3: Fetches error logs at those timestamps from workflow-tools-service
 * Phase 4: Correlates and classifies
 * Phase 5: Generates report
 * 
 * Usage:
 *   npx tsx run-live.ts --days 7 --threshold 10
 *   npx tsx run-live.ts --days 1 --threshold 5 --services document-management-service
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

// Import the existing cloudwatch-metrics-reports modules
// @ts-ignore -- external JS module from cloudwatch-metrics-reports (no type declarations)
import { discoverEndpointsForServices, fetchErrorData } from '../cloudwatch-metrics-reports/src/discovery.mjs';
// @ts-ignore -- external JS module from cloudwatch-metrics-reports (no type declarations)
import { getMetricDataBatched, buildMetricQuery } from '../cloudwatch-metrics-reports/src/cloudwatch.mjs';

// Our modules
import { ErrorClassifier } from './src/classification/error-classifier.js';
import { StatusCodeMismatchPattern } from './src/classification/patterns/status-code-mismatch.js';
import { NullReferencePattern } from './src/classification/patterns/null-reference.js';
import { DDBThrottlingPattern } from './src/classification/patterns/ddb-throttling.js';
import { PathConstructionPattern } from './src/classification/patterns/path-construction.js';
import { TimeoutPattern } from './src/classification/patterns/timeout.js';
import { ValidationErrorPattern } from './src/classification/patterns/validation-error.js';
import { UpstreamDependencyPattern } from './src/classification/patterns/upstream-dependency.js';
import { AuthErrorPattern } from './src/classification/patterns/auth-error.js';
import { DiagnosisEngine } from './src/diagnosis/diagnosis-engine.js';
import { MarkdownReportGenerator } from './src/report/markdown-generator.js';
import { JsonReportGenerator } from './src/report/json-generator.js';

import type { AnalysisConfig, EndpointErrorMetric, NormalizedLogEntry, CorrelatedErrorGroup, DiagnosisReport } from './src/types/index.js';

// ============================================================
// HELPERS
// ============================================================

const FALLBACK_WORKFLOW_TOOLS_URL = 'http://nginx--nlbC3-sn7vKMsxDDMK-3360319dfff3cca3.elb.eu-west-1.amazonaws.com/workflow-tools-service';

function safeISO(date: Date | unknown): string {
  if (!date) return 'unknown';
  if (date instanceof Date && !isNaN(date.getTime())) return date.toISOString();
  return 'unknown';
}

interface LogConfig {
  at: string;
  rt: string;
  baseUrl: string;
}

/** Parse a dotenv-style file into a key→value map (quotes stripped). */
function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* file missing — ignore */
  }
  return out;
}

let _logConfig: LogConfig | null = null;

/**
 * Resolve the workflow-tools-service log auth (AT/RT tokens) and base URL.
 *
 * These prod logs are read through the workflow-tools-service log API. The
 * canonical, maintained source for the tokens + URL is the workflow-mcp-server's
 * `.env` (the same config the MCP server uses), so we read that first.
 *
 * Resolution order (first non-empty wins, per field):
 *   1. Environment variables AT_TOKEN / RT_TOKEN / WORKFLOW_TOOLS_URL
 *   2. $LOG_AUTH_ENV_PATH (an explicit .env path)
 *   3. workflow-mcp-server/.env  (../mcp/workflow-mcp-server/.env) — canonical
 *   4. this tool's own .env       (proactive-error-analyser/.env)
 * baseUrl falls back to the known ELB URL if not found anywhere.
 */
function getLogConfig(): LogConfig {
  if (_logConfig) return _logConfig;

  const localDir = path.dirname(fileURLToPath(import.meta.url));
  let at = process.env.AT_TOKEN?.trim() || '';
  let rt = process.env.RT_TOKEN?.trim() || '';
  let baseUrl = process.env.WORKFLOW_TOOLS_URL?.trim() || '';

  const files = [
    process.env.LOG_AUTH_ENV_PATH,
    path.join(localDir, '../mcp/workflow-mcp-server/.env'),
    path.join(localDir, '.env'),
  ].filter(Boolean) as string[];

  for (const f of files) {
    const env = parseEnvFile(f);
    if (!at && env.AT_TOKEN) at = env.AT_TOKEN;
    if (!rt && env.RT_TOKEN) rt = env.RT_TOKEN;
    if (!baseUrl && env.WORKFLOW_TOOLS_URL) baseUrl = env.WORKFLOW_TOOLS_URL;
    if (at && rt && baseUrl) break;
  }

  _logConfig = { at, rt, baseUrl: baseUrl || FALLBACK_WORKFLOW_TOOLS_URL };
  return _logConfig;
}

/** Fetch logs for a single 10-min window */
async function fetchWindowLogs(
  service: string,
  window: { start: string; end: string },
  searchTerm?: string,
): Promise<NormalizedLogEntry[]> {
  const cfg = getLogConfig();
  const params = new URLSearchParams({
    serviceName: service,
    startTime: window.start,
    endTime: window.end,
    size: '50',
  });
  if (searchTerm) params.set('searchTerm', searchTerm);

  const fullUrl = `${cfg.baseUrl}/application-logs/search?${params.toString()}`;

  const response = await fetch(fullUrl, {
    headers: { 'Cookie': `at=${cfg.at}; rt=${cfg.rt}`, 'Accept': 'application/x-ndjson' },
  });

  if (!response.ok) {
    // Surface the failure loudly — a silent empty result made a broken log API
    // (expired tokens / backend 500) look identical to "no errors in logs".
    const hint =
      response.status === 401 || response.status === 403
        ? ' → auth rejected; refresh AT/RT tokens (see README).'
        : response.status >= 500
          ? ' → log API server error; tokens may be expired or the log backend is down.'
          : '';
    console.warn(`   ⚠️  log API returned HTTP ${response.status} for ${service}${hint}`);
    return [];
  }
  const text = await response.text();
  if (!text || text.length === 0) return [];

  const entries: NormalizedLogEntry[] = [];
  for (const line of text.split('\n').filter(l => l.trim())) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'data' || !parsed.entry) continue;
      const raw = parsed.entry;
      const rawTs = raw.timestamp || raw.date || raw['@timestamp'];
      const ts = rawTs ? new Date(rawTs) : null;
      if (!ts || isNaN(ts.getTime())) continue;

      entries.push({
        timestamp: ts,
        level: (raw.level || 'ERROR').toUpperCase() as 'ERROR',
        message: String(raw.message || raw.msg || ''),
        service,
        endpoint: String(raw.originalUrl || raw.endpoint || ''),
        traceId: raw.traceId ? String(raw.traceId) : (raw.request_id ? String(raw.request_id) : undefined),
        requestId: raw.requestId ? String(raw.requestId) : (raw.request_id ? String(raw.request_id) : undefined),
        statusCode: raw.resStatusCode ? Number(raw.resStatusCode) : (raw.statusCode ? Number(raw.statusCode) : undefined),
        stackTrace: raw.error ? String(raw.error) : (raw.stacktrace ? String(raw.stacktrace) : undefined),
        raw: {
          prevService: raw.prevService || undefined,
          portal: raw.portal || undefined,
          referer: raw.referer || undefined,
          callScopeId: raw.callScopeId || undefined,
          originalUrl: raw.originalUrl || undefined,
          method: raw.method || undefined,
          ecsTaskId: raw.ecsTaskId || undefined,
        },
      });
    } catch { /* skip */ }
  }
  return entries;
}

/**
 * Convert an endpoint template (e.g. "/cv-parser/:id") into a RegExp that
 * matches concrete request URLs (e.g. "/cv-parser/Component@abc?x=y").
 * `:param` segments become `[^/]+`. Returns null if the endpoint is unusable.
 */
function endpointToRegex(endpoint: string): RegExp | null {
  if (!endpoint || endpoint === 'N/A') return null;
  const pathOnly = endpoint.split('?')[0];
  const pattern = pathOnly
    .split('/')
    .map((seg) => {
      if (seg === '') return '';
      if (seg.startsWith(':')) return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  try {
    return new RegExp('^' + pattern + '(?:[/?].*)?$', 'i');
  } catch {
    return null;
  }
}

/**
 * Fetch error logs for a SPECIFIC endpoint, covering the whole error timeline.
 * - Builds 10-min windows around each error timestamp
 * - Only keeps ERROR-level entries
 * - Scopes to the endpoint: an entry with a request URL is kept only if that URL
 *   matches this endpoint; entries without a URL (deep/background errors) are
 *   kept as ambiguous signal. This prevents another endpoint's errors from being
 *   attributed here.
 * - Deduplicates by message, tracks occurrence count
 */
async function fetchLogsForEndpoint(
  service: string,
  endpoint: string,
  errorTimestamps: Date[],
  maxEntries: number = 20,
  logSink?: (entry: NormalizedLogEntry) => void,
): Promise<NormalizedLogEntry[]> {
  const cfg = getLogConfig();
  if (!cfg.at || !cfg.rt) {
    console.warn('   ⚠️  No auth tokens — skipping log fetch');
    return [];
  }

  const endpointRe = endpointToRegex(endpoint);

  // Build 10-min windows from each error timestamp
  const allWindows: Array<{ start: string; end: string }> = [];
  const seen = new Set<string>();
  for (const ts of errorTimestamps) {
    const key = new Date(Math.floor(ts.getTime() / (10 * 60 * 1000)) * (10 * 60 * 1000)).toISOString();
    if (seen.has(key)) continue;
    seen.add(key);
    allWindows.push({
      start: new Date(ts.getTime() - 5 * 60 * 1000).toISOString(),
      end: new Date(ts.getTime() + 5 * 60 * 1000).toISOString(),
    });
  }

  // Query ALL error windows (deduplication handles volume)
  const windowsToQuery = allWindows;
  
  const entries: NormalizedLogEntry[] = [];
  const uniqueMessages = new Set<string>();
  const messageOccurrences = new Map<string, Date[]>();

  for (const window of windowsToQuery) {
    // NOTE: do NOT early-break on the in-memory cap here — we still want to
    // fetch every window so the on-disk log sink captures the full evidence.
    // The `entries` array is separately capped at `maxEntries` inside the loop.
    try {
      // Try with 'error' search term first
      let windowEntries = await fetchWindowLogs(service, window, 'error');
      
      // If nothing found, retry without search term
      if (windowEntries.length === 0) {
        windowEntries = await fetchWindowLogs(service, window);
      }

      for (const entry of windowEntries) {
        if (entry.level !== 'ERROR') continue;

        // Endpoint scoping: if the entry carries a request URL, keep it only when
        // that URL matches THIS endpoint. URL-less deep errors are kept (ambiguous).
        if (endpointRe) {
          const url = entry.endpoint || String((entry.raw as Record<string, unknown>)?.originalUrl || '');
          if (url && !endpointRe.test(url)) continue;
        }

        // Stream the full raw entry to disk (if a sink is provided) BEFORE any
        // in-memory cap. This keeps the complete evidence on disk for future
        // context while memory stays bounded to `maxEntries` deduped entries.
        if (logSink) logSink(entry);

        const msgKey = entry.message.slice(0, 100);

        // Track all occurrences
        if (!messageOccurrences.has(msgKey)) messageOccurrences.set(msgKey, []);
        messageOccurrences.get(msgKey)!.push(entry.timestamp);

        // Only keep first instance of each unique error, capped at maxEntries,
        // for the in-memory set used by classification.
        if (entries.length >= maxEntries) continue;
        if (uniqueMessages.has(msgKey)) continue;
        uniqueMessages.add(msgKey);
        entries.push(entry);
      }
    } catch (err) {
      console.warn(`   ⚠️  Log fetch error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Annotate entries with occurrence info
  for (const entry of entries) {
    const msgKey = entry.message.slice(0, 100);
    const occurrences = messageOccurrences.get(msgKey) || [];
    if (occurrences.length > 1) {
      const otherTimes = occurrences
        .filter(t => t.getTime() !== entry.timestamp.getTime())
        .slice(0, 10)
        .map(t => safeISO(t));
      (entry.raw as Record<string, unknown>).alsoOccurredAt = otherTimes;
      (entry.raw as Record<string, unknown>).totalOccurrences = occurrences.length;
    }
  }

  return entries;
}

// ============================================================
// CONFIG
// ============================================================

const NAMESPACE = 'DFG-Observability';
const ALL_SERVICES = [
  'verification-workflow-engine', 'verification-request', 'document-management-service',
  'core-verification-data-structure-service', 'payment-service', 'verification-initiation-service',
  'migration-service', 'document-generation-service', 'poi-service', 'alert-service', 'narada',
];

function parseArgs() {
  const args = process.argv.slice(2);
  let threshold = 10, services = ALL_SERVICES, days = 7;
  let startDate: Date | null = null, endDate: Date | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold') threshold = parseInt(args[++i], 10);
    if (args[i] === '--services') services = args[++i].split(',').map(s => s.trim());
    if (args[i] === '--days') days = parseInt(args[++i], 10);
    if (args[i] === '--start') startDate = new Date(args[++i]);
    if (args[i] === '--end') endDate = new Date(args[++i]);
  }
  return { threshold, services, days, startDate, endDate };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const { threshold, services, days, startDate, endDate } = parseArgs();
  const now = endDate || new Date();
  const start = startDate || new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startTime = Date.now();

  const label = startDate ? `${start.toISOString().slice(0,10)} to ${now.toISOString().slice(0,10)}` : `${days} days`;

  console.log('🔍 Proactive Error Analyser — LIVE Production Run\n');
  console.log('='.repeat(70));
  console.log(`  Time Range: ${start.toISOString()} → ${now.toISOString()} (${label})`);
  console.log(`  Services: ${services.length} services`);
  console.log(`  Error Threshold: ${threshold}`);
  console.log('='.repeat(70));

  // Warn early if log tokens are missing — Phase 3 (log fetch) will be skipped.
  const _cfg = getLogConfig();
  if (!_cfg.at || !_cfg.rt) {
    console.warn('\n⚠️  No AT/RT tokens found — Phase 3 (log fetch) will be SKIPPED, so issues stay "unclassified".');
    console.warn('   Fix: ensure workflow-mcp-server/.env has AT_TOKEN/RT_TOKEN, or export them (see README).');
  } else {
    console.log(`\n🔑 Log auth loaded — full log fetch + classification enabled (via ${_cfg.baseUrl.replace(/^https?:\/\//, '').slice(0, 40)}...).`);
  }

  // --- Phase 1: Error summary ---
  console.log('\n📡 Phase 1: Fetching error summary...');
  const serviceEndpoints = await discoverEndpointsForServices({ namespace: NAMESPACE, services, metricName: 'API_COUNT' });
  const errorRows = await fetchErrorData({ namespace: NAMESPACE, serviceEndpoints, errorCodes: ['500'], start, end: now, period: 3600, errorThreshold: threshold, filterMode: 'above' });
  
  console.log(`\n   Found ${errorRows.length} endpoints with errors > ${threshold}`);
  for (const row of errorRows.slice(0, 15)) {
    console.log(`   ${String(row.errorCount).padStart(5)} errors | ${row.errorRatio.padStart(7)} | ${row.service} ${row.endpoint}`);
  }
  if (errorRows.length === 0) { console.log('\n🎉 All clear!'); process.exit(0); }

  // --- Phase 2: Pinpoint timestamps ---
  console.log(`\n📍 Phase 2: Pinpointing error timestamps...`);
  const serviceMap = new Map<string, EndpointErrorMetric[]>();

  for (const row of errorRows) {
    if (!serviceMap.has(row.service)) serviceMap.set(row.service, []);
    
    const query = buildMetricQuery({ id: 'p0', namespace: NAMESPACE, metricName: 'API_COUNT', dimensions: [
      { Name: 'serviceName', Value: row.service }, { Name: 'endpoint', Value: row.endpoint },
      { Name: 'statusCode', Value: '500' }, { Name: 'environment', Value: 'production' },
    ], stat: 'Sum', period: 300 });

    const results = await getMetricDataBatched({ queries: [query], start, end: now, period: 300 });
    
    if (results?.[0]?.Values?.length > 0) {
      const timestamps = (results[0].Timestamps || []).map((t: any) => t instanceof Date ? t : new Date(t));
      const values: number[] = results[0].Values || [];
      const errorTs: Date[] = [], errorVals: number[] = [];
      let peak = 0, peakTs = start;
      for (let i = 0; i < values.length; i++) {
        if (values[i] > 0) { errorTs.push(timestamps[i]); errorVals.push(values[i]); if (values[i] > peak) { peak = values[i]; peakTs = timestamps[i]; } }
      }
      if (errorTs.length > 0) {
        serviceMap.get(row.service)!.push({ service: row.service, endpoint: row.endpoint, statusCode: 500, totalCount: row.errorCount, timestamps: errorTs, values: errorVals, peakCount: peak, peakTimestamp: peakTs });
        console.log(`   ${row.service} ${row.endpoint}: ${errorTs.length} periods, peak ${peak} at ${safeISO(peakTs)}`);
      }
    }
  }

  // --- Phase 3: Fetch logs + build correlated groups (one group per endpoint) ---
  // Each group is paired with the logs fetched for THAT specific endpoint, so no
  // endpoint inherits another endpoint's logs.
  //
  // Logs are STREAMED TO DISK (not accumulated in memory) under
  // logs/<runId>/<service>__<endpoint>.log.jsonl as they are fetched. Only a
  // small deduped, capped set is kept in memory for classification. The on-disk
  // logs are retained for future context (they are NOT deleted).
  console.log(`\n📜 Phase 3: Fetching endpoint-scoped error logs...`);
  const correlatedGroups: CorrelatedErrorGroup[] = [];

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs', runId);
  fs.mkdirSync(logsRoot, { recursive: true });
  const logFilesWritten: string[] = [];

  /** Build a sink that appends each fetched raw entry as one JSON line to disk. */
  function makeLogSink(service: string, endpoint: string): (e: NormalizedLogEntry) => void {
    const safe = `${service}__${endpoint}`.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
    const file = path.join(logsRoot, `${safe}.log.jsonl`);
    const stream = fs.createWriteStream(file, { flags: 'a' });
    logFilesWritten.push(file);
    return (e: NormalizedLogEntry) => {
      stream.write(JSON.stringify({
        timestamp: safeISO(e.timestamp),
        level: e.level,
        service: e.service,
        endpoint: e.endpoint,
        statusCode: e.statusCode,
        traceId: e.traceId,
        requestId: e.requestId,
        message: e.message,
        stackTrace: e.stackTrace,
        raw: e.raw,
      }) + '\n');
    };
  }

  for (const metrics of serviceMap.values()) {
    for (const metric of metrics) {
      console.log(`   ${metric.service} ${metric.endpoint}...`);
      const sink = makeLogSink(metric.service, metric.endpoint);
      const logEntries = await fetchLogsForEndpoint(metric.service, metric.endpoint, metric.timestamps, 20, sink);
      console.log(
        logEntries.length > 0
          ? `     → ${logEntries.length} endpoint-scoped error log(s) [full set streamed to disk]`
          : `     → No endpoint-scoped error logs`,
      );

      correlatedGroups.push({
        id: crypto.randomUUID(),
        service: metric.service,
        endpoint: metric.endpoint,
        errorCount: metric.totalCount,
        timeRange: { start, end: now },
        metrics: [metric],
        logEntries,
        runtimeErrors: [],
        anomalies: [],
        correlationConfidence: logEntries.length > 0 ? 'medium' : 'low',
        correlationMethod: logEntries.length > 0 ? ['endpoint_match', 'time_window'] : ['endpoint_match'],
      });
    }
  }

  // --- Phase 4: Classify ---
  console.log('\n📊 Phase 4: Classifying...');
  console.log(`   ${correlatedGroups.length} error groups`);

  const classifier = new ErrorClassifier();
  classifier.registerPattern(StatusCodeMismatchPattern);
  classifier.registerPattern(NullReferencePattern);
  classifier.registerPattern(DDBThrottlingPattern);
  classifier.registerPattern(PathConstructionPattern);
  classifier.registerPattern(TimeoutPattern);
  classifier.registerPattern(ValidationErrorPattern);
  classifier.registerPattern(UpstreamDependencyPattern);
  classifier.registerPattern(AuthErrorPattern);
  const classifiedErrors = correlatedGroups.map(g => classifier.classify(g));

  // --- Phase 5: Report ---
  console.log('\n🩺 Phase 5: Generating report...');
  const config: AnalysisConfig = { timeRange: { start, end: now }, services, namespace: NAMESPACE, errorThreshold: threshold, includeLatencyAnalysis: false, includeAnomalyDetection: false, outputFormat: 'both', maxLogEntries: 500 };
  const report = new DiagnosisEngine().diagnose(classifiedErrors, config, startTime);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outputDir = path.join(__dirname, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  
  const md = new MarkdownReportGenerator().generateMarkdown(report);
  const mdPath = path.join(outputDir, `live-analysis-${ts}.md`);
  fs.writeFileSync(mdPath, md, 'utf-8');
  
  const jsonGen = new JsonReportGenerator();
  const jsonPath = path.join(outputDir, `live-analysis-${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonGen.generateJSON(report), null, 2), 'utf-8');

  // Write a manifest of the retained on-disk logs alongside them, so a future
  // reader (human or the autopilot) can map report issues → raw log files.
  const logsManifestPath = path.join(logsRoot, 'manifest.json');
  fs.writeFileSync(
    logsManifestPath,
    JSON.stringify(
      {
        runId,
        generatedAt: new Date().toISOString(),
        timeRange: { start: safeISO(start), end: safeISO(now) },
        reportMarkdown: mdPath,
        reportJson: jsonPath,
        logFiles: logFilesWritten,
      },
      null,
      2,
    ),
    'utf-8',
  );

  console.log('\n' + '='.repeat(70));
  console.log(`\n✅ ${jsonGen.generateSummary(report)}`);
  console.log(`   Duration: ${report.metadata.duration}ms`);
  console.log(`\n📄 Report: ${mdPath}`);
  console.log(`📄 JSON:   ${jsonPath}`);
  console.log(`📂 Logs:   ${logsRoot} (${logFilesWritten.length} file(s), retained)\n`);

  for (const issue of report.issues.slice(0, 10)) {
    const b = issue.severity === 'critical' ? '🔴' : issue.severity === 'high' ? '🟠' : issue.severity === 'medium' ? '🟡' : '🟢';
    console.log(`${b} [${issue.severity.toUpperCase()}] ${issue.service} \`${issue.endpoint}\` — ${issue.errorCount} errors — ${issue.category}`);
  }

  return { report, mdPath, jsonPath, logsRoot, logsManifestPath, runId };
}

// Exported for reuse by run-autopilot.ts (which chains ticket creation + bugfix).
export type LiveAnalysisResult = {
  report: DiagnosisReport;
  mdPath: string;
  jsonPath: string;
  logsRoot: string;
  logsManifestPath: string;
  runId: string;
};
export { main as runLiveAnalysis };

// Only auto-run when invoked directly (not when imported by the autopilot).
const _invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (_invokedDirectly) {
  main().catch(err => { console.error('❌', err); process.exit(1); });
}
