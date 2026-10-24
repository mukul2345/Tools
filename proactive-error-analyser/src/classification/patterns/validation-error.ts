import type { CorrelatedErrorGroup, PatternMatchResult } from '../../types/index.js';
import type { IErrorPattern } from '../../types/interfaces.js';

/**
 * Validation / missing-required-input errors.
 *
 * Catches the DFG family of input-validation failures that surface as a thrown
 * domain exception with a "<field> is required" / "invalid <field>" message and
 * a stack trace pointing at a *Service/*Exception (e.g.
 *   DFGError: Client contract id is required for client config based attribute
 *   at ComponentTypeService.js:212 ...
 * ). These are real code-level gaps (an unhandled input case) that the fix agent
 * can address — distinct from null-reference crashes.
 */
const VALIDATION_PATTERNS: RegExp[] = [
  /\bis required\b/i,
  /\brequired\b.*\b(field|parameter|param|id|attribute|property)\b/i,
  /\b(missing|invalid|malformed)\b.*\b(field|parameter|param|id|attribute|body|payload|argument)\b/i,
  /ValidationError/i,
  /\bDFGError\b/,
  /[A-Za-z]+Exception\b/,
  /must (be|not be|contain)/i,
  /failed validation/i,
];

export const ValidationErrorPattern: IErrorPattern = {
  name: 'ValidationError',
  category: 'validation_error',
  // Below NullReference(90)/StatusCodeMismatch but above Timeout(80) so a genuine
  // socket-hangup still wins the timeout/upstream classification.
  priority: 70,

  match(group: CorrelatedErrorGroup): PatternMatchResult {
    const totalEntries = group.logEntries.length + group.runtimeErrors.length;
    if (totalEntries === 0) {
      return { matched: false, confidence: 0, evidence: [] };
    }

    let matchCount = 0;
    const evidence: string[] = [];

    const check = (text: string, sample: string) => {
      if (VALIDATION_PATTERNS.some((p) => p.test(text))) {
        matchCount++;
        if (evidence.length < 5) evidence.push(sample);
      }
    };

    for (const entry of group.logEntries) {
      check([entry.message, entry.stackTrace ?? ''].join(' '), entry.message);
    }
    for (const error of group.runtimeErrors) {
      check(error.errorMessage, error.errorMessage);
    }

    const confidence = matchCount / totalEntries;
    // Lower bar than crash patterns: even a minority of clear "X is required"
    // lines in the window is a strong, actionable signal.
    return { matched: confidence >= 0.3, confidence, evidence };
  },

  getSuggestion(_group: CorrelatedErrorGroup): string {
    return (
      'Add input validation / a guard for the required field before it is used, ' +
      'and return a 4xx client error (not a 500) when it is absent. Trace the ' +
      'throwing *Service/*Exception in the stack to the exact unhandled input case.'
    );
  },
};
