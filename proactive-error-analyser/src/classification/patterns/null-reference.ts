import type { CorrelatedErrorGroup, PatternMatchResult } from '../../types/index.js';
import type { IErrorPattern } from '../../types/interfaces.js';

const NULL_REFERENCE_PATTERNS: RegExp[] = [
  /cannot read propert(y|ies) of (null|undefined)/i,
  /TypeError:.*is not a function/i,
  /TypeError:.*is (null|undefined)/i,
  /Cannot destructure property/i,
];

export const NullReferencePattern: IErrorPattern = {
  name: 'NullReference',
  category: 'null_reference',
  priority: 90,

  match(group: CorrelatedErrorGroup): PatternMatchResult {
    const totalEntries = group.logEntries.length + group.runtimeErrors.length;
    if (totalEntries === 0) {
      return { matched: false, confidence: 0, evidence: [] };
    }

    let matchCount = 0;
    const evidence: string[] = [];

    for (const entry of group.logEntries) {
      const searchText = [entry.message, entry.stackTrace ?? ''].join(' ');
      const isMatch = NULL_REFERENCE_PATTERNS.some((pattern) => pattern.test(searchText));
      if (isMatch) {
        matchCount++;
        if (evidence.length < 5) {
          evidence.push(entry.message);
        }
      }
    }

    for (const error of group.runtimeErrors) {
      const searchText = error.errorMessage;
      const isMatch = NULL_REFERENCE_PATTERNS.some((pattern) => pattern.test(searchText));
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
    return 'Add null check before accessing the property. Consider using optional chaining (?.) or adding a guard clause.';
  },
};
