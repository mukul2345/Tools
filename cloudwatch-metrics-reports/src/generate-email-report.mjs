/**
 * Generate an email-friendly HTML report
 * Uses inline CSS + HTML tables + Unicode bar charts (no JavaScript)
 * Compatible with Outlook, Gmail, Apple Mail, etc.
 */

import { listMetricsAll, getMetricDataBatched, buildMetricQuery } from "./cloudwatch.mjs";
import { logger } from "./logger.mjs";
import { writeFileSync, mkdirSync } from "fs";

const services = [
  "garuda",
  "applicant-service",
  "jaya-vijaya",
  "kuber",
  "order-service",
  "partner-service",
];

const namespace = "DFG-Observability";
const clusterName = "cluster-production-common";

const startDate = new Date("2026-03-15T18:30:00.000Z");
const numWeeks = 12;

function generateWeekBoundaries() {
  const weeks = [];
  for (let i = 0; i < numWeeks; i++) {
    const weekStart = new Date(startDate.getTime() + i * 7 * 24 * 60 * 60 * 1000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
    weeks.push({ start: weekStart, end: weekEnd, label: `W${i + 1}` });
  }
  return weeks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWeeklyMetrics(service, weeks) {
  const ecsServiceName = `${service}-production-common`;
  const traffic = [];
  const errorRate = [];
  const cpu = [];
  const memory = [];

  for (const week of weeks) {
    // Traffic
    const tMetrics = await listMetricsAll({
      namespace, metricName: "API_COUNT",
      dimensions: [{ Name: "serviceName", Value: service }, { Name: "environment", Value: "production" }],
    });
    if (tMetrics.length > 0) {
      const tQueries = tMetrics.map((m, i) => buildMetricQuery({ id: `t${i}`, namespace, metricName: "API_COUNT", dimensions: m.Dimensions, stat: "Sum", period: 3600 }));
      const tData = await getMetricDataBatched({ queries: tQueries, start: week.start, end: week.end, period: 3600 });
      let total = 0;
      for (const r of tData) { if (r.Values) total += r.Values.reduce((a, b) => a + b, 0); }
      traffic.push(Math.round(total));
    } else {
      traffic.push(0);
    }

    // 5xx errors
    const eMetrics = await listMetricsAll({
      namespace, metricName: "API_COUNT",
      dimensions: [{ Name: "serviceName", Value: service }, { Name: "environment", Value: "production" }, { Name: "statusCode", Value: "500" }],
    });
    if (eMetrics.length > 0) {
      const eQueries = eMetrics.map((m, i) => buildMetricQuery({ id: `e${i}`, namespace, metricName: "API_COUNT", dimensions: m.Dimensions, stat: "Sum", period: 3600 }));
      const eData = await getMetricDataBatched({ queries: eQueries, start: week.start, end: week.end, period: 3600 });
      let errors = 0;
      for (const r of eData) { if (r.Values) errors += r.Values.reduce((a, b) => a + b, 0); }
      const rate = traffic[traffic.length - 1] > 0 ? (errors / traffic[traffic.length - 1]) * 100 : 0;
      errorRate.push(parseFloat(rate.toFixed(4)));
    } else {
      errorRate.push(0);
    }

    // CPU
    const cpuQ = [buildMetricQuery({ id: "cpu", namespace: "AWS/ECS", metricName: "CPUUtilization", dimensions: [{ Name: "ServiceName", Value: ecsServiceName }, { Name: "ClusterName", Value: clusterName }], stat: "Average", period: 3600 })];
    const cpuD = await getMetricDataBatched({ queries: cpuQ, start: week.start, end: week.end, period: 3600 });
    const cpuR = cpuD.find(x => x.Id === "cpu");
    cpu.push(cpuR && cpuR.Values && cpuR.Values.length > 0 ? parseFloat((cpuR.Values.reduce((a, b) => a + b, 0) / cpuR.Values.length).toFixed(1)) : 0);

    // Memory
    const memQ = [buildMetricQuery({ id: "mem", namespace: "AWS/ECS", metricName: "MemoryUtilization", dimensions: [{ Name: "ServiceName", Value: ecsServiceName }, { Name: "ClusterName", Value: clusterName }], stat: "Average", period: 3600 })];
    const memD = await getMetricDataBatched({ queries: memQ, start: week.start, end: week.end, period: 3600 });
    const memR = memD.find(x => x.Id === "mem");
    memory.push(memR && memR.Values && memR.Values.length > 0 ? parseFloat((memR.Values.reduce((a, b) => a + b, 0) / memR.Values.length).toFixed(1)) : 0);

    await sleep(100);
  }

  return { service, traffic, errorRate, cpu, memory };
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return String(n);
}

function pctChange(o, n) {
  if (o === 0 && n === 0) return "Flat";
  if (o === 0) return "+∞";
  const pct = ((n - o) / o) * 100;
  return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
}

function trendColor(o, n, inverse) {
  if (o === 0 && n === 0) return "#94a3b8";
  const up = n > o;
  if (inverse) return up ? "#ef4444" : "#22c55e";
  return up ? "#22c55e" : "#ef4444";
}

function sparkBar(values, maxVal, color) {
  if (maxVal === 0) maxVal = 1;
  return values.map(v => {
    const height = Math.max(2, Math.round((v / maxVal) * 24));
    return `<td style="padding:0 1px;vertical-align:bottom;"><div style="width:8px;height:${height}px;background:${color};border-radius:2px;"></div></td>`;
  }).join("");
}

function generatePortalTable(portalName, rows) {
  let html = `<h3 style="font-size:14px;color:#475569;margin:16px 0 8px;">${portalName}</h3>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
<thead>
<tr style="background:#f8fafc;">
  <th style="padding:8px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Metric</th>
  <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Before</th>
  <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Now</th>
  <th style="padding:8px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Trend</th>
  <th style="padding:8px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Status</th>
</tr>
</thead>
<tbody>`;

  for (const row of rows) {
    html += `
<tr style="border-bottom:1px solid #f1f5f9;">
  <td style="padding:10px 8px;font-weight:500;">${row.metric}</td>
  <td style="padding:10px 8px;text-align:right;color:#64748b;">${row.before}</td>
  <td style="padding:10px 8px;text-align:right;font-weight:600;">${row.now}</td>
  <td style="padding:10px 8px;text-align:center;font-weight:600;color:${row.statusColor};">${row.trend}</td>
  <td style="padding:10px 8px;text-align:center;"><span style="background:${row.statusColor}15;color:${row.statusColor};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${row.status}</span></td>
</tr>`;
  }

  html += `</tbody></table>`;
  return html;
}

function generateEmailHTML(allData, weeks) {
  const labels = weeks.map(w => w.label);

  let html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;">
<div style="max-width:800px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

<h1 style="margin:0 0 4px;font-size:22px;color:#0f172a;">🔍 Consumer Apps & Services — Observability Report</h1>
<p style="margin:0 0 24px;color:#64748b;font-size:13px;">Period: 15 Mar 2026 → 7 Jun 2026 (12 weeks) | Generated: ${new Date().toISOString().slice(0, 10)}</p>

<!-- Summary Cards -->
<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
<tr>
  <td style="padding:8px;"><div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:24px;font-weight:700;color:#16a34a;">${allData.length}</div><div style="font-size:11px;color:#64748b;">Services Monitored</div></div></td>
  <td style="padding:8px;"><div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:24px;font-weight:700;color:#dc2626;">${allData.filter(s => s.errorRate[11] > 0.01).length}</div><div style="font-size:11px;color:#64748b;">Services with 5XX > 0.01%</div></div></td>
  <td style="padding:8px;"><div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;text-align:center;"><div style="font-size:24px;font-weight:700;color:#2563eb;">${fmtNum(allData.reduce((s, d) => s + d.traffic[11], 0))}</div><div style="font-size:11px;color:#64748b;">Total Weekly Traffic (W12)</div></div></td>
</tr>
</table>

<!-- API Traffic & Error Rate Table -->
<h2 style="font-size:16px;color:#334155;margin:24px 0 12px;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">📊 API Traffic & 5XX Error Rate — 12 Week Trend</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
<thead>
<tr style="background:#f8fafc;">
  <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Service</th>
  <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Traffic Sparkline</th>
  <th style="padding:10px 8px;text-align:right;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">W1 → W12</th>
  <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Trend</th>
  <th style="padding:10px 8px;text-align:right;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">5XX Rate (W12)</th>
</tr>
</thead>
<tbody>`;

  for (const s of allData) {
    const maxTraffic = Math.max(...s.traffic);
    const tColor = "#3b82f6";
    const change = pctChange(s.traffic[0], s.traffic[11]);
    const changeColor = trendColor(s.traffic[0], s.traffic[11], false);
    const errColor = s.errorRate[11] > 0.01 ? "#ef4444" : "#22c55e";

    html += `
<tr style="border-bottom:1px solid #f1f5f9;">
  <td style="padding:12px 8px;font-weight:600;">${s.service}</td>
  <td style="padding:12px 8px;"><table style="border-collapse:collapse;margin:0 auto;"><tr>${sparkBar(s.traffic, maxTraffic, tColor)}</tr></table></td>
  <td style="padding:12px 8px;text-align:right;color:#64748b;">${fmtNum(s.traffic[0])} → ${fmtNum(s.traffic[11])}</td>
  <td style="padding:12px 8px;text-align:center;font-weight:600;color:${changeColor};">${change}</td>
  <td style="padding:12px 8px;text-align:right;"><span style="background:${errColor}15;color:${errColor};padding:2px 8px;border-radius:4px;font-weight:600;">${s.errorRate[11]}%</span></td>
</tr>`;
  }

  html += `</tbody></table>

<!-- CPU & Memory Table -->
<h2 style="font-size:16px;color:#334155;margin:24px 0 12px;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">⚙️ Infrastructure — CPU & Memory Utilization</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
<thead>
<tr style="background:#f8fafc;">
  <th style="padding:10px 8px;text-align:left;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Service</th>
  <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">CPU Sparkline</th>
  <th style="padding:10px 8px;text-align:right;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">CPU (W1→W12)</th>
  <th style="padding:10px 8px;text-align:center;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Mem Sparkline</th>
  <th style="padding:10px 8px;text-align:right;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:11px;text-transform:uppercase;">Memory (W1→W12)</th>
</tr>
</thead>
<tbody>`;

  for (const s of allData) {
    const maxCpu = Math.max(...s.cpu, 1);
    const maxMem = Math.max(...s.memory, 1);
    const cpuChange = pctChange(s.cpu[0], s.cpu[11]);
    const memChange = pctChange(s.memory[0], s.memory[11]);
    const cpuColor = s.cpu[11] > 50 ? "#ef4444" : s.cpu[11] > 30 ? "#f59e0b" : "#22c55e";
    const memColor = s.memory[11] > 70 ? "#ef4444" : s.memory[11] > 50 ? "#f59e0b" : "#22c55e";

    html += `
<tr style="border-bottom:1px solid #f1f5f9;">
  <td style="padding:12px 8px;font-weight:600;">${s.service}</td>
  <td style="padding:12px 8px;"><table style="border-collapse:collapse;margin:0 auto;"><tr>${sparkBar(s.cpu, maxCpu, cpuColor)}</tr></table></td>
  <td style="padding:12px 8px;text-align:right;"><span style="color:${trendColor(s.cpu[0], s.cpu[11], true)};font-weight:600;">${s.cpu[0]}% → ${s.cpu[11]}%</span><br><span style="color:#94a3b8;font-size:11px;">${cpuChange}</span></td>
  <td style="padding:12px 8px;"><table style="border-collapse:collapse;margin:0 auto;"><tr>${sparkBar(s.memory, maxMem, memColor)}</tr></table></td>
  <td style="padding:12px 8px;text-align:right;"><span style="color:${trendColor(s.memory[0], s.memory[11], true)};font-weight:600;">${s.memory[0]}% → ${s.memory[11]}%</span><br><span style="color:#94a3b8;font-size:11px;">${memChange}</span></td>
</tr>`;
  }

  html += `</tbody></table>

<!-- Client-Facing Portals Section -->
<h2 style="font-size:16px;color:#334155;margin:24px 0 12px;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">🌐 Client-Facing Portals — 4-Month Trend Analysis (p90 Metrics)</h2>
<p style="color:#64748b;font-size:12px;margin-bottom:16px;">Window: Week of 2026/01/29 (Before) → Week of 2026/05/22 (Now)</p>

${generatePortalTable("Applicant Portal", [
  { metric: "Latency (p90)", before: "219 ms", now: "279 ms", trend: "+27.4%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "5XX Errors", before: "2,795", now: "1,009", trend: "−63.9%", status: "Healthy", statusColor: "#22c55e" },
  { metric: "4XX Errors", before: "122,930", now: "266,810", trend: "+117.0%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "API Traffic", before: "3.86M", now: "6.60M", trend: "+71.0%", status: "Scaling", statusColor: "#3b82f6" },
  { metric: "JS Errors", before: "345", now: "1,387", trend: "+302.0%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "LCP (Load Time)", before: "6,335 ms", now: "7,148 ms", trend: "+12.8%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "CLS (Stability)", before: "0.645", now: "0.649", trend: "+0.6%", status: "Stable", statusColor: "#22c55e" },
])}

${generatePortalTable("Client Portal", [
  { metric: "Latency (p90)", before: "1,232 ms", now: "943 ms", trend: "−23.5%", status: "Healthy", statusColor: "#22c55e" },
  { metric: "5XX Errors", before: "42", now: "100", trend: "+138.1%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "4XX Errors", before: "562", now: "1,193", trend: "+112.3%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "API Traffic", before: "10,024", now: "26,165", trend: "+161.0%", status: "Scaling", statusColor: "#3b82f6" },
  { metric: "JS Errors", before: "0", now: "0", trend: "Flat", status: "Healthy", statusColor: "#22c55e" },
  { metric: "LCP (Load Time)", before: "6,167 ms", now: "3,284 ms", trend: "−46.8%", status: "Healthy", statusColor: "#22c55e" },
  { metric: "CLS (Stability)", before: "0.699", now: "0.330", trend: "−52.8%", status: "Healthy", statusColor: "#22c55e" },
])}

${generatePortalTable("Partner Portal", [
  { metric: "Latency (p90)", before: "245 ms", now: "900 ms", trend: "+267.3%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "5XX Errors", before: "523", now: "253", trend: "−51.6%", status: "Healthy", statusColor: "#22c55e" },
  { metric: "4XX Errors", before: "6,669", now: "14,392", trend: "+115.8%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "API Traffic", before: "138,789", now: "392,549", trend: "+182.8%", status: "Scaling", statusColor: "#3b82f6" },
  { metric: "JS Errors", before: "36", now: "22", trend: "−38.9%", status: "Healthy", statusColor: "#22c55e" },
  { metric: "LCP (Load Time)", before: "5,129 ms", now: "6,156 ms", trend: "+20.0%", status: "Degraded", statusColor: "#ef4444" },
  { metric: "CLS (Stability)", before: "0.644", now: "0.473", trend: "−26.6%", status: "Healthy", statusColor: "#22c55e" },
])}

<!-- Footer -->
<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:11px;">
  <p>Data source: CloudWatch namespace <code>DFG-Observability</code> + <code>AWS/ECS</code> + <code>AWS/RUM</code> | Dashboard: Consumer_Application_And_Services</p>
  <p>Generated automatically by CloudWatch Metrics Reports tool</p>
</div>

</div>
</body>
</html>`;

  return html;
}

async function main() {
  logger.info("Generating email-friendly HTML report...");
  const weeks = generateWeekBoundaries();
  const allData = [];

  for (const service of services) {
    logger.info(`Fetching weekly data for: ${service}`);
    const data = await fetchWeeklyMetrics(service, weeks);
    allData.push(data);
    logger.info(`  ✅ ${service} done`);
  }

  const html = generateEmailHTML(allData, weeks);

  mkdirSync("./output", { recursive: true });
  const filename = "./output/consumer-apps-email-report.html";
  writeFileSync(filename, html, "utf8");
  logger.info(`✅ Email report written: ${filename}`);
  console.log(`\n📧 Email-friendly report: ${filename}`);
  console.log(`   - Open in browser to preview`);
  console.log(`   - Copy/paste into email (Gmail: Ctrl+A in browser, Ctrl+C, paste into compose)`);
  console.log(`   - Or attach as .html file`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
