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

  const cw = new CloudWatchClient({
    region: REGION,
    credentials: fromIni({ profile: PROFILE }),
  });

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

  // Weekend filter helper
  function isWeekendInTZ(date, tz) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: tz,
    }).format(date);
    return weekday === "Sat" || weekday === "Sun";
  }

  // Build baseline windows (one per "baseline day" we care about, skipping weekends if configured)
  const CURR_END = END;
  const CURR_START = new Date(END.getTime() - WINDOW_MIN * 60 * 1000);
  const BASE_WINDOWS = [];

  if (SKIP_WEEKENDS) {
    let collected = 0;
    let daysBack = 1;
    while (collected < BASELINE_DAYS && daysBack <= 30) {
      const e = new Date(CURR_END.getTime() - daysBack * 24 * 60 * 60 * 1000);
      if (!isWeekendInTZ(e, TIMEZONE)) {
        const s = new Date(e.getTime() - WINDOW_MIN * 60 * 1000);
        BASE_WINDOWS.push([s, e]);
        collected++;
      }
      daysBack++;
    }
  } else {
    for (let d = 1; d <= BASELINE_DAYS; d++) {
      const e = new Date(CURR_END.getTime() - d * 24 * 60 * 60 * 1000);
      const s = new Date(e.getTime() - WINDOW_MIN * 60 * 1000);
      BASE_WINDOWS.push([s, e]);
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
        cwLink, // <--- NEW
      });
      return;
    }

    const agg = pickAggregator(s.stat, s.metricName);

    const currData = vals.filter((_, idx) =>
      inRange(ts[idx], CURR_START, CURR_END)
    );
    const curr = aggregate(currData, agg);

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
    const pctChange =
      baseMed !== 0 ? ((curr - baseMed) / Math.abs(baseMed)) * 100 : 0;

    const baseMAD = mad(baseData);
    const z = baseMAD !== 0 ? (curr - baseMed) / (1.4826 * baseMAD) : 0;

    const pts = currData.length;
    const base = baseData.length;

    const isAnomaly =
      pts >= MIN_SAMPLES &&
      Math.abs(z) >= Z_THRESH &&
      Math.abs(pctChange) >= PCT_THRESH;

    rows.push({
      name: s.name,
      stat: s.stat || "Average",
      agg: agg,
      curr: round(curr),
      baseMed: round(baseMed),
      pctChange: round(pctChange),
      z: round(z),
      pts: pts,
      base: base,
      anomaly: isAnomaly,
      metricName: s.metricName,
      namespace: s.namespace,
      title: cfg.title,
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
