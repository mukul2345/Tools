#!/usr/bin/env node

/**
 * Self-contained weekly report generator.
 *
 * Fetches 12-week CPU & Memory utilisation data from CloudWatch,
 * generates CSV files and dual-axis HTML charts for both metrics.
 *
 * This script has ZERO local imports — all logic from cloudwatch.mjs,
 * logger.mjs, and fetch-cpu-mem-latency.mjs is inlined here so that
 * teammates only need this one file + the @aws-sdk dependencies.
 *
 * Usage:
 *   node src/generate-weekly-report-standalone.mjs [--period <seconds>] [--weeks <count>]
 *
 * Defaults: --period 300 --weeks 12
 *
 * Output:
 *   output/cpu-utilisation-report.csv
 *   output/memory-utilisation-report.csv
 *   output/cpu-utilisation-charts.html
 *   output/memory-utilisation-charts.html
 *
 * Prerequisites:
 *   - Node.js >= 20
 *   - npm install @aws-sdk/client-cloudwatch @aws-sdk/credential-providers
 *   - AWS profile "dfg-prod" configured (or set AWS_PROFILE env var)
 */

import {
    CloudWatchClient,
    ListMetricsCommand,
    GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { fromIni } from "@aws-sdk/credential-providers";
import fs from "fs";
import path from "path";

// ============================================================
//  Logger (inlined from logger.mjs)
// ============================================================

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

function _log(level, ...args) {
    if (LOG_LEVELS[level] <= currentLogLevel) {
        const timestamp = new Date().toISOString();
        const emoji = { error: "❌", warn: "⚠️", info: "ℹ️", debug: "🔍" }[level] || "";
        console.error(`[${timestamp}] ${emoji} [${level.toUpperCase()}]`, ...args);
    }
}

const logger = {
    error: (...args) => _log("error", ...args),
    warn: (...args) => _log("warn", ...args),
    info: (...args) => _log("info", ...args),
    debug: (...args) => _log("debug", ...args),
};

// ============================================================
//  CloudWatch helpers (inlined from cloudwatch.mjs)
// ============================================================

const awsProfile = process.env.AWS_PROFILE || "prod";
const awsRegion = process.env.AWS_REGION || "eu-west-1";

const cloudWatchClient = new CloudWatchClient({
    region: awsRegion,
    credentials: fromIni({ profile: awsProfile }),
});

function sleepWithJitter(ms) {
    const jitter = Math.random() * 0.3 * ms;
    return new Promise((resolve) => setTimeout(resolve, ms + jitter));
}

async function executeWithRetry(commandFn, maxRetries = 5) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await cloudWatchClient.send(commandFn());
        } catch (error) {
            lastError = error;
            const isThrottling =
                error.name === "ThrottlingException" ||
                error.name === "TooManyRequestsException" ||
                error.$metadata?.httpStatusCode === 429;

            if (isThrottling && attempt < maxRetries) {
                const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
                logger.warn(`Throttled, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
                await sleepWithJitter(backoffMs);
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

async function listMetricsAll({ namespace, metricName, dimensions }) {
    const allMetrics = [];
    let nextToken = undefined;

    logger.info(`Listing metrics in namespace: ${namespace}${metricName ? `, metric: ${metricName}` : ""}`);

    do {
        const params = { Namespace: namespace, NextToken: nextToken };
        if (metricName) params.MetricName = metricName;
        if (dimensions?.length > 0) params.Dimensions = dimensions;

        const response = await executeWithRetry(() => new ListMetricsCommand(params));
        if (response.Metrics) {
            allMetrics.push(...response.Metrics);
            logger.debug(`Fetched ${response.Metrics.length} metrics (total: ${allMetrics.length})`);
        }
        nextToken = response.NextToken;
    } while (nextToken);

    logger.info(`Total metrics found: ${allMetrics.length}`);
    return allMetrics;
}

async function getMetricDataPaginated({ queries, start, end }) {
    const allResults = [];
    let nextToken = undefined;

    do {
        const params = {
            MetricDataQueries: queries,
            StartTime: start,
            EndTime: end,
            ScanBy: "TimestampDescending",
            NextToken: nextToken,
        };

        const response = await executeWithRetry(() => new GetMetricDataCommand(params));

        if (response.MetricDataResults) {
            if (allResults.length === 0) {
                allResults.push(...response.MetricDataResults);
            } else {
                response.MetricDataResults.forEach((newResult) => {
                    const existing = allResults.find((r) => r.Id === newResult.Id);
                    if (existing && newResult.Values) {
                        existing.Values.push(...newResult.Values);
                        existing.Timestamps.push(...newResult.Timestamps);
                    }
                });
            }
        }
        nextToken = response.NextToken;
    } while (nextToken);

    return allResults;
}

async function getMetricDataBatched({ queries, start, end, period }) {
    const BATCH_SIZE = 500;
    const allResults = [];

    logger.info(`Fetching metric data for ${queries.length} queries from ${start.toISOString()} to ${end.toISOString()}`);

    for (let i = 0; i < queries.length; i += BATCH_SIZE) {
        const batch = queries.slice(i, i + BATCH_SIZE);
        logger.debug(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(queries.length / BATCH_SIZE)} (${batch.length} queries)`);
        const batchResults = await getMetricDataPaginated({ queries: batch, start, end });
        allResults.push(...batchResults);
    }

    logger.info(`Fetched data for ${allResults.length} metric queries`);
    return allResults;
}

function buildMetricQuery({ id, namespace, metricName, dimensions, stat, period }) {
    return {
        Id: id,
        MetricStat: {
            Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions },
            Period: period,
            Stat: stat,
        },
        ReturnData: true,
    };
}

// ============================================================
//  Constants & helpers (inlined from fetch-cpu-mem-latency.mjs)
// ============================================================

const SERVICES = [
    "verification-workflow-engine",
    "verification-request",
    "poi-service",
    "core-verification-data-structure-service",
    "verification-initiation-service",
    "document-generation-service",
];

const CLUSTER_NAME = "cluster-production-common";
const OBSERVABILITY_NAMESPACE = "DFG-Observability";

function getWeekRanges(weekCount) {
    const now = new Date();
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon
    const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const currentWeekStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToSubtract)
    );

    const ranges = [];
    for (let i = weekCount; i >= 1; i--) {
        const weekStart = new Date(currentWeekStart.getTime() - i * 7 * 24 * 60 * 60 * 1000);
        const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
        ranges.push({ weekStart, weekEnd, label: `W${weekCount - i + 1}` });
    }
    return ranges;
}

function averageOfValues(metricResult) {
    if (!metricResult?.Values || metricResult.Values.length === 0) return 0;
    return metricResult.Values.reduce((a, b) => a + b, 0) / metricResult.Values.length;
}

function formatDate(date) {
    return date.toISOString().slice(0, 10);
}

// ============================================================
//  CLI argument parsing
// ============================================================

function parseArgs() {
    const args = process.argv.slice(2);
    let period = 300;
    let weeks = 12;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--period" && args[i + 1]) {
            period = parseInt(args[i + 1], 10);
            if (isNaN(period) || period <= 0) {
                console.error("Error: --period must be a positive integer (seconds).");
                process.exit(1);
            }
            i++;
        } else if (args[i] === "--weeks" && args[i + 1]) {
            weeks = parseInt(args[i + 1], 10);
            if (isNaN(weeks) || weeks <= 0) {
                console.error("Error: --weeks must be a positive integer.");
                process.exit(1);
            }
            i++;
        }
    }
    return { period, weeks };
}

// ============================================================
//  Fetch utilisation data for a single metric (cpu | memory)
// ============================================================

async function fetchUtilisationData(metric, period, weeks) {
    const weekRanges = getWeekRanges(weeks);
    const metricName = metric === "memory" ? "MemoryUtilization" : "CPUUtilization";
    const metricLabel = metric === "memory" ? "Memory" : "CPU";

    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Fetching ${metricLabel.toUpperCase()} utilisation (${weeks} weeks, ${period}s period)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Period: ${period}s | Metric: ${metricName} | Relative to API Request Count`);
    console.log(`Week range: ${formatDate(weekRanges[0].weekStart)} → ${formatDate(weekRanges[weekRanges.length - 1].weekEnd)}\n`);

    const allResults = [];

    for (const service of SERVICES) {
        const ecsServiceName = `${service}-production-common`;
        logger.info(`Processing: ${service}`);

        const weeklyData = [];

        // Discover API_COUNT metrics for accurate request counts
        const apiMetrics = await listMetricsAll({
            namespace: OBSERVABILITY_NAMESPACE,
            metricName: "API_COUNT",
            dimensions: [
                { Name: "serviceName", Value: service },
                { Name: "environment", Value: "production" },
            ],
        });

        logger.info(`Found ${apiMetrics.length} API_COUNT metric combinations for ${service}`);

        for (const { weekStart, weekEnd, label } of weekRanges) {
            const maxQuery = buildMetricQuery({
                id: "metricmax",
                namespace: "AWS/ECS",
                metricName,
                dimensions: [
                    { Name: "ServiceName", Value: ecsServiceName },
                    { Name: "ClusterName", Value: CLUSTER_NAME },
                ],
                stat: "Maximum",
                period,
            });

            const apiCountQueries = apiMetrics.map((m, i) =>
                buildMetricQuery({
                    id: `api${i}`,
                    namespace: OBSERVABILITY_NAMESPACE,
                    metricName: "API_COUNT",
                    dimensions: m.Dimensions,
                    stat: "Sum",
                    period,
                })
            );

            const results = await getMetricDataBatched({
                queries: [maxQuery, ...apiCountQueries],
                start: weekStart,
                end: weekEnd,
                period,
            });

            const maxResult = results.find((r) => r.Id === "metricmax");
            const avgMax = averageOfValues(maxResult);

            let totalApiCount = 0;
            for (const r of results) {
                if (r.Id.startsWith("api") && r.Values?.length > 0) {
                    totalApiCount += r.Values.reduce((a, b) => a + b, 0);
                }
            }

            weeklyData.push({
                week: label,
                start: formatDate(weekStart),
                end: formatDate(weekEnd),
                avgMaxUtilisation: parseFloat(avgMax.toFixed(2)),
                apiRequestCount: Math.round(totalApiCount),
            });
        }

        allResults.push({ service, weeklyData });

        // Console table
        console.log(`\n${service}:`);
        console.log(`  ${"Week".padEnd(5)} | ${"Period".padEnd(23)} | ${`Avg Max ${metricLabel} (%)`.padEnd(18)} | API Requests`);
        console.log(`  ${"-".repeat(5)} | ${"-".repeat(23)} | ${"-".repeat(18)} | ${"-".repeat(12)}`);
        for (const w of weeklyData) {
            console.log(`  ${w.week.padEnd(5)} | ${(w.start + " → " + w.end).padEnd(23)} | ${String(w.avgMaxUtilisation + "%").padEnd(18)} | ${w.apiRequestCount.toLocaleString()}`);
        }
    }

    return { allResults, metricLabel };
}

// ============================================================
//  Write CSV
// ============================================================

function writeCsv(metric, metricLabel, allResults, outputDir) {
    const csvRows = [`Service,Week,Start,End,Avg Max ${metricLabel} (%),API Requests`];
    for (const { service, weeklyData } of allResults) {
        for (const w of weeklyData) {
            csvRows.push(`${service},${w.week},${w.start},${w.end},${w.avgMaxUtilisation},${w.apiRequestCount}`);
        }
    }
    const csvPath = path.join(outputDir, `${metric}-utilisation-report.csv`);
    fs.writeFileSync(csvPath, csvRows.join("\n"), "utf-8");
    console.log(`\n📄 CSV written to: ${csvPath}`);
    return csvPath;
}

// ============================================================
//  Generate dual-axis HTML charts from CSV
// ============================================================

function generateChartHtml(metric, csvPath, outputPath, weeks, period) {
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

    const dataEntries = [];
    for (const line of lines) {
        const [service, week, start, end, value, apiReqs] = line.split(",");
        const numVal = parseFloat(value);
        const numApi = parseInt(apiReqs, 10);
        if (numVal === 0 && numApi === 0) continue;
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
    return outputPath;
}

// ============================================================
//  Main
// ============================================================

async function main() {
    const { period, weeks } = parseArgs();
    const outputDir = path.resolve("output");

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log("🚀 Starting weekly utilisation report generation...\n");

    // Step 1: Fetch CPU data & write CSV
    const cpuData = await fetchUtilisationData("cpu", period, weeks);
    const cpuCsvPath = writeCsv("cpu", cpuData.metricLabel, cpuData.allResults, outputDir);

    // Step 2: Fetch Memory data & write CSV
    const memData = await fetchUtilisationData("memory", period, weeks);
    const memCsvPath = writeCsv("memory", memData.metricLabel, memData.allResults, outputDir);

    // Step 3: Generate HTML charts from CSVs
    const cpuHtmlPath = path.join(outputDir, "cpu-utilisation-charts.html");
    generateChartHtml("cpu", cpuCsvPath, cpuHtmlPath, weeks, period);

    const memHtmlPath = path.join(outputDir, "memory-utilisation-charts.html");
    generateChartHtml("memory", memCsvPath, memHtmlPath, weeks, period);

    // Summary
    console.log(`\n${"=".repeat(60)}`);
    console.log("  ✅ All done! Output files:");
    console.log(`${"=".repeat(60)}`);
    console.log(`  📄 ${cpuCsvPath}`);
    console.log(`  📄 ${memCsvPath}`);
    console.log(`  📊 ${cpuHtmlPath}`);
    console.log(`  📊 ${memHtmlPath}`);
    console.log(`\n  Open charts in browser:`);
    console.log(`    open ${cpuHtmlPath}`);
    console.log(`    open ${memHtmlPath}`);
}

main().catch((e) => {
    console.error("❌ Fatal error:", e);
    process.exit(1);
});
