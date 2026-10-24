import type { CorrelatedErrorGroup, PatternMatchResult } from '../../types/index.js';
import type { IErrorPattern } from '../../types/interfaces.js';

const DDB_THROTTLING_PATTERNS: RegExp[] = [
  /ProvisionedThroughputExceededException/i,
  /throttl(ed|ing)/i,
  /Rate exceeded/i,
  /TransactionConflictException/i,
];

export const DDBThrottlingPattern: IErrorPattern = {
  name: 'DDBThrottling',
  category: 'ddb_throttling',
  priority: 95,

  match(group: CorrelatedErrorGroup): PatternMatchResult {
    const totalEntries = group.logEntries.length + group.runtimeErrors.length;
    if (totalEntries === 0) {
      return { matched: false, confidence: 0, evidence: [] };
    }

    let matchCount = 0;
    const evidence: string[] = [];

    for (const entry of group.logEntries) {
      const searchText = [entry.message, entry.stackTrace ?? ''].join(' ');
      const isMatch = DDB_THROTTLING_PATTERNS.some((pattern) => pattern.test(searchText));
      if (isMatch) {
        matchCount++;
        if (evidence.length < 5) {
          evidence.push(entry.message);
        }
      }
    }

    for (const error of group.runtimeErrors) {
      const searchText = error.errorMessage;
      const isMatch = DDB_THROTTLING_PATTERNS.some((pattern) => pattern.test(searchText));
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
    return 'Review DynamoDB table capacity. Consider switching to on-demand capacity mode or implementing exponential backoff with jitter.';
  },
};
