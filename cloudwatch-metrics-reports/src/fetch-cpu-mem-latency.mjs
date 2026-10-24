/**
 * Fetch CPU, Memory, and Latency trend data for Consumer App services
 */

import { getMetricDataBatched, buildMetricQuery, listMetricsAll } from "./cloudwatch.mjs";
import { logger } from "./logger.mjs";

const services = [
  "garuda",
  "applicant-service",
  "jaya-vijaya",
  "kuber",
  "order-service",
  "partner-service",
];

const clusterName = "cluster-production-common";
const namespace = "DFG-Observability";

const w1Start = new Date("2026-03-15T18:30:00.000Z");
const w1End = new Date("2026-03-22T18:30:00.000Z");
const w12Start = new Date("2026-05-31T18:30:00.000Z");
const w12End = new Date("2026-06-07T18:30:00.000Z");

function avg(results, id) {
  const r = results.find((x) => x.Id === id);
  if (!r || !r.Values || r.Values.length === 0) return 0;
  return r.Values.reduce((a, b) => a + b, 0) / r.Values.length;
}

function pctChange(oldVal, newVal) {
  if (oldVal === 0 && newVal === 0) return 0;
  if (oldVal === 0) return 100;
  return ((newVal - oldVal) / oldVal) * 100;
}

async function main() {
  console.log("=== CPU, Memory & Latency Trends ===");
  console.log("W1:  15 Mar - 22 Mar 2026");
  console.log("W12: 31 May - 7 Jun 2026");
  console.log("");

  const allResults = [];

  for (const service of services) {
    const ecsServiceName = `${service}-production-common`;
    logger.info(`Processing: ${service}`);

    // CPU & Memory queries
    const ecsQueries = [
      buildMetricQuery({
        id: "cpuavg",
        namespace: "AWS/ECS",
        metricName: "CPUUtilization",
        dimensions: [
          { Name: "ServiceName", Value: ecsServiceName },
          { Name: "ClusterName", Value: clusterName },
        ],
        stat: "Average",
        period: 3600,
      }),
      buildMetricQuery({
        id: "memavg",
        namespace: "AWS/ECS",
        metricName: "MemoryUtilization",
        dimensions: [
          { Name: "ServiceName", Value: ecsServiceName },
          { Name: "ClusterName", Value: clusterName },
        ],
        stat: "Average",
        period: 3600,
      }),
      buildMetricQuery({
        id: "cpumax",
        namespace: "AWS/ECS",
        metricName: "CPUUtilization",
        dimensions: [
          { Name: "ServiceName", Value: ecsServiceName },
          { Name: "ClusterName", Value: clusterName },
        ],
        stat: "Maximum",
        period: 3600,
      }),
      buildMetricQuery({
        id: "memmax",
        namespace: "AWS/ECS",
        metricName: "MemoryUtilization",
        dimensions: [
          { Name: "ServiceName", Value: ecsServiceName },
          { Name: "ClusterName", Value: clusterName },
        ],
        stat: "Maximum",
        period: 3600,
      }),
    ];

    const [ecsW1, ecsW12] = await Promise.all([
      getMetricDataBatched({ queries: ecsQueries, start: w1Start, end: w1End, period: 3600 }),
      getMetricDataBatched({ queries: ecsQueries, start: w12Start, end: w12End, period: 3600 }),
    ]);

    // Latency (p90) - discover and batch
    const latencyMetrics = await listMetricsAll({
      namespace,
      metricName: "API_LATENCY",
      dimensions: [
        { Name: "serviceName", Value: service },
        { Name: "environment", Value: "production" },
        { Name: "statusCode", Value: "200" },
      ],
    });

    let latencyW1P90 = 0;
    let latencyW12P90 = 0;

    if (latencyMetrics.length > 0) {
      const latencyQueries = latencyMetrics.map((m, i) =>
        buildMetricQuery({
          id: `lat${i}`,
          namespace,
          metricName: "API_LATENCY",
          dimensions: m.Dimensions,
          stat: "p90",
          period: 3600,
        })
      );

      const [latW1Results, latW12Results] = await Promise.all([
        getMetricDataBatched({ queries: latencyQueries, start: w1Start, end: w1End, period: 3600 }),
        getMetricDataBatched({ queries: latencyQueries, start: w12Start, end: w12End, period: 3600 }),
      ]);

      // Get average of all p90 values across endpoints (overall p90 approximation)
      const allP90W1 = [];
      const allP90W12 = [];
      for (const r of latW1Results) {
        if (r.Values && r.Values.length > 0) {
          allP90W1.push(...r.Values);
        }
      }
      for (const r of latW12Results) {
        if (r.Values && r.Values.length > 0) {
          allP90W12.push(...r.Values);
        }
      }

      // Use the 90th percentile of all p90 values as the overall p90
      allP90W1.sort((a, b) => a - b);
      allP90W12.sort((a, b) => a - b);

      if (allP90W1.length > 0) {
        const idx = Math.floor(allP90W1.length * 0.9);
        latencyW1P90 = allP90W1[idx];
      }
      if (allP90W12.length > 0) {
        const idx = Math.floor(allP90W12.length * 0.9);
        latencyW12P90 = allP90W12[idx];
      }
    }

    const cpuAvgW1 = avg(ecsW1, "cpuavg");
    const cpuAvgW12 = avg(ecsW12, "cpuavg");
    const memAvgW1 = avg(ecsW1, "memavg");
    const memAvgW12 = avg(ecsW12, "memavg");
    const cpuMaxW1 = avg(ecsW1, "cpumax"); // avg of hourly maxes
    const cpuMaxW12 = avg(ecsW12, "cpumax");
    const memMaxW1 = avg(ecsW1, "memmax");
    const memMaxW12 = avg(ecsW12, "memmax");

    const row = {
      service,
      cpuAvgW1,
      cpuAvgW12,
      cpuChange: pctChange(cpuAvgW1, cpuAvgW12),
      memAvgW1,
      memAvgW12,
      memChange: pctChange(memAvgW1, memAvgW12),
      cpuMaxW1,
      cpuMaxW12,
      memMaxW1,
      memMaxW12,
      latencyW1P90,
      latencyW12P90,
      latencyChange: pctChange(latencyW1P90, latencyW12P90),
    };

    allResults.push(row);

    console.log(`${service}:`);
    console.log(`  CPU (avg): ${cpuAvgW1.toFixed(1)}% → ${cpuAvgW12.toFixed(1)}% (${row.cpuChange >= 0 ? "+" : ""}${row.cpuChange.toFixed(1)}%)`);
    console.log(`  CPU (max): ${cpuMaxW1.toFixed(1)}% → ${cpuMaxW12.toFixed(1)}%`);
    console.log(`  Memory (avg): ${memAvgW1.toFixed(1)}% → ${memAvgW12.toFixed(1)}% (${row.memChange >= 0 ? "+" : ""}${row.memChange.toFixed(1)}%)`);
    console.log(`  Memory (max): ${memMaxW1.toFixed(1)}% → ${memMaxW12.toFixed(1)}%`);
    console.log(`  Latency (p90): ${latencyW1P90.toFixed(0)} ms → ${latencyW12P90.toFixed(0)} ms (${row.latencyChange >= 0 ? "+" : ""}${row.latencyChange.toFixed(1)}%)`);
    console.log("");
  }

  // Output JSON for report generation
  console.log("---JSON_OUTPUT---");
  console.log(JSON.stringify(allResults));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
