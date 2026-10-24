import { WorkflowApiClient } from '../api-client.js';
import { handleApiError } from '../errors.js';

export const auditTrailTools = [
  {
    name: 'query_audit_trail',
    description:
      'Query audit trail records by business object ID, record ID, and/or time range. Returns paginated audit records showing create, update, and delete operations on business objects.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        businessObjectId: {
          type: 'string',
          description: 'Business object ID to filter audit records by',
        },
        id: {
          type: 'string',
          description: 'Specific audit record ID to look up',
        },
        startTime: {
          type: 'string',
          description: 'Start of time range filter in ISO 8601 format (e.g., 2025-01-15T10:00:00Z)',
        },
        endTime: {
          type: 'string',
          description: 'End of time range filter in ISO 8601 format (e.g., 2025-01-15T12:00:00Z)',
        },
        pageSize: {
          type: 'number',
          description: 'Number of results per page (default: 20)',
        },
        lastEvaluatedKey: {
          type: 'object',
          description: 'Pagination cursor from a previous response to fetch the next page',
        },
      },
    },
  },
];

function toEpochMs(isoString: string): number {
  const ms = new Date(isoString).getTime();
  if (isNaN(ms)) {
    throw new Error(`Invalid ISO 8601 timestamp: ${isoString}`);
  }
  return ms;
}

export async function handleAuditTrailTool(
  args: Record<string, unknown>,
  apiClient: WorkflowApiClient
) {
  try {
    const startTimeStr = args.startTime as string | undefined;
    const endTimeStr = args.endTime as string | undefined;

    let startTime: number | undefined;
    let endTime: number | undefined;

    if (startTimeStr) {
      startTime = toEpochMs(startTimeStr);
    }
    if (endTimeStr) {
      endTime = toEpochMs(endTimeStr);
    }

    const result = await apiClient.queryAuditTrail({
      businessObjectId: args.businessObjectId as string | undefined,
      id: args.id as string | undefined,
      startTime,
      endTime,
      size: args.pageSize as number | undefined,
      lastEvaluatedKey: args.lastEvaluatedKey as unknown,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ISO 8601 timestamp')) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'VALIDATION_ERROR',
              message: error.message,
            }),
          },
        ],
        isError: true,
      };
    }
    return handleApiError(error);
  }
}
