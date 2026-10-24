#!/usr/bin/env node
/**
 * p1-ticket-builder MCP
 *
 * Builds a P1 bug-ticket payload (summary + a description that follows the DFG
 * P1 template + a machine-readable KIRO-EXEC block). It does NOT create the
 * ticket itself — it returns a payload you pass to the Jira MCP's
 * `jira_create_issue` tool. (MCP servers can't call each other; Kiro bridges.)
 *
 * Reference pattern: https://dataflowplus.atlassian.net/browse/DT-47018
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'p1-ticket-builder', version: '1.0.0' });

// ============================================================
// KIRO-EXEC block
// ============================================================

const kiroExecSchema = z
  .object({
    autonomy: z.enum(['propose', 'auto-mr', 'auto-merge']).default('auto-mr'),
    primary_repos: z.array(z.string()).default([]),
    context_repos: z.array(z.string()).default([]),
    multi_repo: z.boolean().default(false),
    base_branch: z.string().default('master'),
    target_branch: z.string().default('master'),
    hotfix: z.boolean().default(false),
    cherry_pick_to: z.array(z.string()).default([]),
    branch_name: z.string().default('auto'),
    reviewers: z.array(z.string()).default([]),
    tests_required: z.boolean().default(true),
    manual_testing_artifacts: z.boolean().default(true),
  })
  .default({});

type KiroExec = z.infer<typeof kiroExecSchema>;

function yamlList(items: string[]): string {
  return `[${items.join(', ')}]`;
}

function renderKiroExec(k: KiroExec): string {
  const lines = [
    '```',
    '# --- KIRO-EXEC ---',
    'schema_version: 1',
    `autonomy: ${k.autonomy}             # propose | auto-mr | auto-merge`,
    `primary_repos: ${yamlList(k.primary_repos)}   # must exist in the component→repo map`,
    `context_repos: ${yamlList(k.context_repos)}`,
    `multi_repo: ${k.multi_repo}             # true → one Jira subtask per repo; MR titles use subtask keys`,
    `base_branch: ${k.base_branch}`,
    `target_branch: ${k.target_branch}`,
    `hotfix: ${k.hotfix}                 # true → hotfix MR targets master first`,
    `cherry_pick_to: ${yamlList(k.cherry_pick_to)}`,
    `branch_name: ${k.branch_name}             # "auto" → <KEY>-<slug>`,
    `reviewers: ${yamlList(k.reviewers)}`,
    `tests_required: ${k.tests_required}`,
    `manual_testing_artifacts: ${k.manual_testing_artifacts}`,
    '# --- END KIRO-EXEC ---',
    '```',
  ];
  return lines.join('\n');
}

// ============================================================
// P1 ticket input schema
// ============================================================

const p1InputSchema = {
  title: z.string().describe('Short bug title (used in the summary after the [p1][TYPE] prefix)'),
  bugType: z.string().default('EXTERNAL_BUG').describe('Tag after [p1], e.g. EXTERNAL_BUG, INTERNAL_BUG, REGRESSION'),
  project: z.string().default('DT').describe('Jira project key'),
  scenario: z.string().describe('The bug scenario / root-cause narrative'),
  currentCase: z.string().optional().describe('Concrete current case + wrong data observed (IDs, names, matched dimensions)'),
  mitigationDone: z.boolean().default(false).describe('Has mitigation already been applied?'),
  regressionType: z.enum(['regression', 'not-regression']).default('not-regression'),
  regressionReason: z.string().optional().describe('Why it is / isn\'t a regression'),
  regressionCausedBy: z.string().default('N/A'),
  regressionTicket: z.string().default('N/A'),
  regressionDev: z.string().default('N/A'),
  regressionQA: z.string().default('N/A'),
  frequency: z.string().describe('Low/high frequency assessment + who is affected'),
  unhandledScenario: z.string().describe('What case scenario is not handled (the code-level gap)'),
  proposedSolution: z.union([z.string(), z.array(z.string())]).describe('Proposed fix — a paragraph or a list of steps'),
  utCoverage: z.string().describe('Should it be covered by unit tests? Yes/No + detail'),
  testAutomation: z.string().describe('Test automation needed? Yes/No + detail'),
  otherCasesImpacted: z.string().describe('Are other cases impacted? Y/N + detail'),
  labels: z.array(z.string()).default([]).describe('Jira labels'),
  components: z.array(z.string()).default([]).describe('Jira components'),
  kiroExec: kiroExecSchema.describe('The KIRO-EXEC automation block'),
};

// ============================================================
// Description renderer (matches the DT-47018 pattern)
// ============================================================

function renderDescription(input: any): string {
  const solution = Array.isArray(input.proposedSolution)
    ? input.proposedSolution.join('\n')
    : input.proposedSolution;

  const regressionLine =
    input.regressionType === 'regression'
      ? `Regression${input.regressionReason ? ` — ${input.regressionReason}` : ''}`
      : `Not-Regression${input.regressionReason ? ` (${input.regressionReason})` : ''}`;

  const parts: string[] = [];
  parts.push('**Debugging details and proposed solution:**');
  parts.push('');
  parts.push(`Scenario: ${input.scenario}`);
  if (input.currentCase) {
    parts.push('');
    parts.push(input.currentCase);
  }
  parts.push('');
  parts.push(`**Is Mitigation Done: ${input.mitigationDone ? 'Yes' : 'No'}**`);
  parts.push('');
  parts.push(`**Regression or not regression:** ${regressionLine}`);
  parts.push('');
  parts.push(`**Regression caused By: ${input.regressionCausedBy}**`);
  parts.push('');
  parts.push(`**Regression caused by Ticket: ${input.regressionTicket}**`);
  parts.push('');
  parts.push('**Dev/QA engineers who has worked on regression caused by Ticket:**');
  parts.push('');
  parts.push(`**Dev: ${input.regressionDev}**`);
  parts.push(`**QA: ${input.regressionQA}**`);
  parts.push('');
  parts.push(`**Low and high frequency:** ${input.frequency}`);
  parts.push('');
  parts.push(`**What is the case scenario which is not handled?** ${input.unhandledScenario}`);
  parts.push('');
  parts.push('**Proposed Solution:**');
  parts.push('');
  parts.push(solution);
  parts.push('');
  parts.push(`**Should it be covered as part of UT coverage?** ${input.utCoverage}`);
  parts.push('');
  parts.push(`**Test Automation?** ${input.testAutomation}`);
  parts.push('');
  parts.push(`**Is there any other cases Impacted?** ${input.otherCasesImpacted}`);
  parts.push('');
  parts.push('');
  parts.push(renderKiroExec(input.kiroExec));

  return parts.join('\n');
}

// ============================================================
// Tool: build_p1_ticket
// ============================================================

server.tool(
  'build_p1_ticket',
  'Build a P1 bug-ticket payload (summary + templated description + KIRO-EXEC block) following the DFG P1 pattern. Returns fields ready to pass to the Jira MCP tool `jira_create_issue` (project_key, issue_type=Bug, summary, description, plus priority/labels/components in additional_fields).',
  p1InputSchema,
  async (input) => {
    const summary = `[p1][${input.bugType}] ${input.title}`;
    const description = renderDescription(input);

    // `jira_create_issue` expects `additional_fields` as a JSON STRING
    // (per the current Jira MCP contract) — priority + labels go here.
    const additionalFields = JSON.stringify({
      priority: { name: 'P1 High' },
      labels: input.labels,
    });

    // These keys map 1:1 to the current jira_create_issue arguments, so the
    // caller can forward `jira_create_issue_args` verbatim — no transformation.
    const jiraCreateIssueArgs: Record<string, string> = {
      project_key: input.project,
      issue_type: 'Bug',
      summary,
      description,
      additional_fields: additionalFields,
    };
    if (input.components.length > 0) {
      jiraCreateIssueArgs.components = input.components.join(',');
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ready_for: 'jira_create_issue',
          note: 'Call the Jira MCP tool `jira_create_issue` with these arguments verbatim (additional_fields is already a JSON string).',
          jira_create_issue_args: jiraCreateIssueArgs,
        }, null, 2),
      }],
    };
  }
);

// ============================================================
// Tool: get_p1_template
// ============================================================

server.tool(
  'get_p1_template',
  'Return the P1 ticket input schema and a filled example (based on DT-47018) so callers know exactly what to provide to build_p1_ticket.',
  {},
  async () => {
    const example = {
      title: 'Wrong Past Cases Appearing in Report (CRN "NA" Expansion Bug)',
      bugType: 'EXTERNAL_BUG',
      project: 'DT',
      scenario: 'Case Discovery recursive expansion extracts clientReferenceNumber = "NA" ... returns thousands of unrelated cases as STRONG matches.',
      currentCase: 'Current case: S003-260607-63B7D ... Wrong past cases: S004-VR-15-200140, ... matched via matchedDimensions: "clientReferenceNumber".',
      mitigationDone: true,
      regressionType: 'not-regression',
      regressionReason: 'design gap — placeholder CRN "NA" was never excluded from expansion logic',
      frequency: 'High frequency — any applicant with a Savvion legacy past case (all have CRN = "NA") triggers this.',
      unhandledScenario: 'extractStrongIdentifiers() does not filter placeholder CRN values ("NA", "N/A") before using them as expansion search terms.',
      proposedSolution: [
        'In StrongIdentifierExtractor.ts → extractClientReferenceNumber(), add a blocklist of placeholder CRNs ("NA","N/A","NONE","-") and skip extraction.',
        'Consider a data backfill to normalize "NA" → null across Savvion CaseRecord docs in DynamoDB and OpenSearch.',
        'Add a unit test in StrongIdentifierExtractor.test.ts verifying placeholder CRNs are not extracted.',
      ],
      utCoverage: 'Yes — unit test asserting "NA"/placeholders are excluded from extraction.',
      testAutomation: 'Yes — integration test verifying expansion rounds do not fan out on placeholder CRNs.',
      otherCasesImpacted: 'Y — any case whose initial round finds a Savvion legacy past case triggers the same expansion bug.',
      labels: ['bug', 'high-frequency', 'not-regression', 'data-privacy', 'case-discovery'],
      components: ['Verification Platform', 'VP-VerificationRequestService'],
      kiroExec: {
        autonomy: 'auto-mr',
        primary_repos: ['verification-request'],
        context_repos: ['verification-search-service'],
        multi_repo: false,
        base_branch: 'master',
        target_branch: 'master',
        hotfix: false,
        cherry_pick_to: [],
        branch_name: 'auto',
        reviewers: ['himanshusharma5'],
        tests_required: true,
        manual_testing_artifacts: true,
      },
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summaryFormat: '[p1][<bugType>] <title>',
          priority: 'P1 High',
          issueType: 'Bug',
          fields: Object.keys(p1InputSchema),
          example,
        }, null, 2),
      }],
    };
  }
);

// ============================================================
// Start
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
