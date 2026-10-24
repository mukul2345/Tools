import type { AnalysisConfig } from '../types/index.js';

const MAX_TIME_RANGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export function validateConfig(config: AnalysisConfig): void {
  // Validate time range
  if (!config.timeRange || !config.timeRange.start || !config.timeRange.end) {
    throw new ConfigValidationError('timeRange with start and end dates is required');
  }

  if (config.timeRange.end <= config.timeRange.start) {
    throw new ConfigValidationError(
      'timeRange.end must be after timeRange.start'
    );
  }

  const rangeMs = config.timeRange.end.getTime() - config.timeRange.start.getTime();
  if (rangeMs > MAX_TIME_RANGE_MS) {
    throw new ConfigValidationError(
      `timeRange exceeds maximum of 7 days (got ${Math.round(rangeMs / (24 * 60 * 60 * 1000))} days)`
    );
  }

  // Validate services
  if (!config.services || !Array.isArray(config.services) || config.services.length === 0) {
    throw new ConfigValidationError('services must be a non-empty array');
  }

  // Validate error threshold
  if (config.errorThreshold == null || config.errorThreshold < 1) {
    throw new ConfigValidationError(
      'errorThreshold must be a positive integer (minimum 1)'
    );
  }

  // Validate namespace
  if (!config.namespace || config.namespace.trim().length === 0) {
    throw new ConfigValidationError('namespace is required');
  }

  // Validate outputFormat
  const validFormats = ['markdown', 'json', 'both'];
  if (!validFormats.includes(config.outputFormat)) {
    throw new ConfigValidationError(
      `outputFormat must be one of: ${validFormats.join(', ')}`
    );
  }

  // Validate maxLogEntries
  if (config.maxLogEntries != null && config.maxLogEntries < 1) {
    throw new ConfigValidationError('maxLogEntries must be a positive integer');
  }
}
