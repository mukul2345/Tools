import type { CorrelatedErrorGroup, PatternMatchResult } from '../../types/index.js';
import type { IErrorPattern } from '../../types/interfaces.js';

const TIMEOUT_PATTERNS: RegExp[] = [
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /socket hang up/i,
  /timeout.*exceeded/i,
  /Task timed out/i,
];

export const TimeoutPattern: IErrorPattern = {
  name: 'Timeout',
  category: 'timeout',
  priority: 80,

  match(group: CorrelatedErrorGroup): PatternMatchResult {
    const totalEntries = group.logEntries.length + group.runtimeErrors.length;
    if (totalEntries === 0) {
      return { matched: false, confidence: 0, evidence: [] };
    }

    let matchCount = 0;
    const evidence: string[] = [];

    for (const entry of group.logEntries) {
      const searchText = [entry.message, entry.stackTrace ?? ''].join(' ');
      const isMatch = TIMEOUT_PATTERNS.some((pattern) => pattern.test(searchText));
      if (isMatch) {
        matchCount++;
        if (evidence.length < 5) {
          evidence.push(entry.message);
        }
      }
    }

    for (const error of group.runtimeErrors) {
      const searchText = error.errorMessage;
      const isMatch = TIMEOUT_PATTERNS.some((pattern) => pattern.test(searchText));
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
    return 'Check downstream service health. Consider increasing timeout values or implementing circuit breaker pattern.';
  },
};
