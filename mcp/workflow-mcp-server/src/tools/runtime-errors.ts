import { WorkflowApiClient } from '../api-client.js';
import { handleApiError } from '../errors.js';

export const runtimeErrorsTools = [
  {
    name: 'get_runtime_error_counts',
    description:
      'Fetch runtime error counts grouped by definition name, sub-type, stage, and state. No parameters required.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_runtime_error_details',
    description:
      'Fetch paginated runtime error log details filtered by definition name, sub-type, stage, and state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        definitionName: {
          type: 'string',
          description: 'Workflow definition name to filter errors by',
        },
        subType: {
          type: 'string',
          description: 'Error sub-type to filter by',
        },
        stage: {
          type: 'string',
          description: 'Workflow stage to filter by',
        },
        state: {
          type: 'string',
          description: 'Workflow state to filter by',
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
      required: ['definitionName', 'subType', 'stage', 'state'],
    },
  },
];

export async function handleRuntimeErrorsTool(
  toolName: string,
  args: Record<string, unknown>,
  apiClient: WorkflowApiClient
) {
  try {
    switch (toolName) {
      case 'get_runtime_error_counts': {
        const result = await apiClient.getErrorCounts();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_runtime_error_details': {
        const definitionName = args.definitionName as string | undefined;
        const subType = args.subType as string | undefined;
        const stage = args.stage as string | undefined;
        const state = args.state as string | undefined;

        if (!definitionName || !subType || !stage || !state) {
          const missing = [
            !definitionName && 'definitionName',
            !subType && 'subType',
            !stage && 'stage',
            !state && 'state',
          ].filter(Boolean);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'VALIDATION_ERROR',
                  message: `Missing required parameter(s): ${missing.join(', ')}`,
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await apiClient.getErrorDetails({
          definitionName,
          subType,
          stage,
          state,
          pageSize: args.pageSize as number | undefined,
          currentPage: args.currentPage as number | undefined,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'UNKNOWN_TOOL',
                message: `Unknown runtime errors tool: ${toolName}`,
              }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return handleApiError(error);
  }
}
