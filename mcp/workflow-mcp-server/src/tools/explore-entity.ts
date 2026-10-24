import { WorkflowApiClient } from '../api-client.js';
import { handleApiError } from '../errors.js';

export const exploreEntityTools = [
  {
    name: 'get_entity',
    description:
      'Retrieve details of any entity by its ID from the workflow system. Returns the full entity object including all fields.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityId: {
          type: 'string',
          description: 'The entity ID to look up',
        },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'get_referenced_entities',
    description:
      'Retrieve all entities referenced by a given entity ID. Useful for exploring relationships between entities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityId: {
          type: 'string',
          description: 'The entity ID whose references to retrieve',
        },
      },
      required: ['entityId'],
    },
  },
];

export async function handleExploreEntityTool(
  toolName: string,
  args: Record<string, unknown>,
  apiClient: WorkflowApiClient
) {
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

  try {
    let result: unknown;

    switch (toolName) {
      case 'get_entity':
        result = await apiClient.getEntity(entityId);
        break;
      case 'get_referenced_entities':
        result = await apiClient.getReferencedEntities(entityId);
        break;
      default:
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'UNKNOWN_TOOL',
                message: `Unknown explore entity tool: ${toolName}`,
              }),
            },
          ],
          isError: true,
        };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return handleApiError(error);
  }
}
