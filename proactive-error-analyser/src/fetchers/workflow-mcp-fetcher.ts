/**
 * Workflow MCP Data Fetcher
 *
 * Fetches runtime errors from the Workflow MCP server. Accepts a client interface
 * for testability — can be backed by direct MCP tool calls or HTTP calls.
 * Handles MCP unavailability gracefully by returning empty snapshots on failure.
 */

import type {
  RuntimeErrorSnapshot,
  RuntimeErrorGroup,
  RuntimeErrorDetail,
} from '../types/index.js';
import type { RuntimeErrorFilter } from '../types/interfaces.js';

// --- Client Interface ---

export interface WorkflowMCPClient {
  getRuntimeErrorCounts(): Promise<RuntimeErrorCountsResponse>;
  getRuntimeErrorDetails(filter: RuntimeErrorFilter): Promise<RuntimeErrorDetailsResponse>;
  searchApplicationLogs(params: LogSearchParams): Promise<LogSearchResponse>;
}

// --- Response Types ---

export interface RuntimeErrorCountsResponse {
  results: Array<{
    definition_name: string;
    sub_type: string | null;
    stage: string;
    state: string;
    count: string;
  }>;
}

export interface RuntimeErrorDetailsResponse {
  results: Array<{
    workflow_id: string;
    trace_id: string;
    rule_description: string;
    resource_entity_id: string;
    details: {
      error: string;
      stepCode: string;
      methodName?: string;
      executionTimeMs?: number;
    };
    timestamp: string;
  }>;
  totalRecords: string;
}

export interface LogSearchParams {
  serviceName: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  searchTerm?: string;
  pageSize?: number;
}

export interface LogSearchResponse {
  entries: Array<Record<string, unknown>>;
  summary: {
    totalMatches: number;
    totalFilesProcessed: number;
  };
}

// --- Public API ---

/**
 * Fetch runtime error counts from the Workflow MCP server and map them to RuntimeErrorGroup[].
 * If the MCP client throws (e.g. server unavailable), logs a warning and returns an empty snapshot.
 */
export async function fetchRuntimeErrors(
  client: WorkflowMCPClient,
): Promise<RuntimeErrorSnapshot> {
  try {
    console.log('[workflow-mcp-fetcher] Fetching runtime error counts...');

    const response = await client.getRuntimeErrorCounts();
    const groups: RuntimeErrorGroup[] = response.results.map((result) => ({
      definitionName: result.definition_name,
      subType: result.sub_type,
      stage: result.stage,
      state: result.state,
      count: parseInt(result.count, 10) || 0,
    }));

    console.log(
      `[workflow-mcp-fetcher] Fetched ${groups.length} error groups (total errors: ${groups.reduce((sum, g) => sum + g.count, 0)})`,
    );

    return {
      errors: groups,
      fetchedAt: new Date(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[workflow-mcp-fetcher] MCP unavailable or failed: ${message}. Returning empty snapshot.`,
    );

    return {
      errors: [],
      fetchedAt: new Date(),
    };
  }
}

/**
 * Fetch detailed runtime error records for a specific error group.
 * If the MCP client throws, logs a warning and returns an empty array.
 */
export async function fetchRuntimeErrorDetails(
  client: WorkflowMCPClient,
  filter: RuntimeErrorFilter,
): Promise<RuntimeErrorDetail[]> {
  try {
    console.log(
      `[workflow-mcp-fetcher] Fetching error details for ${filter.definitionName} [${filter.stage}/${filter.state}]...`,
    );

    const response = await client.getRuntimeErrorDetails(filter);
    const details: RuntimeErrorDetail[] = response.results.map((result) => ({
      workflowId: result.workflow_id,
      traceId: result.trace_id || undefined,
      errorMessage: result.details.error,
      timestamp: new Date(result.timestamp),
      stage: filter.stage,
      state: filter.state,
    }));

    console.log(
      `[workflow-mcp-fetcher] Fetched ${details.length} error details (total records: ${response.totalRecords})`,
    );

    return details;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[workflow-mcp-fetcher] Failed to fetch error details: ${message}. Returning empty array.`,
    );

    return [];
  }
}
