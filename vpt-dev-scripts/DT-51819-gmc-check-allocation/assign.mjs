/**
 * DT-51819 - GMC Check Allocation Script
 *
 * Assigns GMC checks (caseIds) to OpsUsers in round-robin fashion equally.
 * Uses axios for HTTP requests.
 * Stores all output (banner, distribution, per-request logs, summary) in results JSON.
 *
 * Setup:
 *   npm install axios
 *
 * Usage:
 *   node assign.mjs                  # Dry run (default)
 *   node assign.mjs --execute        # Actually hit the API
 *   node assign.mjs --execute --delay 500   # Custom delay between requests (ms)
 */

import axios from "axios";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL =
  "prod_url/verification-workflow-engine/workflow/allocation/allocate";
const REQUEST_ID = "DT-51819-dev-Mitigation";
const DEFAULT_DELAY_MS = 300;

// ─── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--execute");
const delayIdx = args.indexOf("--delay");
const DELAY_MS =
  delayIdx !== -1 ? parseInt(args[delayIdx + 1], 10) : DEFAULT_DELAY_MS;

// ─── Load data ───────────────────────────────────────────────────────────────

const dataPath = resolve(__dirname, "data.json");
const data = JSON.parse(readFileSync(dataPath, "utf-8"));
const { opsUsers, caseIds } = data;

if (!opsUsers?.length || !caseIds?.length) {
  console.error("ERROR: data.json must have non-empty opsUsers and caseIds");
  process.exit(1);
}

// ─── Build assignment plan (round-robin) ─────────────────────────────────────

const assignments = caseIds.map((caseId, index) => {
  const opsUser = opsUsers[index % opsUsers.length];
  return {
    index: index + 1,
    caseId,
    opsUserId: opsUser.opsUserId,
    opsUserName: opsUser.name,
  };
});

// ─── Distribution ────────────────────────────────────────────────────────────

const distribution = {};
for (const a of assignments) {
  distribution[a.opsUserName] = (distribution[a.opsUserName] || 0) + 1;
}

// ─── Log helper (prints to console AND collects for file) ────────────────────

const logs = [];
function log(msg) {
  console.log(msg);
  logs.push(msg);
}

// ─── Print summary ───────────────────────────────────────────────────────────

log("═══════════════════════════════════════════════════════════");
log("  DT-51819 GMC Check Allocation");
log("═══════════════════════════════════════════════════════════");
log(`  Mode:        ${DRY_RUN ? "DRY RUN (no API calls)" : "EXECUTE"}`);
log(`  OpsUsers:    ${opsUsers.length}`);
log(`  Cases:       ${caseIds.length}`);
log(`  Per user:    ~${Math.ceil(caseIds.length / opsUsers.length)}`);
log(`  Delay:       ${DELAY_MS}ms between requests`);
log(`  Base URL:    ${BASE_URL}`);
log("═══════════════════════════════════════════════════════════");
log("");
log("Distribution:");
for (const [name, count] of Object.entries(distribution)) {
  log(`  ${name}: ${count} checks`);
}
log("");

// ─── Helper: sleep ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Execute ─────────────────────────────────────────────────────────────────

async function run() {
  const results = [];
  let success = 0;
  let failed = 0;

  for (const assignment of assignments) {
    const { index, caseId, opsUserId, opsUserName } = assignment;
    const url = `${BASE_URL}/${opsUserId}/${caseId}?skipValidation=true`;

    if (DRY_RUN) {
      const msg = `[${index}/${caseIds.length}] ${caseId} -> ${opsUserName}... [DRY RUN]`;
      log(msg);
      results.push({ ...assignment, status: "DRY_RUN", httpCode: null, responseBody: null });
      success++;
      continue;
    }

    try {
      const response = await axios.put(url, null, {
        headers: { "x-request-id": REQUEST_ID },
        validateStatus: () => true,
      });

      const httpCode = response.status;
      const responseBody = response.data;

      if (httpCode >= 200 && httpCode < 300) {
        const msg = `[${index}/${caseIds.length}] ${caseId} -> ${opsUserName}... OK (${httpCode})`;
        log(msg);
        results.push({ ...assignment, status: "SUCCESS", httpCode, responseBody });
        success++;
      } else {
        const msg = `[${index}/${caseIds.length}] ${caseId} -> ${opsUserName}... FAILED (${httpCode})`;
        log(msg);
        results.push({ ...assignment, status: "FAILED", httpCode, responseBody });
        failed++;
      }
    } catch (err) {
      const errMsg = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      const msg = `[${index}/${caseIds.length}] ${caseId} -> ${opsUserName}... ERROR: ${errMsg}`;
      log(msg);
      results.push({
        ...assignment,
        status: "ERROR",
        httpCode: err.response?.status || null,
        responseBody: err.response?.data || null,
        error: errMsg,
      });
      failed++;
    }

    await sleep(DELAY_MS);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  log("");
  log("═══════════════════════════════════════════════════════════");
  log("  SUMMARY");
  log("═══════════════════════════════════════════════════════════");
  log(`  Total:   ${caseIds.length}`);
  log(`  Success: ${success}`);
  log(`  Failed:  ${failed}`);
  log("═══════════════════════════════════════════════════════════");

  if (failed > 0) {
    log("");
    log("Failed assignments:");
    for (const r of results.filter(
      (r) => r.status !== "SUCCESS" && r.status !== "DRY_RUN"
    )) {
      log(`  ${r.caseId} -> ${r.opsUserName} | HTTP ${r.httpCode} | ${r.error || ""}`);
    }
  }

  // ─── Write results file ──────────────────────────────────────────────────

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = resolve(__dirname, `results-${timestamp}.json`);

  const output = {
    meta: {
      executedAt: new Date().toISOString(),
      mode: DRY_RUN ? "DRY_RUN" : "EXECUTE",
      baseUrl: BASE_URL,
      requestId: REQUEST_ID,
      totalCases: caseIds.length,
      totalOpsUsers: opsUsers.length,
      delayMs: DELAY_MS,
      successCount: success,
      failedCount: failed,
      distribution,
    },
    logs,
    results,
  };

  writeFileSync(logFile, JSON.stringify(output, null, 2));
  log("");
  log(`Results written to: ${logFile}`);
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
