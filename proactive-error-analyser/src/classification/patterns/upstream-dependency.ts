import type { CorrelatedErrorGroup, PatternMatchResult } from '../../types/index.js';
import type { IErrorPattern } from '../../types/interfaces.js';
import { traceRootService } from '../../diagnosis/root-service-tracer.js';

/**
 * Upstream-dependency failures (socket hang up / ECONNRESET / connection drop).
 *
 * When the surface service reports a connection drop, the fault propagated from a
 * DOWNSTREAM root service. This pattern matches those drops and — via
 * traceRootService — names the root service in its evidence + suggestion so the
 * ticket can be routed there instead of the surface service.
 *
 * Priority 85 > Timeout(80): a socket-hangup that we can trace to a root service
 * is classified as an upstream_dependency issue rather than a generic timeout.
 */
const CONNECTION_DROP = [/socket hang up/i, /ECONNRESET/i, /ECONNREFUSED/i, /EPIPE/i];

export const UpstreamDependencyPattern: IErrorPattern = {
  name: 'UpstreamDependency',
  category: 'upstream_dependency',
  priority: 85,

  match(group: CorrelatedErrorGroup): PatternMatchResult {
    const total = group.logEntries.length + group.runtimeErrors.length;
    if (total === 0) return { matched: false, confidence: 0, evidence: [] };

    let matchCount = 0;
    for (const entry of group.logEntries) {
      const text = [entry.message, entry.stackTrace ?? ''].join(' ');
      if (CONNECTION_DROP.some((p) => p.test(text))) matchCount++;
    }
    for (const error of group.runtimeErrors) {
      if (CONNECTION_DROP.some((p) => p.test(error.errorMessage))) matchCount++;
    }
    if (matchCount === 0) return { matched: false, confidence: 0, evidence: [] };

    const trace = traceRootService(group);
    const evidence: string[] = [];
    if (trace.rootService && trace.rootService !== group.service) {
      evidence.push(`Root service (traced via ${trace.via}): ${trace.rootService}`);
    } else {
      evidence.push('Connection drop detected; root service could not be resolved from logs.');
    }
    evidence.push(...trace.evidence.slice(0, 4));

    const confidence = matchCount / total;
    return { matched: confidence >= 0.3, confidence, evidence };
  },

  getSuggestion(group: CorrelatedErrorGroup): string {
    const trace = traceRootService(group);
    if (trace.rootService && trace.rootService !== group.service) {
      return (
        `Connection dropped while ${group.service} talked to ${trace.rootService} ` +
        `(traced via ${trace.via}). Investigate and fix in the ROOT service ` +
        `${trace.rootService} — check its health, latency, and whether it is ` +
        `closing connections / timing out. The fix likely belongs there, not in ${group.service}.`
      );
    }
    return (
      `Connection drop (socket hang up / ECONNRESET) in ${group.service}. The root ` +
      `service could not be resolved from the logs — inspect the failing outbound ` +
      `call target and downstream health.`
    );
  },
};
