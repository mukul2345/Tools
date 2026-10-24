import { WorkflowApiClient } from '../api-client.js';
import { handleApiError } from '../errors.js';

export const applicationLogsTools = [
  {
    name: 'search_application_logs',
    description:
      'Search application logs by service name and time range. Optionally filter by a search term or trace ID. ' +
      'Returns matching log entries as a streamed NDJSON response — the result is collected and returned as a JSON array. ' +
      'Time range must not exceed 10 minutes. serviceName is required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        serviceName: {
          type: 'string',
          description: 'Name of the service to fetch logs for (e.g. "workflow-service", "ia-service"). Required.',
        },
        startTime: {
          type: 'string',
          description: 'Start of the time range in ISO 8601 format (e.g. 2025-01-15T10:00:00Z). Required.',
        },
        endTime: {
          type: 'string',
          description: 'End of the time range in ISO 8601 format (e.g. 2025-01-15T10:10:00Z). Required. Must be within 10 minutes of startTime.',
        },
        searchTerm: {
          type: 'string',
          description: 'Optional keyword or trace ID to filter log entries by.',
        },
        pageSize: {
          type: 'number',
          description: 'Maximum number of log entries to return (default: 5000).',
        },
      },
      required: ['serviceName', 'startTime', 'endTime'],
    },
  },
  {
    name: 'get_sql_query_templates',
    description:
      'Returns pre-built SQL query templates for common log analysis use cases such as usage analytics, ' +
      'traffic analysis, anomaly detection, and audit trails. Use these as a starting point for execute_sql_log_query.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'execute_sql_log_query',
    description:
      'Execute a custom SQL query against application logs stored in Athena. ' +
      'The query runs against a "log_data" table with columns: date, level, message, traceId, requestID, userID, and other log fields. ' +
      'Use get_sql_query_templates first to see available templates. ' +
      'serviceName, startTime, and endTime scope the data partition. ' +
      'The sqlQuery must be plain SQL (not Base64 — encoding is handled automatically).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sqlQuery: {
          type: 'string',
          description: 'Plain SQL query to execute against the log_data table.',
        },
        serviceName: {
          type: 'string',
          description: 'Service name to scope the query partition.',
        },
        startTime: {
          type: 'string',
          description: 'Start of the time range in ISO 8601 format.',
        },
        endTime: {
          type: 'string',
          description: 'End of the time range in ISO 8601 format.',
        },
      },
      required: ['sqlQuery', 'serviceName', 'startTime', 'endTime'],
    },
  },
];

export async function handleApplicationLogsTool(
  toolName: string,
  args: Record<string, unknown>,
  apiClient: WorkflowApiClient
) {
  try {
    switch (toolName) {
      case 'search_application_logs': {
        const serviceName = args.serviceName as string | undefined;
        const startTime = args.startTime as string | undefined;
        const endTime = args.endTime as string | undefined;

        const missing = [
          !serviceName && 'serviceName',
          !startTime && 'startTime',
          !endTime && 'endTime',
        ].filter(Boolean);

        if (missing.length > 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'VALIDATION_ERROR', message: `Missing required parameters: ${missing.join(', ')}` }),
            }],
            isError: true,
          };
        }

        const result = await apiClient.searchApplicationLogs({
          serviceName: serviceName!,
          startTime: startTime!,
          endTime: endTime!,
          searchTerm: args.searchTerm as string | undefined,
          pageSize: args.pageSize as number | undefined,
        });

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_sql_query_templates': {
        const result = await apiClient.getSqlQueryTemplates();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'execute_sql_log_query': {
        const sqlQuery = args.sqlQuery as string | undefined;
        const serviceName = args.serviceName as string | undefined;
        const startTime = args.startTime as string | undefined;
        const endTime = args.endTime as string | undefined;

        const missing = [
          !sqlQuery && 'sqlQuery',
          !serviceName && 'serviceName',
          !startTime && 'startTime',
          !endTime && 'endTime',
        ].filter(Boolean);

        if (missing.length > 0) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'VALIDATION_ERROR', message: `Missing required parameters: ${missing.join(', ')}` }),
            }],
            isError: true,
          };
        }

        const result = await apiClient.executeSqlLogQuery({
          sqlQuery: sqlQuery!,
          serviceName: serviceName!,
          startTime: startTime!,
          endTime: endTime!,
        });

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'UNKNOWN_TOOL', message: `Unknown application logs tool: ${toolName}` }),
          }],
          isError: true,
        };
    }
  } catch (error) {
    return handleApiError(error);
  }
}
