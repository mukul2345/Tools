# Requirements Document

## Introduction

The Proactive Error Analyser is an automated diagnosis system that correlates error data across CloudWatch metrics, application logs (via S3/Athena), and the workflow runtime engine to identify, classify, and suggest fixes for production issues. It addresses the operational pain point of manually correlating errors across multiple data sources by automating detection, classification, and reporting of API errors — reducing mean-time-to-resolution.

## Glossary

- **CloudWatch Metrics**: AWS CloudWatch custom metrics in the DFG-Observability namespace tracking API_COUNT and API_LATENCY per service/endpoint/statusCode
- **Workflow MCP Server**: Model Context Protocol server providing tools to query runtime errors, execution steps, and application logs
- **Correlated Error Group**: A collection of error signals (metrics, logs, runtime errors) linked by endpoint, trace ID, or time window
- **Error Pattern**: A regex-based rule that matches log messages/stack traces to classify errors into known categories
- **Status Code Mismatch**: An API returning HTTP 500 for what is actually a client/validation error (should be 400)

## Requirements

### Requirement 1: CloudWatch Error Metric Collection

**User Story:** As a platform engineer, I want the system to automatically fetch API error metrics from CloudWatch so that I don't have to manually query each service for 500 errors.

#### Acceptance Criteria

- Given a list of services and a time range (max 7 days), when the system runs, then it retrieves error counts (API_COUNT with statusCode=500) per endpoint per service from the DFG-Observability namespace using batched queries (max 500 per batch)
- Given the CloudWatch API is throttled, when fetching metrics, then the system retries with exponential backoff up to 5 retries with max 30s delay
- Given a time range exceeding 7 days, when the system validates config, then it rejects the request with a clear error message

### Requirement 2: CloudWatch Latency Metric Collection

**User Story:** As a platform engineer, I want latency data fetched alongside error data so that I can identify if high-error endpoints also have latency issues.

#### Acceptance Criteria

- Given endpoints with error counts above the configured threshold, when latency data is fetched, then p90 latency values are retrieved for those endpoints only
- Given no endpoints exceed the error threshold, when the analysis runs, then latency fetching is skipped entirely

### Requirement 3: Workflow MCP Runtime Error Collection

**User Story:** As a platform engineer, I want the system to query workflow runtime errors so that stuck or failing workflows are included in the analysis.

#### Acceptance Criteria

- Given the MCP server is available, when the system runs, then it calls get_runtime_error_counts and retrieves grouped error counts by definition/stage/state
- Given runtime error groups sorted by count, when fetching details, then the system retrieves error details (workflow ID, trace ID, error message, timestamp) for the top N groups
- Given the MCP server is unavailable, when the system attempts to connect, then it logs a warning and continues analysis without workflow data

### Requirement 4: Error Time Range Pinpointing

**User Story:** As a platform engineer, I want the system to identify the exact time windows when errors occurred from CloudWatch metric timestamps so that log searches target the right period and produce conclusive results.

#### Acceptance Criteria

- Given CloudWatch error metrics with per-period timestamps and values, when identifying error windows, then the system extracts the specific time periods where errors > 0 occurred (not the entire analysis range)
- Given an endpoint with errors spread across multiple non-contiguous periods, when pinpointing, then each error period is identified separately with its start/end timestamps
- Given the MCP log search has a maximum 10-minute query window, when constructing log queries, then the system uses the pinpointed error timestamps to create targeted 10-minute search windows centered on the error peaks
- Given an endpoint with errors only in a 5-minute window within a 24-hour analysis range, when searching logs, then only that 5-minute window is queried (not the full 24 hours)

### Requirement 5: Application Log Collection

**User Story:** As a platform engineer, I want the system to fetch relevant application logs for high-error endpoints using pinpointed time ranges so that root cause analysis is conclusive rather than sampling random windows.

#### Acceptance Criteria

- Given a high-error endpoint with pinpointed error timestamps, when searching logs, then the system queries the MCP server's log search using the exact error time windows (not the full analysis range)
- Given the log search API has a 10-minute max window constraint, when an error period exceeds 10 minutes, then the system splits it into multiple sequential 10-minute queries and merges results
- Given log entries with traceId, requestId, and stackTrace fields, when normalizing, then all fields are preserved in the internal NormalizedLogEntry format
- Given malformed log entries missing required fields, when processing, then they are skipped and counted in report metadata
- Given no error logs found in the pinpointed window, when reporting, then the system flags this as "inconclusive — errors detected in metrics but no matching logs found" rather than declaring no issue

### Requirement 6: Endpoint-Based Error Correlation

**User Story:** As a platform engineer, I want errors from different data sources to be correlated by endpoint so that I get a unified view of each failing API.

#### Acceptance Criteria

- Given a CloudWatch error metric for service X endpoint Y, when correlating, then log entries from service X with endpoint Y are grouped together in a CorrelatedErrorGroup
- Given an error metric with no matching log entries, when correlating, then the metric still appears in a correlated group with empty log entries and "low" confidence
- Given N error metrics above threshold, when correlation completes, then at least N correlated groups exist (no signal loss)

### Requirement 7: Trace ID-Based Error Correlation

**User Story:** As a platform engineer, I want errors linked by trace ID so that I can see the full request path across services for a single failing request.

#### Acceptance Criteria

- Given a log entry with traceId T and a runtime error with traceId T, when correlating, then both are placed in the same correlated group
- Given a correlated group with at least one trace ID match between logs and runtime errors, when assigning confidence, then the group receives "high" correlation confidence
- Given entries with undefined traceId, when correlating by trace, then those entries are excluded from trace-based matching

### Requirement 8: Time Window-Based Error Correlation

**User Story:** As a platform engineer, I want errors correlated by time proximity when trace IDs are unavailable so that temporally related errors are still grouped.

#### Acceptance Criteria

- Given a CloudWatch error spike at time T and log entries within ±5 minutes of T, when correlating, then those log entries are associated with the metric
- Given correlation by time window only (no trace ID match), when assigning confidence, then the group receives "medium" correlation confidence

### Requirement 9: Status Code Mismatch Pattern Detection

**User Story:** As a platform engineer, I want the system to detect APIs returning 500 for validation errors so that I can fix them to return proper 400 responses.

#### Acceptance Criteria

- Given a correlated group with 500 status code and log messages containing "not satisfied", "validation failed", "invalid", "not found", "already exists", "missing required", or "bad request", when classifying, then the category is "status_code_mismatch"
- Given the classification confidence is proportional to matching_logs / total_logs, when confidence is below 0.6, then the pattern does not match

### Requirement 10: Null Reference Pattern Detection

**User Story:** As a platform engineer, I want the system to detect null reference errors so that I can identify missing null checks in the codebase.

#### Acceptance Criteria

- Given a correlated group with log messages containing "Cannot read property of null", "TypeError: X is not a function", or "Cannot destructure property", when classifying, then the category is "null_reference"
- Given the pattern matches, when generating suggestions, then the fix identifies the specific property/method that was null

### Requirement 11: DynamoDB Throttling Pattern Detection

**User Story:** As a platform engineer, I want the system to detect DynamoDB throttling so that I can proactively scale table capacity before it impacts users.

#### Acceptance Criteria

- Given a correlated group with log messages containing "ProvisionedThroughputExceededException", "throttled", or "Rate exceeded", when classifying, then the category is "ddb_throttling"
- Given the pattern matches, when generating suggestions, then the fix recommends reviewing table capacity or implementing backoff

### Requirement 12: Path Construction Pattern Detection

**User Story:** As a platform engineer, I want the system to detect file/URL path construction bugs so that broken file operations are identified quickly.

#### Acceptance Criteria

- Given a correlated group with log messages containing "ENOENT", "No such file or directory", or double-prefixed paths, when classifying, then the category is "path_construction"
- Given the pattern matches, when generating suggestions, then the fix identifies the malformed path pattern from the evidence

### Requirement 13: Timeout Pattern Detection

**User Story:** As a platform engineer, I want the system to detect timeout and connection errors so that I can identify infrastructure or downstream service issues.

#### Acceptance Criteria

- Given a correlated group with log messages containing "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", or "socket hang up", when classifying, then the category is "timeout"
- Given the pattern matches, when generating suggestions, then the fix recommends checking downstream service health or increasing timeout values

### Requirement 14: Exhaustive Classification

**User Story:** As a platform engineer, I want every error group to receive a classification so that no errors are silently ignored in the report.

#### Acceptance Criteria

- Given a correlated group that matches no known patterns, when classifying, then the category is "unclassified" with confidence 0
- Given a correlated group that matches multiple patterns, when classifying, then the highest-priority pattern wins
- Given N correlated groups as input, when classification completes, then exactly N ClassifiedError objects are produced

### Requirement 15: Extensible Pattern Registry

**User Story:** As a platform engineer, I want to add new error patterns without modifying existing code so that the system can evolve as new error types emerge.

#### Acceptance Criteria

- Given a new pattern definition (name, category, priority, match function, suggestion function), when registered via registerPattern(), then it is applied during subsequent classifications
- Given the pattern registry, when listing patterns via getPatterns(), then all built-in and custom patterns are returned

### Requirement 16: Severity Computation

**User Story:** As a platform engineer, I want errors prioritized by severity so that I can focus on the most impactful issues first.

#### Acceptance Criteria

- Given an error group with >100 errors or infrastructure category with anomaly, when computing severity, then the result is "critical"
- Given an error group with >50 errors or category "ddb_throttling", when computing severity, then the result is "high"
- Given an error group with >10 errors, when computing severity, then the result is "medium"
- Given an error group with ≤10 errors and no special category, when computing severity, then the result is "low"
- Given two groups with the same category where group A has more errors than group B, when computing severity, then severity(A) ≥ severity(B)

### Requirement 17: Root Cause and Fix Suggestions

**User Story:** As a platform engineer, I want actionable fix suggestions for each error so that I can resolve issues without extensive manual investigation.

#### Acceptance Criteria

- Given a "status_code_mismatch" classification, when generating diagnosis, then the suggestion recommends adding an error mapper or setting the correct error code on the thrown exception
- Given a "ddb_throttling" classification, when generating diagnosis, then the suggestion recommends reviewing table capacity or implementing backoff
- Given an "unclassified" error, when generating diagnosis, then the suggestion is "Manual investigation required"
- Given a classified error with confidence > 0, when generating the report, then at least one evidence item (log line, metric value, or workflow ID) is included

### Requirement 18: Markdown Report Generation

**User Story:** As a platform engineer, I want a readable Markdown report so that I can share findings with the team and paste into Confluence or Slack.

#### Acceptance Criteria

- Given a completed analysis with N issues, when generating Markdown, then the report includes a summary table (total errors, issues by severity, top categories, plus a per-service breakdown) followed by detailed sections **grouped by service**, and within each service the issues are ordered by severity descending with their error category shown as a tag
- Given the report output, when viewing in a Markdown renderer, then tables, code blocks, and headers render correctly
- Given analysis metadata, when generating the report, then it includes analysisId, duration in ms, data sources queried, and any errors encountered

### Requirement 19: JSON Report Generation

**User Story:** As a platform engineer, I want a machine-readable JSON report so that downstream tools (Jira, dashboards) can consume the analysis results programmatically.

#### Acceptance Criteria

- Given a completed analysis, when generating JSON, then the output includes all fields: id, generatedAt, timeRange, services, summary, issues, metadata
- Given the JSON output, when parsed by a consumer, then all fields are correctly typed per the DiagnosisReport interface

### Requirement 20: CLI Execution Mode

**User Story:** As a platform engineer, I want to run the analyser on-demand from the command line so that I can investigate errors immediately when alerted.

#### Acceptance Criteria

- Given the command `npx proactive-error-analyser --services verification-request --last 24h --threshold 5`, when executed, then the analysis runs for the specified parameters and outputs the report
- Given the `--help` flag, when executed, then usage documentation with all available options is printed
- Given `--output markdown` or `--output json` or `--output both`, when executed, then the report is generated in the specified format(s)

### Requirement 21: Scheduled Execution Mode

**User Story:** As a platform engineer, I want the analyser to run on a schedule so that errors are detected proactively without manual intervention.

#### Acceptance Criteria

- Given a cron schedule (e.g., every 6 hours), when the trigger fires, then the analysis runs with default configuration (all services, last 6h, threshold 10)
- Given a scheduled run completes, when the report is generated, then it is written to the configured output directory with a timestamped filename

### Requirement 22: Graceful Degradation on Data Source Failure

**User Story:** As a platform engineer, I want the system to produce partial results when a data source is unavailable so that I still get value from the available data.

#### Acceptance Criteria

- Given CloudWatch is unavailable but MCP and logs are available, when the analysis runs, then a report is generated using only MCP and log data with metadata noting the gap
- Given all data sources fail, when the analysis runs, then an error report is generated explaining that no data could be collected
- Given malformed data from any source, when processing, then the system does not crash — it skips bad entries and continues

### Requirement 23: Configuration Validation

**User Story:** As a platform engineer, I want invalid configurations rejected upfront so that I don't waste time on a run that will fail partway through.

#### Acceptance Criteria

- Given a time range where end is before start, when validating, then a clear error is thrown before any data fetching begins
- Given an empty services array, when validating, then a clear error is thrown
- Given an error threshold of 0 or negative, when validating, then a clear error is thrown
- Given a time range exceeding 7 days, when validating, then a clear error is thrown

### Requirement 24: Jira Ticket Creation (Phase 2)

**User Story:** As a platform engineer, I want confirmed issues to automatically create Jira tickets so that they enter the team's workflow without manual ticket creation.

#### Acceptance Criteria

- Given a diagnosed issue with severity "critical" or "high" and Jira integration enabled, when creating tickets, then a bug ticket is created with the issue title, description, root cause, and suggested fix
- Given an issue that was already reported in a previous run (same service + endpoint + category within 7 days), when creating tickets, then the existing ticket is updated rather than creating a duplicate
- Given Jira integration is disabled, when the analysis completes, then no tickets are created

### Requirement 25: Service-Grouped Reporting

**User Story:** As a platform engineer, I want the report organised primarily by service — with each issue tagged by its error category rather than grouped under it — so that I can see every problem for a given service in one place and route it to the owning team.

#### Acceptance Criteria

- Given a completed analysis spanning multiple services, when generating any report (Markdown or JSON), then diagnosed issues are grouped primarily by service, and within each service group ordered by severity descending
- Given an issue rendered inside a service group, when displayed, then its error category (e.g., `status_code_mismatch`, `ddb_throttling`) is shown as a tag/label on the issue — categorisation is retained as metadata, not used as the top-level grouping
- Given a service group header, when rendered, then it shows a per-service rollup: total errors, issue count, a breakdown by severity, and the categories present in that service
- Given the report summary, when generated, then it includes a per-service breakdown (service, total errors, issue count, counts by severity) in addition to the existing overall severity and top-category totals
- Given a service that has no issues above the threshold, when generating the grouped sections, then that service is omitted from the detailed sections (optionally noted as "no issues above threshold" in the per-service summary)
- Given the JSON report, when generated, then it exposes both the flat `issues` array (each item carrying `service` and `category`) and a `serviceGroups` structure so downstream tools can consume either shape without data loss
