#!/usr/bin/env node
/**
 * HTML Report Generator - Wraps existing HTML template logic
 * This module uses the existing HTML generation from run-all.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load metric rules from configuration.json (for backward compatibility)
const configPath = path.join(__dirname, "../../configuration.json");
let metricRules = {};
let defaultRule = {};
let globalConfig = {};

if (fs.existsSync(configPath)) {
  globalConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  metricRules = globalConfig.metrics || {};
  defaultRule = metricRules.count || {};
}

// Helper functions from run-all.mjs
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

function detectMetricType(name = "", stat = "", metricName = "", title = "", namespace = "", dimensions = {}) {
  // First, try explicit mapping from configuration.json based on namespace and metricName
  if (namespace && metricName && globalConfig.metricMappings) {
    const namespaceMappings = globalConfig.metricMappings[namespace];
    if (namespaceMappings && namespaceMappings[metricName]) {
      let mappedType = namespaceMappings[metricName];
      
      // Override: If metric is API_COUNT but has error status code (4xx, 5xx), treat as error
      if (mappedType === "count" && metricName === "API_COUNT" && dimensions) {
        const statusCode = dimensions.statusCode || dimensions.StatusCode || "";
        const statusCodeNum = parseInt(statusCode);
        if (statusCodeNum >= 400 && statusCodeNum < 600) {
          mappedType = "error";
        }
      }
      
      return mappedType;
    }
  }

  // Fall back to pattern matching (backward compatibility)
  const s = String(name).toLowerCase();
  const st = String(stat).toLowerCase();
  const mn = String(metricName).toLowerCase();
  const t = String(title).toLowerCase();
  const combined = `${s} ${mn} ${t}`;

  // Check for HTTP error status codes (4xx, 5xx) in name or dimensions before other checks
  if (dimensions) {
    const statusCode = dimensions.statusCode || dimensions.StatusCode || "";
    const statusCodeNum = parseInt(statusCode);
    if (statusCodeNum >= 400 && statusCodeNum < 600) {
      return "error";
    }
  }
  // Also check for status codes in the name (e.g., "[500]", "[404]")
  if (/\[(4|5)\d{2}\]/.test(name)) {
    return "error";
  }

  if (/\blatency\b/.test(combined) || /\bp\d{1,3}\b/.test(st) || /p\d{1,3}/.test(combined))
    return "latency";
  if (/\berror|exception|fail\b/.test(combined)) return "error";
  if (/\bcpu\b/.test(combined) || /cpu utilization/.test(combined)) return "cpu";
  if (/\bmem(ory)?\b/.test(combined) || /memory utilization/.test(combined)) return "memory";
  if (/\bage of oldest|oldest message|message age|age\b/.test(combined)) return "age";
  // Check for consumed capacity metrics (must come before generic count check)
  if (/\bconsumed.*read.*capacity|consumedreadcapacity\b/.test(combined)) return "consumedReadCapacity";
  if (/\bconsumed.*write.*capacity|consumedwritecapacity\b/.test(combined)) return "consumedWriteCapacity";
  if (/\bread.*throttle|readthrottle\b/.test(combined)) return "readThrottleEvents";
  if (/\bworkflow.*lambda.*invocation|workflowlambdainvocation\b/.test(combined)) return "workflowLambdaInvocations";
  if (/\bworkflow.*event.*timeline|workfloweventtimeline\b/.test(combined)) return "workflowEventTimeline";
  if (/\bprocessed.*bytes|processedbytes\b/.test(combined)) return "processedBytes";
  if (/\bscan.*returned.*item.*count|scanreturneditemcount\b/.test(combined)) return "scanReturnedItemCount";
  if (/\bcount|requests?|calls?\b/.test(combined)) return "count";
  return "count";
}

function classifyAnomaly(metricType, pctChange) {
  const ruleDef = metricRules[metricType] || defaultRule;
  let badFn = ruleDef.badIf;
  let goodFn = ruleDef.goodIf;
  
  // Normalize condition strings: convert OR/AND to JavaScript operators, handle "between" syntax
  const normalizeCondition = (condition) => {
    if (typeof condition !== "string") return condition;
    let normalized = condition.trim();
    // Handle "between X and Y" syntax first (before OR/AND conversion): convert to "pct >= X && pct <= Y"
    // Match: "pct between -25 and 25" or "pct between 10 and 20" etc.
    normalized = normalized.replace(/\bpct\s+between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)\b/gi, (match, min, max) => {
      return `pct >= ${min} && pct <= ${max}`;
    });
    // Convert "OR" to "||" and "AND" to "&&" (case-insensitive, but preserve && that we just created)
    normalized = normalized.replace(/\bOR\b/gi, "||").replace(/\bAND\b/gi, "&&");
    return normalized;
  };
  
  if (typeof badFn === "string") {
    badFn = normalizeCondition(badFn);
    badFn = new Function("pct", `return ${badFn}`);
  }
  if (typeof goodFn === "string") {
    goodFn = normalizeCondition(goodFn);
    goodFn = new Function("pct", `return ${goodFn}`);
  }

  if (badFn(pctChange)) return { isAnomaly: true, color: "red", impact: "bad" };
  if (goodFn(pctChange)) return { isAnomaly: true, color: "green", impact: "good" };
  return { isAnomaly: false, color: "neutral", impact: "neutral" };
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
  );
}

function td(v, cls = "") {
  return `<td class="${cls}">${escapeHtml(v)}</td>`;
}

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

/**
 * Render HTML report from analysis results
 * @param {Array} allResults - Array of dashboard results
 * @param {string} dashboardName - Dashboard name
 * @returns {string} HTML string
 */
export function renderHTML(allResults, dashboardName) {
  // Flatten results for processing
  const results = Array.isArray(allResults[0]?.results) 
    ? allResults.flatMap((d) => d.results)
    : allResults;

  // Build anomaly stats
  let totalAnoms = 0;
  let totalOrangeZone = 0;
  const anomalyStats = {};

  results.forEach((r) => {
    r.rows.forEach((row) => {
      const metricType = detectMetricType(row.name, row.stat, row.metricName, row.title, row.namespace, row.dimensions);
      const pct = Number(row.pctChange || 0);
      const { impact, isAnomaly } = classifyAnomaly(metricType, pct);

      row.anomaly = isAnomaly;

      const stat = (row.stat || "").toLowerCase();
      const isLatencyMetric =
        (row.metricName || "").toLowerCase().includes("latency") ||
        row.agg === "median" ||
        stat.startsWith("p") ||
        stat.includes("percentile");
      row.orangeZone = isAnomaly && isLatencyMetric && row.curr < 100 && row.curr > 0;

      if (isAnomaly) {
        totalAnoms++;
        if (row.orangeZone) totalOrangeZone++;

        if (!anomalyStats[metricType]) anomalyStats[metricType] = { red: 0, green: 0, orange: 0 };
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

  let html = `<!doctype html><html><head><meta charset="utf-8"><title>Anomaly Report - ${escapeHtml(dashboardName)}</title><style>${style}</style></head><body>`;
  html += `<h1>CloudWatch Anomaly Report</h1>`;
  html += `<div class="muted">Generated: ${new Date().toISOString()} | Configs=${results.length} <span class="badge ${
    totalAnoms ? "warn" : "ok"
  }">Anomalies: ${totalAnoms}</span> <span class="badge badge-orange">Orange Zone: ${totalOrangeZone}</span></div>`;

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
    const severity = total ? ((stats.red / total) * 100).toFixed(1) + "%" : "0%";
    const bgColor =
      mt === "latency" ? "#fff3f3" : mt === "error" ? "#f3fff3" : mt === "count" ? "#f3f3ff" : "#f9f9f9";

    html += `<tr style="background:${bgColor};">
      <td>${escapeHtml(rule.label)}</td>
      <td>${fmtThreshold(rule)}</td>
      <td style="text-align:center; background:#ffcccc; font-weight:bold;">${stats.red}</td>
      <td style="text-align:center; background:#ccffcc; font-weight:bold;">${stats.green}</td>
      <td style="text-align:center; background:#fef3c7; font-weight:bold;">${stats.orange}</td>
      <td style="text-align:center;">${total}</td>
      <td style="text-align:center; font-weight:bold;">${severity}</td>
    </tr>`;
  }

  html += `</tbody></table></div>`;

  // Per-config tables
  results.forEach((r) => {
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
        const metricType = detectMetricType(row.name, row.stat, row.metricName, row.title, row.namespace, row.dimensions);
        const { impact } = classifyAnomaly(metricType, Number(row.pctChange || 0));
        const cls = row.orangeZone ? "orange" : impact === "bad" ? "bad" : impact === "good" ? "good" : "";
        const linkHtml = row.cwLink
          ? `<a href="${escapeHtml(row.cwLink)}" target="_blank" rel="noopener noreferrer">View</a>`
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

  html += `</body></html>`;
  return html;
}

