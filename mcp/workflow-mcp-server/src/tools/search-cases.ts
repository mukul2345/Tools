import { WorkflowApiClient } from '../api-client.js';
import { handleApiError } from '../errors.js';

export const searchCasesTools = [
  {
    name: 'search_cases',
    description:
      'Search verification cases by applicant email address. Returns all cases associated with the given email.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        email: {
          type: 'string',
          description: 'Applicant email address to search for',
        },
      },
      required: ['email'],
    },
  },
];

export async function handleSearchCasesTool(
  args: Record<string, unknown>,
  apiClient: WorkflowApiClient
) {
  const email = args.email as string | undefined;

  if (!email || email.trim() === '') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'VALIDATION_ERROR',
            message: 'Missing required parameter: email',
          }),
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await apiClient.searchCases(email);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return handleApiError(error);
  }
}
