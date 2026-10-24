/**
 * Markdown Report Generator
 *
 * Generates a human-readable Markdown report from a DiagnosisReport.
 */

import type { DiagnosedIssue, DiagnosisReport, ReportSummary, ServiceIssueGroup } from '../types/index.js';
import type { IReportGenerator } from '../types/interfaces.js';

// --- Severity Badges ---

const SEVERITY_BADGES: Record<string, string> = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
  low: '🟢 LOW',
};

// --- Markdown Report Generator ---

export class MarkdownReportGenerator implements IReportGenerator {
  generateMarkdown(report: DiagnosisReport): string {
    const sections: string[] = [];

    sections.push(this.renderHeader(report));
    sections.push(this.renderSummaryTable(report.summary));
    sections.push(this.renderIssuesByService(report.serviceGroups));
    sections.push(this.renderMetadata(report));

    return sections.join('\n\n');
  }

  generateJSON(report: DiagnosisReport): object {
    return report;
  }

  generateSummary(report: DiagnosisReport): string {
    const { summary } = report;
    return (
      `Analysis complete: ${summary.totalErrorsAnalyzed} errors analyzed, ` +
      `${summary.issuesFound} issues found ` +
      `(${summary.criticalCount} critical, ${summary.highCount} high, ` +
      `${summary.mediumCount} medium, ${summary.lowCount} low)`
    );
  }

  // --- Private Helpers ---

  private renderHeader(report: DiagnosisReport): string {
    const lines: string[] = [];
    lines.push('# Proactive Error Analysis Report');
    lines.push('');
    lines.push(`**Generated:** ${report.generatedAt.toISOString()}`);
    lines.push(`**Analysis Window:** ${report.timeRange.start.toISOString()} → ${report.timeRange.end.toISOString()}`);
    lines.push(`**Services:** ${report.services.join(', ')}`);
    return lines.join('\n');
  }

  private renderSummaryTable(summary: ReportSummary): string {
    const lines: string[] = [];
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total Errors Analyzed | ${summary.totalErrorsAnalyzed} |`);
    lines.push(`| Issues Found | ${summary.issuesFound} |`);
    lines.push(`| 🔴 Critical | ${summary.criticalCount} |`);
    lines.push(`| 🟠 High | ${summary.highCount} |`);
    lines.push(`| 🟡 Medium | ${summary.mediumCount} |`);
    lines.push(`| 🟢 Low | ${summary.lowCount} |`);
    lines.push('');

    if (summary.topCategories.length > 0) {
      lines.push('**Top Categories:**');
      for (const { category, count } of summary.topCategories) {
        lines.push(`- \`${category}\`: ${count} issue(s)`);
      }
      lines.push('');
    }

    if (summary.byService && summary.byService.length > 0) {
      lines.push('**By Service:**');
      lines.push('');
      lines.push('| Service | Errors | Issues | 🔴 | 🟠 | 🟡 | 🟢 |');
      lines.push('|---------|-------:|-------:|---:|---:|---:|---:|');
      for (const s of summary.byService) {
        lines.push(
          `| **${s.service}** | ${s.errorCount} | ${s.issueCount} | ${s.criticalCount} | ${s.highCount} | ${s.mediumCount} | ${s.lowCount} |`,
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * Detailed issues section — grouped PRIMARILY by service. Each service is
   * a section with a rollup header, then its issues ordered by severity.
   * The error category is shown as a tag on each issue (not used for grouping).
   */
  private renderIssuesByService(groups: ServiceIssueGroup[]): string {
    if (!groups || groups.length === 0) {
      return '## Issues by Service\n\nNo issues detected.';
    }

    const lines: string[] = [];
    lines.push('## Issues by Service');

    for (const group of groups) {
      lines.push('');
      lines.push(this.renderServiceGroup(group));
    }

    return lines.join('\n');
  }

  private renderServiceGroup(group: ServiceIssueGroup): string {
    const lines: string[] = [];
    const sc = group.severityCounts;

    lines.push(`### 📦 ${group.service}`);
    lines.push('');
    lines.push(
      `> **${group.errorCount} errors** across **${group.issueCount} issue(s)** | ` +
      `🔴 ${sc.critical}  � ${sc.high}  � ${sc.medium}  🟢 ${sc.low}`,
    );
    lines.push('>');
    lines.push(`> **Categories:** ${group.categories.map((c) => `\`${c}\``).join(', ')}`);
    lines.push('');

    for (const issue of group.issues) {
      lines.push(this.renderIssue(issue));
      lines.push('');
    }

    return lines.join('\n');
  }

  private renderIssue(issue: DiagnosedIssue): string {
    const badge = SEVERITY_BADGES[issue.severity] ?? issue.severity;
    const lines: string[] = [];

    // Title with severity badge inline (nested under the service ### header)
    lines.push(`#### ${badge} \`${issue.endpoint || 'N/A'}\`  \`[${issue.category}]\``);
    lines.push('');

    // Quick summary box
    lines.push(`> **${issue.errorCount} errors** in the analysis window | Category: \`${issue.category}\``);
    if (issue.category !== 'unclassified') {
      lines.push(`> `);
      lines.push(`> **Suggested Fix:** ${issue.suggestedFix}`);
    }
    lines.push('');

    // Error timeline (from CloudWatch evidence)
    const cwEvidence = issue.evidence.find(e => e.source === 'cloudwatch');
    if (cwEvidence) {
      lines.push('#### 📅 Error Timeline');
      lines.push('');
      lines.push('```');
      lines.push(cwEvidence.data);
      lines.push('```');
      lines.push('');
    }

    // Error logs section — the actual errors found
    const logEvidence = issue.evidence.filter(e => e.source === 'logs');
    if (logEvidence.length > 0) {
      lines.push(`#### 🔍 Error Logs Found (${logEvidence.length} unique error types)`);
      lines.push('');

      for (let i = 0; i < logEvidence.length; i++) {
        const ev = logEvidence[i];
        const ts = ev.timestamp && ev.timestamp instanceof Date && !isNaN(ev.timestamp.getTime())
          ? ev.timestamp.toISOString()
          : 'unknown';

        // Show a concise summary line, then details in a collapsible
        lines.push(`**${i + 1}. \`${ts}\`** — ${ev.description}`);
        lines.push('');
        lines.push('<details>');
        lines.push('<summary>Full details</summary>');
        lines.push('');
        lines.push('```');
        lines.push(ev.data);
        lines.push('```');
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    } else if (!cwEvidence) {
      lines.push('#### ⚠️ No error logs found');
      lines.push('');
      lines.push('Could not retrieve error logs for this endpoint. The errors may have been too old or the log group may not contain matching entries.');
      lines.push('');
    }

    // Workflow errors section
    const wfEvidence = issue.evidence.filter(e => e.source === 'workflow_mcp');
    if (wfEvidence.length > 0) {
      lines.push(`#### 🔄 Workflow Errors`);
      lines.push('');
      for (const ev of wfEvidence) {
        lines.push('```');
        lines.push(ev.data);
        lines.push('```');
        lines.push('');
      }
    }

    // Related workflow IDs
    if (issue.relatedWorkflowIds && issue.relatedWorkflowIds.length > 0) {
      lines.push(`**Related Workflows:** \`${issue.relatedWorkflowIds.join('`, `')}\``);
      lines.push('');
    }

    // Root cause summary (if we have one that's not generic)
    if (issue.rootCause && !issue.rootCause.includes('Unable to determine') && !issue.rootCause.includes('see evidence')) {
      lines.push(`**Root Cause:** ${issue.rootCause}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private renderMetadata(report: DiagnosisReport): string {
    const { metadata } = report;
    const lines: string[] = [];

    lines.push('---');
    lines.push('');
    lines.push('## Metadata');
    lines.push('');
    lines.push(`- **Analysis ID:** ${metadata.analysisId}`);
    lines.push(`- **Duration:** ${metadata.duration}ms`);
    lines.push(`- **Data Sources Queried:** ${metadata.dataSourcesQueried.join(', ')}`);

    if (metadata.errorsEncountered.length > 0) {
      lines.push(`- **Errors Encountered:** ${metadata.errorsEncountered.join('; ')}`);
    } else {
      lines.push('- **Errors Encountered:** None');
    }

    return lines.join('\n');
  }
}
