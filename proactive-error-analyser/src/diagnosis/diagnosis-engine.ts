/**
 * Diagnosis Engine
 *
 * Transforms classified errors into a structured DiagnosisReport with
 * diagnosed issues, summary statistics, and metadata.
 */

import { randomUUID } from 'crypto';

import type {
  AnalysisConfig,
  ClassifiedError,
  DiagnosedIssue,
  DiagnosisReport,
  ErrorCategory,
  EvidenceItem,
  ReportMetadata,
  ReportSummary,
  ServiceIssueGroup,
  ServiceSummary,
} from '../types/index.js';

const SEVERITY_RANK: Record<DiagnosedIssue['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
import type { IDiagnosisEngine } from '../types/interfaces.js';

// --- Diagnosis Engine ---

export class DiagnosisEngine implements IDiagnosisEngine {
  diagnose(errors: ClassifiedError[], config: AnalysisConfig, startTime: number): DiagnosisReport {
    const issues: DiagnosedIssue[] = [];
    for (const error of errors) {
      try {
        issues.push(this.buildIssue(error));
      } catch (err) {
        // Never crash the whole report because of one bad issue
        console.warn(`[diagnosis-engine] Failed to build issue for ${error.group.service}/${error.group.endpoint}: ${err instanceof Error ? err.message : err}`);
        issues.push({
          id: randomUUID(),
          title: `[ERROR] Failed to diagnose — ${error.group.service} \`${error.group.endpoint || 'unknown'}\``,
          category: error.category,
          severity: error.severity,
          service: error.group.service,
          endpoint: error.group.endpoint,
          errorCount: error.group.errorCount,
          description: `${error.group.errorCount} errors detected. Diagnosis failed due to: ${err instanceof Error ? err.message : String(err)}`,
          rootCause: 'Diagnosis engine encountered an internal error processing this group.',
          suggestedFix: 'Check the raw data — the error may have unexpected field formats.',
          evidence: [],
        });
      }
    }
    const serviceGroups = this.buildServiceGroups(issues);
    const summary = this.buildSummary(errors, issues, serviceGroups);
    const metadata = this.buildMetadata(config, startTime, errors);

    return {
      id: randomUUID(),
      generatedAt: new Date(),
      timeRange: config.timeRange,
      services: config.services,
      summary,
      issues,
      serviceGroups,
      metadata,
    };
  }

  /**
   * Bucket diagnosed issues by service (primary report grouping).
   * Each group's issues are ordered by severity descending; the error
   * category is retained on each issue as a tag (not used for grouping).
   */
  private buildServiceGroups(issues: DiagnosedIssue[]): ServiceIssueGroup[] {
    const byService = new Map<string, DiagnosedIssue[]>();
    for (const issue of issues) {
      const list = byService.get(issue.service) ?? [];
      list.push(issue);
      byService.set(issue.service, list);
    }

    const groups: ServiceIssueGroup[] = [];
    for (const [service, serviceIssues] of byService) {
      const ordered = [...serviceIssues].sort(
        (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
      );
      const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
      const categories = new Set<ErrorCategory>();
      let errorCount = 0;
      for (const issue of ordered) {
        severityCounts[issue.severity]++;
        categories.add(issue.category);
        errorCount += issue.errorCount;
      }
      groups.push({
        service,
        errorCount,
        issueCount: ordered.length,
        severityCounts,
        categories: Array.from(categories),
        issues: ordered,
      });
    }

    // Most impacted service first: by critical count, then total errors.
    groups.sort(
      (a, b) =>
        b.severityCounts.critical - a.severityCounts.critical ||
        b.errorCount - a.errorCount,
    );
    return groups;
  }

  // --- Private Helpers ---

  private buildIssue(error: ClassifiedError): DiagnosedIssue {
    const { group } = error;

    // Build title from pattern name and endpoint
    const endpointLabel = group.endpoint || 'unknown endpoint';
    const patternLabel = error.pattern !== 'none' ? error.pattern : error.category;
    const title = `[${error.severity.toUpperCase()}] ${patternLabel} — ${group.service} \`${endpointLabel}\``;

    // Build description
    const description =
      error.category !== 'unclassified'
        ? `Classified as \`${error.category}\` with ${(error.confidence * 100).toFixed(0)}% confidence. ` +
          `${group.errorCount} errors detected in the analysis window.`
        : `${group.errorCount} errors detected but no known pattern matched. ` +
          `Full error trail included below for manual investigation.`;

    // Root cause derived from evidence
    const rootCause =
      error.evidence.length > 0
        ? error.evidence[0]
        : (group.logEntries.length > 0
          ? group.logEntries[0].message
          : 'Unable to determine root cause — see evidence trail below.');

    // Suggested fix
    const suggestedFix = error.suggestion;

    // Build comprehensive evidence with full context
    const evidence: EvidenceItem[] = [];

    // 1. CloudWatch metric data — timestamps when errors happened + console link
    for (const metric of group.metrics) {
      if (metric.timestamps.length > 0) {
        const timeLines: string[] = [];
        timeLines.push(`Endpoint: ${metric.endpoint}`);
        timeLines.push(`Status Code: ${metric.statusCode}`);
        timeLines.push(`Total Count: ${metric.totalCount}`);
        timeLines.push(`Peak: ${metric.peakCount} errors at ${this.safeISOString(metric.peakTimestamp)}`);
        timeLines.push(`Error Timestamps:`);
        for (const ts of metric.timestamps.slice(0, 20)) {
          const idx = metric.timestamps.indexOf(ts);
          timeLines.push(`  ${this.safeISOString(ts)} → ${metric.values[idx]} errors`);
        }
        // Copy-paste query for CloudWatch Logs Insights
        const cwQuery = [
          '',
          'CloudWatch Logs Insights Query (copy-paste):',
          `  Log Group: /ecs/production/${metric.service}`,
          `  Start: ${this.safeISOString(metric.timestamps[metric.timestamps.length - 1])}`,
          `  End: ${this.safeISOString(metric.timestamps[0])}`,
          `  Query:`,
          `    fields @timestamp, @message, level, traceId, endpoint`,
          `    | filter level = "error"`,
          `    | filter @message like /${metric.endpoint.replace(/\//g, '\\\\/')}/`,
          `    | sort @timestamp desc`,
          `    | limit 50`,
        ].join('\n');
        timeLines.push(cwQuery);

        evidence.push({
          source: 'cloudwatch',
          description: `${metric.totalCount} errors on \`${metric.endpoint}\` (peak: ${metric.peakCount} at ${this.safeISOString(metric.peakTimestamp)})`,
          data: timeLines.join('\n'),
          timestamp: metric.peakTimestamp,
        });
      }
    }

    // 2. Log entries — full detail with method, trace, stack
    for (const entry of group.logEntries.slice(0, 15)) {
      const logLines: string[] = [];
      const tsStr = this.safeISOString(entry.timestamp);
      logLines.push(`Timestamp: ${tsStr}`);
      logLines.push(`Level: ${entry.level}`);
      logLines.push(`Service: ${entry.service}`);
      if (entry.endpoint) logLines.push(`Endpoint: ${entry.endpoint}`);
      if (entry.traceId) logLines.push(`Trace ID: ${entry.traceId}`);
      if (entry.requestId) logLines.push(`Request ID: ${entry.requestId}`);
      if (entry.statusCode) logLines.push(`Status Code: ${entry.statusCode}`);
      if (entry.errorType) logLines.push(`Error Type: ${entry.errorType}`);
      logLines.push(`Message: ${entry.message}`);
      if (entry.stackTrace) {
        logLines.push(`Stack Trace:`);
        // Extract method names from stack trace
        const methods = this.extractMethodsFromStack(entry.stackTrace);
        if (methods.length > 0) {
          logLines.push(`  Call Chain: ${methods.join(' → ')}`);
        }
        logLines.push(`  Full Trace:`);
        logLines.push(`  ${entry.stackTrace}`);
      }
      // Include raw fields that give context (prevService, referer, portal)
      const raw = entry.raw || {};
      if (raw.prevService) logLines.push(`Called From: ${raw.prevService}`);
      if (raw.referer) logLines.push(`Referer: ${raw.referer}`);
      if (raw.portal) logLines.push(`Portal: ${raw.portal}`);
      if (raw.callScopeId) logLines.push(`Call Scope: ${raw.callScopeId}`);
      if (raw.originalUrl) logLines.push(`Original URL: ${raw.originalUrl}`);
      if (raw.method) logLines.push(`HTTP Method: ${raw.method}`);
      // Show if this error occurred multiple times
      if (raw.totalOccurrences && (raw.totalOccurrences as number) > 1) {
        logLines.push(`⚠️  This error occurred ${raw.totalOccurrences} times total`);
        const alsoAt = raw.alsoOccurredAt as string[] | undefined;
        if (alsoAt && alsoAt.length > 0) {
          logLines.push(`Also occurred at: ${alsoAt.join(', ')}`);
        }
      }

      const desc = entry.stackTrace
        ? `${entry.message} (${this.extractMethodsFromStack(entry.stackTrace).slice(0, 2).join(' → ')})`
        : entry.message;

      evidence.push({
        source: 'logs',
        description: desc,
        data: logLines.join('\n'),
        timestamp: entry.timestamp,
      });
    }

    // 3. Runtime errors — workflow context
    for (const re of group.runtimeErrors.slice(0, 10)) {
      const reLines: string[] = [];
      reLines.push(`Timestamp: ${this.safeISOString(re.timestamp)}`);
      reLines.push(`Workflow ID: ${re.workflowId}`);
      if (re.traceId) reLines.push(`Trace ID: ${re.traceId}`);
      reLines.push(`Stage: ${re.stage}`);
      reLines.push(`State: ${re.state}`);
      reLines.push(`Error:`);
      // Extract method chain from error
      const methods = this.extractMethodsFromStack(re.errorMessage);
      if (methods.length > 0) {
        reLines.push(`  Call Chain: ${methods.join(' → ')}`);
      }
      reLines.push(`  ${re.errorMessage}`);

      evidence.push({
        source: 'workflow_mcp',
        description: `Workflow \`${re.workflowId}\` [${re.stage}/${re.state}]`,
        data: reLines.join('\n'),
        timestamp: re.timestamp,
      });
    }

    // Extract related workflow IDs
    const relatedWorkflowIds = group.runtimeErrors
      .map((re) => re.workflowId)
      .filter((id) => id != null && id.length > 0);

    return {
      id: randomUUID(),
      title,
      category: error.category,
      severity: error.severity,
      service: group.service,
      endpoint: group.endpoint,
      errorCount: group.errorCount,
      description,
      rootCause,
      suggestedFix,
      evidence,
      relatedWorkflowIds: relatedWorkflowIds.length > 0 ? relatedWorkflowIds : undefined,
    };
  }

  /**
   * Extract method/function names from a stack trace string.
   * Returns the call chain in execution order.
   */
  private extractMethodsFromStack(stackTrace: string): string[] {
    const methods: string[] = [];
    // Match patterns like "at ClassName.methodName" or "at functionName"
    const regex = /at\s+(?:async\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(stackTrace)) !== null) {
      const method = match[1];
      // Skip internal/node modules
      if (!method.startsWith('process.') && !method.startsWith('node:') && method !== 'Object') {
        methods.push(method);
      }
    }
    return methods.slice(0, 5); // top 5 in the chain
  }

  /**
   * Build a CloudWatch Logs Insights link for a specific service and time range.
   * The link pre-fills a query to find errors for the given endpoint.
   */
  private buildCloudWatchLink(service: string, endpoint: string, timestamps: Date[]): string {
    try {
      const region = 'eu-west-1';
      const logGroup = `/ecs/production/${service}`;

      // Determine time range: earliest timestamp - 5min to latest + 5min
      const validTimes = timestamps
        .filter(t => t instanceof Date && !isNaN(t.getTime()))
        .map(t => t.getTime());
      
      if (validTimes.length === 0) return '(no valid timestamps for link)';

      const start = new Date(Math.min(...validTimes) - 5 * 60 * 1000);
      const end = new Date(Math.max(...validTimes) + 5 * 60 * 1000);

      // Build the Logs Insights query
      const escapedEndpoint = endpoint.replace(/[/]/g, '\\/');
      const query = [
        'fields @timestamp, @message, level, traceId, endpoint',
        `| filter level = "error"`,
        `| filter @message like /${escapedEndpoint}/`,
        '| sort @timestamp desc',
        '| limit 50',
      ].join('\n');

      // CloudWatch Logs Insights URL format
      const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');
      const encodedLogGroup = encodeURIComponent(encodeURIComponent(logGroup));
      const startEpoch = Math.floor(start.getTime() / 1000);
      const endEpoch = Math.floor(end.getTime() / 1000);

      return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:logs-insights/queryDetail/~(end~${endEpoch}~start~${startEpoch}~timeType~'ABSOLUTE~tz~'UTC~editorString~'${encodedQuery}~isLiveTail~false~source~(~'${encodedLogGroup}))`;
    } catch {
      return '(failed to generate CloudWatch link)';
    }
  }

  private buildSummary(
    errors: ClassifiedError[],
    issues: DiagnosedIssue[],
    serviceGroups: ServiceIssueGroup[],
  ): ReportSummary {
    const totalErrorsAnalyzed = errors.reduce(
      (sum, err) => sum + err.group.errorCount,
      0,
    );

    const criticalCount = issues.filter((i) => i.severity === 'critical').length;
    const highCount = issues.filter((i) => i.severity === 'high').length;
    const mediumCount = issues.filter((i) => i.severity === 'medium').length;
    const lowCount = issues.filter((i) => i.severity === 'low').length;

    // Compute top categories
    const categoryMap = new Map<ErrorCategory, number>();
    for (const error of errors) {
      const current = categoryMap.get(error.category) ?? 0;
      categoryMap.set(error.category, current + 1);
    }

    const topCategories = Array.from(categoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    const byService: ServiceSummary[] = serviceGroups.map((g) => ({
      service: g.service,
      errorCount: g.errorCount,
      issueCount: g.issueCount,
      criticalCount: g.severityCounts.critical,
      highCount: g.severityCounts.high,
      mediumCount: g.severityCounts.medium,
      lowCount: g.severityCounts.low,
    }));

    return {
      totalErrorsAnalyzed,
      issuesFound: issues.length,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      topCategories,
      byService,
    };
  }

  private buildMetadata(
    config: AnalysisConfig,
    startTime: number,
    errors: ClassifiedError[],
  ): ReportMetadata {
    const duration = Date.now() - startTime;

    // Determine which data sources were queried based on config
    const dataSourcesQueried: string[] = ['cloudwatch_errors', 'runtime_errors', 'application_logs'];
    if (config.includeLatencyAnalysis) {
      dataSourcesQueried.push('cloudwatch_latency');
    }
    if (config.includeAnomalyDetection) {
      dataSourcesQueried.push('anomaly_detection');
    }

    // Collect any errors encountered (unclassified items indicate gaps)
    const errorsEncountered: string[] = [];
    const unclassifiedCount = errors.filter((e) => e.category === 'unclassified').length;
    if (unclassifiedCount > 0) {
      errorsEncountered.push(
        `${unclassifiedCount} error group(s) could not be classified`,
      );
    }

    return {
      analysisId: randomUUID(),
      duration,
      dataSourcesQueried,
      errorsEncountered,
    };
  }

  private inferEvidenceSource(evidence: string): EvidenceItem['source'] {
    const lower = evidence.toLowerCase();
    if (lower.includes('cloudwatch') || lower.includes('metric')) return 'cloudwatch';
    if (lower.includes('log') || lower.includes('stack')) return 'logs';
    if (lower.includes('workflow') || lower.includes('runtime')) return 'workflow_mcp';
    if (lower.includes('anomaly') || lower.includes('baseline')) return 'anomaly';
    return 'logs'; // default
  }

  /**
   * Safely convert a Date to ISO string. Returns 'unknown' for invalid dates.
   */
  private safeISOString(date: Date | unknown): string {
    if (!date) return 'unknown';
    if (date instanceof Date && !isNaN(date.getTime())) {
      return date.toISOString();
    }
    // Try to parse as string
    const parsed = new Date(date as string);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return 'unknown';
  }
}
