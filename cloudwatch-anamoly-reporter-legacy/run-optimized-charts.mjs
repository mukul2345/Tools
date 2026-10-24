#!/usr/bin/env node
/**
 * run-optimized-charts.mjs
 * 
 * Generate interactive CloudWatch anomaly charts with summary at top.
 */

import fs from "fs";
import path from "path";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { fromIni } from "@aws-sdk/credential-providers";

const globalConfig = JSON.parse(fs.readFileSync("configuration.json", "utf-8"));
const REGION = process.env.AWS_REGION || globalConfig.aws.region || "eu-west-1";
const PROFILE = process.env.AWS_PROFILE || globalConfig.aws.profile || undefined;

// -------------------- Helpers -------------------- //
const fmtDT = (d, tz="Asia/Kolkata") => {
  if(!d||!(d instanceof Date)||isNaN(d.getTime())) return "Invalid Date";
  return new Intl.DateTimeFormat("en-GB",{
    weekday:"short",day:"2-digit",month:"short",year:"numeric",
    hour:"2-digit",minute:"2-digit",hour12:false,timeZone:tz,timeZoneName:"short"
  }).format(d);
};

const isWeekendInTZ = (date,tz="Asia/Kolkata") => {
  const wd = new Intl.DateTimeFormat("en-US",{weekday:"short",timeZone:tz}).format(date);
  return wd==="Sat"||wd==="Sun";
};

const chunk = (arr,size)=>arr.reduce((acc,_,i)=>(i%size?acc:acc.concat([arr.slice(i,i+size)])),[]);

// Statistical helpers (matching analyze.mjs)
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
  if (!arr.length) return NaN;
  if (how === "sum") return arr.reduce((a, b) => a + b, 0);
  if (how === "median") return median(arr);
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// -------------------- Metric Rules -------------------- //
const metricRules = globalConfig.metrics;

// Detect metric type (matching run-all.mjs)
function detectMetricType(name="",stat="",metricName="",title=""){
  const s = String(name).toLowerCase();
  const st = String(stat).toLowerCase();
  const mn = String(metricName).toLowerCase();
  const t = String(title).toLowerCase();

  // Combine all relevant fields for comprehensive matching
  const combined = `${s} ${mn} ${t}`;

  if (/\blatency\b/.test(combined) || /\bp\d{1,3}\b/.test(st) || /p\d{1,3}/.test(combined)) return "latency";
  if (/\berror|exception|fail\b/.test(combined)) return "error";
  if (/\bcpu\b/.test(combined) || /cpu utilization/.test(combined)) return "cpu";
  if (/\bmem(ory)?\b/.test(combined) || /memory utilization/.test(combined)) return "memory";
  if (/\bage of oldest|oldest message|message age|age\b/.test(combined)) return "age";
  if (/\bcount|requests?|calls?\b/.test(combined)) return "count";

  return "count"; // default fallback
}

// Classify anomaly
function classifyAnomaly(metricType,pctChange){
  const rule = metricRules[metricType]||metricRules.count;
  let badFn = rule.badIf, goodFn = rule.goodIf;
  if(typeof badFn==="string") badFn = new Function("pct",`return ${badFn}`);
  if(typeof goodFn==="string") goodFn = new Function("pct",`return ${goodFn}`);
  if(badFn(pctChange)) return {isAnomaly:true,impact:"bad",color:"red"};
  if(goodFn(pctChange)) return {isAnomaly:true,impact:"good",color:"green"};
  return {isAnomaly:false,impact:"neutral",color:"neutral"};
}

// CloudWatch client
function createCloudWatchClient(region=REGION,profile=PROFILE){
  const opts={region};
  if(profile) opts.credentials=fromIni({profile});
  return new CloudWatchClient(opts);
}

// Fetch series (with pagination like analyze.mjs)
async function fetchSeriesData(seriesList,fetchStart,fetchEnd,period=60){
  const cw=createCloudWatchClient();
  const queries=seriesList.map((s,i)=>({
    Id:`m${i}`,
    MetricStat:{
      Metric:{
        Namespace:s.namespace,
        MetricName:s.metricName,
        Dimensions:Object.entries(s.dimensions||{}).map(([Name,Value])=>({Name,Value}))
      },
      Period:period,
      Stat:s.stat||"Average"
    },
    ReturnData:true
  }));
  const queryChunks = chunk(queries,500);
  
  async function getAllData(qs) {
    let results = {};
    for (const q of qs) {
      let NextToken;
      do {
        const res = await cw.send(
          new GetMetricDataCommand({
            StartTime: fetchStart,
            EndTime: fetchEnd,
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
      } while (NextToken);
    }
    return results;
  }
  
  return await getAllData(queryChunks);
}

// Convert widget to series (matching analyze.mjs)
function convertWidgetToConfig(widget){
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
          console.warn(`Odd number of dimension tokens in metric row ${idx}, skipping`);
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

// -------------------- CLI -------------------- //
const cfgDir = process.argv[2]||"configs";
const htmlPath = process.argv[3]||"optimized-charts-report.html";
const endISO = process.argv.find(x=>x.startsWith("--end="))?.split("=")[1];

const cfgFiles = fs.readdirSync(cfgDir).filter(f=>f.endsWith(".json")&&!f.startsWith("manifest."));
if(!cfgFiles.length){console.error("No configs found in",cfgDir);process.exit(1);}

// -------------------- Main -------------------- //
async function main(){
  let HTML=`<html><head><meta charset="utf-8"><title>CloudWatch Anomaly Charts</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    body{font-family:system-ui,sans-serif;margin:24px;max-width:1400px;}
    h1{margin-bottom:12px;}
    .badge{padding:2px 8px;border-radius:8px;font-size:12px;margin-left:6px;}
    .chart-container{margin:24px 0;padding:12px;border:1px solid #e5e5e5;border-radius:8px;}
    .chart-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
    table{border-collapse:collapse;width:100%;margin-top:16px;}
    th,td{border:1px solid #ddd;padding:6px;text-align:center;}
    th{background:#f3f3f3;}
  </style>
  </head><body>`;
  HTML+=`<h1>CloudWatch Anomaly Charts</h1><div>Generated: ${new Date().toISOString()}</div>`;

  const anomalyStats={};
  const charts=[];
  const seenMetrics=new Map(); // Track unique (name, stat) pairs to avoid double-counting

  // Process configs
  for(const f of cfgFiles){
    let cfg=JSON.parse(fs.readFileSync(path.join(cfgDir,f),"utf-8"));
    if(cfg.metrics&&!cfg.series) cfg=convertWidgetToConfig(cfg);
    if(!cfg.series?.length) continue;

    const NOW=endISO?new Date(endISO):new Date();
    const PERIOD=cfg.periodSeconds||globalConfig.report.periodSeconds||60;
    const WINDOW_MIN=cfg.windowMinutes||globalConfig.report.windowMinutes||60;
    const BASELINE_DAYS=cfg.baselineDays||globalConfig.report.baselineDays||7;
    const MIN_SAMPLES=cfg.minSamples||globalConfig.report.minSamples||10;
    const Z_THRESH=cfg.zThreshold||globalConfig.report.zThreshold||3.0;
    const PCT_THRESH=cfg.pctThreshold||globalConfig.report.pctThreshold||40;
    const TZ=cfg.timezone||globalConfig.report.timezone||"Asia/Kolkata";
    const SKIP_WEEKENDS=cfg.skipWeekends!==undefined?cfg.skipWeekends:(globalConfig.report.skipWeekends!==undefined?globalConfig.report.skipWeekends:true);

    // Define current window
    const CURR_END=NOW;
    const CURR_START=new Date(NOW.getTime()-WINDOW_MIN*60*1000);

    // Build baseline windows, collecting N weekdays (not just N days)
    const BASE_WINDOWS=[];
    if(SKIP_WEEKENDS){
      // Need to collect BASELINE_DAYS number of weekdays
      let collected=0;
      let daysBack=1;
      
      while(collected<BASELINE_DAYS && daysBack<=30){ // max 30 days back
        const e=new Date(CURR_END.getTime()-daysBack*24*60*60*1000);
        
        if(!isWeekendInTZ(e,TZ)){
          const s=new Date(e.getTime()-WINDOW_MIN*60*1000);
          BASE_WINDOWS.push([s,e]);
          collected++;
        }
        
        daysBack++;
      }
    }else{
      // Include all days (original logic)
      for(let d=1;d<=BASELINE_DAYS;d++){
        const e=new Date(CURR_END.getTime()-d*24*60*60*1000);
        const s=new Date(e.getTime()-WINDOW_MIN*60*1000);
        BASE_WINDOWS.push([s,e]);
      }
    }

    // Calculate fetch start based on earliest baseline window (if any)
    // This ensures we fetch all data needed for baseline calculations
    const FETCH_START=BASE_WINDOWS.length?BASE_WINDOWS[BASE_WINDOWS.length-1][0]:CURR_START;
    const FETCH_END=NOW;

    const raw=await fetchSeriesData(cfg.series,FETCH_START,FETCH_END,PERIOD);

    for(let i=0;i<cfg.series.length;i++){
      const s=cfg.series[i];
      const id=`m${i}`;
      const ts=raw[id]?.Timestamps||[];
      const vals=raw[id]?.Values||[];

      if(ts.length===0) continue;

      const agg=pickAggregator(s.stat,s.metricName);

      // Current window data
      const currData=vals.filter((_,idx)=>inRange(ts[idx],CURR_START,CURR_END));
      const curr=aggregate(currData,agg);

      // Baseline data from previous days
      const baseData=[];
      BASE_WINDOWS.forEach(([baseStart,baseEnd])=>{
        const windowData=vals.filter((_,idx)=>inRange(ts[idx],baseStart,baseEnd));
        if(windowData.length>0){
          baseData.push(aggregate(windowData,agg));
        }
      });

      const baseMed=median(baseData);
      const pctChange=baseMed!==0?((curr-baseMed)/Math.abs(baseMed))*100:0;

      // Calculate Z-score using MAD
      const baseMAD=mad(baseData);
      const z=baseMAD!==0?(curr-baseMed)/(1.4826*baseMAD):0;

      const pts=currData.length;
      const base=baseData.length;

      // Determine if this is an anomaly (all three conditions must be met)
      const isAnomalyByStats=pts>=MIN_SAMPLES&&Math.abs(z)>=Z_THRESH&&Math.abs(pctChange)>=PCT_THRESH;

      // Always classify metrics (even non-anomalies) to match run-all.mjs behavior
      const metricType=detectMetricType(s.name,s.stat,s.metricName,cfg.title);
      const {isAnomaly,impact,color}=classifyAnomaly(metricType,pctChange);

      // Only count unique metrics to avoid double-counting (same API in multiple sections)
      if(isAnomaly || isAnomalyByStats){
        const metricKey=`${s.name}|${s.stat}`;
        
        if(!seenMetrics.has(metricKey)){
          // First time seeing this metric - count it
          seenMetrics.set(metricKey,{metricType,impact});
          
          if(!anomalyStats[metricType]) anomalyStats[metricType]={red:0,green:0};
          if(impact==="bad") anomalyStats[metricType].red++;
          if(impact==="good") anomalyStats[metricType].green++;
        }
      }

      // Only skip if it's neither statistically significant nor classified as anomaly
      if (!isAnomalyByStats && !isAnomaly) continue;

      const chartId=`chart_${Math.random().toString(36).slice(2,9)}`;
      const timelineX=ts.map(d=>d.toISOString()),timelineY=vals;

      const dims=Object.entries(s.dimensions||{}).map(([k,v])=>`~'${k}~'${v.replace(/\//g,'*2f')}`).join('');
      const statType=s.metricName.toUpperCase().includes("COUNT")?"SampleCount":s.stat||"Average";
      const consoleUrl=`https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#metricsV2?graph=~(metrics~(~(~'${s.namespace}~'${s.metricName}${dims}~(stat~'${statType}~period~60~region~'${REGION})))~view~'timeSeries~stacked~false~region~'${REGION})`;

      charts.push({
        chartId,timelineX,timelineY,color,consoleUrl,
        title:cfg.title,
        seriesName:s.name||`${s.namespace}/${s.metricName}`,
        metricType,
        curr:round(curr),
        baseMed:round(baseMed),
        pctChange:round(pctChange),
        z:round(z),
        pts,
        base
      });
    }
  }

  // -------------------- Summary at top -------------------- //
  HTML+=`<div style="margin:24px;padding:12px;border:1px solid #e5e5e5;border-radius:8px;">
    <h2>Anomaly Summary</h2>
    <table>
      <tr><th>Metric Type</th><th>Bad Anomalies 🔴</th><th>Good Changes 🟢</th><th>Total</th></tr>`;
  for(const [mt,counts] of Object.entries(anomalyStats)){
    const total=(counts.red||0)+(counts.green||0);
    HTML+=`<tr>
      <td>${metricRules[mt]?.label||mt}</td>
      <td>${counts.red||0}</td>
      <td>${counts.green||0}</td>
      <td><strong>${total}</strong></td>
    </tr>`;
  }
  HTML+=`</table></div>`;

  // -------------------- Render Charts -------------------- //
  for(const c of charts){
    const fmtPct = (n) => (Number.isFinite(n) ? ((n >= 0 ? "+" : "") + n.toFixed(1) + "%") : "");
    HTML+=`<div class="chart-container">
      <div class="chart-header">
        <div>
          <strong>${c.title}</strong> • ${c.seriesName} 
          <span class="badge" style="background:${c.color==='red'?'#fee2e2':'#dcfce7'}; color:${c.color==='red'?'#b91c1c':'#166534'}">${c.color.toUpperCase()}</span>
        </div>
        <div><a href="${c.consoleUrl}" target="_blank">View in CloudWatch</a></div>
      </div>
      <div style="margin:8px 0;padding:8px;background:#f9f9f9;border-radius:4px;font-size:12px;">
        <strong>Metrics:</strong> 
        Curr=${c.curr} | BaseMed=${c.baseMed} | Δ%=${fmtPct(c.pctChange)} | z=${c.z} | Pts=${c.pts} | Base=${c.base}
      </div>
      <div id="${c.chartId}" style="height:300px;"></div>
    </div>
    <script>
      Plotly.newPlot("${c.chartId}",[{x:${JSON.stringify(c.timelineX)},y:${JSON.stringify(c.timelineY)},mode:"lines+markers",line:{color:"${c.color}"}}],{margin:{l:50,r:20,t:10,b:50}});
    </script>`;
  }

  HTML+=`</body></html>`;
  fs.writeFileSync(htmlPath,HTML);
  console.log("→ Wrote",htmlPath);
}

main().catch(err=>{console.error("Fatal:",err);process.exit(1);});