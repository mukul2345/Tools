import { WorkflowApiClient } from '../api-client.js';
import { handleApiError } from '../errors.js';

export const executionStepsTools = [
  {
    name: 'get_execution_steps',
    description:
      'Retrieve execution steps by trace ID or workflow ID. Provide at least one of traceId or workflowId. ' +
      'When traceId is provided, fetches all execution steps for that specific trace. ' +
      'When workflowId is provided (without traceId), fetches execution step traces for that workflow — ' +
      'startTimestamp and endTimestamp are REQUIRED in that case to bound the time range. ' +
      'The traces response includes first_timestamp, stage, and state fields needed to call get_workflow_run_logs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        traceId: {
          type: 'string',
          description: 'Trace ID to look up execution steps for. When provided, workflowId/startTimestamp/endTimestamp are ignored.',
        },
        workflowId: {
          type: 'string',
          description: 'Workflow ID to look up execution step traces for. Requires startTimestamp and endTimestamp.',
        },
        startTimestamp: {
          type: 'string',
          description: 'Start of the time range to search traces (required when using workflowId). ISO 8601 format, e.g. 2025-01-15T10:00:00Z.',
        },
        endTimestamp: {
          type: 'string',
          description: 'End of the time range to search traces (required when using workflowId). ISO 8601 format, e.g. 2025-01-15T12:00:00Z.',
        },
        pageSize: {
          type: 'number',
          description: 'Number of results per page (default: 20)',
        },
        currentPage: {
          type: 'number',
          description: 'Page number to retrieve (default: 1)',
        },
      },
    },
  },
];

export async function handleExecutionStepsTool(
  args: Record<string, unknown>,
  apiClient: WorkflowApiClient
) {
  const traceId = args.traceId as string | undefined;
  const workflowId = args.workflowId as string | undefined;

  if ((!traceId || traceId.trim() === '') && (!workflowId || workflowId.trim() === '')) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'VALIDATION_ERROR',
            message: 'At least one of traceId or workflowId is required',
          }),
        },
      ],
      isError: true,
    };
  }

  const useTraceId = traceId && traceId.trim() !== '';

  if (!useTraceId) {
    const startTimestamp = args.startTimestamp as string | undefined;
    const endTimestamp = args.endTimestamp as string | undefined;
    if (!startTimestamp || !endTimestamp) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'VALIDATION_ERROR',
              message: 'startTimestamp and endTimestamp are required when querying by workflowId. Provide an ISO 8601 time range, e.g. "2025-01-15T10:00:00Z".',
            }),
          },
        ],
        isError: true,
      };
    }
  }

  const pagination = {
    pageSize: args.pageSize as number | undefined,
    currentPage: args.currentPage as number | undefined,
  };

  try {
    const result = useTraceId
      ? await apiClient.getExecutionStepsByTraceId(traceId!, pagination)
      : await apiClient.getExecutionStepsByWorkflowId(workflowId!, {
          startTimestamp: args.startTimestamp as string,
          endTimestamp: args.endTimestamp as string,
          ...pagination,
        });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return handleApiError(error);
  }
}
