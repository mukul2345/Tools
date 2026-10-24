import { WorkflowApiClient } from '../api-client.js';
import { handleApiError } from '../errors.js';

export const workflowRunLogsTools = [
  {
    name: 'get_workflow_run_events',
    description:
      'Fetch all workflow run events for a given workflow ID with pagination support. ' +
      'Returns a list of all run events associated with the workflow across all its runs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityId: {
          type: 'string',
          description: 'Workflow ID to fetch all run events for',
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
      required: ['entityId'],
    },
  },
  {
    name: 'get_workflow_run_logs',
    description:
      'Fetch workflow run logs for a specific workflow run, identified by workflowId + timestamp + stage + state. ' +
      'These four parameters together pinpoint the exact starting event of a workflow run in the database. ' +
      'To get valid values for timestamp, stage, and state, first call get_execution_steps with the workflowId ' +
      'to retrieve execution traces, then pick the timestamp, stage, and state from the desired trace entry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflowId: {
          type: 'string',
          description: 'Workflow ID to fetch run logs for',
        },
        timestamp: {
          type: 'string',
          description:
            'Timestamp of the starting event for this workflow run (required). ' +
            'Obtain this from get_execution_steps results (first_timestamp field).',
        },
        stage: {
          type: 'string',
          description:
            'Stage of the starting event for this workflow run (required). ' +
            'Obtain this from get_execution_steps results.',
        },
        state: {
          type: 'string',
          description:
            'State of the starting event for this workflow run (required). ' +
            'Obtain this from get_execution_steps results.',
        },
        pageSize: {
          type: 'number',
          description: 'Number of results per page (default: 100)',
        },
        currentPage: {
          type: 'number',
          description: 'Page number to retrieve (default: 1)',
        },
      },
      required: ['workflowId', 'timestamp', 'stage', 'state'],
    },
  },
  {
    name: 'get_root_workflow',
    description:
      'Fetch workflow details by workflow ID. Use this to look up the full details of any workflow, ' +
      'including root/parent workflows. Useful for inspecting a workflow\'s definition, stage, state, and metadata.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rootId: {
          type: 'string',
          description: 'Workflow ID to look up',
        },
      },
      required: ['rootId'],
    },
  },
  {
    name: 'get_child_workflows',
    description:
      'Fetch all child workflow details for a given parent workflow ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflowId: {
          type: 'string',
          description: 'Parent workflow ID to fetch child workflows for',
        },
      },
      required: ['workflowId'],
    },
  },
];

export async function handleWorkflowRunLogsTool(
  toolName: string,
  args: Record<string, unknown>,
  apiClient: WorkflowApiClient
) {
  try {
    switch (toolName) {
      case 'get_workflow_run_events': {
        const entityId = args.entityId as string | undefined;
        if (!entityId || entityId.trim() === '') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'VALIDATION_ERROR',
                  message: 'Missing required parameter: entityId',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await apiClient.getWorkflowRunEvents(entityId, {
          pageSize: args.pageSize as number | undefined,
          currentPage: args.currentPage as number | undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_workflow_run_logs': {
        const workflowId = args.workflowId as string | undefined;
        const timestamp = args.timestamp as string | undefined;
        const stage = args.stage as string | undefined;
        const state = args.state as string | undefined;

        const missingParams = [
          !workflowId && 'workflowId',
          !timestamp && 'timestamp',
          !stage && 'stage',
          !state && 'state',
        ].filter(Boolean);

        if (missingParams.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'VALIDATION_ERROR',
                  message: `Missing required parameters: ${missingParams.join(', ')}. ` +
                    'Call get_execution_steps with the workflowId first to retrieve valid timestamp, stage, and state values.',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await apiClient.getWorkflowRunLogs({
          workflowId: workflowId!,
          timestamp,
          stage,
          state,
          pageSize: args.pageSize as number | undefined,
          currentPage: args.currentPage as number | undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_root_workflow': {
        const rootId = args.rootId as string | undefined;
        if (!rootId || rootId.trim() === '') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'VALIDATION_ERROR',
                  message: 'Missing required parameter: rootId',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await apiClient.getRootWorkflowDetails(rootId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_child_workflows': {
        const workflowId = args.workflowId as string | undefined;
        if (!workflowId || workflowId.trim() === '') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'VALIDATION_ERROR',
                  message: 'Missing required parameter: workflowId',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await apiClient.getChildWorkflows(workflowId);
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
                message: `Unknown workflow run logs tool: ${toolName}`,
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
