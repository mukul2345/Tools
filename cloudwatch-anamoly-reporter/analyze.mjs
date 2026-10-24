#!/usr/bin/env node
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { fromIni } from "@aws-sdk/credential-providers";
import fs from "fs";
const globalConfig = JSON.parse(fs.readFileSync("configuration.json", "utf-8"));

const REGION = process.env.AWS_REGION || globalConfig.aws.region;
const PROFILE = process.env.AWS_PROFILE || globalConfig.aws.profile;

// ---------- NEW HELPERS FOR CLOUDWATCH URL GENERATION ----------

// CloudWatch's "query=" parameter is basically encodeURIComponent(...)
// but with "%" replaced by "*" and hex digits made lowercase.
// We also need this same encoding for dimension values and title inside the graph blob.
function encodeForCwConsole(str) {
  const encoded = encodeURIComponent(str); // e.g. "%2Fclaim-items%2F"
  // Turn "%2F" into "*2f" (lowercase hex, keep original text case)
  return encoded.replace(
    /%([0-9A-F]{2})/g,
    (_, hex) => `*${hex.toLowerCase()}`
  );
}

// Build the `query=` portion in the URL. This is mostly cosmetic in the console, but nice to have.
// Example shape (before encoding):
//   {DFG-Observability,endpoint,environment,serviceName,statusCode} /claim-items/ MetricName="API_LATENCY" endpoint="/claim-items/" statusCode="200"
function buildCwQuery(namespace, metricName, dims) {
  const dimKeys = Object.keys(dims || {});
  const primaryPath = dims.endpoint || dims.path || dims.Endpoint || ""; // try to show an API-ish identifier

  const queryText =
    `{${namespace},${dimKeys.join(",")}} ` +
    `${primaryPath} ` +
    `MetricName="${metricName}" ` +
    dimKeys.map((k) => `${k}="${dims[k]}"`).join(" ");

  // CloudWatch wraps this in "~'<encoded>"
  return "~'" + encodeForCwConsole(queryText);
}

// Build the `graph=` portion (CloudWatch's rison-ish structure).
// We generate one metric line with all its dimensions.
function buildCwGraph({
  namespace,
  metricName,
  dims,
  region,
  stat,
  title,
  periodSeconds,
}) {
  // Build the metric vector: ['Namespace','MetricName','dimName','dimVal','dimName','dimVal',...]
  // Encoded in CW console style:
  // ~(metrics~(~(~'Namespace~'MetricName~'DimName~'DimVal ...)) ~view~'timeSeries ...)
  // Values like "/claim-items/" must be encodedForCwConsole().
  const metricParts = [
    `~'${namespace}`,
    `~'${metricName}`,
    ...Object.entries(dims || {}).flatMap(([k, v]) => [
      `~'${k}`,
      `~'${encodeForCwConsole(String(v))}`,
    ]),
  ];

  const metricList = "(~(" + metricParts.join("") + "))";

  const encTitle = encodeForCwConsole(title || `${namespace}/${metricName}`);

  // We'll use last 24h (-PT24H → P0D), periodSeconds from config (fallback 3600),
  // and whatever stat p90/p95/etc the series asked for.
  const period = periodSeconds || 3600;
  const graph =
    "~(" +
    [
      `metrics~${metricList}`,
      `view~'timeSeries`,
      `stacked~false`,
      `region~'${region}`,
      `period~${period}`,
      `stat~'${stat || "Average"}`,
      `title~'${encTitle}`,
      `start~'-PT24H`,
      `end~'P0D`,
    ].join("~") +
    ")";

  return graph;
}

// Final full CloudWatch link
// https://<region>.console.aws.amazon.com/cloudwatch/home?region=<region>#metricsV2?graph=<graph>&query=<query>
function buildCloudWatchLink({
  region,
  namespace,
  metricName,
  dims,
  stat,
  title,
  periodSeconds,
}) {
  const graph = buildCwGraph({
    namespace,
    metricName,
    dims,
    region,
    stat,
    title,
    periodSeconds,
  });
  const query = buildCwQuery(namespace, metricName, dims);

  return (
    `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}` +
    `#metricsV2?graph=${graph}&query=${query}`
  );
}

// --------------------------------------------------------------

// Statistical helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (arr) => {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const mad = (arr) => {
  if (!arr.length) return NaN;
  const med = median(arr);
  const dev = arr.map((v) => Math.abs(v - med));
  return median(dev);
};
const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);

// Convert widget format to series format (unchanged)
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

      // Handle direct metric rows (complete metric specifications)
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

  return {
    ...widget,
    series: toSeries(widget),
  };
}

export async function analyzeConfig(cfg, { endISO }) {
  // Convert widget-style config to series-style config if needed
  if (cfg.metrics && !cfg.series) {
    try {
      cfg = convertWidgetToConfig(cfg);
    } catch (error) {
      console.error(`Error converting widget config:`, error.message);
      return { rows: [], title: cfg.title || "Unknown" };
    }
  }

  if (!cfg.series || cfg.series.length === 0) {
    return { rows: [], title: cfg.title || "Unknown" };
  }

  // Filter out invalid series (missing namespace or metricName)
  const validSeries = cfg.series.filter((s, idx) => {
    if (!s.namespace || !s.metricName) {
      console.warn(
        `⚠️  Skipping invalid series at index ${idx} in "${cfg.title || "Unknown"}": missing namespace or metricName`,
        { name: s.name, namespace: s.namespace, metricName: s.metricName }
      );
      return false;
    }
    return true;
  });

  if (validSeries.length === 0) {
    console.error(`❌ No valid series found in config: ${cfg.title || "Unknown"}`);
    return { rows: [], title: cfg.title || "Unknown" };
  }

  // Use only valid series for processing
  cfg.series = validSeries;

  const PERIOD = cfg.periodSeconds ?? globalConfig.report.periodSeconds ?? 60;
  const WINDOW_MIN =
    cfg.windowMinutes ?? globalConfig.report.windowMinutes ?? 60;
  const BASELINE_DAYS =
    cfg.baselineDays ?? globalConfig.report.baselineDays ?? 7;
  const MIN_SAMPLES = cfg.minSamples ?? globalConfig.report.minSamples ?? 10;
  const Z_THRESH = cfg.zThreshold ?? globalConfig.report.zThreshold ?? 3.0;
  const PCT_THRESH = cfg.pctThreshold ?? globalConfig.report.pctThreshold ?? 40;
  const TIMEZONE =
    cfg.timezone ?? globalConfig.report.timezone ?? "Asia/Kolkata";
  const SKIP_WEEKENDS =
    cfg.skipWeekends ?? globalConfig.report.skipWeekends ?? true;

  const END = endISO ? new Date(endISO) : new Date();
  if (isNaN(END.getTime())) {
    console.error(`Invalid endISO date: ${endISO}`);
    return { rows: [], title: cfg.title || "Unknown" };
  }

  // Region for console link
  const CW_REGION = cfg.region || globalConfig.aws.region || REGION;

  // How far back to ask CW for raw data (we may skip weekends later)
  const fetchDays = SKIP_WEEKENDS
    ? Math.ceil(BASELINE_DAYS * 1.5)
    : BASELINE_DAYS;
  const START = new Date(
    END.getTime() - (fetchDays * 24 * 60 + WINDOW_MIN) * 60 * 1000
  );

  // Use IAM role in Lambda, profile locally
  const cwConfig = { region: REGION };
  if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
    // Local mode: use profile
    cwConfig.credentials = fromIni({ profile: PROFILE });
  }
  // Lambda mode: use IAM role (no credentials needed)
  const cw = new CloudWatchClient(cwConfig);

  // Build GetMetricData queries
  const queries = cfg.series.map((s, i) => ({
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
  }));

  // Split into chunks of 500 queries (API limit)
  const chunk = (arr, size) =>
    arr.reduce(
      (acc, _, i) => (i % size ? acc : acc.concat([arr.slice(i, i + size)])),
      []
    );
  const queryChunks = chunk(queries, 500);

  /**
   * Execute CloudWatch command with exponential backoff retry for throttling
   * @param {Function} commandFn - Function that returns a Command object
   * @param {number} maxRetries - Maximum retry attempts
   * @returns {Promise<any>}
   */
  async function executeWithRetry(commandFn, maxRetries = 5) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const command = commandFn();
        return await cw.send(command);
      } catch (error) {
        lastError = error;

        // Check if it's a throttling error
        const isThrottling =
          error.name === "Throttling" ||
          error.name === "ThrottlingException" ||
          error.name === "TooManyRequestsException" ||
          error.$metadata?.httpStatusCode === 429;

        if (isThrottling && attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 30s)
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
          console.warn(
            `⚠️  CloudWatch throttled, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`
          );
          await sleep(backoffMs);
          continue;
        }

        // For other errors or max retries reached, throw
        throw error;
      }
    }

    throw lastError;
  }

  async function getAllData(qs) {
    let results = {};
    
    // Process chunks sequentially to avoid overwhelming CloudWatch API
    // This prevents throttling errors when processing large dashboards
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const chunkResults = {};
      let NextToken;
      
      do {
        // Use retry logic with exponential backoff for throttling
        const res = await executeWithRetry(() =>
          new GetMetricDataCommand({
            StartTime: START,
            EndTime: END,
            ScanBy: "TimestampAscending",
            MetricDataQueries: q,
            NextToken,
          })
        );
        
        (res.MetricDataResults || []).forEach((r) => {
          if (!chunkResults[r.Id]) chunkResults[r.Id] = { Timestamps: [], Values: [] };
          r.Timestamps.forEach((t, idx) => {
            const v = r.Values[idx];
            if (v != null) {
              chunkResults[r.Id].Timestamps.push(new Date(t));
              chunkResults[r.Id].Values.push(v);
            }
          });
        });
        NextToken = res.NextToken;
        
        // Add delay between pagination requests to avoid throttling
        if (NextToken) {
          await sleep(200); // Increased from 50ms to 200ms
        }
      } while (NextToken);
      
      // Add delay between chunks to avoid overwhelming the API
      if (i < qs.length - 1) {
        await sleep(500); // 500ms delay between chunks
      }
      
      // Merge chunk results
      Object.keys(chunkResults).forEach((id) => {
        if (!results[id]) results[id] = { Timestamps: [], Values: [] };
        results[id].Timestamps.push(...chunkResults[id].Timestamps);
        results[id].Values.push(...chunkResults[id].Values);
      });
    }
    
    return results;
  }

  const data = await getAllData(queryChunks);

  // Weekend filter helper
  function isWeekendInTZ(date, tz) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: tz,
    }).format(date);
    return weekday === "Sat" || weekday === "Sun";
  }

  // Helper to get start and end of day in a specific timezone
  // Returns UTC timestamps for start (00:00:00) and end (23:59:59.999) of the day in target timezone
  function getDayBoundsInTZ(date, tz) {
    // Get the date string in the target timezone (YYYY-MM-DD format)
    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    
    const parts = dateStr.split("-");
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1; // JS months are 0-indexed
    const day = parseInt(parts[2]);
    
    // Create dates for start and end of day, then find their UTC equivalents
    // We'll create a date at noon UTC for that day, format it in target TZ to find offset
    const noonUTC = new Date(Date.UTC(year, month, day, 12, 0, 0, 0));
    
    // Format in target timezone to see what hour it is there
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      hour12: false,
    });
    const tzHourAtNoon = parseInt(formatter.format(noonUTC));
    
    // Calculate offset: if noon UTC shows as hour X in target TZ, offset is (X - 12) hours
    const offsetHours = tzHourAtNoon - 12;
    
    // Create start of day: midnight in target TZ
    // Midnight in target TZ = (midnight UTC for that date) - offset
    const dayStart = new Date(Date.UTC(year, month, day, -offsetHours, 0, 0, 0));
    
    // Create end of day: 23:59:59.999 in target TZ
    const dayEnd = new Date(Date.UTC(year, month, day, 23 - offsetHours, 59, 59, 999));
    
    return [dayStart, dayEnd];
  }

  // Build baseline windows (one per "baseline day" we care about, skipping weekends if configured)
  // Use full 24-hour periods for baseline instead of same time window
  const CURR_END = END;
  const CURR_START = new Date(END.getTime() - WINDOW_MIN * 60 * 1000);
  const BASE_WINDOWS = [];

  if (SKIP_WEEKENDS) {
    let collected = 0;
    let daysBack = 1;
    while (collected < BASELINE_DAYS && daysBack <= 30) {
      // Get the date N days back
      const targetDate = new Date(CURR_END.getTime() - daysBack * 24 * 60 * 60 * 1000);
      if (!isWeekendInTZ(targetDate, TIMEZONE)) {
        // Use full 24-hour period: start of day to end of day in target timezone
        const [dayStart, dayEnd] = getDayBoundsInTZ(targetDate, TIMEZONE);
        BASE_WINDOWS.push([dayStart, dayEnd]);
        collected++;
      }
      daysBack++;
    }
  } else {
    for (let d = 1; d <= BASELINE_DAYS; d++) {
      // Get the date N days back
      const targetDate = new Date(CURR_END.getTime() - d * 24 * 60 * 60 * 1000);
      // Use full 24-hour period: start of day to end of day in target timezone
      const [dayStart, dayEnd] = getDayBoundsInTZ(targetDate, TIMEZONE);
      BASE_WINDOWS.push([dayStart, dayEnd]);
    }
  }

  function inRange(ts, start, end) {
    const t = ts.getTime();
    return t >= start.getTime() && t <= end.getTime();
  }

  function pickAggregator(stat, metricName) {
    const st = (stat || "").toLowerCase();
    if (st.startsWith("p") || metricName.toLowerCase().includes("latency"))
      return "median";
    if (st === "sum" || metricName.toLowerCase().includes("count"))
      return "sum";
    return "average";
  }

  function aggregate(arr, how) {
    if (!arr.length) return NaN;
    if (how === "sum") return arr.reduce((a, b) => a + b, 0);
    if (how === "median") return median(arr);
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  const rows = [];

  cfg.series.forEach((s, i) => {
    const id = `m${i}`;
    const ts = data[id]?.Timestamps || [];
    const vals = data[id]?.Values || [];

    // Build CloudWatch link even if data is missing, so you can still jump.
    const cwLink = buildCloudWatchLink({
      region: CW_REGION,
      namespace: s.namespace,
      metricName: s.metricName,
      dims: s.dimensions || {},
      stat: s.stat,
      title: cfg.title,
      periodSeconds: PERIOD,
    });

    if (ts.length === 0) {
      rows.push({
        name: s.name,
        stat: s.stat || "Average",
        agg: "avg",
        curr: 0,
        baseMed: 0,
        pctChange: 0,
        z: 0,
        pts: 0,
        base: 0,
        anomaly: false,
        metricName: s.metricName,
        namespace: s.namespace,
        title: cfg.title,
        dimensions: s.dimensions,
        cwLink, // <--- NEW
      });
      return;
    }

    const agg = pickAggregator(s.stat, s.metricName);

    // Detect if this is a latency metric for special handling
    const isLatencyMetric = (() => {
      // Check explicit mapping first
      if (s.namespace && s.metricName && globalConfig.metricMappings) {
        const namespaceMappings = globalConfig.metricMappings[s.namespace];
        if (namespaceMappings && namespaceMappings[s.metricName] === "latency") {
          return true;
        }
      }
      // Fall back to pattern matching
      const st = (s.stat || "").toLowerCase();
      const mn = (s.metricName || "").toLowerCase();
      return st.startsWith("p") || mn.includes("latency");
    })();

    const currData = vals.filter((_, idx) =>
      inRange(ts[idx], CURR_START, CURR_END)
    );
    
    // Use MAX (peak spike value) for current window to capture spikes
    // This applies to all metrics (CPU, memory, latency, errors, counts, etc.)
    let curr;
    if (currData.length > 0) {
      curr = Math.max(...currData);
    } else {
      curr = aggregate(currData, agg);
    }

    const baseData = [];
    BASE_WINDOWS.forEach(([baseStart, baseEnd]) => {
      const windowData = vals.filter((_, idx) =>
        inRange(ts[idx], baseStart, baseEnd)
      );
      if (windowData.length > 0) {
        // For latency: use average for each baseline day
        // For other metrics: use the standard aggregation
        if (isLatencyMetric) {
          const dayAvg = windowData.reduce((a, b) => a + b, 0) / windowData.length;
          baseData.push(dayAvg);
        } else {
          baseData.push(aggregate(windowData, agg));
        }
      }
    });

    // For latency: use AVERAGE of baseline days
    // For other metrics: use MEDIAN of baseline days
    const baseMed = isLatencyMetric 
      ? (baseData.length > 0 ? baseData.reduce((a, b) => a + b, 0) / baseData.length : NaN)
      : median(baseData);
    const pctChange =
      baseMed !== 0 ? ((curr - baseMed) / Math.abs(baseMed)) * 100 : 0;

    const baseMAD = mad(baseData);
    const z = baseMAD !== 0 ? (curr - baseMed) / (1.4826 * baseMAD) : 0;

    const pts = currData.length;
    const base = baseData.length;

    // Use the same anomaly detection logic as run-all.mjs (classifyAnomaly)
    // This matches the original working logic
    // Updated to use explicit namespace+metricName mapping from configuration.json first
    function detectMetricType(name, stat, metricName, title, namespace) {
      // First, try explicit mapping from configuration.json based on namespace and metricName
      if (namespace && metricName && globalConfig.metricMappings) {
        const namespaceMappings = globalConfig.metricMappings[namespace];
        if (namespaceMappings && namespaceMappings[metricName]) {
          return namespaceMappings[metricName];
        }
      }

      // Fall back to pattern matching (backward compatibility)
      const s = String(name).toLowerCase();
      const st = String(stat || "").toLowerCase();
      const mn = String(metricName || "").toLowerCase();
      const t = String(title || "").toLowerCase();
      const combined = `${s} ${mn} ${t}`;

      if (/\blatency\b/.test(combined) || /\bp\d{1,3}\b/.test(st) || /p\d{1,3}/.test(combined)) return "latency";
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
      return "count"; // default
    }

    function classifyAnomaly(metricType, pctChange) {
      const ruleDef = globalConfig.metrics[metricType] || globalConfig.metrics.count;
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

    // Use classifyAnomaly logic (same as run-all.mjs) - this is what makes local reports work
    // Pass namespace to detectMetricType for explicit mapping
    // Also check dimensions for error status codes (4xx, 5xx) to override metric type
    let metricType = detectMetricType(s.name, s.stat, s.metricName, cfg.title, s.namespace);
    
    // Override: If metric is API_COUNT but has error status code (4xx, 5xx), treat as error
    if (metricType === "count" && s.metricName === "API_COUNT" && s.dimensions) {
      const statusCode = s.dimensions.statusCode || s.dimensions.StatusCode || "";
      const statusCodeNum = parseInt(statusCode);
      if (statusCodeNum >= 400 && statusCodeNum < 600) {
        metricType = "error";
      }
    }
    
    const { isAnomaly } = classifyAnomaly(metricType, pctChange);
    
    // Also require minimum samples and baseline data
    const isAnomalyFinal = isAnomaly && pts >= MIN_SAMPLES && base >= 1;

    rows.push({
      name: s.name,
      stat: s.stat || "Average",
      agg: "max",  // Current window uses MAX to capture spikes for all metrics
      curr: round(curr),
      baseMed: round(baseMed),
      pctChange: round(pctChange),
      z: round(z),
      pts: pts,
      base: base,
      anomaly: isAnomalyFinal,
      metricName: s.metricName,
      namespace: s.namespace,
      title: cfg.title,
      dimensions: s.dimensions,
      cwLink, // <--- NEW
    });
  });

  return {
    rows,
    title: cfg.title || "Unknown",
    now: END.toISOString(),
    timezone: "Asia/Kolkata",
    windowMinutes: WINDOW_MIN,
    baselineDays: BASELINE_DAYS,
    rules: {
      minSamples: MIN_SAMPLES,
      zThreshold: Z_THRESH,
      pctThreshold: PCT_THRESH,
    },
  };
}
