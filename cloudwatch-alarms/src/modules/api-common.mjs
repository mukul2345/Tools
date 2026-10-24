/**
 * Shared API discovery and top-N by volume (duplicated logic for standalone module).
 */
import { listMetricsAll, getMetricDataBatched, buildMetricQuery } from "../core/cloudwatch.mjs";

const METRIC_NAME = "API_STATUS_CODE";

export async function discoverEndpointsForServices({ namespace, services, metricName = METRIC_NAME }) {
  const serviceEndpoints = new Map();
  for (const s of services) serviceEndpoints.set(s, new Set());

  const metrics = await listMetricsAll({ namespace, metricName });
  for (const metric of metrics) {
    const dims = metric.Dimensions || [];
    const serviceName = dims.find((d) => d.Name === "serviceName")?.Value;
    const endpoint = dims.find((d) => d.Name === "endpoint")?.Value;
    if (!serviceName || !endpoint || !serviceEndpoints.has(serviceName)) continue;
    serviceEndpoints.get(serviceName).add(endpoint);
  }
  return serviceEndpoints;
}

export async function fetchTopApisByVolumeFromStatusCodes({
  namespace,
  serviceEndpoints,
  start,
  end,
  period,
  topN,
  environment = "production",
}) {
  const queries = [];
  const queryMap = new Map();
  const statusCodes = ["2xx", "4xx", "5xx"];
  let qid = 0;
  for (const [service, endpoints] of serviceEndpoints) {
    for (const endpoint of endpoints) {
      for (const statusCode of statusCodes) {
        const id = `top_${qid}`;
        queries.push(
          buildMetricQuery({
            id,
            namespace,
            metricName: METRIC_NAME,
            dimensions: [
              { Name: "serviceName", Value: service },
              { Name: "endpoint", Value: endpoint },
              { Name: "statusCode", Value: statusCode },
              { Name: "environment", Value: environment },
            ],
            stat: "Sum",
            period,
          }),
        );
        queryMap.set(id, { service, endpoint, statusCode });
        qid++;
      }
    }
  }
  if (queries.length === 0) return [];
  const results = await getMetricDataBatched({ queries, start, end, period });
  const endpointTotals = new Map();
  for (const result of results) {
    const meta = queryMap.get(result.Id);
    if (!meta || !result.Values?.length) continue;
    const key = `${meta.service}|${meta.endpoint}`;
    if (!endpointTotals.has(key)) {
      endpointTotals.set(key, { service: meta.service, endpoint: meta.endpoint, requestCount: 0 });
    }
    endpointTotals.get(key).requestCount += (result.Values || []).reduce((a, v) => a + v, 0);
  }
  const byService = new Map();
  for (const s of serviceEndpoints.keys()) byService.set(s, []);
  for (const data of endpointTotals.values()) {
    if (byService.has(data.service)) {
      byService.get(data.service).push({ endpoint: data.endpoint, requestCount: Math.round(data.requestCount) });
    }
  }
  const rows = [];
  for (const [service, apis] of byService) {
    apis.sort((a, b) => b.requestCount - a.requestCount);
    rows.push({ service, topApis: apis.slice(0, topN) });
  }
  rows.sort((a, b) => a.service.localeCompare(b.service));
  return rows;
}
