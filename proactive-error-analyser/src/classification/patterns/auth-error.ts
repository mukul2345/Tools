import type { CorrelatedErrorGroup, PatternMatchResult } from '../../types/index.js';
import type { IErrorPattern } from '../../types/interfaces.js';

/**
 * Authentication / token errors.
 *
 * Catches the DFG auth-failure family seen across services:
 *   INVALID_TOKEN
 *   Unable to decode access token, trying with refresh token
 *   401 / Unauthorized / jwt expired / token expired
 *
 * These are real, high-volume errors. Classified separately from validation so
 * the suggestion is auth-specific (token lifecycle / refresh flow), not input
 * validation.
 */
const AUTH_PATTERNS: RegExp[] = [
  /INVALID_TOKEN/i,
  /unable to decode (access|refresh) token/i,
  /\b(jwt|token) (expired|invalid|malformed)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /authentication failed/i,
];

export const AuthErrorPattern: IErrorPattern = {
  name: 'AuthError',
  category: 'configuration',
  priority: 75,

  match(group: CorrelatedErrorGroup): PatternMatchResult {
    const total = group.logEntries.length + group.runtimeErrors.length;
    if (total === 0) return { matched: false, confidence: 0, evidence: [] };

    let matchCount = 0;
    const evidence: string[] = [];
    const check = (text: string, sample: string) => {
      if (AUTH_PATTERNS.some((p) => p.test(text))) {
        matchCount++;
        if (evidence.length < 5) evidence.push(sample);
      }
    };
    for (const e of group.logEntries) check([e.message, e.stackTrace ?? ''].join(' '), e.message);
    for (const err of group.runtimeErrors) check(err.errorMessage, err.errorMessage);

    const confidence = matchCount / total;
    return { matched: confidence >= 0.3, confidence, evidence };
  },

  getSuggestion(_group: CorrelatedErrorGroup): string {
    return (
      'Token validation is failing (INVALID_TOKEN / decode failure). Check the ' +
      'token issuer/audience config, clock skew, and the access→refresh fallback ' +
      'flow. Confirm the caller sends a valid, unexpired token and that the ' +
      'refresh path actually re-issues before retrying the request.'
    );
  },
};
