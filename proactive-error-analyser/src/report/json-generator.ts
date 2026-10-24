/**
 * JSON Report Generator
 *
 * Returns the DiagnosisReport as a structured JSON object and provides
 * a one-line summary string for quick consumption.
 */

import type { DiagnosisReport } from '../types/index.js';
import type { IReportGenerator } from '../types/interfaces.js';

// --- JSON Report Generator ---

export class JsonReportGenerator implements IReportGenerator {
  generateMarkdown(report: DiagnosisReport): string {
    // Fallback: serialize the report as formatted JSON in a markdown code block
    return '```json\n' + JSON.stringify(report, null, 2) + '\n```';
  }

  generateJSON(report: DiagnosisReport): object {
    // The report is already structured correctly — return as-is
    return report;
  }

  generateSummary(report: DiagnosisReport): string {
    const { summary } = report;
    return (
      `${summary.issuesFound} issues found from ${summary.totalErrorsAnalyzed} errors ` +
      `(${summary.criticalCount}C/${summary.highCount}H/${summary.mediumCount}M/${summary.lowCount}L)`
    );
  }
}
