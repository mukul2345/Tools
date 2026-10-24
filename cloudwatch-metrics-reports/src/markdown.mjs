/**
 * Markdown table rendering for Confluence
 */

/**
 * Render latency table in Markdown format
 * @param {Array} rows - Array of {service, endpoint, p90Ms, volume}
 * @param {string} filterMode - "below" or "above"
 * @returns {string} - Markdown table
 */
export function renderLatencyTable(rows, filterMode = "below") {
  const operator = filterMode === "below" ? "<" : ">";
  const title = `## Latency Report (p90 ${operator} Threshold)`;

  if (rows.length === 0) {
    return `${title}\n\nNo data available.\n`;
  }

  // Sort by service, then endpoint
  const sorted = [...rows].sort((a, b) => {
    if (a.service !== b.service) {
      return a.service.localeCompare(b.service);
    }
    return a.endpoint.localeCompare(b.endpoint);
  });

  let markdown = `${title}\n\n`;
  markdown +=
    "| APIs | Service | p90 (ms) | Volume | Target p90 | Status | DueDate |\n";
  markdown +=
    "|------|---------|----------|--------|------------|--------|----------|\n";

  for (const row of sorted) {
    markdown += `| ${row.endpoint} | ${row.service} | ${row.p90Ms} | ${row.volume} | 100 |  |  |\n`;
  }

  markdown += `\n**Total APIs:** ${sorted.length}\n`;

  return markdown;
}

/**
 * Render error table in Markdown format
 * @param {Array} rows - Array of {service, endpoint, errorCount, totalCount, errorRatio}
 * @param {string} filterMode - "below" or "above"
 * @returns {string} - Markdown table
 */
export function renderErrorTable(rows, filterMode = "below") {
  const operator = filterMode === "below" ? "<" : ">";
  const title = `## Error Report (Error Count ${operator} Threshold)`;

  if (rows.length === 0) {
    return `${title}\n\nNo data available.\n`;
  }

  // Sort by service, then endpoint
  const sorted = [...rows].sort((a, b) => {
    if (a.service !== b.service) {
      return a.service.localeCompare(b.service);
    }
    return a.endpoint.localeCompare(b.endpoint);
  });

  let markdown = `${title}\n\n`;
  markdown +=
    "| APIs | Service | Error Count | Total Count | Error Ratio | Status | Remarks |\n";
  markdown +=
    "|------|---------|-------------|-------------|-------------|--------|----------|\n";

  for (const row of sorted) {
    markdown += `| ${row.endpoint} | ${row.service} | ${row.errorCount} | ${row.totalCount} | ${row.errorRatio} |  |  |\n`;
  }

  markdown += `\n**Total APIs:** ${sorted.length}\n`;

  return markdown;
}

/**
 * Combine multiple markdown sections
 * @param {Array<string>} sections - Array of markdown strings
 * @returns {string}
 */
export function combineReports(sections) {
  return sections.filter((s) => s).join("\n\n---\n\n");
}

/**
 * Render latency data as CSV
 * @param {Array} rows - Array of {service, endpoint, p90Ms, volume}
 * @param {string} filterMode - "below" or "above"
 * @returns {string} - CSV content
 */
export function renderLatencyCSV(rows, filterMode = "below") {
  if (rows.length === 0) {
    return "No data available\n";
  }

  // Sort by service, then endpoint
  const sorted = [...rows].sort((a, b) => {
    if (a.service !== b.service) {
      return a.service.localeCompare(b.service);
    }
    return a.endpoint.localeCompare(b.endpoint);
  });

  let csv = "API,Service,p90 (ms),Volume,Target p90,Status,DueDate\n";

  for (const row of sorted) {
    // Escape commas in endpoint/service names
    const endpoint = `"${row.endpoint.replace(/"/g, '""')}"`;
    const service = `"${row.service.replace(/"/g, '""')}"`;
    csv += `${endpoint},${service},${row.p90Ms},${row.volume},100,,\n`;
  }

  return csv;
}

/**
 * Render error data as CSV
 * @param {Array} rows - Array of {service, endpoint, errorCount, totalCount, errorRatio}
 * @param {string} filterMode - "below" or "above"
 * @returns {string} - CSV content
 */
export function renderErrorCSV(rows, filterMode = "below") {
  if (rows.length === 0) {
    return "No data available\n";
  }

  // Sort by service, then endpoint
  const sorted = [...rows].sort((a, b) => {
    if (a.service !== b.service) {
      return a.service.localeCompare(b.service);
    }
    return a.endpoint.localeCompare(b.endpoint);
  });

  let csv = "API,Service,Error Count,Total Count,Error Ratio,Status,Remarks\n";

  for (const row of sorted) {
    // Escape commas in endpoint/service names
    const endpoint = `"${row.endpoint.replace(/"/g, '""')}"`;
    const service = `"${row.service.replace(/"/g, '""')}"`;
    csv += `${endpoint},${service},${row.errorCount},${row.totalCount},${row.errorRatio},,\n`;
  }

  return csv;
}

/**
 * Render ECS resource table in Markdown format
 * @param {Array} rows - Array of {service, cpuAvg, memoryAvg}
 * @returns {string} - Markdown table
 */
export function renderECSResourceTable(rows) {
  const title = `## ECS Resource Utilization Report`;

  if (rows.length === 0) {
    return `${title}\n\nNo data available.\n`;
  }

  // Sort by service name
  const sorted = [...rows].sort((a, b) => a.service.localeCompare(b.service));

  let markdown = `${title}\n\n`;
  markdown += "| Service | CPU (avg) % | Memory (avg) % |\n";
  markdown += "|---------|-------------|----------------|\n";

  for (const row of sorted) {
    markdown += `| ${row.service} | ${row.cpuAvg} | ${row.memoryAvg} |\n`;
  }

  markdown += `\n**Total Services:** ${sorted.length}\n`;

  return markdown;
}

/**
 * Render ECS resource data as CSV
 * @param {Array} rows - Array of {service, cpuAvg, memoryAvg}
 * @returns {string} - CSV content
 */
export function renderECSResourceCSV(rows) {
  if (rows.length === 0) {
    return "No data available\n";
  }

  // Sort by service name
  const sorted = [...rows].sort((a, b) => a.service.localeCompare(b.service));

  let csv = "Service,CPU (avg) %,Memory (avg) %\n";

  for (const row of sorted) {
    // Escape commas in service names
    const service = `"${row.service.replace(/"/g, '""')}"`;
    csv += `${service},${row.cpuAvg},${row.memoryAvg}\n`;
  }

  return csv;
}

/**
 * Render SQS age table in Markdown format
 * @param {Array} rows - Array of {queueName, serviceName, maxAge}
 * @returns {string} - Markdown table
 */
export function renderSQSAgeTable(rows) {
  const title = `## SQS Age of Oldest Message Report`;

  if (rows.length === 0) {
    return `${title}\n\nNo data available.\n`;
  }

  // Sort by queue name
  const sorted = [...rows].sort((a, b) =>
    a.queueName.localeCompare(b.queueName)
  );

  let markdown = `${title}\n\n`;
  markdown +=
    "| Queue | Service | Age of Oldest Message (seconds) | Status |\n";
  markdown +=
    "|-------|---------|----------------------------------|--------|\n";

  for (const row of sorted) {
    markdown += `| ${row.queueName} | ${row.serviceName} | ${row.maxAge} |  |\n`;
  }

  markdown += `\n**Total Queues:** ${sorted.length}\n`;

  return markdown;
}

/**
 * Render SQS age data as CSV
 * @param {Array} rows - Array of {queueName, serviceName, maxAge}
 * @returns {string} - CSV content
 */
export function renderSQSAgeCSV(rows) {
  if (rows.length === 0) {
    return "No data available\n";
  }

  // Sort by queue name
  const sorted = [...rows].sort((a, b) =>
    a.queueName.localeCompare(b.queueName)
  );

  let csv = "Queue,Service,Age of Oldest Message (seconds),Status\n";

  for (const row of sorted) {
    // Escape commas in queue names and service names
    const queueName = `"${row.queueName.replace(/"/g, '""')}"`;
    const serviceName = `"${row.serviceName.replace(/"/g, '""')}"`;
    csv += `${queueName},${serviceName},${row.maxAge},\n`;
  }

  return csv;
}

/**
 * Render Lambda performance table in Markdown format
 * @param {Array} rows - Array of {functionName, serviceName, invocations, durationP90, errors, throttles}
 * @returns {string} - Markdown table
 */
export function renderLambdaPerformanceTable(rows) {
  const title = `## Lambda Performance Report`;

  if (rows.length === 0) {
    return `${title}\n\nNo data available.\n`;
  }

  // Sort by function name
  const sorted = [...rows].sort((a, b) =>
    a.functionName.localeCompare(b.functionName)
  );

  let markdown = `${title}\n\n`;
  markdown +=
    "| Lambda | Service | Invocations | Latency (p90) | Errors | Throttles | Status |\n";
  markdown +=
    "|--------|---------|-------------|---------------|--------|-----------|--------|\n";

  for (const row of sorted) {
    markdown += `| ${row.functionName} | ${row.serviceName} | ${row.invocations} | ${row.durationP90} | ${row.errors} | ${row.throttles} |  |\n`;
  }

  markdown += `\n**Total Functions:** ${sorted.length}\n`;

  return markdown;
}

/**
 * Render top APIs table per service in Markdown format
 * @param {Array} rows - Array of {service, topApis: Array<{endpoint, requestCount}>}
 * @returns {string} - Markdown content
 */
export function renderTopApisTable(rows) {
  const title = `## Top APIs by Request Volume`;

  if (rows.length === 0) {
    return `${title}\n\nNo data available.\n`;
  }

  let markdown = `${title}\n`;

  for (const { service, topApis } of rows) {
    markdown += `\n### ${service}\n\n`;

    if (topApis.length === 0) {
      markdown += `No API data available for this service.\n`;
      continue;
    }

    markdown += `| Rank | Endpoint | Request Count |\n`;
    markdown += `|------|----------|---------------|\n`;

    topApis.forEach(({ endpoint, requestCount }, idx) => {
      markdown += `| ${idx + 1} | ${endpoint} | ${requestCount} |\n`;
    });

    markdown += `\n**Total APIs shown:** ${topApis.length}\n`;
  }

  return markdown;
}

/**
 * Render top APIs data as CSV
 * @param {Array} rows - Array of {service, topApis: Array<{endpoint, requestCount}>}
 * @returns {string} - CSV content
 */
export function renderTopApisCSV(rows) {
  if (rows.length === 0) {
    return "No data available\n";
  }

  let csv = "Service,Rank,Endpoint,Request Count\n";

  for (const { service, topApis } of rows) {
    topApis.forEach(({ endpoint, requestCount }, idx) => {
      const svc = `"${service.replace(/"/g, '""')}"`;
      const ep = `"${endpoint.replace(/"/g, '""')}"`;
      csv += `${svc},${idx + 1},${ep},${requestCount}\n`;
    });
  }

  return csv;
}

/**
 * Render Lambda performance data as CSV
 * @param {Array} rows - Array of {functionName, serviceName, invocations, durationP90, errors, throttles}
 * @returns {string} - CSV content
 */
export function renderLambdaPerformanceCSV(rows) {
  if (rows.length === 0) {
    return "No data available\n";
  }

  // Sort by function name
  const sorted = [...rows].sort((a, b) =>
    a.functionName.localeCompare(b.functionName)
  );

  let csv =
    "Lambda,Service,Invocations,Latency (p90),Errors,Throttles,Status\n";

  for (const row of sorted) {
    // Escape commas in function names and service names
    const functionName = `"${row.functionName.replace(/"/g, '""')}"`;
    const serviceName = `"${row.serviceName.replace(/"/g, '""')}"`;
    csv += `${functionName},${serviceName},${row.invocations},${row.durationP90},${row.errors},${row.throttles},\n`;
  }

  return csv;
}
