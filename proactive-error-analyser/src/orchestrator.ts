/**
 * Orchestrator
 *
 * Wires together all components of the Proactive Error Analyser:
 * config validation → data fetching → correlation → classification → diagnosis → reporting.
 */

import { validateConfig } from './config/validator.js';
import { DataFetcher, identifyHotEndpoints } from './fetchers/data-fetcher.js';
import { CorrelationEngine } from './correlation/correlation-engine.js';
import { ErrorClassifier } from './classification/error-classifier.js';
import { StatusCodeMismatchPattern } from './classification/patterns/status-code-mismatch.js';
import { NullReferencePattern } from './classification/patterns/null-reference.js';
import { DDBThrottlingPattern } from './classification/patterns/ddb-throttling.js';
import { PathConstructionPattern } from './classification/patterns/path-construction.js';
import { TimeoutPattern } from './classification/patterns/timeout.js';
import { ValidationErrorPattern } from './classification/patterns/validation-error.js';
import { UpstreamDependencyPattern } from './classification/patterns/upstream-dependency.js';
import { AuthErrorPattern } from './classification/patterns/auth-error.js';
import { DiagnosisEngine } from './diagnosis/diagnosis-engine.js';
import { MarkdownReportGenerator } from './report/markdown-generator.js';
import { JsonReportGenerator } from './report/json-generator.js';

import type { AnalysisConfig, ClassifiedError, DiagnosisReport } from './types/index.js';
import type { AnalysisStatus, IOrchestrator } from './types/interfaces.js';
import type { WorkflowMCPClient } from './fetchers/workflow-mcp-fetcher.js';

// --- Orchestrator ---

export class Orchestrator implements IOrchestrator {
  private readonly mcpClient: WorkflowMCPClient;
  private status: AnalysisStatus = 'idle';
  private cancelled = false;

  constructor(mcpClient: WorkflowMCPClient) {
    this.mcpClient = mcpClient;
  }

  getStatus(): AnalysisStatus {
    return this.status;
  }

  cancel(): void {
    this.cancelled = true;
    this.status = 'idle';
  }

  async startAnalysis(config: AnalysisConfig): Promise<DiagnosisReport> {
    const startTime = Date.now();
    this.cancelled = false;

    try {
      // Step 1: Validate configuration
      validateConfig(config);

      // Step 2: Fetch data
      this.status = 'fetching';
      this.checkCancelled();

      const dataFetcher = new DataFetcher(this.mcpClient);
      const collectedData = await dataFetcher.fetchAll(config);

      // Step 3: Correlate
      this.status = 'correlating';
      this.checkCancelled();

      const correlationEngine = new CorrelationEngine();
      const correlatedGroups = correlationEngine.correlate(collectedData);

      // Step 4: Classify
      this.status = 'classifying';
      this.checkCancelled();

      const classifier = this.buildClassifier();
      const classifiedErrors: ClassifiedError[] = correlatedGroups.map((group) =>
        classifier.classify(group),
      );

      // Step 5: Diagnose
      this.status = 'diagnosing';
      this.checkCancelled();

      const diagnosisEngine = new DiagnosisEngine();
      const report = diagnosisEngine.diagnose(classifiedErrors, config, startTime);

      // Step 6: Generate report in requested format
      this.generateOutput(report, config.outputFormat);

      this.status = 'complete';
      return report;
    } catch (error) {
      if (this.cancelled) {
        this.status = 'idle';
      } else {
        this.status = 'error';
      }
      throw error;
    }
  }

  async startAnalysisForService(service: string, config: AnalysisConfig): Promise<DiagnosisReport> {
    const serviceConfig: AnalysisConfig = {
      ...config,
      services: [service],
    };
    return this.startAnalysis(serviceConfig);
  }

  // --- Private Helpers ---

  private buildClassifier(): ErrorClassifier {
    const classifier = new ErrorClassifier();
    classifier.registerPattern(StatusCodeMismatchPattern);
    classifier.registerPattern(NullReferencePattern);
    classifier.registerPattern(DDBThrottlingPattern);
    classifier.registerPattern(PathConstructionPattern);
    classifier.registerPattern(TimeoutPattern);
    classifier.registerPattern(ValidationErrorPattern);
    classifier.registerPattern(UpstreamDependencyPattern);
    classifier.registerPattern(AuthErrorPattern);
    return classifier;
  }

  private generateOutput(
    report: DiagnosisReport,
    format: AnalysisConfig['outputFormat'],
  ): { markdown?: string; json?: object } {
    const result: { markdown?: string; json?: object } = {};

    if (format === 'markdown' || format === 'both') {
      const markdownGenerator = new MarkdownReportGenerator();
      result.markdown = markdownGenerator.generateMarkdown(report);
    }

    if (format === 'json' || format === 'both') {
      const jsonGenerator = new JsonReportGenerator();
      result.json = jsonGenerator.generateJSON(report);
    }

    return result;
  }

  private checkCancelled(): void {
    if (this.cancelled) {
      throw new Error('Analysis cancelled');
    }
  }
}

// --- Convenience Function ---

/**
 * One-shot analysis function. Creates an Orchestrator, runs the analysis, and returns the report.
 */
export async function analyze(
  config: AnalysisConfig,
  mcpClient: WorkflowMCPClient,
): Promise<DiagnosisReport> {
  const orchestrator = new Orchestrator(mcpClient);
  return orchestrator.startAnalysis(config);
}
