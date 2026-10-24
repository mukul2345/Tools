/**
 * Demo script to test the Proactive Error Analyser pipeline
 * 
 * This uses mock data simulating what we found during our real investigation:
 * - document-management-service path construction errors
 * - verification-request pre-validation-integrity-check 500→400 mismatch
 * - workflow engine DynamoDB accessor failures
 * 
 * Run with: npx tsx run-demo.ts
 */

import { CorrelationEngine } from './src/correlation/correlation-engine.js';
import { ErrorClassifier } from './src/classification/error-classifier.js';
import { StatusCodeMismatchPattern } from './src/classification/patterns/status-code-mismatch.js';
import { NullReferencePattern } from './src/classification/patterns/null-reference.js';
import { DDBThrottlingPattern } from './src/classification/patterns/ddb-throttling.js';
import { PathConstructionPattern } from './src/classification/patterns/path-construction.js';
import { TimeoutPattern } from './src/classification/patterns/timeout.js';
import { DiagnosisEngine } from './src/diagnosis/diagnosis-engine.js';
import { MarkdownReportGenerator } from './src/report/markdown-generator.js';
import { JsonReportGenerator } from './src/report/json-generator.js';

import type { CollectedData, AnalysisConfig, NormalizedLogEntry, EndpointErrorMetric, RuntimeErrorDetail } from './src/types/index.js';

// ============================================================
// Mock data based on our real investigation
// ============================================================

const now = new Date();
const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

// --- Error Metrics (from CloudWatch) ---

const docServiceErrors: EndpointErrorMetric = {
  service: 'document-management-service',
  endpoint: '/extractDocument/v2/analyze-verification',
  statusCode: 500,
  totalCount: 2499,
  timestamps: [
    new Date('2026-05-29T06:00:00Z'),
    new Date('2026-05-29T06:01:00Z'),
    new Date('2026-05-29T06:02:00Z'),
  ],
  values: [833, 833, 833],
  peakCount: 833,
  peakTimestamp: new Date('2026-05-29T06:00:00Z'),
};

const preValidationErrors: EndpointErrorMetric = {
  service: 'verification-request',
  endpoint: '/verification-request/:id/pre-validation-integrity-check',
  statusCode: 500,
  totalCount: 12,
  timestamps: [new Date('2026-05-29T06:00:00Z')],
  values: [12],
  peakCount: 12,
  peakTimestamp: new Date('2026-05-29T06:00:00Z'),
};

const workflowErrors: EndpointErrorMetric = {
  service: 'verification-workflow-engine',
  endpoint: '/workflow/:id',
  statusCode: 500,
  totalCount: 321,
  timestamps: [
    new Date('2026-05-29T05:00:00Z'),
    new Date('2026-05-29T05:30:00Z'),
    new Date('2026-05-29T06:00:00Z'),
  ],
  values: [107, 107, 107],
  peakCount: 107,
  peakTimestamp: new Date('2026-05-29T06:00:00Z'),
};

// --- Log Entries ---

const docServiceLogs: NormalizedLogEntry[] = [
  {
    timestamp: new Date('2026-05-29T06:00:01Z'),
    level: 'ERROR',
    message: 'Error in convertpdfToImage: ',
    service: 'document-management-service',
    endpoint: '/extractDocument/v2/analyze-verification',
    traceId: 'BFFTraceId@ffe5addc-f660-401f-b24b-d45ed72c1643',
    requestId: 'BFFTraceId@ffe5addc-f660-401f-b24b-d45ed72c1643',
    stackTrace: 'Error: Command failed: gm convert: Unable to open file (/usr/src/app/build/modules/userDocument/usr/src/app/downloads9f1c5a1a-9f60-4bbc-bc5a-59ee011a997c/e2e23d28ea84f8276e2b95511f7d383c.1.webp) [No such file or directory].\n    at ChildProcess.onExit (/usr/src/app/node_modules/.pnpm/gm@1.25.1/node_modules/gm/lib/command.js:318:17)\n    at ChildProcess.emit (node:events:517:28)\n    at maybeClose (node:internal/child_process:1098:16)',
    raw: {
      prevService: 'document-generation-service',
      portal: 'ops',
      referer: 'https://0.0.0.0:80/en/verify-details?caseId=M004-260506-699D4-DCE',
      callScopeId: 'DOCUMENT-MANAGEMENT-SERVICE_CallId@880f49bd-fd61-44c1-86e1-bc4abbbd56d1',
      ecsTaskId: '2a118556ed47421d933be197e56282b9-2509618986',
    },
  },
  {
    timestamp: new Date('2026-05-29T06:00:02Z'),
    level: 'ERROR',
    message: 'Unable to Process Request due to Server Error in convertpdfToImage',
    service: 'document-management-service',
    endpoint: '/extractDocument/v2/analyze-verification',
    traceId: 'BFFTraceId@ffe5addc-f660-401f-b24b-d45ed72c1643',
    raw: {
      prevService: 'document-generation-service',
      callScopeId: 'DOCUMENT-MANAGEMENT-SERVICE_CallId@880f49bd-fd61-44c1-86e1-bc4abbbd56d1',
    },
  },
  {
    timestamp: new Date('2026-05-29T06:00:03Z'),
    level: 'ERROR',
    message: 'Error in creating thumbnail',
    service: 'document-management-service',
    endpoint: '/extractDocument/v2/analyze-verification',
    traceId: 'BFFTraceId@ffe5addc-f660-401f-b24b-d45ed72c1643',
    stackTrace: 'DFGError: Unable to Process Request due to Server Error in convertpdfToImage\n    at convertpdfToImage (/usr/src/app/build/modules/userDocument/UserDocumentUtils.js:31:15)\n    at async getThumbnail (/usr/src/app/build/modules/userDocument/UserDocumentUtils.js:43:26)\n    at async UserDocumentService.saveFileThumbNail (/usr/src/app/build/modules/userDocument/UserDocumentService.js:208:35)',
    raw: {
      prevService: 'document-generation-service',
      callScopeId: 'DOCUMENT-MANAGEMENT-SERVICE_CallId@880f49bd-fd61-44c1-86e1-bc4abbbd56d1',
    },
  },
];

const preValidationLogs: NormalizedLogEntry[] = [
  {
    timestamp: new Date('2026-05-29T06:00:00Z'),
    level: 'ERROR',
    message: 'Error from VerificationRequestService preValidationIntegrityCheck   Set of component type inclusion is not satisfied',
    service: 'verification-request',
    endpoint: '/verification-request/:id/pre-validation-integrity-check',
    traceId: 'VERIFICATION-REQUESTTraceId@3d45aa4f-93c8-4b7d-b9d4-220145f2bbde',
    requestId: 'VERIFICATION-REQUESTTraceId@3d45aa4f-93c8-4b7d-b9d4-220145f2bbde',
    statusCode: 500,
    stackTrace: 'DFGError: Set of component type inclusion is not satisfied\n    at VerificationRequestService.validateComponentSetRequirements (/usr/src/app/build/modules/verificationRequest/VerificationRequestService.js:6058:27)\n    at VerificationRequestService.preValidationIntegrityCheck (/usr/src/app/build/modules/verificationRequest/VerificationRequestService.js:1227:22)\n    at async VerificationRequestService.executePostPaymentTasks (/usr/src/app/build/modules/verificationRequest/VerificationRequestService.js:5644:17)\n    at async VerificationRequestService.updatePaymentContracts (/usr/src/app/build/modules/verificationRequest/VerificationRequestService.js:2692:13)\n    at async updatePaymentContractsV2 (/usr/src/app/build/modules/verificationRequest/VerificationRequestController.js:398:13)',
    raw: {
      prevService: 'verification-workflow-engine',
      originalUrl: '/verification-request/VerificationRequest@9f0ab085-b70f-4397-ac99-5fa8fb3cbb0c/pre-validation-integrity-check',
      method: 'PATCH',
      callScopeId: 'VERIFICATION-REQUEST_CallId@2d26af1b-1414-4056-a694-03ee387417cc',
    },
  },
];

const workflowRuntimeErrors: RuntimeErrorDetail[] = [
  {
    workflowId: 'B003-260511-3F64C-1BF',
    traceId: 'WorkflowTraceId@e099be47-c906-4437-8525-665b56567c6c_1',
    errorMessage: 'DFGError: SOMETHING_WENT_WRONG at WorkflowDataAccessorDDbImpl.getWorkflowsInternal',
    timestamp: new Date('2026-05-29T06:01:35Z'),
    stage: 'VERIFICATION',
    state: 'IN_PROGRESS',
  },
  {
    workflowId: 'C001-260413-A8FB7-CEB',
    traceId: 'WorkflowTraceId@7865037d-4be4-4d67-81a5-76f550aba117_1',
    errorMessage: 'DFGError: SOMETHING_WENT_WRONG at WorkflowDataAccessorDDbImpl.getWorkflowsInternal',
    timestamp: new Date('2026-05-29T06:21:38Z'),
    stage: 'VERIFICATION',
    state: 'IN_PROGRESS',
  },
];

// ============================================================
// Run the pipeline
// ============================================================

async function main() {
  console.log('🔍 Proactive Error Analyser — Demo Run\n');
  console.log('=' .repeat(60));

  const startTime = Date.now();

  // Step 1: Assemble collected data (normally done by DataFetcher)
  const collectedData: CollectedData = {
    metrics: [
      {
        service: 'document-management-service',
        timeRange: { start: oneHourAgo, end: now },
        errorMetrics: [docServiceErrors],
        latencyMetrics: [],
        fetchedAt: now,
      },
      {
        service: 'verification-request',
        timeRange: { start: oneHourAgo, end: now },
        errorMetrics: [preValidationErrors],
        latencyMetrics: [],
        fetchedAt: now,
      },
      {
        service: 'verification-workflow-engine',
        timeRange: { start: oneHourAgo, end: now },
        errorMetrics: [workflowErrors],
        latencyMetrics: [],
        fetchedAt: now,
      },
    ],
    runtimeErrors: {
      errors: [
        {
          definitionName: 'CLAIM_VERIFICATION_WORKFLOW',
          subType: null,
          stage: 'VERIFICATION',
          state: 'IN_PROGRESS',
          count: 198,
          details: workflowRuntimeErrors,
        },
      ],
      fetchedAt: now,
    },
    logs: [
      { service: 'document-management-service', entries: docServiceLogs, fetchedAt: now },
      { service: 'verification-request', entries: preValidationLogs, fetchedAt: now },
    ],
  };

  // Step 2: Correlate
  console.log('\n📊 Step 1: Correlating error signals...');
  const correlationEngine = new CorrelationEngine();
  const correlatedGroups = correlationEngine.correlate(collectedData);
  console.log(`   Found ${correlatedGroups.length} correlated error groups`);

  for (const group of correlatedGroups) {
    console.log(`   - ${group.service}/${group.endpoint}: ${group.errorCount} errors [${group.correlationConfidence} confidence]`);
  }

  // Step 3: Classify
  console.log('\n🏷️  Step 2: Classifying errors...');
  const classifier = new ErrorClassifier();
  classifier.registerPattern(StatusCodeMismatchPattern);
  classifier.registerPattern(NullReferencePattern);
  classifier.registerPattern(DDBThrottlingPattern);
  classifier.registerPattern(PathConstructionPattern);
  classifier.registerPattern(TimeoutPattern);

  const classifiedErrors = correlatedGroups.map((group) => classifier.classify(group));

  for (const classified of classifiedErrors) {
    console.log(`   - [${classified.severity.toUpperCase()}] ${classified.category}: ${classified.group.service}/${classified.group.endpoint} (confidence: ${(classified.confidence * 100).toFixed(0)}%)`);
  }

  // Step 4: Diagnose
  console.log('\n🩺 Step 3: Generating diagnosis...');
  const config: AnalysisConfig = {
    timeRange: { start: oneHourAgo, end: now },
    services: ['document-management-service', 'verification-request', 'verification-workflow-engine'],
    namespace: 'DFG-Observability',
    errorThreshold: 10,
    includeLatencyAnalysis: false,
    includeAnomalyDetection: false,
    outputFormat: 'both',
    maxLogEntries: 500,
  };

  const diagnosisEngine = new DiagnosisEngine();
  const report = diagnosisEngine.diagnose(classifiedErrors, config, startTime);

  // Step 5: Generate reports
  console.log('\n📝 Step 4: Generating reports...\n');
  console.log('=' .repeat(60));

  const markdownGenerator = new MarkdownReportGenerator();
  const markdown = markdownGenerator.generateMarkdown(report);
  
  // Save to file
  const fs = await import('fs');
  const path = await import('path');
  const outputDir = path.join(import.meta.dirname || '.', 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `error-analysis-${timestamp}.md`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, markdown, 'utf-8');
  
  console.log(`📄 Report saved to: ${filepath}`);
  console.log('');
  console.log(markdown);

  // Summary
  console.log('\n' + '=' .repeat(60));
  const jsonGenerator = new JsonReportGenerator();
  console.log(`\n✅ ${jsonGenerator.generateSummary(report)}`);
  console.log(`   Duration: ${report.metadata.duration}ms`);
  console.log(`   Report: ${filepath}`);
}

main().catch(console.error);
