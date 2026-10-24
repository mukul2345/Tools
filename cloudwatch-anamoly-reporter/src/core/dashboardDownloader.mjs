#!/usr/bin/env node
/**
 * Dashboard Config Downloader - Downloads dashboard configs from CloudWatch
 * Used by Lambda to ensure fresh configs before report generation
 */

import {
  CloudWatchClient,
  GetDashboardCommand,
} from "@aws-sdk/client-cloudwatch";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGION = process.env.AWS_REGION || "eu-west-1";

/**
 * Create folder name from dashboard name (e.g., "Verification_Platform_Performance" -> "Verification")
 * Matches the logic from dashboard-to-configs.mjs exactly
 * Handles multiple dashboards with same prefix (e.g., Core_Services_Dashboard, Core_API_Performance, Core_Platform)
 */
function createFolderName(dashboardName) {
  // Convert dashboard name to folder name (like ECS_Observability_Dashboard -> ECS)
  const parts = dashboardName.split("_");
  if (parts.length > 1) {
    // Take first meaningful part (skip common words) - matches dashboard-to-configs.mjs
    const meaningfulParts = parts.filter(
      (part) =>
        !["dashboard", "observability", "monitoring", "metrics"].includes(
          part.toLowerCase()
        )
    );
    return meaningfulParts[0] || parts[0];
  }
  return dashboardName;
}

/**
 * Convert widget to config format (full version matching dashboard-to-configs.mjs)
 */
function convertWidgetToConfig(widget) {
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const props = widget.properties || {};

  function toSeries(widgetProps) {
    const metrics = widgetProps.metrics || [];
    if (!metrics.length) return [];

    let namespace = null,
      metricName = null,
      dimNames = [],
      lastDimVals = [];
    const stat = (widgetProps.stat || "").trim() || "Average";
    const series = [];

    const toDimsMap = (names, vals) =>
      Object.fromEntries(names.map((n, i) => [n, String(vals[i] ?? "")]));
    const clone = (o) => JSON.parse(JSON.stringify(o));

    function buildName(dimMap) {
      // Handle DynamoDB metrics - include TableName
      if (namespace === "AWS/DynamoDB" && dimMap.TableName) {
        const tableName = dimMap.TableName;
        const operation = dimMap.Operation || "";
        return operation ? `${tableName} (${operation})` : tableName;
      }

      // Handle API metrics
      const svc =
        dimMap.serviceName ||
        dimMap.ServiceName ||
        dimMap.api ||
        dimMap.ApiName ||
        "";
      const code = dimMap.statusCode || dimMap.StatusCode || "";
      const endpoint =
        dimMap.endpoint || dimMap.Endpoint || dimMap.path || dimMap.Path || "";
      const parts = [];
      if (svc) parts.push(svc);
      if (code) parts.push(`[${code}]`);
      if (endpoint) parts.push(endpoint);
      return parts.join(" ").trim() || `${namespace}/${metricName}`;
    }

    function pushSeries(dimVals) {
      const dimMap = toDimsMap(dimNames, dimVals);
      series.push({
        name: buildName(dimMap),
        namespace,
        metricName,
        stat,
        dimensions: dimMap,
      });
    }

    for (let idx = 0; idx < metrics.length; idx++) {
      const row = metrics[idx];
      if (!Array.isArray(row) || !row.length) continue;

      const hasOpts = isObj(row[row.length - 1]);
      const core = hasOpts ? row.slice(0, -1) : row;

      if (idx === 0 && row[0] !== "...") {
        namespace = core[0];
        metricName = core[1];
        const pairs = core.slice(2);
        if (pairs.length % 2 !== 0)
          throw new Error("Odd number of dimension tokens in first metric");
        dimNames = [];
        lastDimVals = [];
        for (let i = 0; i < pairs.length; i += 2) {
          dimNames.push(pairs[i]);
          lastDimVals.push(pairs[i + 1]);
        }
        pushSeries(lastDimVals);
        continue;
      }

      if (core[0] === "...") {
        const tokens = core.slice(1);
        const need = 2 * dimNames.length;
        const pos = tokens.slice(0, need);
        while (pos.length < need) pos.push(".");

        const newNames = clone(dimNames);
        const newVals = clone(lastDimVals);

        for (let k = 0; k < dimNames.length; k++) {
          const nameTok = pos[2 * k];
          const valTok = pos[2 * k + 1];
          const isKnown = (t) => typeof t === "string" && newNames.includes(t);

          if (nameTok && nameTok !== "." && isKnown(nameTok)) {
            newNames[k] = nameTok;
            if (valTok && valTok !== ".") newVals[k] = String(valTok);
            continue;
          }
          if (nameTok && nameTok !== "." && !isKnown(nameTok)) {
            newVals[k] = String(nameTok);
            continue;
          }
          if (valTok && valTok !== ".") newVals[k] = String(valTok);
        }
        lastDimVals = newVals;
        pushSeries(newVals);
        continue;
      }

      // Handle rows with "." as first element (same namespace, different metric name)
      // Format: [".","MetricName",".","."] or [".","MetricName","DimName","DimValue",...]
      if (
        core.length >= 2 &&
        core[0] === "." &&
        typeof core[1] === "string" &&
        core[1] !== "..."
      ) {
        // Same namespace, new metric name
        metricName = core[1];
        const pairs = core.slice(2);

        if (
          pairs.length === 0 ||
          (pairs.length === 2 && pairs[0] === "." && pairs[1] === ".")
        ) {
          // No dimensions specified, use same dimensions as before
          pushSeries(lastDimVals);
          continue;
        }

        if (pairs.length % 2 !== 0) {
          console.warn(
            `Odd number of dimension tokens in metric row ${idx}, skipping`
          );
          continue;
        }

        // Parse new dimensions
        const dimVals = [];
        for (let i = 0; i < pairs.length; i += 2) {
          if (pairs[i] === "." && pairs[i + 1] === ".") {
            // Use previous dimension value
            dimVals.push(lastDimVals[Math.floor(i / 2)] || ".");
          } else if (pairs[i] === ".") {
            // Same dimension name, new value
            dimVals.push(pairs[i + 1]);
          } else {
            // New dimension name and value
            dimVals.push(pairs[i + 1]);
          }
        }

        // Ensure we have the right number of dimensions
        while (dimVals.length < dimNames.length) {
          dimVals.push(".");
        }

        lastDimVals = dimVals.slice(0, dimNames.length);
        pushSeries(lastDimVals);
        continue;
      }

      // Handle complete metric rows (not using "..." format)
      if (core.length >= 2 && core[0] === namespace && core[1] === metricName) {
        const pairs = core.slice(2);
        if (pairs.length % 2 !== 0) {
          console.warn(
            `Odd number of dimension tokens in metric row ${idx}, skipping`
          );
          continue;
        }

        const dimVals = [];
        for (let i = 0; i < pairs.length; i += 2) {
          dimVals.push(pairs[i + 1]);
        }

        // Ensure we have the right number of dimensions
        while (dimVals.length < dimNames.length) {
          dimVals.push(".");
        }

        pushSeries(dimVals.slice(0, dimNames.length));
        continue;
      }

      // Handle new metric name/namespace (widgets with multiple different metrics)
      if (
        core.length >= 2 &&
        typeof core[0] === "string" &&
        typeof core[1] === "string" &&
        core[0] !== "." &&
        core[0] !== "..."
      ) {
        // This is a new metric with different namespace or metricName
        namespace = core[0];
        metricName = core[1];
        const pairs = core.slice(2);
        if (pairs.length % 2 !== 0) {
          console.warn(
            `Odd number of dimension tokens in metric row ${idx}, skipping`
          );
          continue;
        }
        dimNames = [];
        lastDimVals = [];
        for (let i = 0; i < pairs.length; i += 2) {
          dimNames.push(pairs[i]);
          lastDimVals.push(pairs[i + 1]);
        }
        pushSeries(lastDimVals);
        continue;
      }

      throw new Error(
        `Unsupported metric row at index ${idx}: ${JSON.stringify(row)}`
      );
    }

    return series;
  }

  const series = toSeries(props);
  if (series.length === 0) {
    return null;
  }

  return {
    title: props.title || "Untitled Widget",
    region: REGION,
    periodSeconds: 900,
    windowMinutes: 300,
    baselineDays: 7,
    minSamples: 10,
    zThreshold: 3.0,
    pctThreshold: 40,
    timezone: "Asia/Kolkata",
    skipWeekends: true,
    series,
  };
}

/**
 * Download dashboard configs from CloudWatch and save to /tmp (Lambda) or local (CLI)
 */
export async function downloadDashboardConfigs(dashboardName) {
  const folderName = createFolderName(dashboardName);

  // Use /tmp in Lambda (writable), configs/ locally (for testing)
  // Lambda environment check: AWS_LAMBDA_FUNCTION_NAME or AWS_EXECUTION_ENV
  const isLambda = !!(
    process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV
  );
  const baseDir = isLambda
    ? path.join("/tmp", "configs")
    : path.join(process.cwd(), "configs");

  const targetDir = path.join(baseDir, folderName);

  // Create directory
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  console.log(
    `[${dashboardName}] Downloading dashboard configs to: ${targetDir}`
  );

  // Configure CloudWatch client (Lambda uses IAM role, local uses profile)
  const cwConfig = { region: REGION };
  const cw = new CloudWatchClient(cwConfig);

  // Download dashboard
  const res = await cw.send(
    new GetDashboardCommand({ DashboardName: dashboardName })
  );

  if (!res || !res.DashboardBody) {
    throw new Error(`No dashboard body returned for ${dashboardName}`);
  }

  const body = JSON.parse(res.DashboardBody);
  const widgets = Array.isArray(body.widgets) ? body.widgets : [];

  if (!widgets.length) {
    throw new Error(`No widgets found in dashboard ${dashboardName}`);
  }

  console.log(`[${dashboardName}] Found ${widgets.length} widgets`);

  // Convert widgets to configs
  const configs = [];
  let count = 0;

  for (let i = 0; i < widgets.length; i++) {
    const w = widgets[i];
    const type = w.type || "unknown";

    // Only process metric widgets
    if (type !== "metric") continue;

    try {
      // Pass widget properties to converter (same as dashboard-to-configs.mjs)
      const config = convertWidgetToConfig({ properties: w.properties || {} });
      if (!config || !config.series || config.series.length === 0) {
        continue;
      }

      count++;
      const filename = `${String(count).padStart(2, "0")}-${config.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .substring(0, 50)}.json`;

      const filepath = path.join(targetDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(config, null, 2), "utf-8");
      configs.push({ file: filename, path: filepath, config });
    } catch (error) {
      console.warn(
        `[${dashboardName}] Failed to convert widget ${i + 1}: ${error.message}`
      );
    }
  }

  // Save manifest
  const manifest = {
    dashboardName,
    dashboardArn: res.DashboardArn,
    region: REGION,
    folderName,
    totalWidgets: widgets.length,
    exportedConfigs: configs.length,
    configs: configs.map((c) => ({
      file: c.file,
      title: c.config.title,
      seriesCount: c.config.series.length,
    })),
  };

  const manifestPath = path.join(
    targetDir,
    `manifest.${dashboardName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  console.log(
    `[${dashboardName}] ✅ Downloaded ${configs.length} config files to ${targetDir}`
  );

  return {
    folderName,
    targetDir,
    configCount: configs.length,
    manifest,
  };
}
