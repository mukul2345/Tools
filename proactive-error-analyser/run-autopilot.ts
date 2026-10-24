#!/usr/bin/env npx tsx
/**
 * run-autopilot.ts — End-to-end automation pipeline driven from the analyser.
 *
 * CHAIN:
 *   1. Run the existing live error analysis (run-live.ts) UNCHANGED. Logs are
 *      streamed to disk (logs/<runId>/, retained for future context — not in
 *      memory, not deleted).
 *   2. Filter the report to critical/high issues.
 *   3. For each issue, build the `build_p1_ticket` MCP input with a SENTINEL
 *      proposedSolution (no human fix) so the bugfix agent devises its own.
 *      KIRO-EXEC is always emitted with autonomy=auto-mr (create+push MR, no merge).
 *   4. Create the ticket + trigger the bugfix agent. Two mechanisms:
 *        (a) DEFAULT — shell `bin/run-autopilot.sh <jobFile>` which uses kiro-cli
 *            to call build_p1_ticket → jira_create_issue (MCP bridge), then runs
 *            jira-gitlab-bugfix-agents-v2's run-bugfix-pipeline.sh headless.
 *        (b) --emit-only — write job files + a plan, take NO side effects
 *            (safe default for review / dry-run).
 *
 * This orchestrator PRESERVES each underlying tool. run-live.ts only gained an
 * exported entrypoint + on-disk log streaming; the P1 MCP and bugfix agent are
 * unmodified and invoked through their public interfaces.
 *
 * Usage:
 *   # Dry-run: analyse + emit P1 job files, no tickets/MRs
 *   npx tsx run-autopilot.ts --emit-only --days 1 --threshold 20
 *
 *   # Full autopilot: analyse → create tickets → open MRs (headless)
 *   AWS_REGION=eu-west-1 KIRO_API_KEY=... npx tsx run-autopilot.ts --run --days 1 --threshold 20
 *
 * Flags (analysis flags are passed through to run-live via argv):
 *   --run                 Actually create tickets + trigger the bugfix agent.
 *   --emit-only           (default) Only analyse + write job files. No side effects.
 *   --severity C,H        Which severities to act on (default: critical,high).
 *   --max-tickets N       Cap tickets created per run (default: 5).
 *   --project KEY         Jira project key (default: DT).
 *   --autonomy MODE       propose | auto-mr | auto-merge (default: auto-mr).
 *   --base-branch NAME    Fix base/target branch (default: develop).
 *   --prefixes DT,VP      Passed to the bugfix pipeline (default: DT).
 *   --days / --threshold / --services / --start / --end   → passed to run-live.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { runLiveAnalysis } from './run-live.js';
import { buildP1InputFromIssue, fingerprintLabel } from './src/autopilot/p1-input.js';
import type { DiagnosedIssue } from './src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AutopilotArgs {
  run: boolean;
  severities: Set<string>;
  maxTickets: number;
  project: string;
  autonomy: 'propose' | 'auto-mr' | 'auto-merge';
  baseBranch: string;
  prefixes: string;
  includeUnclassified: boolean;
}

function parseAutopilotArgs(): AutopilotArgs {
  const argv = process.argv.slice(2);
  const out: AutopilotArgs = {
    run: false,
    severities: new Set(['critical', 'high']),
    maxTickets: 5,
    project: 'DT',
    autonomy: 'auto-mr',
    baseBranch: 'develop',
    prefixes: 'DT',
    includeUnclassified: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.run = true;
    else if (a === '--emit-only') out.run = false;
    else if (a === '--include-unclassified') out.includeUnclassified = true;
    else if (a === '--severity') out.severities = new Set(argv[++i].split(',').map((s) => normalizeSeverity(s)));
    else if (a === '--max-tickets') out.maxTickets = parseInt(argv[++i], 10);
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--autonomy') out.autonomy = argv[++i] as AutopilotArgs['autonomy'];
    else if (a === '--base-branch') out.baseBranch = argv[++i];
    else if (a === '--prefixes') out.prefixes = argv[++i];
  }
  return out;
}

function normalizeSeverity(s: string): string {
  const t = s.trim().toLowerCase();
  if (t === 'c') return 'critical';
  if (t === 'h') return 'high';
  if (t === 'm') return 'medium';
  if (t === 'l') return 'low';
  return t;
}

async function main() {
  const opts = parseAutopilotArgs();

  console.log('🤖 Proactive Error Analyser — AUTOPILOT');
  console.log('='.repeat(70));
  console.log(`  Mode: ${opts.run ? 'RUN (create tickets + trigger fix agent)' : 'EMIT-ONLY (dry-run, no side effects)'}`);
  console.log(`  Act on severities: ${[...opts.severities].join(', ')}`);
  console.log(`  Max tickets: ${opts.maxTickets} · Project: ${opts.project} · Autonomy: ${opts.autonomy} · Base: ${opts.baseBranch}`);
  console.log('='.repeat(70));

  // --- Step 1+2: run the existing live analysis (logs stream to disk) ---
  const analysis = await runLiveAnalysis();
  if (!analysis) {
    console.log('\n🎉 All clear — nothing to do.');
    return;
  }
  const { report, mdPath, jsonPath, logsRoot, runId } = analysis;

  // --- Step 3: filter to actionable issues ---
  // Default: only classified issues that pass the severity filter.
  // --include-unclassified: ALSO act on unclassified issues (the bug fixer will
  // investigate from scratch). For unclassified we bypass the severity floor when
  // there is a real error cluster (errorCount > 5), since an unclassified error
  // has no category to raise its severity but is still a genuine prod failure.
  const UNCLASSIFIED_MIN_ERRORS = 5;
  const actionable: DiagnosedIssue[] = report.issues
    .filter((i) => {
      if (i.category !== 'unclassified') {
        // classified issue → normal severity gate
        return opts.severities.has(i.severity);
      }
      // unclassified issue
      if (!opts.includeUnclassified) return false;
      // let it through on severity OR on a real error cluster
      return opts.severities.has(i.severity) || i.errorCount > UNCLASSIFIED_MIN_ERRORS;
    })
    .slice(0, opts.maxTickets);

  console.log(`\n🎯 ${actionable.length} actionable issue(s) after filter${opts.includeUnclassified ? ' (including unclassified)' : ''}.`);

  // Prepare a per-run autopilot workspace next to the logs.
  const jobsDir = path.join(__dirname, 'autopilot', runId, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });

  const plan: Array<Record<string, unknown>> = [];

  for (const issue of actionable) {
    const p1Input = buildP1InputFromIssue(issue, {
      project: opts.project,
      autonomy: opts.autonomy,
      baseBranch: opts.baseBranch,
    });
    const jobFile = path.join(jobsDir, `${issue.id}.job.json`);
    const job = {
      issueId: issue.id,
      service: issue.service,
      endpoint: issue.endpoint,
      severity: issue.severity,
      category: issue.category,
      fingerprintLabel: fingerprintLabel(issue.service, issue.endpoint),
      // The exact object to hand to the build_p1_ticket MCP tool:
      buildP1TicketInput: p1Input,
      prefixes: opts.prefixes,
    };
    fs.writeFileSync(jobFile, JSON.stringify(job, null, 2), 'utf-8');
    plan.push({ issueId: issue.id, service: issue.service, endpoint: issue.endpoint, severity: issue.severity, jobFile });
    console.log(`   • ${issue.severity.toUpperCase()} ${issue.service} ${issue.endpoint} → ${jobFile}`);
  }

  const planPath = path.join(__dirname, 'autopilot', runId, 'plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({ runId, report: { md: mdPath, json: jsonPath }, logsRoot, mode: opts.run ? 'run' : 'emit-only', jobs: plan }, null, 2),
    'utf-8',
  );
  console.log(`\n📋 Plan: ${planPath}`);
  console.log(`📂 Logs: ${logsRoot} (retained)`);

  if (!opts.run) {
    console.log('\n💡 EMIT-ONLY mode — no tickets created, no MRs opened.');
    console.log('   Review the job files, then re-run with --run (and KIRO_API_KEY set) to execute.');
    return;
  }

  // --- Step 4: create ticket + trigger bugfix agent, per job ---
  const driver = path.join(__dirname, 'bin', 'run-autopilot.sh');
  for (const p of plan) {
    const jobFile = String(p.jobFile);
    console.log(`\n🚀 Executing job ${p.issueId} via ${driver}`);
    const res = spawnSync('bash', [driver, jobFile], { stdio: 'inherit', env: process.env });
    if (res.status !== 0) {
      console.warn(`   ⚠️  Job ${p.issueId} exited with status ${res.status} — see output above.`);
    }
  }

  console.log('\n✅ Autopilot complete. Check the driver output above for created ticket keys + MR URLs.');
}

main().catch((err) => {
  console.error('❌ autopilot fatal:', err);
  process.exit(1);
});
