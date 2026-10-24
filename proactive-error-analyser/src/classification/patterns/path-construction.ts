import type { CorrelatedErrorGroup, PatternMatchResult } from '../../types/index.js';
import type { IErrorPattern } from '../../types/interfaces.js';

const PATH_CONSTRUCTION_PATTERNS: RegExp[] = [
  /ENOENT.*no such file/i,
  /Unable to open file/i,
  /No such file or directory/i,
  /Invalid URL/i,
  /path.*undefined/i,
  /Cannot resolve.*path/i,
];

export const PathConstructionPattern: IErrorPattern = {
  name: 'PathConstruction',
  category: 'path_construction',
  priority: 85,

  match(group: CorrelatedErrorGroup): PatternMatchResult {
    const totalEntries = group.logEntries.length + group.runtimeErrors.length;
    if (totalEntries === 0) {
      return { matched: false, confidence: 0, evidence: [] };
    }

    let matchCount = 0;
    const evidence: string[] = [];

    for (const entry of group.logEntries) {
      const searchText = [entry.message, entry.stackTrace ?? ''].join(' ');
      const isMatch = PATH_CONSTRUCTION_PATTERNS.some((pattern) => pattern.test(searchText));
      if (isMatch) {
        matchCount++;
        if (evidence.length < 5) {
          evidence.push(entry.message);
        }
      }
    }

    for (const error of group.runtimeErrors) {
      const searchText = error.errorMessage;
      const isMatch = PATH_CONSTRUCTION_PATTERNS.some((pattern) => pattern.test(searchText));
      if (isMatch) {
        matchCount++;
        if (evidence.length < 5) {
          evidence.push(error.errorMessage);
        }
      }
    }

    const confidence = totalEntries > 0 ? matchCount / totalEntries : 0;

    // Path construction errors often have only 1 detailed error among several related logs
    // Use a lower effective threshold: if at least 1 match exists and confidence > 0.3, consider it matched
    const effectivelyMatched = matchCount > 0 && confidence >= 0.3;

    return {
      matched: effectivelyMatched,
      confidence,
      evidence,
    };
  },

  getSuggestion(_group: CorrelatedErrorGroup): string {
    return 'Fix the file path construction. The path appears to be double-prefixed or using a relative path where an absolute path is expected.';
  },
};
