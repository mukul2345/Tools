import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import fs from "fs";
import path from "path";

// --------- helpers ----------
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

// --------- CLI args ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const [k, v] = s.includes("=")
      ? s.split("=")
      : [s.replace(/^--?/, ""), true];
    return [k.replace(/^--?/, ""), v];
  })
);

const configPath = args.config || "configuration.json";
const cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf-8"));

const REGION = cfg.region ||
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "eu-west-1";
const PERIOD = cfg.periodSeconds || 60;
const WINDOW_MIN = cfg.windowMinutes || 60;
const BASELINE_DAYS = cfg.baselineDays || 7;
const MIN_SAMPLES = cfg.minSamples ?? 10;
const Z_THRESH = cfg.zThreshold ?? 3.0;
const PCT_THRESH = cfg.pctThreshold ?? 40;
const TIMEZONE = cfg.timezone || "Asia/Kolkata";
const SKIP_WEEKENDS = cfg.skipWeekends !== undefined ? cfg.skipWeekends : true;

const NOW = args.end ? new Date(args.end) : new Date(); // optional: --end=2025-09-04T08:00:00+05:30
const END = NOW;

// Calculate how far back to fetch data
// If skipWeekends=true, we need to fetch more days to get N weekdays
// Worst case: need to go back ~1.5x days (e.g., 3 weekdays could span 5 calendar days)
const fetchDays = SKIP_WEEKENDS ? Math.ceil(BASELINE_DAYS * 1.5) : BASELINE_DAYS;
const START = new Date(
  END.getTime() - (fetchDays * 24 * 60 + WINDOW_MIN) * 60 * 1000
); // enough to cover baseline windows + current

const cw = new CloudWatchClient({ region: REGION, profile: "prod" });

// Build a single GetMetricData call for all series
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
      Stat: s.stat, // "Sum", "Average", "p95", etc
    },
    ReturnData: true,
  });
});

// CloudWatch returns up to 500 queries per call; if you have >500, chunk them.
const chunk = (arr, size) =>
  arr.reduce(
    (acc, _, i) => (i % size ? acc : acc.concat([arr.slice(i, i + size)])),
    []
  );
const queryChunks = chunk(queries, 500);

// Fetch data (handle pagination)
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
        // Append keeping order
        r.Timestamps.forEach((t, idx) => {
          const v = r.Values[idx];
          // CloudWatch may yield nulls; skip null/undefined
          if (v != null) {
            results[r.Id].Timestamps.push(new Date(t));
            results[r.Id].Values.push(v);
          }
        });
      });
      NextToken = res.NextToken;
      if (NextToken) await sleep(100); // polite
    } while (NextToken);
  }
  return results;
}

function inRange(ts, start, end) {
  const t = ts.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

// Helper to check if date is weekend in specific timezone
function isWeekendInTZ(date, tz) {
  const weekday = new Intl.DateTimeFormat("en-US", { 
    weekday: "short", 
    timeZone: tz 
  }).format(date);
  return weekday === "Sat" || weekday === "Sun";
}

// Define current & baseline windows
const CURR_END = END;
const CURR_START = new Date(END.getTime() - WINDOW_MIN * 60 * 1000);
const BASE_WINDOWS = []; // array of [start, end] for each previous day, same hour window

// Build baseline windows, collecting N weekdays (not just N days)
if (SKIP_WEEKENDS) {
  // Need to collect BASELINE_DAYS number of weekdays
  let collected = 0;
  let daysBack = 1;
  
  while (collected < BASELINE_DAYS && daysBack <= 30) { // max 30 days back
    const e = new Date(CURR_END.getTime() - daysBack * 24 * 60 * 60 * 1000);
    
    if (!isWeekendInTZ(e, TIMEZONE)) {
      const s = new Date(e.getTime() - WINDOW_MIN * 60 * 1000);
      BASE_WINDOWS.push([s, e]);
      collected++;
    }
    
    daysBack++;
  }
} else {
  // Include all days (original logic)
  for (let d = 1; d <= BASELINE_DAYS; d++) {
    const e = new Date(CURR_END.getTime() - d * 24 * 60 * 60 * 1000);
    const s = new Date(e.getTime() - WINDOW_MIN * 60 * 1000);
    BASE_WINDOWS.push([s, e]);
  }
}

// pick aggregator per series (latency p95 -> median of points; counts (Sum) -> sum)
function pickAggregator(stat, metricName) {
  const st = (stat || "").toLowerCase();
  if (st.startsWith("p") || metricName.toLowerCase().includes("latency"))
    return "median";
  if (st === "sum" || metricName.toLowerCase().includes("count")) return "sum";
  return "average";
}
function aggregate(arr, how) {
  if (!arr.length) return NaN;
  if (how === "sum") return arr.reduce((a, b) => a + b, 0);
  if (how === "median") return median(arr);
  return arr.reduce((a, b) => a + b, 0) / arr.length; // average
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return "";
  return (n >= 0 ? "+" : "") + round(n, 1) + "%";
}

(async () => {
  const data = await getAllData(queryChunks);

  const rows = [];
  for (let i = 0; i < cfg.series.length; i++) {
    const s = cfg.series[i];
    const id = `m${i}`;
    const res = data[id] || { Timestamps: [], Values: [] };

    // current window points
    const currVals = [];
    for (let j = 0; j < res.Timestamps.length; j++) {
      const ts = res.Timestamps[j];
      const v = res.Values[j];
      if (inRange(ts, CURR_START, CURR_END)) currVals.push(v);
    }

    // baseline windows -> build day-level aggregates
    const aggType = pickAggregator(s.stat, s.metricName);
    const baselineAggs = [];
    BASE_WINDOWS.forEach(([bs, be]) => {
      const vals = [];
      for (let j = 0; j < res.Timestamps.length; j++) {
        const ts = res.Timestamps[j];
        if (inRange(ts, bs, be)) vals.push(res.Values[j]);
      }
      if (vals.length) baselineAggs.push(aggregate(vals, aggType));
    });

    // Current window uses MAX to capture spikes for all metrics
    const currAgg = currVals.length > 0 ? Math.max(...currVals) : aggregate(currVals, aggType);
    const baseMed = median(baselineAggs);
    const baseMAD = mad(baselineAggs);
    const baseSigma = baseMAD * 1.4826; // ~stddev from MAD
    const z =
      Number.isFinite(baseSigma) && baseSigma > 0
        ? (currAgg - baseMed) / baseSigma
        : 0;
    const pct =
      Number.isFinite(baseMed) && baseMed !== 0
        ? ((currAgg - baseMed) / baseMed) * 100
        : Number.isFinite(currAgg)
        ? currAgg > 0
          ? Infinity
          : -Infinity
        : NaN;

    const anomaly =
      currVals.length >= MIN_SAMPLES &&
      Math.abs(z) >= Z_THRESH &&
      (Number.isFinite(pct) ? Math.abs(pct) >= PCT_THRESH : true);

    rows.push({
      Series: s.name,
      Stat: s.stat,
      Agg: "max",  // Current window uses MAX to capture spikes for all metrics
      Curr: round(currAgg),
      BaseMed: round(baseMed),
      "Δ%": fmtPct(pct),
      z: round(z, 2),
      CurrPts: currVals.length,
      BaseDays: baselineAggs.length,
      Anom: anomaly ? "YES" : "",
    });
  }

  // sort by severity (|z| desc then |Δ%|)
  rows.sort((a, b) => Math.abs(b["z"]) - Math.abs(a["z"]));

  if (args.json) {
    console.log(
      JSON.stringify(
        { now: END.toISOString(), windowMinutes: WINDOW_MIN, rows },
        null,
        2
      )
    );
  } else {
    // pretty table
    const Table = (await import("cli-table3")).default;
    const t = new Table({
      head: [
        "Series",
        "Stat",
        "Agg",
        "Curr",
        "BaseMed",
        "Δ%",
        "z",
        "CurrPts",
        "BaseDays",
        "Anom",
      ],
    });
    rows.forEach((r) =>
      t.push([
        r.Series,
        r.Stat,
        r.Agg,
        r.Curr,
        r.BaseMed,
        r["Δ%"],
        r.z,
        r.CurrPts,
        r.BaseDays,
        r.Anom,
      ])
    );
    console.log(
      `Time now: ${END.toISOString()} | Window: last ${WINDOW_MIN}m | Baseline: same window over last ${BASELINE_DAYS} days`
    );
    console.log(t.toString());
    console.log(
      `Rules: minSamples=${MIN_SAMPLES}, |z|>=${Z_THRESH}, |Δ%|>=${PCT_THRESH} ⇒ Anom=YES`
    );
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
