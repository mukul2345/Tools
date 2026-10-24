import { McpToolError } from "./errors.js";

export interface ApiClientConfig {
  baseUrl: string;
  timeout?: number;
}

export interface PaginationParams {
  pageSize?: number;
  currentPage?: number;
  startTimestamp?: string;
  endTimestamp?: string;
}

export interface ExplorerPaginationParams {
  size?: number;
  lastEvaluatedKey?: unknown;
  sortKey?: string;
  sortDirection?: string;
}

export interface ErrorDetailParams {
  definitionName: string;
  subType: string;
  stage: string;
  state: string;
  pageSize?: number;
  currentPage?: number;
}

export interface WorkflowRunLogParams {
  workflowId: string;
  timestamp?: string;
  stage?: string;
  state?: string;
  pageSize?: number;
  currentPage?: number;
}

export interface AuditTrailFilterParams {
  businessObjectId?: string;
  id?: string;
  startTime?: number;
  endTime?: number;
  size?: number;
  lastEvaluatedKey?: unknown;
}

export interface ApplicationLogSearchParams {
  serviceName: string;
  startTime: string;
  endTime: string;
  searchTerm?: string;
  pageSize?: number;
}

export interface SqlLogQueryParams {
  sqlQuery: string;
  serviceName: string;
  startTime: string;
  endTime: string;
}

const AUTH_SETUP_MESSAGE =
  "Authentication tokens are not configured. Please set the AT_TOKEN and RT_TOKEN environment variables before starting the MCP server.";

export class WorkflowApiClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly atToken: string;
  private readonly rtToken: string;

  constructor(config: ApiClientConfig) {
    if (!config.baseUrl || !config.baseUrl.trim()) {
      throw new Error(
        "WORKFLOW_TOOLS_URL is not configured. Please set it in your environment variables.",
      );
    }

    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error(
        `WORKFLOW_TOOLS_URL "${config.baseUrl}" is not a valid URL. Please provide a valid URL (e.g. https://your-service.example.com).`,
      );
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.timeout = config.timeout ?? 30000;

    const atToken = process.env.AT_TOKEN;
    const rtToken = process.env.RT_TOKEN;

    if (!atToken || !rtToken) {
      throw new Error(AUTH_SETUP_MESSAGE);
    }

    this.atToken = atToken;
    this.rtToken = rtToken;
  }

  private async request(
    path: string,
    queryParams?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Cookie: `at=${this.atToken}; rt=${this.rtToken}`,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new McpToolError(
            `Authentication failed (HTTP ${response.status}). Your AT_TOKEN and/or RT_TOKEN are invalid or expired. Please update them in your environment and restart the MCP server.`,
            "AUTH_ERROR",
            response.status,
          );
        }
        let errorMessage = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          errorMessage =
            ((body as Record<string, unknown>).message as string) ||
            errorMessage;
        } catch {
          // use status text if body parsing fails
        }
        throw new McpToolError(errorMessage, "API_ERROR", response.status);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async requestGetNdjson(
    path: string,
    queryParams?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Cookie: `at=${this.atToken}; rt=${this.rtToken}`,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new McpToolError(
            `Authentication failed (HTTP ${response.status}). Your AT_TOKEN and/or RT_TOKEN are invalid or expired. Please update them in your environment and restart the MCP server.`,
            "AUTH_ERROR",
            response.status,
          );
        }
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errBody = await response.json();
          errorMessage =
            ((errBody as Record<string, unknown>).message as string) ||
            errorMessage;
        } catch {
          /* use status */
        }
        throw new McpToolError(errorMessage, "API_ERROR", response.status);
      }

      return this.collectNdjsonResponse(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async requestPost(path: string, body: unknown): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Cookie: `at=${this.atToken}; rt=${this.rtToken}`,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new McpToolError(
            `Authentication failed (HTTP ${response.status}). Your AT_TOKEN and/or RT_TOKEN are invalid or expired. Please update them in your environment and restart the MCP server.`,
            "AUTH_ERROR",
            response.status,
          );
        }
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errBody = await response.json();
          errorMessage =
            ((errBody as Record<string, unknown>).message as string) ||
            errorMessage;
        } catch {
          /* use status */
        }
        throw new McpToolError(errorMessage, "API_ERROR", response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("ndjson")) {
        return this.collectNdjsonResponse(response);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async collectNdjsonResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const entries: unknown[] = [];
    let summary: unknown = null;

    for (const line of lines) {
      try {
        const chunk = JSON.parse(line) as Record<string, unknown>;
        if (chunk.type === "data") {
          entries.push(chunk.entry);
        } else if (chunk.type === "done") {
          summary = chunk.summary;
        } else if (chunk.type === "sql-done") {
          summary = chunk;
        } else if (chunk.type === "error") {
          throw new McpToolError(
            chunk.message as string,
            chunk.code as string,
            500,
          );
        }
        // skip heartbeat chunks
      } catch (e) {
        if (e instanceof McpToolError) throw e;
        // skip unparseable lines
      }
    }

    return { entries, summary };
  }

  // --- Entity Explorer ---

  async getEntity(entityId: string): Promise<unknown> {
    return this.request(`/explore/entity/${encodeURIComponent(entityId)}`);
  }

  async getReferencedEntities(entityId: string): Promise<unknown> {
    return this.request(
      `/explore/entity/${encodeURIComponent(entityId)}/reference`,
    );
  }

  // --- Entity Filter Query ---

  async queryEntities(
    entityType: string,
    filter?: Record<string, string>,
    pagination?: ExplorerPaginationParams,
  ): Promise<unknown> {
    const queryParams: Record<string, string> = { ...filter };

    if (pagination?.size !== undefined) {
      queryParams.size = String(pagination.size);
    }
    if (pagination?.lastEvaluatedKey !== undefined) {
      queryParams.lastVal = JSON.stringify(pagination.lastEvaluatedKey);
    }
    if (pagination?.sortKey) {
      queryParams.sortKey = pagination.sortKey;
    }
    if (pagination?.sortDirection) {
      queryParams.sortType = pagination.sortDirection;
    }

    return this.request(
      `/explore/${encodeURIComponent(entityType)}/filter`,
      queryParams,
    );
  }

  // --- Runtime Errors ---

  async getErrorCounts(): Promise<unknown> {
    return this.request("/events/errorLogCounts");
  }

  async getErrorDetails(params: ErrorDetailParams): Promise<unknown> {
    const queryParams: Record<string, string> = {
      definitionName: params.definitionName,
      subType: params.subType,
      stage: params.stage,
      state: params.state,
    };
    if (params.pageSize !== undefined)
      queryParams.pageSize = String(params.pageSize);
    if (params.currentPage !== undefined)
      queryParams.currentPage = String(params.currentPage);

    return this.request("/events/errorLogsDetails", queryParams);
  }

  // --- Search Cases ---

  async searchCases(email: string): Promise<unknown> {
    return this.request("/search-cases/", { email });
  }

  // --- Execution Steps ---

  async getExecutionStepsByTraceId(
    traceId: string,
    pagination?: PaginationParams,
  ): Promise<unknown> {
    const queryParams: Record<string, string> = {};
    if (pagination?.pageSize !== undefined)
      queryParams.pageSize = String(pagination.pageSize);
    if (pagination?.currentPage !== undefined)
      queryParams.currentPage = String(pagination.currentPage);

    return this.request(
      `/events/execution-steps/${encodeURIComponent(traceId)}`,
      queryParams,
    );
  }

  async getExecutionStepsByWorkflowId(
    workflowId: string,
    pagination?: PaginationParams,
  ): Promise<unknown> {
    const queryParams: Record<string, string> = {};
    if (pagination?.startTimestamp)
      queryParams.startTimestamp = pagination.startTimestamp;
    if (pagination?.endTimestamp)
      queryParams.endTimestamp = pagination.endTimestamp;
    if (pagination?.pageSize !== undefined)
      queryParams.pageSize = String(pagination.pageSize);
    if (pagination?.currentPage !== undefined)
      queryParams.currentPage = String(pagination.currentPage);

    return this.request(
      `/events/execution-steps/traces/${encodeURIComponent(workflowId)}`,
      queryParams,
    );
  }

  // --- Audit Trail ---

  async queryAuditTrail(params: AuditTrailFilterParams): Promise<unknown> {
    const queryParams: Record<string, string> = {};

    if (params.businessObjectId)
      queryParams.businessObjectId = params.businessObjectId;
    if (params.id) queryParams.id = params.id;
    if (params.startTime !== undefined)
      queryParams.startTime = String(params.startTime);
    if (params.endTime !== undefined)
      queryParams.endTime = String(params.endTime);
    if (params.size !== undefined) queryParams.size = String(params.size);
    if (params.lastEvaluatedKey !== undefined) {
      queryParams.lastVal = JSON.stringify(params.lastEvaluatedKey);
    }

    return this.request("/explore/AuditTrail/filter", queryParams);
  }

  // --- Workflow Run Logs ---

  async getWorkflowRunEvents(
    entityId: string,
    pagination?: PaginationParams,
  ): Promise<unknown> {
    const queryParams: Record<string, string> = {};
    if (pagination?.pageSize !== undefined)
      queryParams.pageSize = String(pagination.pageSize);
    if (pagination?.currentPage !== undefined)
      queryParams.currentPage = String(pagination.currentPage);

    return this.request(
      `/events/workflowRunsAllById/${encodeURIComponent(entityId)}`,
      queryParams,
    );
  }

  async getWorkflowRunLogs(params: WorkflowRunLogParams): Promise<unknown> {
    const queryParams: Record<string, string> = {};
    if (params.timestamp) queryParams.timestamp = params.timestamp;
    if (params.stage) queryParams.stage = params.stage;
    if (params.state) queryParams.state = params.state;
    if (params.pageSize !== undefined)
      queryParams.pageSize = String(params.pageSize);
    if (params.currentPage !== undefined)
      queryParams.currentPage = String(params.currentPage);

    return this.request(
      `/events/workflowRun/${encodeURIComponent(params.workflowId)}`,
      queryParams,
    );
  }

  async getRootWorkflowDetails(rootId: string): Promise<unknown> {
    return this.request(`/events/workflows/${encodeURIComponent(rootId)}`);
  }

  async getChildWorkflows(workflowId: string): Promise<unknown> {
    return this.request(`/events/${encodeURIComponent(workflowId)}/childs`);
  }

  // --- Application Logs ---

  async searchApplicationLogs(
    params: ApplicationLogSearchParams,
  ): Promise<unknown> {
    const queryParams: Record<string, string> = {
      serviceName: params.serviceName,
      startTime: params.startTime,
      endTime: params.endTime,
    };
    if (params.searchTerm) queryParams.searchTerm = params.searchTerm;
    if (params.pageSize !== undefined)
      queryParams.size = String(params.pageSize);

    return this.requestGetNdjson("/application-logs/search", queryParams);
  }

  async getSqlQueryTemplates(): Promise<unknown> {
    return this.request("/application-logs/sql-query/templates");
  }

  async executeSqlLogQuery(params: SqlLogQueryParams): Promise<unknown> {
    // The controller expects sqlQuery as Base64-encoded
    const encodedSql = Buffer.from(params.sqlQuery, "utf-8").toString("base64");
    return this.requestPost("/application-logs/sql-query", {
      sqlQuery: encodedSql,
      serviceName: params.serviceName,
      startTime: params.startTime,
      endTime: params.endTime,
    });
  }
}
