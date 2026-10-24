// ============================================================
// Core Types for Proactive Error Analyser
// ============================================================

// --- Configuration ---

export interface AnalysisConfig {
  timeRange: TimeRange;
  services: string[];
  namespace: string;
  errorThreshold: number;
  includeLatencyAnalysis: boolean;
  includeAnomalyDetection: boolean;
  outputFormat: 'markdown' | 'json' | 'both';
  maxLogEntries: number;
}

export interface TimeRange {
  start: Date;
  end: Date;
}

// --- Metrics ---

export interface MetricsSnapshot {
  service: string;
  timeRange: TimeRange;
  errorMetrics: EndpointErrorMetric[];
  latencyMetrics: EndpointLatencyMetric[];
  fetchedAt: Date;
}

export interface EndpointErrorMetric {
  service: string;
  endpoint: string;
  statusCode: number;
  totalCount: number;
  timestamps: Date[];
  values: number[];
  peakCount: number;
  peakTimestamp: Date;
}

export interface EndpointLatencyMetric {
  service: string;
  endpoint: string;
  p90Ms: number;
  p99Ms: number;
  avgMs: number;
  maxMs: number;
}

// --- Runtime Errors ---

export interface RuntimeErrorSnapshot {
  errors: RuntimeErrorGroup[];
  fetchedAt: Date;
}

export interface RuntimeErrorGroup {
  definitionName: string;
  subType: string | null;
  stage: string;
  state: string;
  count: number;
  details?: RuntimeErrorDetail[];
}

export interface RuntimeErrorDetail {
  workflowId: string;
  traceId?: string;
  errorMessage: string;
  timestamp: Date;
  stage: string;
  state: string;
}

// --- Logs ---

export interface LogSnapshot {
  service: string;
  entries: NormalizedLogEntry[];
  fetchedAt: Date;
}

export interface NormalizedLogEntry {
  timestamp: Date;
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  message: string;
  traceId?: string;
  requestId?: string;
  service: string;
  endpoint?: string;
  statusCode?: number;
  errorType?: string;
  stackTrace?: string;
  raw: Record<string, unknown>;
}

// --- Anomaly ---

export interface AnomalySnapshot {
  anomalies: AnomalyResult[];
  fetchedAt: Date;
}

export interface AnomalyResult {
  metricName: string;
  service: string;
  endpoint?: string;
  currentValue: number;
  baselineMedian: number;
  pctChange: number;
  zScore: number;
  isAnomaly: boolean;
}

// --- Correlation ---

export interface CorrelatedErrorGroup {
  id: string;
  service: string;
  endpoint: string;
  errorCount: number;
  timeRange: TimeRange;
  metrics: EndpointErrorMetric[];
  logEntries: NormalizedLogEntry[];
  runtimeErrors: RuntimeErrorDetail[];
  anomalies: AnomalyResult[];
  correlationConfidence: 'high' | 'medium' | 'low';
  correlationMethod: CorrelationMethod[];
}

export type CorrelationMethod = 'endpoint_match' | 'trace_id' | 'time_window' | 'error_message';

// --- Classification ---

export type ErrorCategory =
  | 'status_code_mismatch'
  | 'null_reference'
  | 'ddb_throttling'
  | 'path_construction'
  | 'timeout'
  | 'validation_error'
  | 'upstream_dependency'
  | 'data_integrity'
  | 'infrastructure'
  | 'configuration'
  | 'unclassified';

export interface PatternMatchResult {
  matched: boolean;
  confidence: number;
  evidence: string[];
}

export interface ClassifiedError {
  group: CorrelatedErrorGroup;
  category: ErrorCategory;
  severity: 'critical' | 'high' | 'medium' | 'low';
  pattern: string;
  confidence: number;
  suggestion: string;
  evidence: string[];
}

// --- Diagnosis ---

export interface DiagnosisReport {
  id: string;
  generatedAt: Date;
  timeRange: TimeRange;
  services: string[];
  summary: ReportSummary;
  issues: DiagnosedIssue[];
  /** Primary grouping for rendering: issues bucketed by service. */
  serviceGroups: ServiceIssueGroup[];
  metadata: ReportMetadata;
}

export interface ReportSummary {
  totalErrorsAnalyzed: number;
  issuesFound: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  topCategories: { category: ErrorCategory; count: number }[];
  /** Per-service rollup (see Requirement 25). */
  byService: ServiceSummary[];
}

/** All diagnosed issues for a single service (primary report grouping). */
export interface ServiceIssueGroup {
  service: string;
  errorCount: number;
  issueCount: number;
  severityCounts: { critical: number; high: number; medium: number; low: number };
  /** Distinct error categories present, kept as tags on the issues. */
  categories: ErrorCategory[];
  /** Issues ordered by severity descending. */
  issues: DiagnosedIssue[];
}

/** Compact per-service line for the summary table. */
export interface ServiceSummary {
  service: string;
  errorCount: number;
  issueCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

export interface DiagnosedIssue {
  id: string;
  title: string;
  category: ErrorCategory;
  severity: 'critical' | 'high' | 'medium' | 'low';
  service: string;
  endpoint: string;
  errorCount: number;
  description: string;
  rootCause: string;
  suggestedFix: string;
  evidence: EvidenceItem[];
  cloudWatchLink?: string;
  relatedWorkflowIds?: string[];
}

export interface EvidenceItem {
  source: 'cloudwatch' | 'logs' | 'workflow_mcp' | 'anomaly';
  description: string;
  data: string;
  timestamp?: Date;
}

export interface ReportMetadata {
  analysisId: string;
  duration: number;
  dataSourcesQueried: string[];
  errorsEncountered: string[];
}

// --- Internal Types ---

export interface HotEndpoint {
  service: string;
  endpoint: string;
  errorCount: number;
  errorTimestamps: Date[];
}

export interface CollectedData {
  metrics: MetricsSnapshot[];
  runtimeErrors: RuntimeErrorSnapshot;
  logs: LogSnapshot[];
  anomalies?: AnomalySnapshot;
}
