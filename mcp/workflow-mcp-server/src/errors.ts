export class McpToolError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly upstreamStatus?: number
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export interface McpToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function handleApiError(error: unknown): McpToolResponse {
  if (error instanceof McpToolError) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error.code,
            message: error.message,
            ...(error.upstreamStatus !== undefined && { upstreamStatus: error.upstreamStatus }),
          }),
        },
      ],
      isError: true,
    };
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes('timeout') || message.includes('aborted')) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'TIMEOUT_ERROR',
              message: `Request timed out: ${error.message}`,
            }),
          },
        ],
        isError: true,
      };
    }

    if (
      message.includes('econnrefused') ||
      message.includes('enotfound') ||
      message.includes('fetch failed') ||
      message.includes('network')
    ) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'CONNECTION_ERROR',
              message:
                'Failed to connect to workflow-tools-service. Ensure the service is running.',
            }),
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'UNKNOWN_ERROR',
          message: error instanceof Error ? error.message : 'An unknown error occurred',
        }),
      },
    ],
    isError: true,
  };
}
