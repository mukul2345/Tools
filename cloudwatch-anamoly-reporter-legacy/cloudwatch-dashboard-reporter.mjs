#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CloudWatchClient,
  GetDashboardCommand,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { fromIni } from "@aws-sdk/credential-providers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load configuration.json as the single source of truth
const globalConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "configuration.json"), "utf-8"));

/**
 * Generalized CloudWatch Dashboard Report Downloader
 * 
 * Downloads CloudWatch dashboard widgets and generates comprehensive anomaly reports
 * using configuration.json as the source of truth for all settings and detection rules.
 * 
 * Usage:
 *   node cloudwatch-dashboard-reporter.mjs "<dashboard-url|name>" [options]
 * 
 * Examples:
 *   node cloudwatch-dashboard-reporter.mjs "https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#dashboards/dashboard/ECS_Observability_Dashboard"
 *   node cloudwatch-dashboard-reporter.mjs "ECS_Observability_Dashboard" --profile=prod --region=eu-west-1
 *   node cloudwatch-dashboard-reporter.mjs "ECS_Observability_Dashboard" --end=2024-01-15T10:00:00Z
 * 
 * This creates:
 *   - configs/DashboardName/ (widget configs)
 *   - DashboardName-report.html (anomaly report with visual highlighting)
 */

// Command line argument parsing
const arg = (k, def = null) => {
  const hit = process.argv.find((p) => p.startsWith(`--${k}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  return process.argv.includes(`--${k}`) ? true : def;
};

const dashboardInput = process.argv[2];
if (!dashboardInput || dashboardInput === '--help' || dashboardInput === '-h') {
  console.log("CloudWatch Dashboard Report Downloader");
  console.log("");
  console.log("Usage: node cloudwatch-dashboard-reporter.mjs <dashboard-url|name> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --region=REGION        AWS region (default: from configuration.json)");
  console.log("  --profile=PROFILE      AWS profile (default: from configuration.json)");
  console.log("  --end=ISO_DATE        End time for analysis (default: now)");
  console.log("  --baseline-days=DAYS  Baseline period in days (default: from configuration.json)");
  console.log("  --window-minutes=MINS  Analysis window in minutes (default: from configuration.json)");
  console.log("");
  console.log("Examples:");
  console.log('  node cloudwatch-dashboard-reporter.mjs "ECS_Observability_Dashboard"');
  console.log('  node cloudwatch-dashboard-reporter.mjs "https://eu-west-1.console.aws.amazon.com/cloudwatch/home?region=eu-west-1#dashboards/dashboard/ECS_Observability_Dashboard"');
  console.log('  node cloudwatch-dashboard-reporter.mjs "ECS_Observability_Dashboard" --profile=prod --region=eu-west-1');
  console.log("");
  console.log("This script will:");
  console.log("  1. Extract dashboard name from URL or use provided name");
  console.log("  2. Download all widget configurations via AWS CloudWatch API");
  console.log("  3. Analyze metrics for anomalies using configuration.json rules");
  console.log("  4. Generate HTML report with visual highlighting");
  console.log("  5. Save widget configs and manifest for further analysis");
  process.exit(0);
}

// Use configuration.json as defaults, allow CLI overrides
const region = arg("region", process.env.AWS_REGION || globalConfig.aws?.region || "eu-west-1");
const profile = arg("profile", process.env.AWS_PROFILE || globalConfig.aws?.profile || "prod");
const endISO = arg("end", null);
const baselineDays = parseInt(arg("baseline-days", globalConfig.report?.baselineDays || "3"));
const windowMinutes = parseInt(arg("window-minutes", globalConfig.report?.windowMinutes || "360"));

// Utility functions
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

// Anomaly detection rules from configuration.json
// Parse threshold from config.metrics rules (e.g., "pct>30" -> 30)
const parseThreshold = (rule) => {
  if (!rule || !rule.badIf) return 30;
  const match = rule.badIf.match(/[-]?\d+/);
  return match ? Math.abs(parseInt(match[0])) : 30;
};

const parseDirection = (rule) => {
  if (!rule || !rule.badIf) return 'increase';
  // For count metrics, decreases are bad (pct<-40 means pct<0 is bad)
  // For latency/error/cpu/memory, increases are bad (pct>30 means pct>0 is bad)
  return rule.badIf.includes('<') ? 'decrease' : 'increase';
};

// Build ANOMALY_RULES from configuration.json metrics
const ANOMALY_RULES = {
  // API metrics
  'API_COUNT': {
    type: 'count',
    threshold: parseThreshold(globalConfig.metrics?.count),
    direction: parseDirection(globalConfig.metrics?.count),
    description: 'API Count Drop'
  },
  'API_LATENCY': {
    type: 'latency',
    threshold: parseThreshold(globalConfig.metrics?.latency),
    direction: parseDirection(globalConfig.metrics?.latency),
    description: 'API Latency Increase'
  },
  'LATENCY': {
    type: 'latency',
    threshold: parseThreshold(globalConfig.metrics?.latency),
    direction: parseDirection(globalConfig.metrics?.latency),
    description: 'Latency Increase'
  },
  'ERROR_COUNT': {
    type: 'error',
    threshold: parseThreshold(globalConfig.metrics?.error),
    direction: parseDirection(globalConfig.metrics?.error),
    description: 'Error Count Increase'
  },
  'ERRORS': {
    type: 'error',
    threshold: parseThreshold(globalConfig.metrics?.error),
    direction: parseDirection(globalConfig.metrics?.error),
    description: 'Error Increase'
  },
  // System metrics
  'CPU_UTILIZATION': {
    type: 'cpu',
    threshold: parseThreshold(globalConfig.metrics?.cpu),
    direction: parseDirection(globalConfig.metrics?.cpu),
    description: 'High CPU Usage'
  },
  'MEMORY_UTILIZATION': {
    type: 'memory',
    threshold: parseThreshold(globalConfig.metrics?.memory),
    direction: parseDirection(globalConfig.metrics?.memory),
    description: 'High Memory Usage'
  },
  // Lambda metrics (use latency rules as default)
  'DURATION': {
    type: 'lambda',
    threshold: parseThreshold(globalConfig.metrics?.latency),
    direction: 'increase',
    description: 'Lambda Duration Anomaly'
  },
  'INVOCATIONS': {
    type: 'lambda',
    threshold: parseThreshold(globalConfig.metrics?.count),
    direction: 'decrease',
    description: 'Lambda Invocation Drop'
  },
  // DynamoDB metrics
  'SCAN_COUNT': {
    type: 'dynamodb',
    threshold: parseThreshold(globalConfig.metrics?.count),
    direction: 'increase',
    description: 'DynamoDB Scan Anomaly'
  },
  'READ_CAPACITY_UNITS': {
    type: 'dynamodb',
    threshold: parseThreshold(globalConfig.metrics?.count),
    direction: 'increase',
    description: 'DynamoDB Read Capacity Anomaly'
  },
  // Workflow metrics
  'AGE_OF_OLDEST_MESSAGE': {
    type: 'workflow',
    threshold: parseThreshold(globalConfig.metrics?.age),
    direction: parseDirection(globalConfig.metrics?.age),
    description: 'Message Age Anomaly'
  },
  'STEP_FUNCTION_EXECUTIONS': {
    type: 'workflow',
    threshold: parseThreshold(globalConfig.metrics?.count),
    direction: 'decrease',
    description: 'Step Function Execution Drop'
  }
};

function detectMetricType(metricName, namespace, stat) {
  const metric = metricName.toUpperCase();
  const ns = namespace.toUpperCase();
  const statType = stat ? stat.toUpperCase() : '';
  
  // Direct metric name match
  if (ANOMALY_RULES[metric]) {
    return ANOMALY_RULES[metric];
  }
  
  // Pattern-based detection
  if (metric.includes('COUNT') && (metric.includes('API') || ns.includes('API'))) {
    return ANOMALY_RULES['API_COUNT'];
  }
  
  if (metric.includes('LATENCY') || statType.includes('P90') || statType.includes('P95') || statType.includes('P99')) {
    return ANOMALY_RULES['API_LATENCY'];
  }
  
  if (metric.includes('ERROR') || ns.includes('ERROR')) {
    return ANOMALY_RULES['ERROR_COUNT'];
  }
  
  if (metric.includes('CPU') || ns.includes('CPU')) {
    return ANOMALY_RULES['CPU_UTILIZATION'];
  }
  
  if (metric.includes('MEMORY') || metric.includes('MEM')) {
    return ANOMALY_RULES['MEMORY_UTILIZATION'];
  }
  
  if (ns.includes('LAMBDA') || metric.includes('LAMBDA')) {
    if (metric.includes('DURATION')) return ANOMALY_RULES['DURATION'];
    if (metric.includes('INVOCATION')) return ANOMALY_RULES['INVOCATIONS'];
    if (metric.includes('ERROR')) return ANOMALY_RULES['ERRORS'];
  }
  
  if (ns.includes('DYNAMODB') || metric.includes('DYNAMO')) {
    if (metric.includes('SCAN')) return ANOMALY_RULES['SCAN_COUNT'];
    if (metric.includes('READ_CAPACITY')) return ANOMALY_RULES['READ_CAPACITY_UNITS'];
    if (metric.includes('LATENCY')) return ANOMALY_RULES['LATENCY'];
  }
  
  if (ns.includes('WORKFLOW') || metric.includes('WORKFLOW') || metric.includes('STEP_FUNCTION')) {
    if (metric.includes('AGE')) return ANOMALY_RULES['AGE_OF_OLDEST_MESSAGE'];
    if (metric.includes('EXECUTION')) return ANOMALY_RULES['STEP_FUNCTION_EXECUTIONS'];
  }
  
  // Default fallback
  return {
    type: 'unknown',
    threshold: 40,
    direction: 'increase',
    description: 'Unknown Metric Anomaly'
  };
}

// Convert widget format to series format
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

      // Handle complete metric rows (not using "..." format)
      if (core.length >= 2 && core[0] === namespace && core[1] === metricName) {
        const pairs = core.slice(2);
        if (pairs.length % 2 !== 0) {
          console.warn(`Odd number of dimension tokens in metric row ${idx}, skipping`);
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

      throw new Error(
        `Unsupported metric row at index ${idx}: ${JSON.stringify(row)}`
      );
    }

    return series;
  }

  const series = toSeries(widget);
  const region = widget.region || "eu-west-1";
  
  return {
    title: widget.title || "Untitled Widget",
    region,
    periodSeconds: 900,
    windowMinutes: 360,
    baselineDays: widget.baselineDays || baselineDays,
    minSamples: widget.minSamples || 10,
    zThreshold: widget.zThreshold || 3.0,
    pctThreshold: widget.pctThreshold || 40,
    timezone: widget.timezone || "Asia/Kolkata",
    skipWeekends: globalConfig.report.skipWeekends || true,
    series,
  };
}

// Statistical functions
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (arr) => {
  if (!arr.length) return 0;
  const validValues = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (!validValues.length) return 0;
  
  const a = [...validValues].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mad = (arr) => {
  if (!arr.length) return 0;
  const med = median(arr);
  const dev = arr.map((v) => Math.abs(v - med));
  return median(dev);
};
const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);

// Analyze configuration for anomalies
async function analyzeConfig(cfg, { endISO, cw }) {
  if (!cfg.series || cfg.series.length === 0) {
    return { rows: [], title: cfg.title || 'Unknown' };
  }

  const PERIOD = cfg.periodSeconds || 300;
  const WINDOW_MIN = cfg.windowMinutes || windowMinutes;
  const BASELINE_DAYS = cfg.baselineDays || baselineDays;
  const MIN_SAMPLES = cfg.minSamples ?? 10;
  const Z_THRESH = cfg.zThreshold ?? 3.0;
  const PCT_THRESH = cfg.pctThreshold ?? 40;

  const END = endISO ? new Date(endISO) : new Date();
  
  if (isNaN(END.getTime())) {
    console.error(`Invalid endISO date: ${endISO}`);
    return { rows: [], title: cfg.title || 'Unknown' };
  }
  
  const START = new Date(
    END.getTime() - (BASELINE_DAYS * 24 * 60 + WINDOW_MIN) * 60 * 1000
  );

  // Build queries for all series
  let queries = [];
  cfg.series.forEach((s, i) => {
    queries.push({
      Id: `m${i}`,
      MetricStat: {
        Metric: {
          Namespace: s.namespace,
          MetricName: s.metricName,
          Dimensions: Object.entries(s.dimensions || {}).map(([Name, Value]) => ({
            Name,
            Value,
          })),
        },
        Period: PERIOD,
        Stat: s.stat,
      },
      ReturnData: true,
    });
  });

  // Fetch data
  const chunk = (arr, size) =>
    arr.reduce(
      (acc, _, i) => (i % size ? acc : acc.concat([arr.slice(i, i + size)])),
      []
    );
  const queryChunks = chunk(queries, 500);

  async function getAllData(qs) {
    let results = {};
    for (const q of qs) {
      let NextToken;
      do {
        const res = await cw.send(
          new GetMetricDataCommand({
            StartTime: START,
            EndTime: END,
            ScanBy: "TimestampAscending",
            MetricDataQueries: q,
            NextToken,
          })
        );
        (res.MetricDataResults || []).forEach((r) => {
          if (!results[r.Id]) results[r.Id] = { Timestamps: [], Values: [] };
          r.Timestamps.forEach((t, idx) => {
            const v = r.Values[idx];
            if (v != null) {
              results[r.Id].Timestamps.push(new Date(t));
              results[r.Id].Values.push(v);
            }
          });
        });
        NextToken = res.NextToken;
        if (NextToken) await sleep(100);
      } while (NextToken);
    }
    return results;
  }

  const data = await getAllData(queryChunks);
  
  // Log data fetching results for debugging
  console.log(`📊 Fetched data for ${Object.keys(data).length} metrics`);
  Object.entries(data).forEach(([id, metricData]) => {
    console.log(`   ${id}: ${metricData.Timestamps.length} data points`);
  });

  // Define windows
  const CURR_END = END;
  const CURR_START = new Date(END.getTime() - WINDOW_MIN * 60 * 1000);
  const BASE_WINDOWS = [];
  for (let d = 1; d <= BASELINE_DAYS; d++) {
    const e = new Date(CURR_END.getTime() - d * 24 * 60 * 60 * 1000);
    const s = new Date(e.getTime() - WINDOW_MIN * 60 * 1000);
    BASE_WINDOWS.push([s, e]);
  }

  function inRange(ts, start, end) {
    const t = ts.getTime();
    return t >= start.getTime() && t <= end.getTime();
  }

  function pickAggregator(stat, metricName) {
    const st = (stat || "").toLowerCase();
    if (st.startsWith("p") || metricName.toLowerCase().includes("latency"))
      return "median";
    if (st === "sum" || metricName.toLowerCase().includes("count")) return "sum";
    return "average";
  }

  function aggregate(arr, how) {
    if (!arr.length) return 0;
    const validValues = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
    if (!validValues.length) return 0;
    
    if (how === "sum") return validValues.reduce((a, b) => a + b, 0);
    if (how === "median") return median(validValues);
    return validValues.reduce((a, b) => a + b, 0) / validValues.length;
  }

  const rows = [];

  cfg.series.forEach((s, i) => {
    const id = `m${i}`;
    const ts = data[id]?.Timestamps || [];
    const vals = data[id]?.Values || [];

    if (ts.length === 0) {
      const rule = detectMetricType(s.metricName, s.namespace, s.stat);
      rows.push({
        name: s.name,
        stat: s.stat || 'Average',
        agg: 'avg',
        curr: 0,
        baseMed: 0,
        pctChange: 0,
        z: 0,
        pts: 0,
        base: 0,
        anomaly: false,
        metricType: rule.type,
        rule: rule,
        namespace: s.namespace,
        metricName: s.metricName
      });
      return;
    }

    const agg = pickAggregator(s.stat, s.metricName);
    
    // Current window data
    const currData = vals.filter((_, idx) => 
      inRange(ts[idx], CURR_START, CURR_END)
    );
    const curr = aggregate(currData, agg);
    
    // Baseline data from previous days
    const baseData = [];
    BASE_WINDOWS.forEach(([baseStart, baseEnd]) => {
      const windowData = vals.filter((_, idx) => 
        inRange(ts[idx], baseStart, baseEnd)
      );
      if (windowData.length > 0) {
        baseData.push(aggregate(windowData, agg));
      }
    });

    const baseMed = median(baseData);
    const pctChange = baseMed !== 0 ? ((curr - baseMed) / Math.abs(baseMed)) * 100 : 0;
    
    // Calculate Z-score using MAD
    const baseMAD = mad(baseData);
    const z = baseMAD !== 0 ? (curr - baseMed) / (1.4826 * baseMAD) : 0;
    
    const pts = currData.length;
    const base = baseData.length;
    
    // Data-driven anomaly detection
    const rule = detectMetricType(s.metricName, s.namespace, s.stat);
    let isAnomaly = false;
    
    // Only consider it an anomaly if we have enough data points
    if (pts >= MIN_SAMPLES && base >= 1) {
      const absPctChange = Math.abs(pctChange);
      
      if (absPctChange >= rule.threshold) {
        if (rule.direction === 'increase' && pctChange > 0) {
          isAnomaly = true;
        } else if (rule.direction === 'decrease' && pctChange < 0) {
          isAnomaly = true;
        }
      }
    }
    
    // Debug logging for anomaly detection
    if (isAnomaly) {
      console.log(`🚨 Anomaly detected: ${s.name}`);
      console.log(`   Metric: ${s.namespace}/${s.metricName}`);
      console.log(`   Rule: ${rule.description} (${rule.type})`);
      console.log(`   Current: ${curr}, Baseline: ${baseMed}, Change: ${pctChange}%`);
      console.log(`   Threshold: ${rule.threshold}%, Direction: ${rule.direction}`);
    }

    rows.push({
      name: s.name,
      stat: s.stat || 'Average',
      agg: agg,
      curr: round(curr),
      baseMed: round(baseMed),
      pctChange: round(pctChange),
      z: round(z),
      pts: pts,
      base: base,
      anomaly: isAnomaly,
      metricType: rule.type,
      rule: rule,
      namespace: s.namespace,
      metricName: s.metricName
    });
  });

  return {
    rows,
    title: cfg.title || 'Unknown',
    now: END.toISOString(),
    timezone: 'Asia/Kolkata',
    windowMinutes: WINDOW_MIN,
    baselineDays: BASELINE_DAYS,
    rules: {
      minSamples: MIN_SAMPLES,
      zThreshold: Z_THRESH,
      pctThreshold: PCT_THRESH
    }
  };
}

// Generate HTML report
function generateHTMLReport(results, dashboardName, configs) {
  const totalAnomalies = results.reduce((sum, r) => sum + r.rows.filter(row => row.anomaly).length, 0);
  const totalMetrics = results.reduce((sum, r) => sum + r.rows.length, 0);
  
  // Group anomalies by type
  const anomaliesByType = {};
  results.forEach(result => {
    result.rows.forEach(row => {
      if (row.anomaly) {
        if (!anomaliesByType[row.metricType]) {
          anomaliesByType[row.metricType] = [];
        }
        anomaliesByType[row.metricType].push(row);
      }
    });
  });

  const STYLE = `
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif;margin:24px;max-width:1400px;background:#f8fafc}
    h1{margin:0 0 6px 0;color:#1f2937} 
    h2{margin:32px 0 16px;color:#374151;border-bottom:2px solid #e5e7eb;padding-bottom:8px}
    h3{margin:24px 0 12px;color:#4b5563;font-size:18px}
    .muted{color:#6b7280;font-size:14px}
    .panel{border:1px solid #e5e7eb;border-radius:12px;padding:20px;background:#ffffff;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
    .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin:20px 0}
    .summary-card{background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
    .summary-title{font-weight:600;color:#374151;margin-bottom:8px}
    .summary-value{font-size:24px;font-weight:700;margin-bottom:4px}
    .summary-label{font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px}
    .anomaly-positive{color:#dc2626;background:#fef2f2;border-color:#fecaca}
    .anomaly-negative{color:#059669;background:#f0fdf4;border-color:#bbf7d0}
    .anomaly-none{color:#374151;background:#f9fafb;border-color:#e5e7eb}
    .metric-table{width:100%;border-collapse:collapse;margin:16px 0}
    .metric-table th{background:#f3f4f6;padding:12px;text-align:left;font-weight:600;color:#374151;border-bottom:2px solid #e5e7eb}
    .metric-table td{padding:12px;border-bottom:1px solid #e5e7eb}
    .metric-table tr.anomaly-positive{background:#fef2f2}
    .metric-table tr.anomaly-negative{background:#f0fdf4}
    .metric-table tr.anomaly-none{background:#ffffff}
    .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:500}
    .badge-red{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
    .badge-green{background:#f0fdf4;color:#059669;border:1px solid #bbf7d0}
    .badge-gray{background:#f9fafb;color:#374151;border:1px solid #e5e7eb}
    .status-normal{color:#059669;font-weight:600}
    .status-anomaly{color:#dc2626;font-weight:600}
  `;

  let HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>CloudWatch Dashboard Report - ${dashboardName}</title>
<style>${STYLE}</style></head><body>
<h1>🔍 CloudWatch Dashboard Report</h1>
<div class="muted">Dashboard: ${dashboardName} • Generated: ${new Date().toISOString()}</div>
`;

  // Summary section
  HTML += `
<div class="panel">
  <h2>📊 Summary</h2>
  <div class="summary-grid">
    <div class="summary-card">
      <div class="summary-title">Total Metrics</div>
      <div class="summary-value">${totalMetrics}</div>
      <div class="summary-label">Monitored</div>
    </div>
    <div class="summary-card">
      <div class="summary-title">Anomalies Detected</div>
      <div class="summary-value" style="color:${totalAnomalies > 0 ? '#dc2626' : '#059669'}">${totalAnomalies}</div>
      <div class="summary-label">${totalAnomalies > 0 ? 'Requires Attention' : 'All Normal'}</div>
    </div>
    <div class="summary-card">
      <div class="summary-title">Dashboard Widgets</div>
      <div class="summary-value">${configs.length}</div>
      <div class="summary-label">Processed</div>
    </div>
  </div>
</div>
`;

  // Anomaly breakdown by type
  if (totalAnomalies > 0) {
    HTML += `
<div class="panel">
  <h2>🚨 Anomaly Breakdown by Type</h2>
  <table class="metric-table">
    <thead>
      <tr>
        <th>Metric Type</th>
        <th>Anomalies</th>
        <th>Description</th>
      </tr>
    </thead>
    <tbody>
`;
    
    Object.entries(anomaliesByType).forEach(([type, anomalies]) => {
      HTML += `
      <tr>
        <td><strong>${type.charAt(0).toUpperCase() + type.slice(1)}</strong></td>
        <td><span class="badge badge-red">${anomalies.length}</span></td>
        <td>${anomalies[0]?.rule?.description || 'Unknown anomaly type'}</td>
      </tr>
`;
    });
    
    HTML += `
    </tbody>
  </table>
</div>
`;
  }

  // Detailed results by widget
  results.forEach(result => {
    const widgetAnomalies = result.rows.filter(row => row.anomaly);
    const hasAnomalies = widgetAnomalies.length > 0;
    
    HTML += `
<div class="panel">
  <h3>${result.title} ${hasAnomalies ? `<span class="badge badge-red">${widgetAnomalies.length} anomalies</span>` : '<span class="badge badge-gray">No anomalies</span>'}</h3>
  <table class="metric-table">
    <thead>
      <tr>
        <th>Metric Name</th>
        <th>Current Value</th>
        <th>Baseline Value</th>
        <th>Change %</th>
        <th>Status</th>
        <th>Type</th>
      </tr>
    </thead>
    <tbody>
`;
    
    result.rows.forEach(row => {
      const statusClass = row.anomaly ? 'anomaly-positive' : 'anomaly-none';
      const statusText = row.anomaly ? '🔴 Anomaly' : '✅ Normal';
      const statusStyle = row.anomaly ? 'status-anomaly' : 'status-normal';
      
      // Handle undefined/null values
      const currValue = row.curr !== undefined && row.curr !== null ? row.curr : 'N/A';
      const baseValue = row.baseMed !== undefined && row.baseMed !== null ? row.baseMed : 'N/A';
      const pctChange = row.pctChange !== undefined && row.pctChange !== null ? 
        (row.pctChange > 0 ? '+' : '') + row.pctChange + '%' : 'N/A';
      const metricType = row.metricType || 'unknown';
      
      HTML += `
      <tr class="${statusClass}">
        <td><strong>${row.name || 'Unknown Metric'}</strong></td>
        <td>${currValue}</td>
        <td>${baseValue}</td>
        <td>${pctChange}</td>
        <td class="${statusStyle}">${statusText}</td>
        <td>${metricType}</td>
      </tr>
`;
    });
    
    HTML += `
    </tbody>
  </table>
</div>
`;
  });

  HTML += `
</body></html>`;

  return HTML;
}

// Main function
async function main() {
  try {
    const dashboardName = extractDashboardName(dashboardInput);
    
    console.log(`📊 Dashboard: ${dashboardName}`);
    console.log(`🌍 Region: ${region}`);
    console.log(`🔐 Profile: ${profile}`);
    console.log(`📅 End Time: ${endISO || 'Now'}`);
    console.log(`📈 Baseline Days: ${baselineDays}`);
    console.log(`⏱️  Window Minutes: ${windowMinutes}`);
    
    // Create output directory
    const outputDir = path.join(__dirname, dashboardName);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    
    console.log(`📁 Created directory: ${outputDir}`);
    
    // Configure CloudWatch client
    console.log("🔐 Configuring AWS client...");
    const clientConfig = { region };
    if (profile) {
      clientConfig.credentials = fromIni({ profile });
    }

    const cw = new CloudWatchClient(clientConfig);
    
    // Test credentials
    try {
      await cw.send(new GetDashboardCommand({ DashboardName: dashboardName }));
    } catch (error) {
      if (error.name === 'InvalidSignatureException' || error.message.includes('Authorization header')) {
        console.error("❌ AWS credentials not configured!");
        console.error("Please configure AWS credentials using one of these methods:");
        console.error("  1. AWS CLI: aws configure");
        console.error("  2. Environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY");
        console.error("  3. IAM roles (if running on EC2)");
        console.error("  4. AWS profiles: export AWS_PROFILE=your-profile");
        console.error(`  5. Use --profile parameter: --profile=${profile}`);
        process.exit(1);
      }
      throw error;
    }

    // Download dashboard widgets
    console.log("⬇️  Downloading dashboard widgets...");
    const res = await cw.send(new GetDashboardCommand({ DashboardName: dashboardName }));

    if (!res || !res.DashboardBody) {
      throw new Error("No dashboard body returned. Check name/region/permissions.");
    }

    const body = JSON.parse(res.DashboardBody);
    const widgets = Array.isArray(body.widgets) ? body.widgets : [];

    if (!widgets.length) {
      console.log("No widgets found on the dashboard.");
      return;
    }

    console.log(`✅ Found ${widgets.length} widgets`);
    
    // Convert widgets to configs and save
    console.log("🔄 Converting widgets to configuration files...");
    const configs = [];
    let count = 0;

    for (let i = 0; i < widgets.length; i++) {
      const w = widgets[i];
      const type = w.type || "unknown";
      const props = w.properties || {};
      const title = props.title || `${type}-widget-${i + 1}`;

      // Only export metric widgets
      if (type !== "metric") continue;

      try {
        const config = convertWidgetToConfig(props);
        if (!config.series || config.series.length === 0) {
          console.log(`⚠️  Skipping widget ${i + 1}: No metric series found`);
          continue;
        }

        const fileBase = `${String(count + 1).padStart(2, "0")}-${slug(title)}`;
        const configPath = path.join(outputDir, `${fileBase}.json`);
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        
        configs.push({
          index: count + 1,
          title: config.title,
          seriesCount: config.series.length,
          file: `${fileBase}.json`,
          path: path.relative(process.cwd(), configPath)
        });
        
        console.log(`→ ${configPath} (${config.series.length} series)`);
        count++;
        
      } catch (error) {
        console.error(`❌ Error converting widget ${i + 1} (${title}):`, error.message);
        continue;
      }
    }

    // Generate manifest
    const manifestPath = path.join(outputDir, `manifest.${slug(dashboardName)}.json`);
    const manifest = {
      dashboardName: res.DashboardName,
      dashboardArn: res.DashboardArn,
      region,
      profile: profile || null,
      totalWidgets: widgets.length,
      exportedConfigs: count,
      configs,
      generatedAt: new Date().toISOString(),
      sourceUrl: dashboardInput,
      analysisParams: {
        endISO,
        baselineDays,
        windowMinutes
      }
    };
    
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    
    // Analyze all configs for anomalies
    console.log("🔍 Analyzing metrics for anomalies...");
    const results = [];
    
    for (const config of configs) {
      try {
        const configPath = path.join(outputDir, config.file);
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const result = await analyzeConfig(configData, { endISO, cw });
        results.push(result);
        console.log(`✓ Analyzed ${config.title}: ${result.rows.filter(r => r.anomaly).length} anomalies`);
      } catch (error) {
        console.error(`❌ Error analyzing ${config.title}:`, error.message);
        continue;
      }
    }
    
    // Generate HTML report
    console.log("📄 Generating HTML report...");
    const htmlReport = generateHTMLReport(results, dashboardName, configs);
    const reportPath = path.join(outputDir, `${dashboardName}-report.html`);
    fs.writeFileSync(reportPath, htmlReport);
    
    // Summary
    const totalAnomalies = results.reduce((sum, r) => sum + r.rows.filter(row => row.anomaly).length, 0);
    
    console.log("\n✅ CloudWatch Dashboard Report Generation Completed!");
    console.log(`📊 Dashboard: ${res.DashboardName}`);
    console.log(`🔗 ARN: ${res.DashboardArn}`);
    console.log(`🌍 Region: ${region}`);
    console.log(`📁 Output Directory: ${path.resolve(outputDir)}`);
    console.log(`📈 Widgets: ${widgets.length} total, ${count} exported`);
    console.log(`🚨 Anomalies: ${totalAnomalies} detected`);
    console.log(`📄 Report: ${path.resolve(reportPath)}`);
    console.log(`📄 Manifest: ${path.resolve(manifestPath)}`);
    
    if (totalAnomalies > 0) {
      console.log(`\n🚨 ${totalAnomalies} anomalies require attention! Check the HTML report for details.`);
    } else {
      console.log(`\n✅ All metrics are within normal ranges.`);
    }
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

main();
