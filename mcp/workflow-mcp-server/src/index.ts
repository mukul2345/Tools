#!/usr/bin/env node
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../.env") });
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WorkflowApiClient } from "./api-client.js";
import {
  exploreEntityTools,
  handleExploreEntityTool,
} from "./tools/explore-entity.js";
import {
  queryEntitiesTools,
  handleQueryEntitiesTool,
} from "./tools/query-entities.js";
import {
  runtimeErrorsTools,
  handleRuntimeErrorsTool,
} from "./tools/runtime-errors.js";
import {
  searchCasesTools,
  handleSearchCasesTool,
} from "./tools/search-cases.js";
import {
  executionStepsTools,
  handleExecutionStepsTool,
} from "./tools/execution-steps.js";
import { auditTrailTools, handleAuditTrailTool } from "./tools/audit-trail.js";
import {
  workflowRunLogsTools,
  handleWorkflowRunLogsTool,
} from "./tools/workflow-run-logs.js";
import {
  applicationLogsTools,
  handleApplicationLogsTool,
} from "./tools/application-logs.js";

const TOOLS = [
  ...exploreEntityTools,
  ...queryEntitiesTools,
  ...runtimeErrorsTools,
  ...searchCasesTools,
  ...executionStepsTools,
  ...auditTrailTools,
  ...workflowRunLogsTools,
  ...applicationLogsTools,
];

async function main() {
  const baseUrl = process.env.WORKFLOW_TOOLS_URL ?? "";
  const apiClient = new WorkflowApiClient({
    baseUrl,
  });

  const server = new Server(
    { name: "workflow-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args ?? {}) as Record<string, unknown>;

    // Entity exploration tools
    if (name === "get_entity" || name === "get_referenced_entities") {
      return handleExploreEntityTool(name, toolArgs, apiClient);
    }

    // Entity filter query tool
    if (name === "query_entities") {
      return handleQueryEntitiesTool(toolArgs, apiClient);
    }

    // Runtime errors tools
    if (
      name === "get_runtime_error_counts" ||
      name === "get_runtime_error_details"
    ) {
      return handleRuntimeErrorsTool(name, toolArgs, apiClient);
    }

    // Search cases tool
    if (name === "search_cases") {
      return handleSearchCasesTool(toolArgs, apiClient);
    }

    // Execution steps tool
    if (name === "get_execution_steps") {
      return handleExecutionStepsTool(toolArgs, apiClient);
    }

    // Audit trail tool
    if (name === "query_audit_trail") {
      return handleAuditTrailTool(toolArgs, apiClient);
    }

    // Workflow run logs tools
    if (
      name === "get_workflow_run_events" ||
      name === "get_workflow_run_logs" ||
      name === "get_root_workflow" ||
      name === "get_child_workflows"
    ) {
      return handleWorkflowRunLogsTool(name, toolArgs, apiClient);
    }

    // Application logs tools
    if (
      name === "search_application_logs" ||
      name === "get_sql_query_templates" ||
      name === "execute_sql_log_query"
    ) {
      return handleApplicationLogsTool(name, toolArgs, apiClient);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "UNKNOWN_TOOL",
            message: `Unknown tool: ${name}`,
          }),
        },
      ],
      isError: true,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
