import type { CorrelatedErrorGroup, NormalizedLogEntry } from '../types/index.js';

/**
 * Socket-hangup / connection-drop root-service tracing.
 *
 * A `socket hang up` / `ECONNRESET` seen on service A almost never originates in
 * A — A was calling a downstream service B (or B was calling A) and the
 * connection dropped. The real fix belongs in the ROOT service where the failure
 * propagated from. This module extracts that root service from the log evidence
 * so the ticket can be attributed/routed there instead of the surface service.
 *
 * Signals used (best-effort, in priority order):
 *   1. An explicit outbound target in the message, e.g.
 *        "Service Caller ERROR: POST http://<host>/<service>/..."
 *   2. The `prevService` field on the log entry's `raw` (the immediate caller/callee
 *      recorded by the DFG call framework).
 *   3. A service-looking token in the URL path of the failing call.
 */

const CONNECTION_DROP = [/socket hang up/i, /ECONNRESET/i, /ECONNREFUSED/i, /EPIPE/i];

// Known DFG service slugs that can appear in URLs / caller fields.
const SERVICE_SLUG =
  /\b([a-z]+(?:-[a-z]+)*-(?:service|engine|structure-service))\b/i;

export interface RootServiceTrace {
  isConnectionDrop: boolean;
  /** The service the fix most likely belongs to (may equal the surface service). */
  rootService: string;
  /** How the root service was determined. */
  via: 'outbound_call' | 'prev_service' | 'url_path' | 'self' | 'unknown';
  /** Short human evidence lines. */
  evidence: string[];
}

function extractFromMessage(message: string): string | null {
  // "Service Caller ERROR: POST http://host/verification-request/..." → verification-request
  const urlMatch = message.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const m = urlMatch[0].match(SERVICE_SLUG);
    if (m) return m[1].toLowerCase();
  }
  const m = message.match(SERVICE_SLUG);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Trace a group's connection-drop errors to the most likely root service.
 * Returns isConnectionDrop=false when the group is not a socket-hangup family error.
 */
export function traceRootService(group: CorrelatedErrorGroup): RootServiceTrace {
  const surface = group.service;
  const entries: NormalizedLogEntry[] = group.logEntries;

  const dropEntries = entries.filter((e) => {
    const text = [e.message, e.stackTrace ?? ''].join(' ');
    return CONNECTION_DROP.some((p) => p.test(text));
  });

  if (dropEntries.length === 0) {
    return { isConnectionDrop: false, rootService: surface, via: 'self', evidence: [] };
  }

  const evidence: string[] = [];
  const tally = new Map<string, number>();
  let via: RootServiceTrace['via'] = 'unknown';

  for (const e of dropEntries) {
    // 1. outbound call target in the message / stack
    const fromMsg = extractFromMessage([e.message, e.stackTrace ?? ''].join(' '));
    // 2. prevService recorded by the call framework
    const prev = (e.raw as Record<string, unknown>)?.prevService;
    const prevService = typeof prev === 'string' && prev.trim() ? prev.trim().toLowerCase() : null;
    // 3. url path
    const fromUrl = e.endpoint ? (e.endpoint.match(SERVICE_SLUG)?.[1]?.toLowerCase() ?? null) : null;

    const candidate = fromMsg || prevService || fromUrl;
    if (candidate && candidate !== surface.toLowerCase()) {
      tally.set(candidate, (tally.get(candidate) ?? 0) + 1);
      if (via === 'unknown') via = fromMsg ? 'outbound_call' : prevService ? 'prev_service' : 'url_path';
      if (evidence.length < 5) {
        evidence.push(`${surface} → ${candidate}: ${e.message.slice(0, 120)}`);
      }
    } else if (evidence.length < 5) {
      evidence.push(`${surface} (origin unresolved): ${e.message.slice(0, 120)}`);
    }
  }

  // Pick the most frequently implicated downstream service.
  let rootService = surface;
  let best = 0;
  for (const [svc, count] of tally) {
    if (count > best) {
      best = count;
      rootService = svc;
    }
  }

  if (rootService === surface) {
    via = 'self';
  }

  return { isConnectionDrop: true, rootService, via, evidence };
}
