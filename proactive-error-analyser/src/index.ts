/**
 * Proactive Error Analyser - Public API
 */

export { Orchestrator, analyze } from './orchestrator.js';
export { DataFetcher, identifyHotEndpoints } from './fetchers/data-fetcher.js';
export { CorrelationEngine, correlate } from './correlation/correlation-engine.js';
export { ErrorClassifier } from './classification/error-classifier.js';
export { DiagnosisEngine } from './diagnosis/diagnosis-engine.js';
export { MarkdownReportGenerator } from './report/markdown-generator.js';
export { JsonReportGenerator } from './report/json-generator.js';
export { validateConfig } from './config/validator.js';

// Types
export type * from './types/index.js';
export type * from './types/interfaces.js';

// Fetcher types
export type { WorkflowMCPClient } from './fetchers/workflow-mcp-fetcher.js';
