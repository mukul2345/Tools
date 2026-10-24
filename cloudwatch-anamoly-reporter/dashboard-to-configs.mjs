#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CloudWatchClient,
  GetDashboardCommand,
} from "@aws-sdk/client-cloudwatch";
import { fromIni } from "@aws-sdk/credential-providers";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../../.env") });

// Load configuration.json as the single source of truth
const globalConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "configuration.json"), "utf-8")
);

/**
 * Dashboard to Configs Downloader
 *
 * Downloads CloudWatch dashboard widgets and converts them to analysis-ready configs
 * using configuration.json as the source of truth for all settings.
 *
 * Usage:
 *   node dashboard-to-configs.mjs "<dashboard-name|arn|console-url>" [--region=eu-west-1] [--profile=prod] [--all]
 *   npm run download-dashboard-configs "<dashboard-name>"
 *
 * Examples:
 *   node dashboard-to-configs.mjs "ECS_Observability_Dashboard"
 *   node dashboard-to-configs.mjs "ECS_Observability_Dashboard" --profile=prod --region=eu-west-1
 *   node dashboard-to-configs.mjs "https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#dashboards/dashboard/ECS_Observability_Dashboard"
 *   npm run download-dashboard-configs "ECS_Observability_Dashboard" -- --profile=prod --region=eu-west-1
 *
 * This creates:
 *   configs/ECS/01-api-latency-for-applicant-service.json
 *   configs/ECS/02-api-status-code-for-applicant-service.json
 *   configs/ECS/manifest.ecs-observability-dashboard.json
 */

const arg = (k, def = null) => {
  const hit = process.argv.find((p) => p.startsWith(`--${k}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  return process.argv.includes(`--${k}`) ? true : def;
};

const dashboardInput = process.argv[2];
if (!dashboardInput) {
  console.error(
    "Usage: node dashboard-to-configs.mjs <dashboard-name|arn|console-url> [--region=eu-west-1] [--profile=prod] [--all]"
  );
  console.error(
    'Example: node dashboard-to-configs.mjs "ECS_Observability_Dashboard"'
  );
  console.error(
    'Example: node dashboard-to-configs.mjs "ECS_Observability_Dashboard" --profile=prod --region=eu-west-1'
  );
  console.error(
    'Example: node dashboard-to-configs.mjs "https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#dashboards/dashboard/ECS_Observability_Dashboard"'
  );
  process.exit(1);
}

// Use configuration.json as defaults, allow CLI overrides
const region = arg(
  "region",
  process.env.AWS_REGION || globalConfig.aws?.region || "eu-west-1"
);
const profile = arg(
  "profile",
  process.env.AWS_PROFILE || globalConfig.aws?.profile || null
);
const includeAllTypes = !!arg("all", false);

function slug(s) {
  return String(s || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function extractDashboardName(input) {
  // ARN: arn:aws:cloudwatch::<acct>:dashboard/<name>
  const arnMatch = input.match(
    /arn:aws:cloudwatch:[^:]*:[0-9]{12}:dashboard\/(.+)$/
  );
  if (arnMatch) return arnMatch[1];

  // Console URL patterns
  if (
    /cloudwatch\.amazon\.com\/cloudwatch\/home/.test(input) ||
    /console\.aws\.amazon\.com\/cloudwatch\/home/.test(input)
  ) {
    const parts = input.split("#");
    const hash = parts[1] || "";
    const candidates = [input, hash];

    for (const p of candidates) {
      // Pattern 1: #dashboards/dashboard/DashboardName
      const dashboardMatch = p.match(/dashboards\/dashboard\/([^\/\?&]+)/);
      if (dashboardMatch) return decodeURIComponent(dashboardMatch[1]);

      // Pattern 2: #dashboards:name=DashboardName
      const nameMatch = p.match(/dashboards:name=([^&]+)/);
      if (nameMatch) return decodeURIComponent(nameMatch[1]);

      // Pattern 3: dashboard=DashboardName or name=DashboardName
      const paramMatch = p.match(/(?:[?&#])(dashboard|name)=([^&]+)/i);
      if (paramMatch) return decodeURIComponent(paramMatch[2]);
    }
  }

  // Fallback: treat as plain name
  return input;
}

function createFolderName(dashboardName) {
  // Convert dashboard name to folder name (like ECS_Observability_Dashboard -> ECS)
  const parts = dashboardName.split("_");
  if (parts.length > 1) {
    // Take first meaningful part (skip common words)
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

function convertWidgetToConfig(widget) {
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

  function toSeries(widget) {
    const metrics = widget.metrics || [];
    if (!metrics.length) return [];

    let namespace = null,
      metricName = null,
      dimNames = [],
      lastDimVals = [];
    const stat = (widget.stat || "").trim() || "Average";
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
      if (core.length >= 2 && core[0] === "." && typeof core[1] === "string" && core[1] !== "...") {
        // Same namespace, new metric name
        metricName = core[1];
        const pairs = core.slice(2);
        
        if (pairs.length === 0 || (pairs.length === 2 && pairs[0] === "." && pairs[1] === ".")) {
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
      if (core.length >= 2 && typeof core[0] === "string" && typeof core[1] === "string" && core[0] !== "." && core[0] !== "...") {
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

  const series = toSeries(widget);
  const region = widget.region || globalConfig.aws?.region || "eu-west-1";

  return {
    title: widget.title || "Untitled Widget",
    region,
    periodSeconds: 900,
    windowMinutes: 300,
    baselineDays: widget.baselineDays || 7,
    minSamples: widget.minSamples || 10,
    zThreshold: widget.zThreshold || 3.0,
    pctThreshold: widget.pctThreshold || 40,
    timezone: widget.timezone || "Asia/Kolkata",
    skipWeekends: globalConfig.report.skipWeekends || true,
    series,
  };
}

async function main() {
  try {
    const dashboardName = extractDashboardName(dashboardInput);
    const folderName = createFolderName(dashboardName);

    console.log(`📊 Dashboard: ${dashboardName}`);
    console.log(`📁 Folder: ${folderName}`);
    console.log(`🌍 Region: ${region}`);
    if (profile) {
      console.log(`🔐 Profile: ${profile}`);
    }

    // Create configs folder
    const configsDir = path.join(__dirname, "configs");
    const targetDir = path.join(configsDir, folderName);

    if (!fs.existsSync(configsDir))
      fs.mkdirSync(configsDir, { recursive: true });
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    console.log(`📁 Created folder: ${targetDir}`);

    // Configure CloudWatch client with optional profile support
    console.log("🔐 Configuring AWS client...");
    const clientConfig = { region };
    if (profile) {
      clientConfig.credentials = fromIni({ profile });
      console.log(`🔐 Using AWS profile: ${profile}`);
    }

    // Check AWS credentials first
    console.log("🔐 Checking AWS credentials...");
    try {
      const cw = new CloudWatchClient(clientConfig);
      // Test credentials with a simple call
      await cw.send(new GetDashboardCommand({ DashboardName: dashboardName }));
    } catch (error) {
      if (
        error.name === "InvalidSignatureException" ||
        error.message.includes("Authorization header")
      ) {
        console.error("❌ AWS credentials not configured!");
        console.error(
          "Please configure AWS credentials using one of these methods:"
        );
        console.error("  1. AWS CLI: aws configure");
        console.error(
          "  2. Environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY"
        );
        console.error("  3. IAM roles (if running on EC2)");
        console.error("  4. AWS profiles: export AWS_PROFILE=your-profile");
        console.error(
          `  5. Use --profile parameter: --profile=${profile || "your-profile"}`
        );
        process.exit(1);
      }
      throw error;
    }

    // Download dashboard widgets
    console.log("⬇️  Downloading dashboard widgets...");
    const cw = new CloudWatchClient(clientConfig);
    const res = await cw.send(
      new GetDashboardCommand({ DashboardName: dashboardName })
    );

    if (!res || !res.DashboardBody) {
      throw new Error(
        "No dashboard body returned. Check name/region/permissions."
      );
    }

    const body = JSON.parse(res.DashboardBody);
    const widgets = Array.isArray(body.widgets) ? body.widgets : [];

    if (!widgets.length) {
      console.log("No widgets found on the dashboard.");
      return;
    }

    console.log(`✅ Found ${widgets.length} widgets`);

    // Convert widgets to configs
    console.log("🔄 Converting widgets to configuration files...");
    const configs = [];
    let count = 0;

    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i];
      const type = w.type || "unknown";
      const props = w.properties || {};
      const title = props.title || `${type}-widget-${i + 1}`;

      // By default, only export metric widgets
      if (!includeAllTypes && type !== "metric") continue;

      try {
        const config = convertWidgetToConfig(props);
        if (!config.series || config.series.length === 0) {
          console.log(`⚠️  Skipping widget ${i + 1}: No metric series found`);
          continue;
        }

        const fileBase = `${String(count + 1).padStart(2, "0")}-${slug(title)}`;
        const configPath = path.join(targetDir, `${fileBase}.json`);

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        configs.push({
          index: count + 1,
          title: config.title,
          seriesCount: config.series.length,
          file: `${fileBase}.json`,
          path: path.relative(process.cwd(), configPath),
        });

        console.log(`→ ${configPath} (${config.series.length} series)`);
        count++;
      } catch (error) {
        console.error(
          `❌ Error converting widget ${i + 1} (${title}):`,
          error.message
        );
        continue;
      }
    }

    // Generate manifest
    const manifestPath = path.join(
      targetDir,
      `manifest.${slug(dashboardName)}.json`
    );
    const manifest = {
      dashboardName: res.DashboardName,
      dashboardArn: res.DashboardArn,
      region,
      profile: profile || null,
      folderName,
      totalWidgets: widgets.length,
      exportedConfigs: count,
      includeAllTypes,
      configs,
      generatedAt: new Date().toISOString(),
      sourceUrl: dashboardInput,
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Summary
    console.log("\n✅ Dashboard configuration download completed!");
    console.log(`📊 Dashboard: ${res.DashboardName}`);
    console.log(`🔗 ARN: ${res.DashboardArn}`);
    console.log(`🌍 Region: ${region}`);
    console.log(`📁 Folder: ${folderName}`);
    console.log(
      `📈 Widgets: ${widgets.length} total, ${count} exported${
        includeAllTypes ? " (all types)" : " (metric only)"
      }`
    );
    console.log(`📄 Manifest: ${manifestPath}`);
    console.log(`📁 Configs: ${path.resolve(targetDir)}`);

    // Show next steps
    console.log("\n🚀 Next steps:");
    console.log(
      `   # Generate anomaly report: npm run ${folderName.toLowerCase()}-anomalies`
    );
    console.log(
      `   # Generate charts report: npm run ${folderName.toLowerCase()}-charts`
    );
    console.log(
      `   # Or run manually: node run-all.mjs configs/${folderName} ${folderName}-anomalies-report.html`
    );
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

main();
