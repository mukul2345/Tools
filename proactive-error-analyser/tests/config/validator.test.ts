import { describe, it, expect } from 'vitest';
import { validateConfig, ConfigValidationError } from '../../src/config/validator.js';
import type { AnalysisConfig } from '../../src/types/index.js';

function makeValidConfig(overrides: Partial<AnalysisConfig> = {}): AnalysisConfig {
  return {
    timeRange: {
      start: new Date('2025-01-20T00:00:00Z'),
      end: new Date('2025-01-21T00:00:00Z'),
    },
    services: ['verification-request', 'verification-workflow-engine'],
    namespace: 'DFG-Observability',
    errorThreshold: 10,
    includeLatencyAnalysis: true,
    includeAnomalyDetection: false,
    outputFormat: 'both',
    maxLogEntries: 500,
    ...overrides,
  };
}

describe('validateConfig', () => {
  it('should pass with a valid config', () => {
    expect(() => validateConfig(makeValidConfig())).not.toThrow();
  });

  describe('timeRange validation', () => {
    it('should reject when end is before start', () => {
      const config = makeValidConfig({
        timeRange: {
          start: new Date('2025-01-21T00:00:00Z'),
          end: new Date('2025-01-20T00:00:00Z'),
        },
      });
      expect(() => validateConfig(config)).toThrow(ConfigValidationError);
      expect(() => validateConfig(config)).toThrow('end must be after');
    });

    it('should reject when end equals start', () => {
      const same = new Date('2025-01-20T00:00:00Z');
      const config = makeValidConfig({
        timeRange: { start: same, end: same },
      });
      expect(() => validateConfig(config)).toThrow('end must be after');
    });

    it('should reject time range exceeding 7 days', () => {
      const config = makeValidConfig({
        timeRange: {
          start: new Date('2025-01-01T00:00:00Z'),
          end: new Date('2025-01-09T00:00:00Z'), // 8 days
        },
      });
      expect(() => validateConfig(config)).toThrow('exceeds maximum of 7 days');
    });

    it('should accept exactly 7 days', () => {
      const config = makeValidConfig({
        timeRange: {
          start: new Date('2025-01-01T00:00:00Z'),
          end: new Date('2025-01-08T00:00:00Z'), // exactly 7 days
        },
      });
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('services validation', () => {
    it('should reject empty services array', () => {
      const config = makeValidConfig({ services: [] });
      expect(() => validateConfig(config)).toThrow('non-empty array');
    });

    it('should reject undefined services', () => {
      const config = makeValidConfig({ services: undefined as unknown as string[] });
      expect(() => validateConfig(config)).toThrow('non-empty array');
    });
  });

  describe('errorThreshold validation', () => {
    it('should reject zero threshold', () => {
      const config = makeValidConfig({ errorThreshold: 0 });
      expect(() => validateConfig(config)).toThrow('positive integer');
    });

    it('should reject negative threshold', () => {
      const config = makeValidConfig({ errorThreshold: -5 });
      expect(() => validateConfig(config)).toThrow('positive integer');
    });

    it('should accept threshold of 1', () => {
      const config = makeValidConfig({ errorThreshold: 1 });
      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('namespace validation', () => {
    it('should reject empty namespace', () => {
      const config = makeValidConfig({ namespace: '' });
      expect(() => validateConfig(config)).toThrow('namespace is required');
    });

    it('should reject whitespace-only namespace', () => {
      const config = makeValidConfig({ namespace: '   ' });
      expect(() => validateConfig(config)).toThrow('namespace is required');
    });
  });

  describe('outputFormat validation', () => {
    it('should reject invalid format', () => {
      const config = makeValidConfig({ outputFormat: 'xml' as any });
      expect(() => validateConfig(config)).toThrow('outputFormat must be one of');
    });

    it('should accept markdown', () => {
      const config = makeValidConfig({ outputFormat: 'markdown' });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept json', () => {
      const config = makeValidConfig({ outputFormat: 'json' });
      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});
