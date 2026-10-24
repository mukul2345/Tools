#!/usr/bin/env node
/**
 * run-all.mjs
 *
 * Generates CloudWatch anomaly report with enhanced summary, thresholds, and correct metric columns.
 */

import fs from "fs";
import path from "path";
import { analyzeConfig } from "./analyze.mjs";

const globalConfig = JSON.parse(fs.readFileSync("configuration.json", "utf-8"));

/********************
 * Metric Rules
 ********************/
const metricRules = globalConfig.metrics;
const defaultRule = metricRules.count;

/********************
 * Helpers
 ********************/
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

function detectMetricType(name = "", stat = "", metricName = "", title = "") {
  const s = String(name).toLowerCase();
  const st = String(stat).toLowerCase();
  const mn = String(metricName).toLowerCase();
  const t = String(title).toLowerCase();

  // Combine all relevant fields for comprehensive matching
  const combined = `${s} ${mn} ${t}`;

  if (
    /\blatency\b/.test(combined) ||
    /\bp\d{1,3}\b/.test(st) ||
    /p\d{1,3}/.test(combined)
  )
    return "latency";
  if (/\berror|exception|fail\b/.test(combined)) return "error";
  if (/\bcpu\b/.test(combined) || /cpu utilization/.test(combined))
    return "cpu";
  if (/\bmem(ory)?\b/.test(combined) || /memory utilization/.test(combined))
    return "memory";
  if (/\bage of oldest|oldest message|message age|age\b/.test(combined))
    return "age";
  // Check for consumed capacity metrics (must come before generic count check)
  if (/\bconsumed.*read.*capacity|consumedreadcapacity\b/.test(combined)) return "consumedReadCapacity";
  if (/\bconsumed.*write.*capacity|consumedwritecapacity\b/.test(combined)) return "consumedWriteCapacity";
  if (/\bread.*throttle|readthrottle\b/.test(combined)) return "readThrottleEvents";
  if (/\bworkflow.*lambda.*invocation|workflowlambdainvocation\b/.test(combined)) return "workflowLambdaInvocations";
  if (/\bworkflow.*event.*timeline|workfloweventtimeline\b/.test(combined)) return "workflowEventTimeline";
  if (/\bprocessed.*bytes|processedbytes\b/.test(combined)) return "processedBytes";
  if (/\bscan.*returned.*item.*count|scanreturneditemcount\b/.test(combined)) return "scanReturnedItemCount";
  if (/\bcount|requests?|calls?\b/.test(combined)) return "count";

  return "count"; // default fallback
}

function classifyAnomaly(metricType, pctChange) {
  const ruleDef = metricRules[metricType] || defaultRule;

  // Convert string expressions to functions
  let badFn = ruleDef.badIf;
  let goodFn = ruleDef.goodIf;
  if (typeof badFn === "string") badFn = new Function("pct", `return ${badFn}`);
  if (typeof goodFn === "string")
    goodFn = new Function("pct", `return ${goodFn}`);

  if (badFn(pctChange)) return { isAnomaly: true, color: "red", impact: "bad" };
  if (goodFn(pctChange))
    return { isAnomaly: true, color: "green", impact: "good" };
  return { isAnomaly: false, color: "neutral", impact: "neutral" };
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        m
      ])
  );
}

function td(v, cls = "") {
  return `<td class="${cls}">${escapeHtml(v)}</td>`;
}

// NEW: raw-cell helper so we can safely insert <a href="...">
function tdRaw(html, cls = "") {
  return `<td class="${cls}">${html}</td>`;
}

function tr(cells, cls = "") {
  return `<tr class="${cls}">${cells.join("")}</tr>`;
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return "";
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}
function fmtThreshold(rule) {
  if (typeof rule.badIf === "string") return rule.badIf;
  if (typeof rule.badIf === "function") return "Custom";
  return "";
}

/********************
 * Concurrency limiter
 ********************/
async function runWithConcurrency(tasks, concurrency = 6) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  return Promise.all(results);
}

/********************
 * Helper to create unique metric key
 ********************/
function getMetricKey(cfg, series) {
  const dims = JSON.stringify(
    Object.entries(series.dimensions || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .reduce((acc, [k, v]) => {
        acc[k] = v;
        return acc;
      }, {})
  );
  return `${series.namespace}|${series.metricName}|${series.stat}|${dims}|${
    cfg.baselineDays || "default"
  }|${cfg.windowMinutes || "default"}`;
}

/********************
 * Helper to recursively find all dashboard folders
 ********************/
function findDashboardFolders(rootDir) {
  const dashboards = [];

  function explore(dir, relativePath = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    // Check if current directory has JSON config files
    const hasConfigs = entries.some(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".json") &&
        !e.name.startsWith("manifest.")
    );

    if (hasConfigs) {
      dashboards.push({
        path: dir,
        name: relativePath || path.basename(dir),
      });
    }

    // Recursively explore subdirectories
    entries.forEach((entry) => {
      if (entry.isDirectory()) {
        const subPath = path.join(dir, entry.name);
        const newRelativePath = relativePath
          ? `${relativePath}/${entry.name}`
          : entry.name;
        explore(subPath, newRelativePath);
      }
    });
  }

  explore(rootDir);
  return dashboards;
}

/********************
 * Main
 ********************/
const parentDir = process.argv[2] || "configs";
const htmlPath = process.argv[3] || "report.html";
const endISO = process.argv.find((x) => x.startsWith("--end="))?.split("=")[1];
const mergedJson = process.argv
  .find((x) => x.startsWith("--json="))
  ?.split("=")[1];

async function main() {
  if (!fs.existsSync(parentDir)) {
    console.error("Parent directory not found:", parentDir);
    return;
  }

  // Find all dashboard folders
  const dashboards = findDashboardFolders(parentDir);
  console.log(
    `Found ${dashboards.length} dashboard(s): ${dashboards
      .map((d) => d.name)
      .join(", ")}`
  );

  if (dashboards.length === 0) {
    console.error(
      "No dashboard folders with config files found in:",
      parentDir
    );
    return;
  }

  // Track processed metrics globally to avoid duplicates
  const processedMetrics = new Set();
  const allResults = [];

  // Process each dashboard
  for (const dashboard of dashboards) {
    console.log(`\nProcessing dashboard: ${dashboard.name}`);

    const files = fs
      .readdirSync(dashboard.path)
      .filter((f) => f.endsWith(".json") && !f.startsWith("manifest."));

    const tasks = files.map((f) => async () => {
      const filePath = path.join(dashboard.path, f);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const cfg = JSON.parse(raw);

        // Filter out duplicate metrics
        const originalSeriesCount = cfg.series?.length || 0;
        const filteredSeries = [];

        for (const series of cfg.series || []) {
          const key = getMetricKey(cfg, series);
          if (!processedMetrics.has(key)) {
            processedMetrics.add(key);
            filteredSeries.push(series);
          }
        }

        if (filteredSeries.length === 0) {
          console.log(
            `  Skipped ${f} - all metrics already processed (${originalSeriesCount} duplicates)`
          );
          return null;
        }

        if (filteredSeries.length < originalSeriesCount) {
          console.log(
            `  ${f}: Processing ${
              filteredSeries.length
            }/${originalSeriesCount} metrics (${
              originalSeriesCount - filteredSeries.length
            } duplicates skipped)`
          );
        }

        cfg.series = filteredSeries;
        const out = await analyzeConfig(cfg, { endISO });
        return { file: f, dashboard: dashboard.name, ...out };
      } catch (err) {
        console.error("  Error processing", f, err.message);
        return null;
      }
    });

    const dashboardResults = (await runWithConcurrency(tasks, 6)).filter(
      Boolean
    );
    allResults.push({
      dashboardName: dashboard.name,
      results: dashboardResults,
    });
  }

  // Flatten results for backward compatibility with mergedJson
  const results = allResults.flatMap((d) => d.results);

  if (mergedJson)
    fs.writeFileSync(mergedJson, JSON.stringify(results, null, 2));

  // Build anomaly stats - already deduplicated by metric key during processing
  let totalAnoms = 0;
  let totalOrangeZone = 0;
  const anomalyStats = {};

  results.forEach((r) => {
    r.rows.forEach((row) => {
      const metricType = detectMetricType(
        row.name,
        row.stat,
        row.metricName,
        row.title
      );
      const pct = Number(row.pctChange || 0);
      const { impact, isAnomaly } = classifyAnomaly(metricType, pct);

      row.anomaly = isAnomaly;

      // Check for orange zone (latency anomaly with curr < 100ms) - for styling only
      const stat = (row.stat || "").toLowerCase();
      const isLatencyMetric =
        (row.metricName || "").toLowerCase().includes("latency") ||
        row.agg === "median" ||
        stat.startsWith("p") || // p90, p95, p99, etc.
        stat.includes("percentile");
      row.orangeZone =
        isAnomaly && isLatencyMetric && row.curr < 100 && row.curr > 0;

      // Count anomalies (already deduplicated)
      if (isAnomaly) {
        totalAnoms++;

        // Track orange zone separately for summary
        if (row.orangeZone) {
          totalOrangeZone++;
        }

        if (!anomalyStats[metricType])
          anomalyStats[metricType] = { red: 0, green: 0, orange: 0 };
        if (row.orangeZone) {
          anomalyStats[metricType].orange++;
        } else if (impact === "bad") {
          anomalyStats[metricType].red++;
        } else if (impact === "good") {
          anomalyStats[metricType].green++;
        }
      }
    });
  });

  // HTML styling
  const style = `
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif;margin:24px;}
    h1{margin-bottom:12px;}
    h2{margin-top:28px;margin-bottom:6px;}
    table{border-collapse:collapse;width:100%;margin:12px 0; box-shadow: 0 0 8px rgba(0,0,0,0.1);}
    th,td{border:1px solid #ddd;padding:8px;font-size:13px;vertical-align:top}
    th{background:#f0f0f0;text-align:left}
    tr.bad{background:#ffcccc;font-weight:bold;border-left:4px solid #d63333;}
    tr.good{background:#ccffcc;font-weight:bold;border-left:4px solid #198754;}
    tr.orange{background:#fef3c7;font-weight:bold;border-left:4px solid #d97706;}
    .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;background:#eee;margin-left:6px}
    .badge.warn{background:#ffcccc;color:#d63333;font-weight:bold;}
    .badge.ok{background:#ccffcc;color:#198754;font-weight:bold;}
    .badge-orange{background:#fef3c7;color:#d97706;font-weight:bold;}
    .panel{border:1px solid #e5e5e5;border-radius:8px;padding:12px;background:#fafafa;margin:12px 0}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .muted{color:#666;font-size:14px;margin-bottom:12px;}
  `;

  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Anomaly Report</title><style>${style}</style></head><body>`;
  html += `<h1>CloudWatch Anomaly Report</h1>`;
  html += `<div class="muted">Generated: ${new Date().toISOString()} | Dashboards=${
    allResults.length
  } | Configs=${results.length} | Metrics Processed=${
    processedMetrics.size
  } <span class="badge ${
    totalAnoms ? "warn" : "ok"
  }">Anomalies: ${totalAnoms}</span> <span class="badge badge-orange">Orange Zone: ${totalOrangeZone}</span></div>`;

  // Dashboard Summary Table
  html += `<div class="panel">
  <h3>📂 Dashboard Summary</h3>
  <table>
    <thead>
      <tr style="background:#e0e0e0;">
        <th>Dashboard</th>
        <th>Configs</th>
        <th>Total Anomalies</th>
        <th>🔴 Bad</th>
        <th>🟢 Good</th>
        <th>🟠 Orange</th>
      </tr>
    </thead>
    <tbody>`;

  allResults.forEach((dashboard) => {
    const configCount = dashboard.results.length;
    const anomalies = dashboard.results.flatMap((r) =>
      r.rows.filter((x) => x.anomaly)
    );
    const badAnoms = anomalies.filter(
      (a) =>
        !a.orangeZone &&
        classifyAnomaly(
          detectMetricType(a.name, a.stat, a.metricName, a.title),
          Number(a.pctChange || 0)
        ).impact === "bad"
    ).length;
    const goodAnoms = anomalies.filter(
      (a) =>
        classifyAnomaly(
          detectMetricType(a.name, a.stat, a.metricName, a.title),
          Number(a.pctChange || 0)
        ).impact === "good"
    ).length;
    const orangeAnoms = anomalies.filter((a) => a.orangeZone).length;

    html += `<tr>
      <td><strong>${escapeHtml(dashboard.dashboardName)}</strong></td>
      <td style="text-align:center;">${configCount}</td>
      <td style="text-align:center; font-weight:bold;">${anomalies.length}</td>
      <td style="text-align:center; background:#ffcccc; font-weight:bold;">${badAnoms}</td>
      <td style="text-align:center; background:#ccffcc; font-weight:bold;">${goodAnoms}</td>
      <td style="text-align:center; background:#fef3c7; font-weight:bold;">${orangeAnoms}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;

  // Enhanced Summary Table
  html += `<div class="panel">
  <h3>📊 Anomaly Summary (Thresholds & Impact)</h3>
  <table>
    <thead>
      <tr style="background:#e0e0e0;">
        <th>Metric</th>
        <th>Δ% Threshold</th>
        <th>Bad Anomalies 🔴</th>
        <th>Good Changes 🟢</th>
        <th>Orange Zone 🟠</th>
        <th>Total</th>
        <th>Severity %</th>
      </tr>
    </thead>
    <tbody>`;

  for (const [mt, rule] of Object.entries(metricRules)) {
    const stats = anomalyStats[mt] || { red: 0, green: 0, orange: 0 };
    const total = stats.red + stats.green + stats.orange;
    const severity = total
      ? ((stats.red / total) * 100).toFixed(1) + "%"
      : "0%";

    // Alternate row background for readability
    const bgColor =
      mt === "latency"
        ? "#fff3f3"
        : mt === "error"
        ? "#f3fff3"
        : mt === "count"
        ? "#f3f3ff"
        : "#f9f9f9";

    html += `<tr style="background:${bgColor};">
      <td>${escapeHtml(rule.label)}</td>
      <td>${fmtThreshold(rule)}</td>
      <td style="text-align:center; background:#ffcccc; font-weight:bold;">${
        stats.red
      }</td>
      <td style="text-align:center; background:#ccffcc; font-weight:bold;">${
        stats.green
      }</td>
      <td style="text-align:center; background:#fef3c7; font-weight:bold;">${
        stats.orange
      }</td>
      <td style="text-align:center;">${total}</td>
      <td style="text-align:center; font-weight:bold;">${severity}</td>
    </tr>`;
  }

  html += `</tbody></table></div>`;

  // Per-dashboard sections with config tables
  allResults.forEach((dashboard) => {
    const dashboardAnomalies = dashboard.results.flatMap((r) =>
      r.rows.filter((x) => x.anomaly)
    );

    html += `<h1 style="margin-top:48px;padding-top:24px;border-top:3px solid #ccc;">📊 ${escapeHtml(
      dashboard.dashboardName
    )} <span class="badge">${
      dashboardAnomalies.length
        ? `${dashboardAnomalies.length} anomalies`
        : "No anomalies"
    }</span></h1>`;

    // Per-config tables with full columns
    dashboard.results.forEach((r) => {
      const anomalies = r.rows.filter((x) => x.anomaly);
      html += `<h2>${escapeHtml(r.title || r.file)} <span class="badge">${
        anomalies.length ? anomalies.length : "No anomalies"
      }</span></h2>`;

      if (anomalies.length === 0) {
        html += `<p style="color:#666;font-style:italic;">No anomalies detected in this configuration.</p>`;
      } else {
        html += `<table><thead><tr>
  <th>Series</th>
  <th>Stat</th>
  <th>Curr</th>
  <th>BaseMed</th>
  <th>Δ%</th>
  <th>z</th>
  <th>Pts</th>
  <th>Base</th>
  <th>Anom</th>
  <th>Link</th>
</tr></thead><tbody>`;
        anomalies.forEach((row) => {
          const metricType = detectMetricType(
            row.name,
            row.stat,
            row.metricName,
            row.title
          );
          const { impact } = classifyAnomaly(
            metricType,
            Number(row.pctChange || 0)
          );

          // Check if this is an orange zone anomaly (override "bad" styling with "orange")
          const cls = row.orangeZone
            ? "orange"
            : impact === "bad"
            ? "bad"
            : impact === "good"
            ? "good"
            : "";

          // build link cell
          const linkHtml = row.cwLink
            ? `<a href="${escapeHtml(
                row.cwLink
              )}" target="_blank" rel="noopener noreferrer">View</a>`
            : "";

          html += tr(
            [
              td(row.name),
              td(row.stat),
              td(row.curr),
              td(row.baseMed),
              td(fmtPct(row.pctChange)),
              td(row.z),
              td(row.pts),
              td(row.base),
              td(row.anomaly ? "YES" : "NO"),
              tdRaw(linkHtml),
            ],
            cls
          );
        });
        html += `</tbody></table>`;
      }
    });
  });

  html += `</body></html>`;
  fs.writeFileSync(htmlPath, html);
  console.log(`→ Wrote ${htmlPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
