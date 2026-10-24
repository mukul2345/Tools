import type { ClassifiedError, CorrelatedErrorGroup } from '../types/index.js';
import type { IErrorClassifier, IErrorPattern } from '../types/interfaces.js';
import { computeSeverity } from './severity.js';

export class ErrorClassifier implements IErrorClassifier {
  private patterns: IErrorPattern[] = [];

  registerPattern(pattern: IErrorPattern): void {
    this.patterns.push(pattern);
  }

  getPatterns(): IErrorPattern[] {
    return [...this.patterns];
  }

  classify(group: CorrelatedErrorGroup): ClassifiedError {
    // Sort patterns by priority descending (highest first)
    const sortedPatterns = [...this.patterns].sort((a, b) => b.priority - a.priority);

    for (const pattern of sortedPatterns) {
      const result = pattern.match(group);

      if (result.matched && result.confidence >= 0.3) {
        const category = pattern.category;
        const severity = computeSeverity(group, category);
        const suggestion = pattern.getSuggestion(group);

        return {
          group,
          category,
          severity,
          pattern: pattern.name,
          confidence: result.confidence,
          suggestion,
          evidence: result.evidence,
        };
      }
    }

    // No pattern matched — return unclassified
    const severity = computeSeverity(group, 'unclassified');

    return {
      group,
      category: 'unclassified',
      severity,
      pattern: 'none',
      confidence: 0,
      suggestion: 'No known pattern matched. Manual investigation recommended.',
      evidence: [],
    };
  }
}
