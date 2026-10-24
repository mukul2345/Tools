import type { CorrelatedErrorGroup, ErrorCategory } from '../types/index.js';

export function computeSeverity(
  group: CorrelatedErrorGroup,
  category: ErrorCategory
): 'critical' | 'high' | 'medium' | 'low' {
  // Critical: errorCount > 100 OR (infrastructure AND has anomalies)
  if (group.errorCount > 100) return 'critical';
  if (category === 'infrastructure' && group.anomalies.length > 0) return 'critical';

  // High: errorCount > 50 OR ddb_throttling
  if (group.errorCount > 50) return 'high';
  if (category === 'ddb_throttling') return 'high';

  // Actionable code-level bugs: a validation gap or an upstream-dependency
  // (socket-hangup) failure is worth a ticket even at lower volume, so floor
  // them at 'high' when there is a real cluster of errors.
  if ((category === 'validation_error' || category === 'upstream_dependency' || category === 'configuration') && group.errorCount > 5) {
    return 'high';
  }

  // Medium: errorCount > 10
  if (group.errorCount > 10) return 'medium';

  // Low: everything else
  return 'low';
}
