# Implementation Plan: Proactive Error Analyser

## Overview

Implement an automated diagnosis system in TypeScript that correlates error data across CloudWatch metrics, application logs (S3/Athena), and the workflow runtime engine. The system identifies, classifies, and suggests fixes for production issues, outputting actionable Markdown and JSON reports. Implementation uses existing dependencies (AWS SDK, Workflow MCP, fast-check, vitest, commander) and follows the pipeline architecture: Fetch → Correlate → Classify → Diagnose → Report.

## Tasks

- [ ] 1. Set up project structure and core types
  - [ ] 1.1 Create project directory structure and configuration files
    - Create `proactive-error-analyser/` directory with `src/`, `src/types/`, `src/fetchers/`, `src/correlation/`, `src/classification/`, `src/diagnosis/`, `src/report/`, `src/cli/`, `src/config/`, `tests/` directories
    - Create `package.json` with dependencies: `@aws-sdk/client-cloudwatch`, `commander`, `chalk`, `uuid`
    - Create `tsconfig.json` with strict mode enabled
    - Create `vitest.config.ts` for test runner configuration
    - _Requirements: 19.1, 22.1_

  - [ ] 1.2 Define all core TypeScript interfaces and types
    - Create `src/types/index.ts` with all interfaces: `AnalysisConfig`, `TimeRange`, `MetricsSnapshot`, `EndpointErrorMetric`, `EndpointLatencyMetric`, `RuntimeErrorSnapshot`, `RuntimeErrorGroup`, `RuntimeErrorDetail`, `LogSnapshot`, `NormalizedLogEntry`, `AnomalySnapshot`, `AnomalyResult`, `CorrelatedErrorGroup`, `CorrelationMethod`, `ErrorCategory`, `ClassifiedError`, `DiagnosisReport`, `ReportSummary`, `DiagnosedIssue`, `EvidenceItem`, `ReportMetadata`, `IErrorPattern`, `PatternMatchResult`
    - Create `src/types/interfaces.ts` with component interfaces: `IOrchestrator`, `IDataFetcher`, `ICorrelationEngine`, `IErrorClassifier`, `IDiagnosisEngine`, `IReportGenerator`
    - _Requirements: 5.1, 13.1, 18.1_

  - [ ] 1.3 Implement configuration validation module
    - Create `src/config/validator.ts` with `validateConfig(config: AnalysisConfig): void` function
    - Validate: end > start, timeRange ≤ 7 days, services array non-empty, errorThreshold ≥ 1
    - Throw descriptive errors for each validation failure
    - _Requirements: 22.1, 22.2, 22.3, 22.4_

  - [ ]* 1.4 Write unit tests for configuration validation
    - Test valid config passes validation
    - Test end-before-start rejection, empty services rejection, zero/negative threshold rejection, >7 day range rejection
    - _Requirements: 22.1, 22.2, 22.3, 22.4_

- [ ] 2. Implement Data Fetcher layer
  - [ ] 2.1 Implement CloudWatch error metrics fetcher
    - Create `src/fetchers/cloudwatch-fetcher.ts`
    - Implement `fetchCloudWatchErrors(params)` that queries DFG-Observability namespace for API_COUNT with statusCode=500
    - Implement batched queries (max 500 per batch) with exponential backoff retry (up to 5 retries, max 30s delay)
    - Return normalized `MetricsSnapshot` with `EndpointErrorMetric[]`
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ] 2.2 Implement CloudWatch latency metrics fetcher
    - Add `fetchCloudWatchLatency(params)` to cloudwatch-fetcher
    - Only fetch p90 latency for endpoints exceeding the error threshold
    - Skip latency fetching entirely if no endpoints exceed threshold
    - _Requirements: 2.1, 2.2_

  - [ ] 2.3 Implement Workflow MCP runtime error fetcher
    - Create `src/fetchers/workflow-mcp-fetcher.ts`
    - Implement `fetchRuntimeErrors()` calling `get_runtime_error_counts` tool
    - Implement `fetchRuntimeErrorDetails(filter)` calling `get_runtime_error_details` for top N error groups
    - Handle MCP server unavailability: log warning, return empty snapshot
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 2.4 Implement application log fetcher
    - Create `src/fetchers/log-fetcher.ts`
    - Implement `fetchApplicationLogs(params)` using MCP server's `search_application_logs` tool
    - Normalize log entries into `NormalizedLogEntry` format preserving traceId, requestId, stackTrace
    - Skip malformed entries missing required fields, count skipped entries
    - Cap entries at `maxLogEntries` per endpoint
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ] 2.5 Implement DataFetcher facade with graceful degradation
    - Create `src/fetchers/data-fetcher.ts` implementing `IDataFetcher` interface
    - Orchestrate parallel fetching using `Promise.allSettled`
    - On individual source failure: log warning, continue with available data, record failure in metadata
    - _Requirements: 21.1, 21.2, 21.3_

  - [ ]* 2.6 Write unit tests for DataFetcher layer
    - Mock CloudWatch SDK, MCP tools, and log service
    - Test retry logic with simulated throttling
    - Test graceful degradation when individual sources fail
    - Test batching respects 500-query limit
    - _Requirements: 1.2, 3.3, 21.1, 21.2_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Correlation Engine
  - [ ] 4.1 Implement endpoint-based correlation
    - Create `src/correlation/correlation-engine.ts` implementing `ICorrelationEngine`
    - Implement `correlateByEndpoint()`: match CloudWatch metrics to log entries by service + endpoint
    - Create `CorrelatedErrorGroup` for each metric, even if no matching logs (with "low" confidence)
    - Ensure no signal loss: every metric above threshold appears in at least one group
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ] 4.2 Implement trace ID-based correlation
    - Add `correlateByTraceId()` function: link log entries and runtime errors sharing the same traceId
    - Assign "high" confidence when trace ID match exists between logs and runtime errors
    - Exclude entries with undefined traceId from trace-based matching
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ] 4.3 Implement time window-based correlation
    - Add `correlateByTimeWindow()` function: associate log entries within ±5 minutes of a CloudWatch error spike
    - Assign "medium" confidence for time-window-only correlations
    - _Requirements: 7.1, 7.2_

  - [ ] 4.4 Implement combined correlation with orphan handling
    - Wire all correlation methods together in `correlate(data: CollectedData)` method
    - Handle orphaned runtime errors not matched by endpoint or trace (create separate groups)
    - Ensure each signal appears in at most one group (no duplicates)
    - _Requirements: 5.3, 6.1, 7.1_

  - [ ]* 4.5 Write property test for No Signal Loss
    - **Property 1: No Signal Loss**
    - **Validates: Requirements 5.3**
    - Generate arbitrary MetricsSnapshot with errorMetrics above threshold, verify all appear in correlation output

  - [ ]* 4.6 Write property test for Correlation Soundness
    - **Property 4: Correlation Soundness**
    - **Validates: Requirements 6.2**
    - Generate arbitrary CorrelatedErrorGroups, verify "high" confidence groups always have at least one trace_id match

- [ ] 5. Implement Error Classifier
  - [ ] 5.1 Implement pattern registry and classifier framework
    - Create `src/classification/error-classifier.ts` implementing `IErrorClassifier`
    - Implement `registerPattern(pattern)` and `getPatterns()` methods
    - Implement `classify(group)`: apply patterns in priority order, return best match or "unclassified"
    - Ensure confidence threshold of 0.6 for pattern match acceptance
    - _Requirements: 13.1, 13.2, 13.3, 14.1, 14.2_

  - [ ] 5.2 Implement Status Code Mismatch pattern
    - Create `src/classification/patterns/status-code-mismatch.ts`
    - Match 500 status codes with log messages containing: "not satisfied", "validation failed", "invalid", "not found", "already exists", "missing required", "bad request"
    - Confidence = matching_logs / total_logs; reject if < 0.6
    - _Requirements: 8.1, 8.2_

  - [ ] 5.3 Implement Null Reference pattern
    - Create `src/classification/patterns/null-reference.ts`
    - Match: "Cannot read property of null", "TypeError: X is not a function", "Cannot destructure property"
    - Generate suggestion identifying the specific property/method that was null
    - _Requirements: 9.1, 9.2_

  - [ ] 5.4 Implement DynamoDB Throttling pattern
    - Create `src/classification/patterns/ddb-throttling.ts`
    - Match: "ProvisionedThroughputExceededException", "throttled", "Rate exceeded"
    - Suggest reviewing table capacity or implementing backoff
    - _Requirements: 10.1, 10.2_

  - [ ] 5.5 Implement Path Construction pattern
    - Create `src/classification/patterns/path-construction.ts`
    - Match: "ENOENT", "No such file or directory", double-prefixed paths
    - Identify the malformed path pattern from evidence
    - _Requirements: 11.1, 11.2_

  - [ ] 5.6 Implement Timeout pattern
    - Create `src/classification/patterns/timeout.ts`
    - Match: "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "socket hang up"
    - Suggest checking downstream service health or increasing timeout values
    - _Requirements: 12.1, 12.2_

  - [ ] 5.7 Implement severity computation
    - Create `src/classification/severity.ts` with `computeSeverity(group, category)` function
    - Critical: >100 errors OR infrastructure category with anomaly
    - High: >50 errors OR ddb_throttling category
    - Medium: >10 errors
    - Low: ≤10 errors and no special category
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [ ]* 5.8 Write property test for No Duplicate Classification
    - **Property 2: No Duplicate Classification**
    - **Validates: Requirements 13.3**
    - Generate N arbitrary CorrelatedErrorGroups, verify classify() produces exactly N ClassifiedError outputs

  - [ ]* 5.9 Write property test for Monotonic Severity
    - **Property 3: Monotonic Severity**
    - **Validates: Requirements 15.5**
    - Generate pairs of groups with same category but different errorCounts, verify higher count → higher or equal severity

  - [ ]* 5.10 Write property test for Pattern Exhaustiveness
    - **Property 5: Pattern Exhaustiveness**
    - **Validates: Requirements 13.1**
    - Generate arbitrary CorrelatedErrorGroups, verify classify() never returns null/undefined

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement Diagnosis Engine and Report Generator
  - [ ] 7.1 Implement Diagnosis Engine
    - Create `src/diagnosis/diagnosis-engine.ts` implementing `IDiagnosisEngine`
    - Generate `DiagnosedIssue` for each `ClassifiedError` with title, description, rootCause, suggestedFix (each issue carries `service` and `category`)
    - Include evidence items (log lines, metric values, workflow IDs) for confidence > 0
    - Generate "Manual investigation required" for unclassified errors
    - Compute report summary: totalErrorsAnalyzed, issuesFound, counts by severity, topCategories, and per-service breakdown (`ServiceSummary[]`)
    - Build `serviceGroups: ServiceIssueGroup[]` — bucket issues by service, order each group by severity descending, keeping category as a tag on each issue
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 25.1, 25.3, 25.4_

  - [ ] 7.2 Implement Markdown report generator
    - Create `src/report/markdown-generator.ts`
    - Generate summary table (total errors, issues by severity, top categories)
    - Generate detailed sections per issue with code blocks, tables, and headers
    - Include analysisId, duration, data sources queried, errors encountered in metadata section
    - _Requirements: 17.1, 17.2, 17.3_

  - [ ] 7.3 Implement JSON report generator
    - Create `src/report/json-generator.ts`
    - Output all fields: id, generatedAt, timeRange, services, summary, issues, metadata
    - Ensure all fields are correctly typed per the DiagnosisReport interface
    - _Requirements: 18.1, 18.2_

  - [ ]* 7.4 Write property test for Evidence Traceability
    - **Property 6: Evidence Traceability**
    - **Validates: Requirements 16.4**
    - Generate arbitrary ClassifiedErrors with confidence > 0, verify evidence array is non-empty

  - [ ]* 7.5 Write unit tests for report generators
    - Test Markdown output renders correctly (tables, code blocks, headers)
    - Test JSON output matches DiagnosisReport interface structure
    - Test empty, single-issue, and multi-issue report generation
    - _Requirements: 17.1, 17.2, 18.1, 18.2_

- [ ] 8. Implement Orchestrator
  - [ ] 8.1 Implement main Orchestrator
    - Create `src/orchestrator.ts` implementing `IOrchestrator`
    - Implement `startAnalysis(config)`: validate config → fetch data → correlate → classify → diagnose → report
    - Implement parallel data fetching with `Promise.allSettled`
    - Handle partial failures: continue with available data, record failures in metadata
    - Implement `identifyHotEndpoints()`: filter endpoints above threshold, sort by totalCount descending, deduplicate
    - _Requirements: 21.1, 21.2, 21.3_

  - [ ] 8.2 Implement graceful degradation logic
    - If CloudWatch unavailable: generate report from MCP + logs only, note gap in metadata
    - If all sources fail: generate error report explaining no data collected
    - Skip malformed data entries without crashing, continue processing
    - _Requirements: 21.1, 21.2, 21.3_

  - [ ]* 8.3 Write property test for Graceful Degradation
    - **Property 8: Graceful Degradation**
    - **Validates: Requirements 21.1, 21.2**
    - Simulate arbitrary combinations of source failures, verify a valid DiagnosisReport is always produced

  - [ ]* 8.4 Write property test for Idempotency
    - **Property 7: Idempotency**
    - **Validates: Requirements 17.1, 18.1**
    - Run analysis twice with identical config and mocked data, verify report outputs are identical (excluding metadata timestamps)

- [ ] 9. Implement CLI interface
  - [ ] 9.1 Implement CLI entry point with commander
    - Create `src/cli/index.ts` as the CLI entry point
    - Parse arguments: `--services`, `--last` (time range shorthand), `--threshold`, `--output` (markdown/json/both), `--help`
    - Convert CLI args to `AnalysisConfig` and invoke orchestrator
    - Print report to stdout or write to file based on output format
    - _Requirements: 19.1, 19.2, 19.3_

  - [ ] 9.2 Implement scheduled execution support
    - Create `src/cli/scheduler.ts` for cron-based execution
    - On trigger: run analysis with default config (all services, last 6h, threshold 10)
    - Write report to configured output directory with timestamped filename
    - _Requirements: 20.1, 20.2_

  - [ ]* 9.3 Write unit tests for CLI argument parsing
    - Test `--services`, `--last`, `--threshold`, `--output`, `--help` flags
    - Test default values when flags are omitted
    - _Requirements: 19.1, 19.2, 19.3_

- [ ] 10. Integration wiring and final validation
  - [ ] 10.1 Wire all components together in main entry point
    - Create `src/index.ts` exporting `ProactiveErrorAnalyser` class
    - Register all built-in patterns in the classifier
    - Wire DataFetcher → CorrelationEngine → ErrorClassifier → DiagnosisEngine → ReportGenerator
    - Export public API for programmatic usage
    - _Requirements: 14.1, 14.2_

  - [ ]* 10.2 Write integration tests for end-to-end pipeline
    - Test full pipeline with mocked data sources returning realistic error data
    - Verify report contains expected classified issues
    - Test graceful degradation end-to-end with simulated source failures
    - _Requirements: 5.1, 13.3, 21.1_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All external data sources (CloudWatch, MCP, S3) should be mocked in tests
- The implementation uses TypeScript as specified in the design document
- Phase 2 (Jira integration, Requirement 23) is excluded from this implementation plan

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.2", "2.5", "2.6"] },
    { "id": 4, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 5, "tasks": ["4.4", "4.5", "4.6"] },
    { "id": 6, "tasks": ["5.1"] },
    { "id": 7, "tasks": ["5.2", "5.3", "5.4", "5.5", "5.6", "5.7"] },
    { "id": 8, "tasks": ["5.8", "5.9", "5.10"] },
    { "id": 9, "tasks": ["7.1"] },
    { "id": 10, "tasks": ["7.2", "7.3", "7.4", "7.5"] },
    { "id": 11, "tasks": ["8.1"] },
    { "id": 12, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 13, "tasks": ["9.1", "9.2"] },
    { "id": 14, "tasks": ["9.3", "10.1"] },
    { "id": 15, "tasks": ["10.2"] }
  ]
}
```
