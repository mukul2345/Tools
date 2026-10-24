/**
 * Backend Services — API Traffic, 5XX Error Rate & Log Ingestion Trend Module
 *
 * Generates a week-over-week comparison report for 12 weeks showing:
 * - API Traffic Trend (total requests per service)
 * - 5XX Error Rate Trend (% of 5XX out of total)
 * - Log Ingestion Trend (CloudWatch Logs IncomingBytes per service)
 */

import { logger } from "./logger.mjs";
import { listMetricsAll, buildMetricQuery, getMetricDataBatched } from "./cloudwatch.mjs";

/**
 * Format bytes to human-readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  if (value >= 100) return `${Math.round(value)} ${units[i]}`;
  if (value >= 10) return `${value.toFixed(1)} ${units[i]}`;
  return `${value.toFixed(2)} ${units[i]}`;
}

/**
 * Format number with K/M suffix
 * @param {number} num
 * @returns {string}
 */
function formatCount(num) {
  if (num === 0) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(0)}K`;
  return `${Math.round(num)}`;
}

/**
 * Format error rate with appropriate precision
 * Shows more decimals for very small rates to avoid displaying as 0.000%
 * @param {number} rate - Error rate as percentage (e.g., 0.0031)
 * @returns {string}
 */
function formatErrorRate(rate) {
  if (rate === 0) return "0%";
  if (rate >= 1) return `${rate.toFixed(2)}%`;
  if (rate >= 0.01) return `${rate.toFixed(3)}%`;
  if (rate >= 0.001) return `${rate.toFixed(4)}%`;
  return `${rate.toFixed(5)}%`;
}

/**
 * Get trend emoji and text
 * @param {number} percentChange - Percentage change (negative = decrease)
 * @param {string} metricType - "traffic", "error", "logs"
 * @returns {string}
 */
function getTrendIndicator(percentChange, metricType) {
  if (Math.abs(percentChange) < 0.5) {
    return "🟢 Flat (0%)";
  }

  const sign = percentChange > 0 ? "+" : "";
  const pctStr = `${sign}${percentChange.toFixed(1)}%`;

  if (metricType === "traffic") {
    // For traffic: decrease is ⚠️ (amber warning), increase is 🟢
    if (percentChange < -10) return `⚠️ ${pctStr}`;
    if (percentChange > 0) return `🟢 ${pctStr}`;
    return `🟡 ${pctStr}`;
  }

  if (metricType === "error") {
    // For errors: decrease is 🟢 (good), increase is 🔴 (bad)
    if (percentChange <= -50) return `🟢 ${pctStr}`;
    if (percentChange < 0) return `🟢 ${pctStr}`;
    if (percentChange > 50) return `🔴 ${pctStr}`;
    return `⚠️ ${pctStr}`;
  }

  if (metricType === "logs") {
    // For log ingestion: decrease is 🟢 (cost savings), increase is ⚠️
    if (percentChange < -50) return `🟢 ${pctStr}`;
    if (percentChange < 0) return `🟢 ${pctStr}`;
    if (percentChange > 50) return `🔴 ${pctStr}`;
    return `⚠️ ${pctStr}`;
  }

  return pctStr;
}

/**
 * Calculate percentage change between two values
 * @param {number} oldVal
 * @param {number} newVal
 * @returns {number}
 */
function percentChange(oldVal, newVal) {
  if (oldVal === 0 && newVal === 0) return 0;
  if (oldVal === 0) return 100;
  return ((newVal - oldVal) / oldVal) * 100;
}

/**
 * Generate week boundaries for N weeks starting from a given date
 * @param {Date} startDate - First day of week 1
 * @param {number} numWeeks
 * @returns {Array<{start: Date, end: Date, label: string}>}
 */
function generateWeekBoundaries(startDate, numWeeks) {
  const weeks = [];
  for (let i = 0; i < numWeeks; i++) {
    const weekStart = new Date(startDate.getTime() + i * 7 * 24 * 60 * 60 * 1000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
    weeks.push({
      start: weekStart,
      end: weekEnd,
      label: `W${i + 1} (${weekStart.toISOString().slice(0, 10)})`,
    });
  }
  return weeks;
}

/**
 * Fetch total API traffic per service for a given time range
 * Uses batch individual metric queries for accuracy (SEARCH has 500-series cap)
 */
async function fetchServiceTraffic({ namespace, service, start, end }) {
  const period = 3600;

  try {
    // Discover all API_COUNT metrics for this service
    const metrics = await listMetricsAll({
      namespace,
      metricName: "API_COUNT",
      dimensions: [
        { Name: "serviceName", Value: service },
        { Name: "environment", Value: "production" },
      ],
    });

    if (metrics.length === 0) {
      logger.warn(`No API_COUNT metrics found for ${service}`);
      return 0;
    }

    // Build queries for all metrics
    const queries = metrics.map((m, i) =>
      buildMetricQuery({
        id: `t${i}`,
        namespace,
        metricName: "API_COUNT",
        dimensions: m.Dimensions,
        stat: "Sum",
        period,
      })
    );

    const results = await getMetricDataBatched({ queries, start, end, period });

    let total = 0;
    for (const r of results) {
      if (r.Values) {
        total += r.Values.reduce((sum, v) => sum + v, 0);
      }
    }

    return total;
  } catch (error) {
    logger.warn(`Failed to fetch traffic for ${service}: ${error.message}`);
    return 0;
  }
}

/**
 * Fetch 5XX error count per service for a given time range
 * Uses batch individual metric queries filtered to statusCode=500
 */
async function fetchService5xxErrors({ namespace, service, start, end }) {
  const period = 3600;

  try {
    // Discover API_COUNT metrics for this service with statusCode=500
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
      return 0;
    }

    // Build queries for all 5xx metrics
    const queries = metrics.map((m, i) =>
      buildMetricQuery({
        id: `e${i}`,
        namespace,
        metricName: "API_COUNT",
        dimensions: m.Dimensions,
        stat: "Sum",
        period,
      })
    );

    const results = await getMetricDataBatched({ queries, start, end, period });

    let total = 0;
    for (const r of results) {
      if (r.Values) {
        total += r.Values.reduce((sum, v) => sum + v, 0);
      }
    }

    return total;
  } catch (error) {
    logger.warn(`Failed to fetch 5xx errors for ${service}: ${error.message}`);
    return 0;
  }
}

/**
 * Fetch log ingestion bytes for a service's log group
 * Checks both the main log group and the -infrequent variant
 */
async function fetchLogIngestion({ service, start, end }) {
  const period = 3600;
  const logGroupMain = service;
  const logGroupInfrequent = `${service}-infrequent`;

  const safeIdMain = `logm${service.replace(/[^a-zA-Z0-9]/g, "")}`.slice(0, 250).toLowerCase();
  const safeIdInfreq = `logi${service.replace(/[^a-zA-Z0-9]/g, "")}`.slice(0, 250).toLowerCase();

  const queries = [
    buildMetricQuery({
      id: safeIdMain,
      namespace: "AWS/Logs",
      metricName: "IncomingBytes",
      dimensions: [{ Name: "LogGroupName", Value: logGroupMain }],
      stat: "Sum",
      period,
    }),
    buildMetricQuery({
      id: safeIdInfreq,
      namespace: "AWS/Logs",
      metricName: "IncomingBytes",
      dimensions: [{ Name: "LogGroupName", Value: logGroupInfrequent }],
      stat: "Sum",
      period,
    }),
  ];

  try {
    const results = await getMetricDataBatched({ queries, start, end, period });

    let total = 0;
    for (const r of results) {
      if (r.Values) {
        total += r.Values.reduce((sum, v) => sum + v, 0);
      }
    }
    return total;
  } catch (error) {
    logger.warn(`Failed to fetch log ingestion for ${service}: ${error.message}`);
    return 0;
  }
}

/**
 * Sleep utility for rate limiting
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the traffic trend module
 * @param {Object} params
 * @param {string} params.namespace - Custom CloudWatch namespace
 * @param {Array<string>} params.services - List of services to report on
 * @param {Date} params.startDate - Start date (first day of week 1)
 * @param {number} params.numWeeks - Number of weeks to analyze (default: 12)
 * @returns {Promise<Object>} - Report data
 */
export async function runTrafficTrendModule({
  namespace,
  services,
  startDate,
  numWeeks = 12,
}) {
  logger.info(`Running Traffic Trend Module for ${numWeeks} weeks starting ${startDate.toISOString().slice(0, 10)}`);
  logger.info(`Services: ${services.join(", ")}`);

  const weeks = generateWeekBoundaries(startDate, numWeeks);
  const firstWeek = weeks[0];
  const lastWeek = weeks[weeks.length - 1];

  logger.info(`Period: ${firstWeek.start.toISOString().slice(0, 10)} to ${lastWeek.end.toISOString().slice(0, 10)}`);

  const results = [];

  for (const service of services) {
    logger.info(`Processing service: ${service}`);

    // Fetch data for first week and last week
    const [firstTraffic, lastTraffic] = await Promise.all([
      fetchServiceTraffic({ namespace, service, start: firstWeek.start, end: firstWeek.end }),
      fetchServiceTraffic({ namespace, service, start: lastWeek.start, end: lastWeek.end }),
    ]);

    await sleep(200); // Rate limit

    const [firstErrors, lastErrors] = await Promise.all([
      fetchService5xxErrors({ namespace, service, start: firstWeek.start, end: firstWeek.end }),
      fetchService5xxErrors({ namespace, service, start: lastWeek.start, end: lastWeek.end }),
    ]);

    await sleep(200);

    const [firstLogs, lastLogs] = await Promise.all([
      fetchLogIngestion({ service, start: firstWeek.start, end: firstWeek.end }),
      fetchLogIngestion({ service, start: lastWeek.start, end: lastWeek.end }),
    ]);

    await sleep(200);

    // Calculate error rates
    const firstErrorRate = firstTraffic > 0 ? (firstErrors / firstTraffic) * 100 : 0;
    const lastErrorRate = lastTraffic > 0 ? (lastErrors / lastTraffic) * 100 : 0;

    // Calculate percentage changes
    const trafficChange = percentChange(firstTraffic, lastTraffic);
    const errorRateChange = percentChange(firstErrorRate, lastErrorRate);
    const logChange = percentChange(firstLogs, lastLogs);

    results.push({
      service,
      firstWeekTraffic: firstTraffic,
      lastWeekTraffic: lastTraffic,
      trafficChange,
      firstWeekErrorRate: firstErrorRate,
      lastWeekErrorRate: lastErrorRate,
      errorRateChange,
      firstWeekErrors: firstErrors,
      lastWeekErrors: lastErrors,
      firstWeekLogs: firstLogs,
      lastWeekLogs: lastLogs,
      logChange,
    });

    logger.info(`  Traffic: ${formatCount(firstTraffic)} → ${formatCount(lastTraffic)} (${trafficChange.toFixed(1)}%)`);
    logger.info(`  5XX Rate: ${firstErrorRate.toFixed(4)}% → ${lastErrorRate.toFixed(4)}%`);
    logger.info(`  Logs: ${formatBytes(firstLogs)} → ${formatBytes(lastLogs)}`);
  }

  return {
    firstWeek,
    lastWeek,
    numWeeks,
    results,
  };
}

/**
 * Render traffic trend report as Markdown table
 * @param {Object} data - Output from runTrafficTrendModule
 * @returns {string}
 */
export function renderTrafficTrendTable(data) {
  const { firstWeek, lastWeek, numWeeks, results } = data;

  let md = `## Backend Services — API Traffic, 5XX Error Rate & Log Ingestion Trend\n\n`;
  md += `**Period:** ${firstWeek.start.toISOString().slice(0, 10)} to ${lastWeek.end.toISOString().slice(0, 10)} (${numWeeks} weeks)\n`;
  md += `**Comparison:** Week 1 (${firstWeek.start.toISOString().slice(0, 10)}) vs Week ${numWeeks} (${lastWeek.start.toISOString().slice(0, 10)})\n\n`;

  md += "| Service Name | API Traffic Trend | 5XX Error Rate Trend | Log Ingestion Trend |\n";
  md += "|---|---|---|---|\n";

  for (const row of results) {
    const trafficTrend = `${getTrendIndicator(row.trafficChange, "traffic")} (${formatCount(row.firstWeekTraffic)} → ${formatCount(row.lastWeekTraffic)})`;

    let errorTrend;
    if (row.firstWeekErrorRate === 0 && row.lastWeekErrorRate === 0) {
      errorTrend = "🟢 Flat (0%)";
    } else if (row.lastWeekErrorRate === 0 && row.firstWeekErrorRate > 0) {
      errorTrend = `🟢 −100% (${formatErrorRate(row.firstWeekErrorRate)} → 0%)`;
    } else if (row.firstWeekErrorRate < 0.001 && row.lastWeekErrorRate < 0.001) {
      // Both rates are negligible (< 0.001%), show as effectively flat or with actual values
      if (Math.abs(row.errorRateChange) > 50 && row.lastWeekErrorRate < 0.001) {
        // Large % change but both values are negligible — show as "Negligible"
        errorTrend = `🟢 Negligible (${formatErrorRate(row.firstWeekErrorRate)} → ${formatErrorRate(row.lastWeekErrorRate)})`;
      } else {
        errorTrend = `${getTrendIndicator(row.errorRateChange, "error")} (${formatErrorRate(row.firstWeekErrorRate)} → ${formatErrorRate(row.lastWeekErrorRate)})`;
      }
    } else {
      errorTrend = `${getTrendIndicator(row.errorRateChange, "error")} (${formatErrorRate(row.firstWeekErrorRate)} → ${formatErrorRate(row.lastWeekErrorRate)})`;
    }

    const logTrend = `${getTrendIndicator(row.logChange, "logs")} (${formatBytes(row.firstWeekLogs)} → ${formatBytes(row.lastWeekLogs)})`;

    md += `| ${row.service} | ${trafficTrend} | ${errorTrend} | ${logTrend} |\n`;
  }

  md += `\n**Legend:**\n`;
  md += `- 🟢 = Healthy / Improved\n`;
  md += `- ⚠️ = Needs Attention\n`;
  md += `- 🔴 = Critical / Degraded\n`;

  return md;
}

/**
 * Render traffic trend report as CSV
 * @param {Object} data - Output from runTrafficTrendModule
 * @returns {string}
 */
export function renderTrafficTrendCSV(data) {
  const { results } = data;

  let csv = "Service,W1 Traffic,W12 Traffic,Traffic Change %,W1 5XX Rate %,W12 5XX Rate %,Error Rate Change %,W1 Log Bytes,W12 Log Bytes,Log Change %\n";

  for (const row of results) {
    const service = `"${row.service}"`;
    csv += `${service},${Math.round(row.firstWeekTraffic)},${Math.round(row.lastWeekTraffic)},${row.trafficChange.toFixed(1)},${row.firstWeekErrorRate.toFixed(4)},${row.lastWeekErrorRate.toFixed(4)},${row.errorRateChange.toFixed(1)},${Math.round(row.firstWeekLogs)},${Math.round(row.lastWeekLogs)},${row.logChange.toFixed(1)}\n`;
  }

  return csv;
}
