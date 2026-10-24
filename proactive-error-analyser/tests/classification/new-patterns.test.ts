import { describe, it, expect } from 'vitest';
import { ValidationErrorPattern } from '../../src/classification/patterns/validation-error.js';
import { UpstreamDependencyPattern } from '../../src/classification/patterns/upstream-dependency.js';
import { traceRootService } from '../../src/diagnosis/root-service-tracer.js';
import type { CorrelatedErrorGroup, NormalizedLogEntry } from '../../src/types/index.js';

function entry(partial: Partial<NormalizedLogEntry>): NormalizedLogEntry {
  return {
    timestamp: new Date('2026-09-30T04:34:03.438Z'),
    level: 'ERROR',
    message: '',
    service: 'core-verification-data-structure-service',
    raw: {},
    ...partial,
  };
}

function group(entries: NormalizedLogEntry[], service = 'core-verification-data-structure-service'): CorrelatedErrorGroup {
  return {
    id: 'g1',
    service,
    endpoint: '/x/:id',
    errorCount: entries.length,
    timeRange: { start: new Date(), end: new Date() },
    metrics: [],
    logEntries: entries,
    runtimeErrors: [],
    anomalies: [],
    correlationConfidence: 'medium',
    correlationMethod: ['time_window'],
  };
}

describe('ValidationErrorPattern', () => {
  it('matches the real "X is required" DFGError family', () => {
    const g = group([
      entry({ message: 'Client contract id is required for client config based attribute', stackTrace: 'DFGError: Client contract id is required ... at ComponentTypeService.js:212' }),
      entry({ message: 'Error in getComponentTypeById - service', stackTrace: 'DFGError: ... ComponentTypeException.js:11' }),
    ]);
    const r = ValidationErrorPattern.match(g);
    expect(r.matched).toBe(true);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it('does not match unrelated messages', () => {
    const g = group([entry({ message: 'user logged in successfully' })]);
    expect(ValidationErrorPattern.match(g).matched).toBe(false);
  });
});

describe('root-service tracer + UpstreamDependencyPattern', () => {
  it('traces a socket hang up to the downstream root service via outbound call', () => {
    const g = group([
      entry({ message: 'Service Caller ERROR: POST http://nlb/verification-request/claim-items socket hang up' }),
      entry({ message: 'socket hang up', raw: { prevService: 'verification-request' } }),
    ]);
    const trace = traceRootService(g);
    expect(trace.isConnectionDrop).toBe(true);
    expect(trace.rootService).toBe('verification-request');
    expect(['outbound_call', 'prev_service']).toContain(trace.via);

    const r = UpstreamDependencyPattern.match(g);
    expect(r.matched).toBe(true);
    expect(r.evidence.join(' ')).toContain('verification-request');

    const suggestion = UpstreamDependencyPattern.getSuggestion(g);
    expect(suggestion).toContain('verification-request');
    expect(suggestion.toLowerCase()).toContain('root');
  });

  it('falls back to prevService when no URL is present', () => {
    const g = group([entry({ message: 'ECONNRESET', raw: { prevService: 'document-management-service' } })]);
    const trace = traceRootService(g);
    expect(trace.rootService).toBe('document-management-service');
    expect(trace.via).toBe('prev_service');
  });

  it('reports isConnectionDrop=false for non-hangup errors', () => {
    const g = group([entry({ message: 'some other error' })]);
    expect(traceRootService(g).isConnectionDrop).toBe(false);
  });
});
