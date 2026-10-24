/**
 * Discovery and data processing for CloudWatch metrics
 */

import {
  listMetricsAll,
  getMetricDataBatched,
  buildMetricQuery,
} from "./cloudwatch.mjs";
import { logger } from "./logger.mjs";

/**
 * Discover unique endpoints for services
 * @param {Object} params
 * @param {string} params.namespace
 * @param {Array<string>} params.services
 * @param {string} params.metricName
 * @param {Array<string>} [params.statusCodes] - Optional status code filter
 * @returns {Promise<Map<string, Set<string>>>} - Map of ServiceName -> Set of endpoints
 */
export async function discoverEndpointsForServices({
  namespace,
  services,
  metricName,
  statusCodes,
}) {
  const serviceEndpoints = new Map();

  // Initialize map for each service
  for (const service of services) {
    serviceEndpoints.set(service, new Set());
  }

  logger.info(`Discovering endpoints for services: ${services.join(", ")}`);

  // List all metrics for the given metric name
  const metrics = await listMetricsAll({ namespace, metricName });

  // Extract unique (ServiceName, endpoint) pairs
  for (const metric of metrics) {
    const dims = metric.Dimensions || [];

    const serviceNameDim = dims.find((d) => d.Name === "serviceName");
    const endpointDim = dims.find((d) => d.Name === "endpoint");
    const statusCodeDim = dims.find((d) => d.Name === "statusCode");

    if (!serviceNameDim || !endpointDim) {
      continue; // Skip metrics without required dimensions
    }

    const serviceName = serviceNameDim.Value;
    const endpoint = endpointDim.Value;

    // Filter by service list
    if (!services.includes(serviceName)) {
      continue;
    }

    // Filter by status codes if provided
    if (statusCodes && statusCodes.length > 0 && statusCodeDim) {
      if (!matchesStatusCodeFilter(statusCodeDim.Value, statusCodes)) {
        continue;
      }
    }

    serviceEndpoints.get(serviceName).add(endpoint);
  }

  // Log discovered endpoints
  for (const [service, endpoints] of serviceEndpoints) {
    logger.debug(`Service ${service}: ${endpoints.size} unique endpoints`);
  }

  return serviceEndpoints;
}

/**
 * Check if a status code matches any filter pattern
 * @param {string} statusCode - Actual status code
 * @param {Array<string>} filters - Filter patterns (e.g., ["200", "4XX"])
 * @returns {boolean}
 */
function matchesStatusCodeFilter(statusCode, filters) {
  for (const filter of filters) {
    if (filter.includes("X")) {
      // Pattern matching (e.g., "4XX" matches "400", "404", etc.)
      const pattern = filter.replace(/X/g, "\\d");
      const regex = new RegExp(`^${pattern}$`);
      if (regex.test(statusCode)) {
        return true;
      }
    } else if (statusCode === filter) {
      return true;
    }
  }
  return false;
}

/**
 * Fetch latency data (p90 and volume) for endpoints
 * @param {Object} params
 * @param {string} params.namespace
 * @param {Map<string, Set<string>>} params.serviceEndpoints
 * @param {Array<string>} params.successCodes
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {number} params.period
 * @param {number} params.thresholdMs
 * @param {string} params.filterMode - "below" or "above"
 * @returns {Promise<Array>} - Array of {service, endpoint, p90Ms, volume}
 */
export async function fetchLatencyData({
  namespace,
  serviceEndpoints,
  successCodes,
  start,
  end,
  period,
  thresholdMs,
  filterMode = "below",
}) {
  const queries = [];
  const queryMap = new Map(); // id -> {service, endpoint, type}

  let queryId = 0;

  // Build queries for each service/endpoint
  for (const [service, endpoints] of serviceEndpoints) {
    for (const endpoint of endpoints) {
      // Query for p90 latency (with success status codes)
      for (const statusCode of successCodes) {
        const p90Id = `p90_${queryId}`;
        queries.push(
          buildMetricQuery({
            id: p90Id,
            namespace,
            metricName: "API_LATENCY",
            dimensions: [
              { Name: "serviceName", Value: service },
              { Name: "endpoint", Value: endpoint },
              { Name: "statusCode", Value: statusCode },
              { Name: "environment", Value: "production" },
            ],
            stat: "p90",
            period,
          })
        );

        queryMap.set(p90Id, { service, endpoint, type: "p90", statusCode });
        queryId++;
      }

      // Query for total volume (same status codes as latency)
      for (const statusCode of successCodes) {
        const volumeId = `vol_${queryId}`;
        queries.push(
          buildMetricQuery({
            id: volumeId,
            namespace,
            metricName: "API_COUNT",
            dimensions: [
              { Name: "serviceName", Value: service },
              { Name: "endpoint", Value: endpoint },
              { Name: "environment", Value: "production" },
              { Name: "statusCode", Value: statusCode },
            ],
            stat: "Sum",
            period,
          })
        );

        queryMap.set(volumeId, {
          service,
          endpoint,
          type: "volume",
          statusCode,
        });
        queryId++;
      }
    }
  }

  logger.info(`Built ${queries.length} queries for latency data`);

  const results = await getMetricDataBatched({ queries, start, end, period });

  // Process results
  const endpointData = new Map(); // key: service|endpoint -> {p90Values, volumeValues}

  for (const result of results) {
    const meta = queryMap.get(result.Id);
    if (!meta) continue;

    const key = `${meta.service}|${meta.endpoint}`;

    if (!endpointData.has(key)) {
      endpointData.set(key, {
        service: meta.service,
        endpoint: meta.endpoint,
        p90Values: [],
        volumeValues: [],
      });
    }

    const data = endpointData.get(key);

    if (meta.type === "p90" && result.Values && result.Values.length > 0) {
      // Collect all p90 values (may be from different status codes)
      data.p90Values.push(...result.Values);
    } else if (
      meta.type === "volume" &&
      result.Values &&
      result.Values.length > 0
    ) {
      data.volumeValues.push(...result.Values);
    }
  }

  // Aggregate and filter
  const rows = [];

  for (const [key, data] of endpointData) {
    // Get most recent p90 (or average if multiple)
    let p90Ms = null;
    if (data.p90Values.length > 0) {
      // Use max p90 across status codes as the representative value
      p90Ms = Math.max(...data.p90Values);

      // Convert to milliseconds if needed (assume metrics are in seconds if < 10)
      if (p90Ms < 10) {
        p90Ms = p90Ms * 1000;
      }
    }

    // Get total volume
    let volume = 0;
    if (data.volumeValues.length > 0) {
      volume = data.volumeValues.reduce((sum, v) => sum + v, 0);
    }

    // Skip if no p90 data
    if (p90Ms === null) {
      continue;
    }

    // Filter by threshold based on mode
    const shouldInclude =
      filterMode === "below" ? p90Ms < thresholdMs : p90Ms > thresholdMs;

    if (!shouldInclude) {
      continue;
    }

    rows.push({
      service: data.service,
      endpoint: data.endpoint,
      p90Ms: Math.round(p90Ms * 100) / 100, // Round to 2 decimals
      volume: Math.round(volume),
    });
  }

  logger.info(
    `Latency data: ${rows.length} rows after filtering (threshold: ${thresholdMs}ms, mode: ${filterMode})`
  );

  return rows;
}

/**
 * Fetch error data (error count, total count, error ratio) for endpoints
 * @param {Object} params
 * @param {string} params.namespace
 * @param {Map<string, Set<string>>} params.serviceEndpoints
 * @param {Array<string>} params.errorCodes
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {number} params.period
 * @param {number} params.errorThreshold
 * @param {string} params.filterMode - "below" or "above"
 * @returns {Promise<Array>} - Array of {service, endpoint, errorCount, totalCount, errorRatio}
 */
export async function fetchErrorData({
  namespace,
  serviceEndpoints,
  errorCodes,
  start,
  end,
  period,
  errorThreshold,
  filterMode = "below",
}) {
  const queries = [];
  const queryMap = new Map();

  let queryId = 0;

  // Build queries for each service/endpoint
  for (const [service, endpoints] of serviceEndpoints) {
    for (const endpoint of endpoints) {
      // Query for error count
      for (const errorCode of errorCodes) {
        const errorId = `err_${queryId}`;
        queries.push(
          buildMetricQuery({
            id: errorId,
            namespace,
            metricName: "API_COUNT",
            dimensions: [
              { Name: "serviceName", Value: service },
              { Name: "endpoint", Value: endpoint },
              { Name: "statusCode", Value: errorCode },
              { Name: "environment", Value: "production" },
            ],
            stat: "Sum",
            period,
          })
        );

        queryMap.set(errorId, {
          service,
          endpoint,
          type: "error",
          statusCode: errorCode,
        });
        queryId++;
      }

      // Query for total count (all status codes: 200, 2XX, 400, 4XX, 500, 5XX)
      const allStatusCodes = [
        "200",
        "201",
        "400",
        "404",
        "401",
        "403",
        "409",
        "412",
        "500",
      ];
      for (const statusCode of allStatusCodes) {
        const totalId = `tot_${queryId}`;
        queries.push(
          buildMetricQuery({
            id: totalId,
            namespace,
            metricName: "API_COUNT",
            dimensions: [
              { Name: "serviceName", Value: service },
              { Name: "endpoint", Value: endpoint },
              { Name: "environment", Value: "production" },
              { Name: "statusCode", Value: statusCode },
            ],
            stat: "Sum",
            period,
          })
        );

        queryMap.set(totalId, { service, endpoint, type: "total", statusCode });
        queryId++;
      }
    }
  }

  logger.info(`Built ${queries.length} queries for error data`);

  const results = await getMetricDataBatched({ queries, start, end, period });

  // Process results
  const endpointData = new Map();

  for (const result of results) {
    const meta = queryMap.get(result.Id);
    if (!meta) continue;

    const key = `${meta.service}|${meta.endpoint}`;

    if (!endpointData.has(key)) {
      endpointData.set(key, {
        service: meta.service,
        endpoint: meta.endpoint,
        errorValues: [],
        totalValues: [],
      });
    }

    const data = endpointData.get(key);

    if (meta.type === "error" && result.Values && result.Values.length > 0) {
      data.errorValues.push(...result.Values);
    } else if (
      meta.type === "total" &&
      result.Values &&
      result.Values.length > 0
    ) {
      data.totalValues.push(...result.Values);
    }
  }

  // Aggregate and filter
  const rows = [];

  for (const [key, data] of endpointData) {
    const errorCount =
      data.errorValues.length > 0
        ? Math.round(data.errorValues.reduce((sum, v) => sum + v, 0))
        : 0;

    const totalCount =
      data.totalValues.length > 0
        ? Math.round(data.totalValues.reduce((sum, v) => sum + v, 0))
        : 0;

    const errorRatio = totalCount > 0 ? errorCount / totalCount : 0;

    // Filter by threshold based on mode
    const shouldInclude =
      filterMode === "below"
        ? errorCount < errorThreshold
        : errorCount > errorThreshold;

    if (!shouldInclude) {
      continue;
    }

    rows.push({
      service: data.service,
      endpoint: data.endpoint,
      errorCount,
      totalCount,
      errorRatio: (errorRatio * 100).toFixed(2) + "%",
    });
  }

  logger.info(
    `Error data: ${rows.length} rows after filtering (threshold: ${errorThreshold}, mode: ${filterMode})`
  );

  return rows;
}

/**
 * Fetch ECS resource utilization data (CPU and Memory) for services
 * @param {Object} params
 * @param {string} params.clusterName - ECS cluster name
 * @param {Array<string>} params.services - List of service names (without -production-common suffix)
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {number} params.period
 * @returns {Promise<Array>} - Array of {service, cpuAvg, memoryAvg}
 */
export async function fetchECSResourceData({
  clusterName,
  services,
  start,
  end,
  period,
}) {
  const queries = [];
  const queryMap = new Map();

  let queryId = 0;

  // Build queries for each service
  for (const service of services) {
    // ECS service name = service + "-production-common"
    const ecsServiceName = `${service}-production-common`;

    // Query for CPU utilization
    const cpuId = `cpu_${queryId}`;
    queries.push(
      buildMetricQuery({
        id: cpuId,
        namespace: "AWS/ECS",
        metricName: "CPUUtilization",
        dimensions: [
          { Name: "ServiceName", Value: ecsServiceName },
          { Name: "ClusterName", Value: clusterName },
        ],
        stat: "Average",
        period,
      })
    );

    queryMap.set(cpuId, {
      service,
      type: "cpu",
    });
    queryId++;

    // Query for Memory utilization
    const memoryId = `mem_${queryId}`;
    queries.push(
      buildMetricQuery({
        id: memoryId,
        namespace: "AWS/ECS",
        metricName: "MemoryUtilization",
        dimensions: [
          { Name: "ServiceName", Value: ecsServiceName },
          { Name: "ClusterName", Value: clusterName },
        ],
        stat: "Average",
        period,
      })
    );

    queryMap.set(memoryId, {
      service,
      type: "memory",
    });
    queryId++;
  }

  logger.info(
    `Built ${queries.length} queries for ECS resource data (${services.length} services)`
  );

  const results = await getMetricDataBatched({ queries, start, end, period });

  // Process results
  const serviceData = new Map();

  for (const result of results) {
    const meta = queryMap.get(result.Id);
    if (!meta) continue;

    if (!serviceData.has(meta.service)) {
      serviceData.set(meta.service, {
        service: meta.service,
        cpuValues: [],
        memoryValues: [],
      });
    }

    const data = serviceData.get(meta.service);

    if (meta.type === "cpu" && result.Values && result.Values.length > 0) {
      data.cpuValues.push(...result.Values);
    } else if (
      meta.type === "memory" &&
      result.Values &&
      result.Values.length > 0
    ) {
      data.memoryValues.push(...result.Values);
    }
  }

  // Aggregate and build rows
  const rows = [];

  for (const [serviceName, data] of serviceData) {
    const cpuMax = data.cpuValues.length > 0 ? Math.max(...data.cpuValues) : 0;

    const memoryMax =
      data.memoryValues.length > 0 ? Math.max(...data.memoryValues) : 0;

    rows.push({
      service: data.service,
      cpuAvg: cpuMax.toFixed(2),
      memoryAvg: memoryMax.toFixed(2),
    });
  }

  // Sort by service name
  rows.sort((a, b) => a.service.localeCompare(b.service));

  logger.info(`ECS resource data: ${rows.length} services processed`);

  return rows;
}

/**
 * Fetch SQS age of oldest message data for queues
 * @param {Object} params
 * @param {Array<Object>} params.queues - List of queue objects with queueName and serviceName
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {number} params.period
 * @returns {Promise<Array>} - Array of {queueName, serviceName, maxAge}
 */
export async function fetchSQSAgeData({ queues, start, end, period }) {
  const queries = [];
  const queryMap = new Map();

  let queryId = 0;

  // Build queries for each queue
  for (const queue of queues) {
    const ageId = `age_${queryId}`;
    queries.push(
      buildMetricQuery({
        id: ageId,
        namespace: "AWS/SQS",
        metricName: "ApproximateAgeOfOldestMessage",
        dimensions: [{ Name: "QueueName", Value: queue.queueName }],
        stat: "Maximum",
        period,
      })
    );

    queryMap.set(ageId, {
      queueName: queue.queueName,
      serviceName: queue.serviceName,
    });
    queryId++;
  }

  logger.info(
    `Built ${queries.length} queries for SQS age data (${queues.length} queues)`
  );

  const results = await getMetricDataBatched({ queries, start, end, period });

  // Process results
  const queueData = new Map();

  for (const result of results) {
    const meta = queryMap.get(result.Id);
    if (!meta) continue;

    if (!queueData.has(meta.queueName)) {
      queueData.set(meta.queueName, {
        queueName: meta.queueName,
        serviceName: meta.serviceName,
        ageValues: [],
      });
    }

    const data = queueData.get(meta.queueName);

    if (result.Values && result.Values.length > 0) {
      data.ageValues.push(...result.Values);
    }
  }

  // Aggregate and build rows
  const rows = [];

  for (const [queueName, data] of queueData) {
    const maxAge = data.ageValues.length > 0 ? Math.max(...data.ageValues) : 0;

    rows.push({
      queueName: data.queueName,
      serviceName: data.serviceName,
      maxAge: Math.round(maxAge), // Round to whole seconds
    });
  }

  // Sort by queue name
  rows.sort((a, b) => a.queueName.localeCompare(b.queueName));

  logger.info(`SQS age data: ${rows.length} queues processed`);

  return rows;
}

/**
 * Fetch top N APIs by total request volume for each service
 * @param {Object} params
 * @param {string} params.namespace
 * @param {Map<string, Set<string>>} params.serviceEndpoints
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {number} params.period
 * @param {number} [params.topN=20] - Number of top APIs to return per service
 * @returns {Promise<Array>} - Array of {service, topApis: Array<{endpoint, requestCount}>}
 */
export async function fetchTopApisByVolume({
  namespace,
  serviceEndpoints,
  start,
  end,
  period,
  topN = 20,
}) {
  const queries = [];
  const queryMap = new Map();

  const statusCodes = [
    "200",
    "201",
    "400",
    "401",
    "403",
    "404",
    "409",
    "412",
    "500",
  ];

  let queryId = 0;

  for (const [service, endpoints] of serviceEndpoints) {
    for (const endpoint of endpoints) {
      for (const statusCode of statusCodes) {
        const qId = `top_${queryId}`;
        queries.push(
          buildMetricQuery({
            id: qId,
            namespace,
            metricName: "API_COUNT",
            dimensions: [
              { Name: "serviceName", Value: service },
              { Name: "endpoint", Value: endpoint },
              { Name: "statusCode", Value: statusCode },
              { Name: "environment", Value: "production" },
            ],
            stat: "Sum",
            period,
          })
        );

        queryMap.set(qId, { service, endpoint, statusCode });
        queryId++;
      }
    }
  }

  logger.info(
    `Built ${queries.length} queries for top APIs data (${statusCodes.length} status codes × endpoints)`
  );

  const results = await getMetricDataBatched({ queries, start, end, period });

  // Accumulate total request count per (service, endpoint)
  const endpointTotals = new Map();

  for (const result of results) {
    const meta = queryMap.get(result.Id);
    if (!meta || !result.Values || result.Values.length === 0) continue;

    const key = `${meta.service}|${meta.endpoint}`;

    if (!endpointTotals.has(key)) {
      endpointTotals.set(key, {
        service: meta.service,
        endpoint: meta.endpoint,
        requestCount: 0,
      });
    }

    const sum = result.Values.reduce((acc, v) => acc + v, 0);
    endpointTotals.get(key).requestCount += sum;
  }

  // Group by service and pick top N
  const serviceMap = new Map();
  for (const service of serviceEndpoints.keys()) {
    serviceMap.set(service, []);
  }

  for (const data of endpointTotals.values()) {
    if (serviceMap.has(data.service)) {
      serviceMap.get(data.service).push({
        endpoint: data.endpoint,
        requestCount: Math.round(data.requestCount),
      });
    }
  }

  const rows = [];
  for (const [service, apis] of serviceMap) {
    apis.sort((a, b) => b.requestCount - a.requestCount);
    rows.push({
      service,
      topApis: apis.slice(0, topN),
    });
  }

  // Sort services alphabetically
  rows.sort((a, b) => a.service.localeCompare(b.service));

  logger.info(
    `Top APIs data: ${rows.length} services processed (topN: ${topN})`
  );

  return rows;
}

/**
 * Fetch Lambda performance metrics (Invocations, Duration, Errors, Throttles)
 * @param {Object} params
 * @param {Array<Object>} params.functions - List of function objects with functionName and serviceName
 * @param {Date} params.start
 * @param {Date} params.end
 * @param {Object} params.periods - Period for each metric
 * @param {number} params.periods.invocationsPeriod
 * @param {number} params.periods.durationPeriod
 * @param {number} params.periods.errorsPeriod
 * @param {number} params.periods.throttlesPeriod
 * @returns {Promise<Array>} - Array of {functionName, serviceName, invocations, durationP90, errors, throttles}
 */
export async function fetchLambdaPerformanceData({
  functions,
  start,
  end,
  periods,
}) {
  const queries = [];
  const queryMap = new Map();

  let queryId = 0;

  // Build queries for each Lambda function
  for (const func of functions) {
    const invocationsId = `inv_${queryId}`;
    const durationId = `dur_${queryId}`;
    const errorsId = `err_${queryId}`;
    const throttlesId = `thr_${queryId}`;

    // Invocations (Sum)
    queries.push(
      buildMetricQuery({
        id: invocationsId,
        namespace: "AWS/Lambda",
        metricName: "Invocations",
        dimensions: [{ Name: "FunctionName", Value: func.functionName }],
        stat: "Sum",
        period: periods.invocationsPeriod,
      })
    );

    // Duration (p90)
    queries.push(
      buildMetricQuery({
        id: durationId,
        namespace: "AWS/Lambda",
        metricName: "Duration",
        dimensions: [{ Name: "FunctionName", Value: func.functionName }],
        stat: "p90",
        period: periods.durationPeriod,
      })
    );

    // Errors (Sum)
    queries.push(
      buildMetricQuery({
        id: errorsId,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        dimensions: [{ Name: "FunctionName", Value: func.functionName }],
        stat: "Sum",
        period: periods.errorsPeriod,
      })
    );

    // Throttles (p90)
    queries.push(
      buildMetricQuery({
        id: throttlesId,
        namespace: "AWS/Lambda",
        metricName: "Throttles",
        dimensions: [{ Name: "FunctionName", Value: func.functionName }],
        stat: "p90",
        period: periods.throttlesPeriod,
      })
    );

    queryMap.set(invocationsId, {
      functionName: func.functionName,
      serviceName: func.serviceName,
      metric: "invocations",
    });
    queryMap.set(durationId, {
      functionName: func.functionName,
      serviceName: func.serviceName,
      metric: "duration",
    });
    queryMap.set(errorsId, {
      functionName: func.functionName,
      serviceName: func.serviceName,
      metric: "errors",
    });
    queryMap.set(throttlesId, {
      functionName: func.functionName,
      serviceName: func.serviceName,
      metric: "throttles",
    });

    queryId++;
  }

  logger.info(
    `Built ${queries.length} queries for Lambda performance data (${functions.length} functions × 4 metrics)`
  );

  // Note: getMetricDataBatched doesn't use the period parameter, it's embedded in queries
  const results = await getMetricDataBatched({ queries, start, end });

  // Process results
  const lambdaData = new Map();

  for (const result of results) {
    const meta = queryMap.get(result.Id);
    if (!meta) continue;

    if (!lambdaData.has(meta.functionName)) {
      lambdaData.set(meta.functionName, {
        functionName: meta.functionName,
        serviceName: meta.serviceName,
        invocationsValues: [],
        durationValues: [],
        errorsValues: [],
        throttlesValues: [],
      });
    }

    const data = lambdaData.get(meta.functionName);

    if (result.Values && result.Values.length > 0) {
      if (meta.metric === "invocations") {
        data.invocationsValues.push(...result.Values);
      } else if (meta.metric === "duration") {
        data.durationValues.push(...result.Values);
      } else if (meta.metric === "errors") {
        data.errorsValues.push(...result.Values);
      } else if (meta.metric === "throttles") {
        data.throttlesValues.push(...result.Values);
      }
    }
  }

  // Aggregate and build rows
  const rows = [];

  for (const [functionName, data] of lambdaData) {
    const invocations =
      data.invocationsValues.length > 0
        ? Math.max(...data.invocationsValues)
        : 0;
    const durationP90 =
      data.durationValues.length > 0 ? Math.max(...data.durationValues) : 0;
    const errorCount =
      data.errorsValues.length > 0
        ? Math.round(data.errorsValues.reduce((sum, v) => sum + v, 0))
        : 0;
    const throttlesCount =
      data.throttlesValues.length > 0
        ? Math.round(data.throttlesValues.reduce((sum, v) => sum + v, 0))
        : 0;

    rows.push({
      functionName: data.functionName,
      serviceName: data.serviceName,
      invocations: Math.round(invocations),
      durationP90: Math.round(durationP90), // Duration in milliseconds
      errors: Math.round(errorCount),
      throttles: Math.round(throttlesCount),
    });
  }

  // Sort by function name
  rows.sort((a, b) => a.functionName.localeCompare(b.functionName));

  logger.info(`Lambda performance data: ${rows.length} functions processed`);

  return rows;
}
