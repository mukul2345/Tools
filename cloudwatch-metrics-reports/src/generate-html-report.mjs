/**
 * Generate an HTML report with charts using Chart.js (CDN)
 * Includes: API Traffic, Error Rate, Log Ingestion, CPU, Memory, Latency trends
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

// 12 weeks starting 15 Mar 2026
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

async function fetchWeeklyTraffic(service, weeks) {
  const results = [];
  for (const week of weeks) {
    const metrics = await listMetricsAll({
      namespace,
      metricName: "API_COUNT",
      dimensions: [
        { Name: "serviceName", Value: service },
        { Name: "environment", Value: "production" },
      ],
    });

    if (metrics.length === 0) {
      results.push(0);
      continue;
    }

    const queries = metrics.map((m, i) =>
      buildMetricQuery({ id: `t${i}`, namespace, metricName: "API_COUNT", dimensions: m.Dimensions, stat: "Sum", period: 3600 })
    );

    const data = await getMetricDataBatched({ queries, start: week.start, end: week.end, period: 3600 });
    let total = 0;
    for (const r of data) {
      if (r.Values) total += r.Values.reduce((a, b) => a + b, 0);
    }
    results.push(Math.round(total));
    await sleep(100);
  }
  return results;
}

async function fetchWeekly5xxRate(service, weeks, trafficData) {
  const results = [];
  for (let i = 0; i < weeks.length; i++) {
    const week = weeks[i];
    const metrics = await listMetricsAll({
      namespace,
      metricName: "API_COUNT",
      dimensions: [
        { Name: "serviceName", Value: service },
        { Name: "environment", Value: "production" },
        { Name: "statusCode", Value: "500" },
      ],
    });

    if (metrics.length === 0) {
      results.push(0);
      continue;
    }

    const queries = metrics.map((m, j) =>
      buildMetricQuery({ id: `e${j}`, namespace, metricName: "API_COUNT", dimensions: m.Dimensions, stat: "Sum", period: 3600 })
    );

    const data = await getMetricDataBatched({ queries, start: week.start, end: week.end, period: 3600 });
    let errors = 0;
    for (const r of data) {
      if (r.Values) errors += r.Values.reduce((a, b) => a + b, 0);
    }
    const rate = trafficData[i] > 0 ? (errors / trafficData[i]) * 100 : 0;
    results.push(parseFloat(rate.toFixed(4)));
    await sleep(100);
  }
  return results;
}

async function fetchWeeklyCPU(service, weeks) {
  const ecsServiceName = `${service}-production-common`;
  const results = [];
  for (const week of weeks) {
    const queries = [
      buildMetricQuery({ id: "cpu", namespace: "AWS/ECS", metricName: "CPUUtilization", dimensions: [{ Name: "ServiceName", Value: ecsServiceName }, { Name: "ClusterName", Value: clusterName }], stat: "Average", period: 3600 }),
    ];
    const data = await getMetricDataBatched({ queries, start: week.start, end: week.end, period: 3600 });
    const r = data.find((x) => x.Id === "cpu");
    const avg = r && r.Values && r.Values.length > 0 ? r.Values.reduce((a, b) => a + b, 0) / r.Values.length : 0;
    results.push(parseFloat(avg.toFixed(2)));
  }
  return results;
}

async function fetchWeeklyMemory(service, weeks) {
  const ecsServiceName = `${service}-production-common`;
  const results = [];
  for (const week of weeks) {
    const queries = [
      buildMetricQuery({ id: "mem", namespace: "AWS/ECS", metricName: "MemoryUtilization", dimensions: [{ Name: "ServiceName", Value: ecsServiceName }, { Name: "ClusterName", Value: clusterName }], stat: "Average", period: 3600 }),
    ];
    const data = await getMetricDataBatched({ queries, start: week.start, end: week.end, period: 3600 });
    const r = data.find((x) => x.Id === "mem");
    const avg = r && r.Values && r.Values.length > 0 ? r.Values.reduce((a, b) => a + b, 0) / r.Values.length : 0;
    results.push(parseFloat(avg.toFixed(2)));
  }
  return results;
}

async function fetchWeeklyLatency(service, weeks) {
  const metrics = await listMetricsAll({
    namespace,
    metricName: "API_LATENCY",
    dimensions: [
      { Name: "serviceName", Value: service },
      { Name: "environment", Value: "production" },
      { Name: "statusCode", Value: "200" },
    ],
  });

  const results = [];
  for (const week of weeks) {
    if (metrics.length === 0) {
      results.push(0);
      continue;
    }
    const queries = metrics.map((m, i) =>
      buildMetricQuery({ id: `l${i}`, namespace, metricName: "API_LATENCY", dimensions: m.Dimensions, stat: "p90", period: 3600 })
    );
    const data = await getMetricDataBatched({ queries, start: week.start, end: week.end, period: 3600 });
    const allVals = [];
    for (const r of data) {
      if (r.Values) allVals.push(...r.Values);
    }
    allVals.sort((a, b) => a - b);
    const p90 = allVals.length > 0 ? allVals[Math.floor(allVals.length * 0.9)] : 0;
    results.push(Math.round(p90));
    await sleep(100);
  }
  return results;
}

function generateHTML(allData, weeks) {
  const labels = weeks.map((w) => w.label);
  const colors = ["#FF6384", "#36A2EB", "#FFCE56", "#4BC0C0", "#9966FF", "#FF9F40"];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Consumer Apps &amp; Services — Observability Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
    h1 { font-size: 28px; margin-bottom: 8px; color: #f8fafc; }
    h2 { font-size: 20px; margin: 32px 0 16px; color: #94a3b8; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    h3 { font-size: 16px; margin: 24px 0 12px; color: #cbd5e1; }
    .subtitle { color: #64748b; font-size: 14px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 32px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .card-title { font-size: 14px; color: #94a3b8; margin-bottom: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .chart-container { position: relative; height: 280px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th { background: #1e293b; color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 12px; text-align: left; border-bottom: 2px solid #334155; }
    td { padding: 12px; border-bottom: 1px solid #1e293b; font-size: 14px; }
    tr:hover td { background: #1e293b; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .badge-green { background: #064e3b; color: #6ee7b7; }
    .badge-red { background: #7f1d1d; color: #fca5a5; }
    .badge-yellow { background: #78350f; color: #fcd34d; }
    .badge-blue { background: #1e3a5f; color: #93c5fd; }
    .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 16px 0; }
    .summary-card { background: #1e293b; border-radius: 8px; padding: 16px; text-align: center; border: 1px solid #334155; }
    .summary-value { font-size: 24px; font-weight: 700; margin: 4px 0; }
    .summary-label { font-size: 12px; color: #64748b; }
    .trend-up { color: #f87171; }
    .trend-down { color: #4ade80; }
    .trend-flat { color: #94a3b8; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } .summary-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>🔍 Consumer Apps & Services — Observability Report</h1>
  <p class="subtitle">Period: 15 Mar 2026 → 7 Jun 2026 (12 weeks) | Dashboard: Consumer Application & Services</p>

  <h2>📊 API Traffic Trend (Weekly)</h2>
  <div class="grid">
    <div class="card">
      <div class="card-title">Total API Requests per Week</div>
      <div class="chart-container"><canvas id="trafficChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">5XX Error Rate % per Week</div>
      <div class="chart-container"><canvas id="errorChart"></canvas></div>
    </div>
  </div>

  <h2>⚙️ Infrastructure — CPU & Memory Utilization</h2>
  <div class="grid">
    <div class="card">
      <div class="card-title">CPU Utilization (avg %)</div>
      <div class="chart-container"><canvas id="cpuChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Memory Utilization (avg %)</div>
      <div class="chart-container"><canvas id="memChart"></canvas></div>
    </div>
  </div>

  <h2>⏱️ API Latency (p90)</h2>
  <div class="grid">
    <div class="card" style="grid-column: span 2;">
      <div class="card-title">p90 Latency (ms) per Week</div>
      <div class="chart-container"><canvas id="latencyChart"></canvas></div>
    </div>
  </div>

  <h2>📋 Summary Table — Week 1 vs Week 12</h2>
  <table>
    <thead>
      <tr><th>Service</th><th>Traffic (W1→W12)</th><th>5XX Rate</th><th>CPU Avg</th><th>Memory Avg</th><th>Latency p90</th></tr>
    </thead>
    <tbody>
      ${allData.map((s, i) => {
        const trafW1 = s.traffic[0], trafW12 = s.traffic[11];
        const errW1 = s.errorRate[0], errW12 = s.errorRate[11];
        const cpuW1 = s.cpu[0], cpuW12 = s.cpu[11];
        const memW1 = s.memory[0], memW12 = s.memory[11];
        const latW1 = s.latency[0], latW12 = s.latency[11];
        const fmtNum = (n) => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : n;
        const pct = (o,n) => o === 0 ? (n === 0 ? '0%' : '+∞') : ((n-o)/o*100).toFixed(1)+'%';
        const badge = (o,n,inv) => { const c = o===0&&n===0 ? 'flat' : (n>o ? (inv?'green':'red') : (inv?'red':'green')); return `<span class="badge badge-${c==='flat'?'blue':c}">${pct(o,n)}</span>`; };
        return `<tr>
          <td><strong>${s.service}</strong></td>
          <td>${fmtNum(trafW1)} → ${fmtNum(trafW12)} ${badge(trafW1,trafW12,false)}</td>
          <td>${errW1}% → ${errW12}% ${badge(errW1,errW12,true)}</td>
          <td>${cpuW1}% → ${cpuW12}% ${badge(cpuW1,cpuW12,true)}</td>
          <td>${memW1}% → ${memW12}% ${badge(memW1,memW12,true)}</td>
          <td>${latW1}ms → ${latW12}ms ${badge(latW1,latW12,true)}</td>
        </tr>`;
      }).join('\n      ')}
    </tbody>
  </table>

  <h2>🌐 Client-Facing Portals — 4-Month Trend (p90 Metrics)</h2>
  <p class="subtitle" style="margin-top:-8px;">Window: Week of 2026/01/29 (Before) → Week of 2026/05/22 (Now)</p>

  <div class="grid">
    <div class="card">
      <div class="card-title">Portal Latency (p90 ms) — Before vs Now</div>
      <div class="chart-container"><canvas id="portalLatencyChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Portal 5XX Errors — Before vs Now</div>
      <div class="chart-container"><canvas id="portal5xxChart"></canvas></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-title">Portal API Traffic — Before vs Now</div>
      <div class="chart-container"><canvas id="portalTrafficChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Core Web Vitals — LCP (ms)</div>
      <div class="chart-container"><canvas id="portalLCPChart"></canvas></div>
    </div>
  </div>

  <h3>Applicant Portal</h3>
  <table>
    <thead><tr><th>Metric</th><th>Before</th><th>Now</th><th>Trend</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>Latency (p90)</td><td>219 ms</td><td>279 ms</td><td><span class="badge badge-red">+27.4%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>5XX Errors</td><td>2,795</td><td>1,009</td><td><span class="badge badge-green">−63.9%</span></td><td><span class="badge badge-green">Healthy</span></td></tr>
      <tr><td>4XX Errors</td><td>122,930</td><td>266,810</td><td><span class="badge badge-red">+117.0%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>API Traffic</td><td>3.86M</td><td>6.60M</td><td><span class="badge badge-blue">+71.0%</span></td><td><span class="badge badge-blue">Scaling</span></td></tr>
      <tr><td>JS Errors</td><td>345</td><td>1,387</td><td><span class="badge badge-red">+302.0%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>LCP (Load Time)</td><td>6,335 ms</td><td>7,148 ms</td><td><span class="badge badge-red">+12.8%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>CLS (Stability)</td><td>0.645</td><td>0.649</td><td><span class="badge badge-green">+0.6%</span></td><td><span class="badge badge-green">Stable</span></td></tr>
    </tbody>
  </table>

  <h3>Client Portal</h3>
  <table>
    <thead><tr><th>Metric</th><th>Before</th><th>Now</th><th>Trend</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>Latency (p90)</td><td>1,232 ms</td><td>943 ms</td><td><span class="badge badge-green">−23.5%</span></td><td><span class="badge badge-green">Healthy</span></td></tr>
      <tr><td>5XX Errors</td><td>42</td><td>100</td><td><span class="badge badge-red">+138.1%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>4XX Errors</td><td>562</td><td>1,193</td><td><span class="badge badge-red">+112.3%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>API Traffic</td><td>10,024</td><td>26,165</td><td><span class="badge badge-blue">+161.0%</span></td><td><span class="badge badge-blue">Scaling</span></td></tr>
      <tr><td>JS Errors</td><td>0</td><td>0</td><td><span class="badge badge-blue">Flat</span></td><td><span class="badge badge-green">Healthy</span></td></tr>
      <tr><td>LCP (Load Time)</td><td>6,167 ms</td><td>3,284 ms</td><td><span class="badge badge-green">−46.8%</span></td><td><span class="badge badge-green">Healthy</span></td></tr>
      <tr><td>CLS (Stability)</td><td>0.699</td><td>0.330</td><td><span class="badge badge-green">−52.8%</span></td><td><span class="badge badge-green">Healthy</span></td></tr>
    </tbody>
  </table>

  <h3>Partner Portal</h3>
  <table>
    <thead><tr><th>Metric</th><th>Before</th><th>Now</th><th>Trend</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>Latency (p90)</td><td>245 ms</td><td>900 ms</td><td><span class="badge badge-red">+267.3%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>5XX Errors</td><td>523</td><td>253</td><td><span class="badge badge-green">−51.6%</span></td><td><span class="badge badge-green">Healthy</span></td></tr>
      <tr><td>4XX Errors</td><td>6,669</td><td>14,392</td><td><span class="badge badge-red">+115.8%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>API Traffic</td><td>138,789</td><td>392,549</td><td><span class="badge badge-blue">+182.8%</span></td><td><span class="badge badge-blue">Scaling</span></td></tr>
      <tr><td>JS Errors</td><td>36</td><td>22</td><td><span class="badge badge-green">−38.9%</span></td><td><span class="badge badge-green">Healthy</span></td></tr>
      <tr><td>LCP (Load Time)</td><td>5,129 ms</td><td>6,156 ms</td><td><span class="badge badge-red">+20.0%</span></td><td><span class="badge badge-red">Degraded</span></td></tr>
      <tr><td>CLS (Stability)</td><td>0.644</td><td>0.473</td><td><span class="badge badge-green">−26.6%</span></td><td><span class="badge badge-green">Healthy</span></td></tr>
    </tbody>
  </table>

  <script>
    const labels = ${JSON.stringify(labels)};
    const colors = ${JSON.stringify(colors)};
    const services = ${JSON.stringify(services)};
    const data = ${JSON.stringify(allData)};

    const commonOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, padding: 12, font: { size: 11 } } } },
      scales: { x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } } }
    };

    // Traffic chart
    new Chart(document.getElementById('trafficChart'), {
      type: 'line',
      data: { labels, datasets: data.map((s, i) => ({ label: s.service, data: s.traffic, borderColor: colors[i], backgroundColor: colors[i]+'33', tension: 0.3, fill: false, pointRadius: 2 })) },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'Requests', color: '#64748b' } } } }
    });

    // Error rate chart
    new Chart(document.getElementById('errorChart'), {
      type: 'line',
      data: { labels, datasets: data.map((s, i) => ({ label: s.service, data: s.errorRate, borderColor: colors[i], tension: 0.3, fill: false, pointRadius: 2 })) },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'Error Rate %', color: '#64748b' } } } }
    });

    // CPU chart
    new Chart(document.getElementById('cpuChart'), {
      type: 'line',
      data: { labels, datasets: data.map((s, i) => ({ label: s.service, data: s.cpu, borderColor: colors[i], tension: 0.3, fill: false, pointRadius: 2 })) },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'CPU %', color: '#64748b' }, max: 100 } } }
    });

    // Memory chart
    new Chart(document.getElementById('memChart'), {
      type: 'line',
      data: { labels, datasets: data.map((s, i) => ({ label: s.service, data: s.memory, borderColor: colors[i], tension: 0.3, fill: false, pointRadius: 2 })) },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'Memory %', color: '#64748b' }, max: 100 } } }
    });

    // Latency chart
    new Chart(document.getElementById('latencyChart'), {
      type: 'line',
      data: { labels, datasets: data.map((s, i) => ({ label: s.service, data: s.latency, borderColor: colors[i], tension: 0.3, fill: false, pointRadius: 2 })) },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'Latency (ms)', color: '#64748b' } } } }
    });

    // Portal charts
    const portalNames = ['Applicant Portal', 'Client Portal', 'Partner Portal'];
    const portalColors = { before: '#64748b', now: '#3b82f6' };

    // Portal Latency
    new Chart(document.getElementById('portalLatencyChart'), {
      type: 'bar',
      data: {
        labels: portalNames,
        datasets: [
          { label: 'Before', data: [219, 1232, 245], backgroundColor: '#475569', borderRadius: 4 },
          { label: 'Now', data: [279, 943, 900], backgroundColor: '#3b82f6', borderRadius: 4 },
        ]
      },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'ms', color: '#64748b' } } } }
    });

    // Portal 5XX
    new Chart(document.getElementById('portal5xxChart'), {
      type: 'bar',
      data: {
        labels: portalNames,
        datasets: [
          { label: 'Before', data: [2795, 42, 523], backgroundColor: '#475569', borderRadius: 4 },
          { label: 'Now', data: [1009, 100, 253], backgroundColor: '#ef4444', borderRadius: 4 },
        ]
      },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'Count', color: '#64748b' } } } }
    });

    // Portal Traffic
    new Chart(document.getElementById('portalTrafficChart'), {
      type: 'bar',
      data: {
        labels: portalNames,
        datasets: [
          { label: 'Before', data: [3860000, 10024, 138789], backgroundColor: '#475569', borderRadius: 4 },
          { label: 'Now', data: [6600000, 26165, 392549], backgroundColor: '#22c55e', borderRadius: 4 },
        ]
      },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'Requests', color: '#64748b' } } } }
    });

    // Portal LCP
    new Chart(document.getElementById('portalLCPChart'), {
      type: 'bar',
      data: {
        labels: portalNames,
        datasets: [
          { label: 'Before', data: [6335, 6167, 5129], backgroundColor: '#475569', borderRadius: 4 },
          { label: 'Now', data: [7148, 3284, 6156], backgroundColor: '#f59e0b', borderRadius: 4 },
        ]
      },
      options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: 'ms', color: '#64748b' } } } }
    });
  </script>
</body>
</html>`;
}

async function main() {
  logger.info("Generating HTML report with charts...");
  const weeks = generateWeekBoundaries();
  const allData = [];

  for (const service of services) {
    logger.info(`Fetching weekly data for: ${service}`);

    const traffic = await fetchWeeklyTraffic(service, weeks);
    const errorRate = await fetchWeekly5xxRate(service, weeks, traffic);
    const cpu = await fetchWeeklyCPU(service, weeks);
    const memory = await fetchWeeklyMemory(service, weeks);
    const latency = await fetchWeeklyLatency(service, weeks);

    allData.push({ service, traffic, errorRate, cpu, memory, latency });

    logger.info(`  ✅ ${service} done`);
  }

  const html = generateHTML(allData, weeks);

  mkdirSync("./output", { recursive: true });
  const filename = "./output/consumer-apps-observability-report.html";
  writeFileSync(filename, html, "utf8");
  logger.info(`✅ HTML report written: ${filename}`);
  console.log(`\n📊 Open in browser: ${filename}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
