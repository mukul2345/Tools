import type { CorrelatedErrorGroup, PatternMatchResult } from '../../types/index.js';
import type { IErrorPattern } from '../../types/interfaces.js';

const STATUS_CODE_MISMATCH_PATTERNS: RegExp[] = [
  /not satisfied/i,
  /validation (failed|error)/i,
  /invalid (input|request|parameter|data)/i,
  /not found/i,
  /already exists/i,
  /missing required/i,
  /malformed/i,
  /bad request/i,
  /constraint violation/i,
  /duplicate (key|entry)/i,
];

export const StatusCodeMismatchPattern: IErrorPattern = {
  name: 'StatusCodeMismatch',
  category: 'status_code_mismatch',
  priority: 100,

  match(group: CorrelatedErrorGroup): PatternMatchResult {
    // Only match if group has 500 status code metrics
    const has500Metrics = group.metrics.some((m) => m.statusCode === 500);
    if (!has500Metrics) {
      return { matched: false, confidence: 0, evidence: [] };
    }

    const totalEntries = group.logEntries.length + group.runtimeErrors.length;
    if (totalEntries === 0) {
      return { matched: false, confidence: 0, evidence: [] };
    }

    let matchCount = 0;
    const evidence: string[] = [];

    for (const entry of group.logEntries) {
      const searchText = [entry.message, entry.stackTrace ?? ''].join(' ');
      const isMatch = STATUS_CODE_MISMATCH_PATTERNS.some((pattern) => pattern.test(searchText));
      if (isMatch) {
        matchCount++;
        if (evidence.length < 5) {
          evidence.push(entry.message);
        }
      }
    }

    for (const error of group.runtimeErrors) {
      const searchText = error.errorMessage;
      const isMatch = STATUS_CODE_MISMATCH_PATTERNS.some((pattern) => pattern.test(searchText));
      if (isMatch) {
        matchCount++;
        if (evidence.length < 5) {
          evidence.push(error.errorMessage);
        }
      }
    }

    const confidence = matchCount / totalEntries;

    return {
      matched: confidence >= 0.6,
      confidence,
      evidence,
    };
  },

  getSuggestion(_group: CorrelatedErrorGroup): string {
    return "Add an error mapper to convert this validation error to HTTP 400. The thrown exception should include errorCode 'GEN_400' or use DFGHTTPError with statusCode 400.";
  },
};
