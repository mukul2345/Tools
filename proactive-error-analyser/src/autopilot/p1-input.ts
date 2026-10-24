/**
 * P1 ticket-input builder (autopilot)
 *
 * Maps a DiagnosedIssue from the analyser into the exact input object that the
 * `p1-ticket-builder` MCP tool `build_p1_ticket` expects.
 *
 * CRITICAL DESIGN CHOICE — "no proposed solution":
 * The `build_p1_ticket` schema *requires* a `proposedSolution` and always renders
 * a "**Proposed Solution:**" section, so we cannot omit it. To honour "let the
 * agent come up with its own solution", we emit an explicit SENTINEL that tells
 * the downstream bugfix agent NOT to trust any prose fix. Combined with the fact
 * that the KIRO-EXEC block emitted by build_p1_ticket carries NO `spec_source`
 * field, the bugfix agent's fixer defaults `spec_source` to `analyzer` — i.e. it
 * runs its own Opus analyzer, derives `findings.md`, and only proceeds when
 * `alignment == aligned`. So the ticket deliberately contains no human solution;
 * the agent devises and implements its own.
 *
 * This module only BUILDS the input. It does not talk to Jira (that goes through
 * the `build_p1_ticket` MCP tool → `jira_create_issue`, bridged by kiro-cli).
 */

import * as crypto from 'crypto';
import type { DiagnosedIssue } from '../types/index.js';

/**
 * Stable dedup fingerprint for an issue: a Jira label derived from
 * service + endpoint. The autopilot searches for this label BEFORE creating a
 * ticket, so a recurring error re-uses / skips the existing ticket instead of
 * filing a duplicate. Label chars are restricted (no '/'), so we hash the
 * endpoint. Example: autopilot-a1b2c3d4
 */
export function fingerprintLabel(service: string, endpoint: string): string {
  const h = crypto
    .createHash('sha1')
    .update(`${service}::${endpoint}`)
    .digest('hex')
    .slice(0, 8);
  return `autopilot-${h}`;
}

/** Sentinel proposed-solution — signals "no human fix; agent must derive it". */
export const NO_HUMAN_SOLUTION_SENTINEL =
  'NONE PROVIDED — this ticket intentionally has no human proposed solution. ' +
  'The automated fix agent (jira-gitlab-bugfix-agents-v2) must independently ' +
  'diagnose the root cause from the analyzer findings and implement its own fix. ' +
  'Do NOT treat this section as a spec (KIRO-EXEC has no spec_source, so the ' +
  'analyzer path is used).';

/** The KIRO-EXEC sub-object accepted by build_p1_ticket (spec_source is NOT a field). */
export interface KiroExecInput {
  autonomy: 'propose' | 'auto-mr' | 'auto-merge';
  primary_repos: string[];
  context_repos: string[];
  multi_repo: boolean;
  base_branch: string;
  target_branch: string;
  hotfix: boolean;
  cherry_pick_to: string[];
  branch_name: string;
  reviewers: string[];
  tests_required: boolean;
  manual_testing_artifacts: boolean;
}

/** The full input object for the build_p1_ticket MCP tool. */
export interface BuildP1TicketInput {
  title: string;
  bugType: string;
  project: string;
  scenario: string;
  currentCase?: string;
  mitigationDone: boolean;
  regressionType: 'regression' | 'not-regression';
  regressionReason?: string;
  frequency: string;
  unhandledScenario: string;
  proposedSolution: string;
  utCoverage: string;
  testAutomation: string;
  otherCasesImpacted: string;
  labels: string[];
  components: string[];
  kiroExec: KiroExecInput;
}

export interface AutopilotP1Options {
  /** Jira project key. Default 'DT'. */
  project?: string;
  /** MR autonomy. Default 'auto-mr' (create+push MR, never merge). */
  autonomy?: 'propose' | 'auto-mr' | 'auto-merge';
  /** Fork/base branch the fix targets. Default 'develop' (DFG working branch). */
  baseBranch?: string;
  /** Optional explicit primary repos; when omitted the agent resolves from components. */
  primaryRepos?: string[];
  /** Optional reviewers. */
  reviewers?: string[];
}

/** Map an analyser service name to a likely GitLab repo / component hint. */
function evidenceSnippet(issue: DiagnosedIssue, max = 8): string {
  const lines = (issue.evidence || [])
    .slice(0, max)
    .map((e) => `- [${e.source}] ${e.description}: ${String(e.data).slice(0, 300)}`);
  return lines.length > 0 ? lines.join('\n') : '- (no log evidence captured)';
}

/**
 * Build the build_p1_ticket input for a single diagnosed issue.
 * The proposedSolution is ALWAYS the sentinel — the agent derives the real fix.
 */
export function buildP1InputFromIssue(
  issue: DiagnosedIssue,
  opts: AutopilotP1Options = {},
): BuildP1TicketInput {
  const project = opts.project ?? 'DT';
  const autonomy = opts.autonomy ?? 'auto-mr';
  const baseBranch = opts.baseBranch ?? 'develop';

  // For a traced socket-hangup (upstream_dependency), the fix belongs in the ROOT
  // service, not the surface service. The classifier put the root service on the
  // issue's rootCause ("Root service (traced via ...): <svc>"). Extract it so the
  // ticket routes there via primary_repos, unless the caller pinned repos.
  let tracedRoot: string | null = null;
  if (issue.category === 'upstream_dependency') {
    const m = (issue.rootCause || '').match(/Root service \(traced via [^)]+\):\s*([a-z0-9-]+)/i);
    if (m && m[1] && m[1].toLowerCase() !== issue.service.toLowerCase()) {
      tracedRoot = m[1].toLowerCase();
    }
  }
  const primaryRepos = opts.primaryRepos ?? (tracedRoot ? [tracedRoot] : []);

  const isUnclassified = issue.category === 'unclassified';

  const scenario =
    `Auto-detected by proactive-error-analyser. ${issue.service} endpoint ` +
    `\`${issue.endpoint}\` produced ${issue.errorCount} error(s) classified as ` +
    `[${issue.category}] (severity: ${issue.severity}). ${issue.description}` +
    (isUnclassified
      ? `\n\n**Unclassified error:** no known error pattern matched. The available ` +
        `signal is the CloudWatch error metric (count + endpoint + timestamps)` +
        `${(issue.evidence && issue.evidence.length > 0) ? ' plus the log evidence below' : ' (no log evidence was captured)'}. ` +
        `The fix agent must investigate the endpoint's controller + service code ` +
        `from scratch, reproduce/reason about the failure, and attempt a fix.`
      : '') +
    (tracedRoot
      ? `\n\n**Cross-service note:** this is a connection-drop that propagated from ` +
        `the root service \`${tracedRoot}\`. The fix most likely belongs in ` +
        `\`${tracedRoot}\`, not in the surface service \`${issue.service}\`.`
      : '');

  const currentCase =
    `**Root-cause hypothesis (analyzer, to be verified by the fix agent):** ` +
    `${issue.rootCause}\n\n**Evidence:**\n${evidenceSnippet(issue)}`;

  return {
    title: issue.title || `${issue.service} ${issue.endpoint} — ${issue.category}`,
    bugType: 'INTERNAL_BUG',
    project,
    scenario,
    currentCase,
    mitigationDone: false,
    regressionType: 'not-regression',
    regressionReason: 'Auto-detected from production error metrics; regression status not yet assessed.',
    frequency: `${issue.errorCount} occurrences in the analysis window (severity ${issue.severity}).`,
    unhandledScenario: isUnclassified
      ? `Unknown — no pattern matched. The fix agent must determine the code-level gap by tracing the \`${issue.endpoint}\` handler and its downstream calls.`
      : (issue.rootCause || 'See analyzer findings; the code-level gap is to be confirmed by the fix agent.'),
    // Intentionally NO real solution — the agent devises its own.
    proposedSolution: NO_HUMAN_SOLUTION_SENTINEL,
    utCoverage: 'Yes — the fix agent must add/adjust unit tests covering the failing path.',
    testAutomation: 'To be decided by the fix agent based on the fix scope.',
    otherCasesImpacted: 'Unknown — the fix agent should assess sibling call paths.',
    labels: ['bug', 'auto-detected', 'proactive-error-analyser', issue.category, issue.severity, fingerprintLabel(issue.service, issue.endpoint)]
      .concat(tracedRoot ? [`root:${tracedRoot}`] : []),
    components: [],
    kiroExec: {
      autonomy,
      primary_repos: primaryRepos,
      context_repos: [],
      multi_repo: false,
      base_branch: baseBranch,
      target_branch: baseBranch,
      hotfix: false,
      cherry_pick_to: [],
      branch_name: 'auto',
      reviewers: opts.reviewers ?? [],
      tests_required: true,
      manual_testing_artifacts: true,
    },
  };
}
