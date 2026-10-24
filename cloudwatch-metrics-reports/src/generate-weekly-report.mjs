#!/usr/bin/env node

/**
 * One-command weekly report generator.
 *
 * Fetches 12-week CPU & Memory utilisation data from CloudWatch,
 * generates CSV files and dual-axis HTML charts for both metrics.
 *
 * Usage:
 *   node src/generate-weekly-report.mjs [--period <seconds>] [--weeks <count>]
 *
 * Defaults: --period 300 --weeks 12
 *
 * Output:
 *   output/cpu-utilisation-report.csv
 *   output/memory-utilisation-report.csv
 *   output/cpu-utilisation-charts.html
 *   output/memory-utilisation-charts.html
 */

import { execFileSync } from "child_process";
import { resolve } from "path";
import fs from "fs";

const args = process.argv.slice(2);
let period = "300";
let weeks = "12";

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--period" && args[i + 1]) { period = args[i + 1]; i++; }
    else if (args[i] === "--weeks" && args[i + 1]) { weeks = args[i + 1]; i++; }
}

const scriptPath = resolve("src/fetch-cpu-mem-latency.mjs");
const outputDir = resolve("output");

function run(metric) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Fetching ${metric.toUpperCase()} utilisation (${weeks} weeks, ${period}s period)`);
    console.log(`${"=".repeat(60)}\n`);

    execFileSync("node", [scriptPath, "--metric", metric, "--period", period, "--weeks", weeks], {
        stdio: "inherit",
        cwd: resolve("."),
    });
}

function generateChartHtml(metric, csvPath, outputPath) {
    const csv = fs.readFileSync(csvPath, "utf-8");
    const lines = csv.trim().split("\n").slice(1); // skip header

    const metricLabel = metric === "cpu" ? "Avg Max CPU (%)" : "Avg Max Memory (%)";
    const metricKey = metric === "cpu" ? "cpu" : "mem";
    const lineColor = metric === "cpu" ? "#e63946" : "#6a0dad";
    const bgColor = metric === "cpu" ? "rgba(230,57,70,0.1)" : "rgba(106,13,173,0.1)";
    const axisLabel = metric === "cpu" ? "CPU %" : "Memory %";
    const title = metric === "cpu"
        ? "Weekly CPU Utilisation & API Request Trends"
        : "Weekly Memory Utilisation & API Request Trends";

    // Parse CSV into JS data
    const dataEntries = [];
    for (const line of lines) {
        const [service, week, start, end, value, apiReqs] = line.split(",");
        const numVal = parseFloat(value);
        const numApi = parseInt(apiReqs, 10);
        if (numVal === 0 && numApi === 0) continue; // skip zero weeks
        dataEntries.push(`{s:"${service}",w:"${week}",start:"${start}",end:"${end}",${metricKey}:${numVal},api:${numApi}}`);
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"><\/script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #1a1a2e; padding: 32px; }
        h1 { text-align: center; margin-bottom: 8px; font-size: 1.6rem; }
        .subtitle { text-align: center; color: #666; margin-bottom: 32px; font-size: 0.9rem; }
        .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; max-width: 1400px; margin: 0 auto; }
        .chart-card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .chart-card h2 { font-size: 0.95rem; color: #333; margin-bottom: 12px; font-weight: 600; }
        .chart-container { position: relative; height: 280px; }
        @media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <h1>${title}</h1>
    <p class="subtitle">Past ${weeks} weeks (filtered: zero-value weeks excluded) · Period: ${period}s</p>
    <div class="charts-grid" id="chartsGrid"></div>
    <script>
    const rawData = [
        ${dataEntries.join(",\n        ")}
    ];

    const services = [...new Set(rawData.map(d => d.s))];
    const serviceData = {};
    for (const s of services) { serviceData[s] = rawData.filter(d => d.s === s && d.${metricKey} > 0); }

    const grid = document.getElementById('chartsGrid');
    const colors = { metric: { line: '${lineColor}', bg: '${bgColor}' }, api: { line: '#457b9d', bg: 'rgba(69,123,157,0.1)' } };

    for (const service of services) {
        const data = serviceData[service];
        const hasApiData = data.some(d => d.api > 0);
        const card = document.createElement('div');
        card.className = 'chart-card';
        card.innerHTML = \`<h2>\${service}</h2><div class="chart-container"><canvas></canvas></div>\`;
        grid.appendChild(card);
        const ctx = card.querySelector('canvas').getContext('2d');

        const datasets = [{
            label: '${metricLabel}', data: data.map(d => d.${metricKey}),
            borderColor: colors.metric.line, backgroundColor: colors.metric.bg,
            yAxisID: 'yMetric', tension: 0.3, pointRadius: 4, pointHoverRadius: 6, fill: true,
        }];
        const scales = {
            yMetric: { type: 'linear', position: 'left', title: { display: true, text: '${axisLabel}', color: colors.metric.line }, ticks: { color: colors.metric.line }, grid: { color: 'rgba(0,0,0,0.04)' } },
        };
        if (hasApiData) {
            datasets.push({
                label: 'API Requests', data: data.map(d => d.api),
                borderColor: colors.api.line, backgroundColor: colors.api.bg,
                yAxisID: 'yApi', tension: 0.3, pointRadius: 4, pointHoverRadius: 6, fill: true, borderDash: [5, 3],
            });
            scales.yApi = { type: 'linear', position: 'right', title: { display: true, text: 'API Requests', color: colors.api.line }, ticks: { color: colors.api.line, callback: (v) => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v }, grid: { drawOnChartArea: false } };
        }
        new Chart(ctx, { type: 'line', data: { labels: data.map(d => d.w), datasets }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, padding: 16 } } }, scales } });
    }
    <\/script>
</body>
</html>`;

    fs.writeFileSync(outputPath, html, "utf-8");
    console.log(`📊 Charts written to: ${outputPath}`);
}

// --- Run ---

console.log("🚀 Starting weekly utilisation report generation...\n");

// Step 1: Fetch CPU data
run("cpu");

// Step 2: Fetch Memory data
run("memory");

// Step 3: Generate CPU charts HTML from CSV
const cpuCsv = resolve(outputDir, "cpu-utilisation-report.csv");
const cpuHtml = resolve(outputDir, "cpu-utilisation-charts.html");
generateChartHtml("cpu", cpuCsv, cpuHtml);

// Step 4: Generate Memory charts HTML from CSV
const memCsv = resolve(outputDir, "memory-utilisation-report.csv");
const memHtml = resolve(outputDir, "memory-utilisation-charts.html");
generateChartHtml("memory", memCsv, memHtml);

console.log(`\n${"=".repeat(60)}`);
console.log("  ✅ All done! Output files:");
console.log(`${"=".repeat(60)}`);
console.log(`  📄 ${cpuCsv}`);
console.log(`  📄 ${memCsv}`);
console.log(`  📊 ${cpuHtml}`);
console.log(`  📊 ${memHtml}`);
console.log(`\n  Open charts in browser:`);
console.log(`    open ${cpuHtml}`);
console.log(`    open ${memHtml}`);
