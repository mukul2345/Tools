// ============================================================
// Component Interfaces for Proactive Error Analyser
// ============================================================

import type {
  AnalysisConfig,
  ClassifiedError,
  CollectedData,
  CorrelatedErrorGroup,
  DiagnosisReport,
  ErrorCategory,
  LogSnapshot,
  MetricsSnapshot,
  PatternMatchResult,
  RuntimeErrorDetail,
  RuntimeErrorSnapshot,
  TimeRange,
} from './index.js';

// --- Status ---

export type AnalysisStatus =
  | 'idle'
  | 'fetching'
  | 'correlating'
  | 'classifying'
  | 'diagnosing'
  | 'complete'
  | 'error';

// --- Orchestrator ---

export interface IOrchestrator {
  startAnalysis(config: AnalysisConfig): Promise<DiagnosisReport>;
  startAnalysisForService(service: string, config: AnalysisConfig): Promise<DiagnosisReport>;
  getStatus(): AnalysisStatus;
  cancel(): void;
}

// --- Data Fetcher ---

export interface MetricFetchParams {
  namespace: string;
  services: string[];
  timeRange: TimeRange;
  errorThreshold: number;
}

export interface LogFetchParams {
  service: string;
  endpoint: string;
  timeRange: TimeRange;
  maxEntries: number;
  errorTimestamps: Date[];
}

export interface RuntimeErrorFilter {
  definitionName: string;
  subType: string | null;
  stage: string;
  state: string;
  pageSize?: number;
}

export interface IDataFetcher {
  fetchCloudWatchErrors(params: MetricFetchParams): Promise<MetricsSnapshot[]>;
  fetchCloudWatchLatency(params: MetricFetchParams): Promise<MetricsSnapshot[]>;
  fetchRuntimeErrors(): Promise<RuntimeErrorSnapshot>;
  fetchRuntimeErrorDetails(filter: RuntimeErrorFilter): Promise<RuntimeErrorDetail[]>;
  fetchApplicationLogs(params: LogFetchParams): Promise<LogSnapshot>;
}

// --- Correlation ---

export interface ICorrelationEngine {
  correlate(data: CollectedData): CorrelatedErrorGroup[];
}

// --- Classification ---

export interface IErrorPattern {
  name: string;
  category: ErrorCategory;
  priority: number;
  match(group: CorrelatedErrorGroup): PatternMatchResult;
  getSuggestion(group: CorrelatedErrorGroup): string;
}

export interface IErrorClassifier {
  classify(group: CorrelatedErrorGroup): ClassifiedError;
  registerPattern(pattern: IErrorPattern): void;
  getPatterns(): IErrorPattern[];
}

// --- Diagnosis ---

export interface IDiagnosisEngine {
  diagnose(errors: ClassifiedError[], config: AnalysisConfig, startTime: number): DiagnosisReport;
}

// --- Report ---

export interface IReportGenerator {
  generateMarkdown(report: DiagnosisReport): string;
  generateJSON(report: DiagnosisReport): object;
  generateSummary(report: DiagnosisReport): string;
}
