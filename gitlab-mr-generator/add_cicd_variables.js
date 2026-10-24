#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const YAML = require("yaml");
const minimist = require("minimist");

// ---------- helpers ----------
function requiredEnv(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v == null) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

function loadYaml(p) {
  const text = fs.readFileSync(p, "utf-8");
  return YAML.parse(text);
}

function encodeProjectPath(projectPath) {
  return encodeURIComponent(projectPath);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) break;
        try {
          results[idx] = await fn(items[idx], idx);
        } catch (e) {
          results[idx] = { error: e };
        }
      }
    });
  await Promise.all(workers);
  return results;
}

/** GitLab may return 409 or 400 with message.key "already been taken" on duplicate create. */
function isVariableKeyConflictError(err) {
  if (!axios.isAxiosError?.(err)) return false;
  const status = err.response?.status;
  if (status === 409) return true;
  if (status !== 400) return false;
  const keyMsgs = err.response?.data?.message?.key;
  if (!Array.isArray(keyMsgs)) return false;
  return keyMsgs.some((m) =>
    String(m).toLowerCase().includes("already been taken")
  );
}

// ---------- GitLab client ----------
class GitLab {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.api = `${this.baseUrl}/api/v4`;
    this.http = axios.create({
      baseURL: this.api,
      timeout: 30000,
      headers: { "PRIVATE-TOKEN": token },
      validateStatus: (s) => s >= 200 && s < 300,
    });
  }

  async _get(url, params) {
    const res = await this.http.get(url, { params });
    return res.data;
  }

  async _post(url, data) {
    const res = await this.http.post(url, data, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });
    return res.data;
  }

  async _put(url, data) {
    const res = await this.http.put(url, data, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });
    return res.data;
  }

  async _delete(url) {
    const res = await this.http.delete(url, { timeout: 60000 });
    return res.data;
  }

  async getProject(projectPathOrId) {
    if (/^\d+$/.test(String(projectPathOrId))) {
      return this._get(`/projects/${projectPathOrId}`);
    }
    const encoded = encodeProjectPath(projectPathOrId);
    return this._get(`/projects/${encoded}`);
  }

  async listProjectVariables(projectId) {
    const perPage = 100;
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await this._get(`/projects/${projectId}/variables`, {
        per_page: perPage,
        page,
      });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < perPage) break;
    }
    return all;
  }

  async getProjectVariable(projectId, key, environmentScope = "*") {
    try {
      const encodedKey = encodeURIComponent(key);
      const params = { filter: { environment_scope: environmentScope } };
      return await this._get(
        `/projects/${projectId}/variables/${encodedKey}`,
        params
      );
    } catch (e) {
      if (axios.isAxiosError?.(e) && e.response?.status === 404) {
        return null;
      }
      throw e;
    }
  }

  async createProjectVariable(projectId, variable) {
    return this._post(`/projects/${projectId}/variables`, variable);
  }

  async updateProjectVariable(projectId, key, variable) {
    const encodedKey = encodeURIComponent(key);
    const params =
      variable.environment_scope && variable.environment_scope !== "*"
        ? { filter: { environment_scope: variable.environment_scope } }
        : {};

    const url = `/projects/${projectId}/variables/${encodedKey}`;
    const fullUrl =
      Object.keys(params).length > 0
        ? `${url}?${new URLSearchParams({
            "filter[environment_scope]": variable.environment_scope,
          }).toString()}`
        : url;

    const res = await this.http.put(fullUrl, variable, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });
    return res.data;
  }

  async deleteProjectVariable(projectId, key) {
    const encodedKey = encodeURIComponent(key);
    return this._delete(`/projects/${projectId}/variables/${encodedKey}`);
  }
}

// ---------- main ----------
(async () => {
  const argv = minimist(process.argv.slice(2));
  if (!argv.config && !argv.c) {
    console.error(
      "Usage: node add_cicd_variables.js --config variables.yml [--dry-run] [--concurrency 4] [--update] [--delete]"
    );
    console.error("\nOptions:");
    console.error("  --config, -c       Path to YAML configuration file");
    console.error("  --dry-run          Preview changes without applying them");
    console.error(
      "  --concurrency      Number of concurrent operations (default: 4)"
    );
    console.error(
      "  --update           Update existing variables (default: skip existing)"
    );
    console.error(
      "  --delete           Delete specified variables instead of creating/updating"
    );
    process.exit(2);
  }

  const cfgPath = path.resolve(argv.config || argv.c);
  const cfg = loadYaml(cfgPath);

  const baseUrl = requiredEnv("GITLAB_BASE_URL", "https://gitlab.com");
  const token = requiredEnv("GITLAB_TOKEN");
  const gl = new GitLab(baseUrl, token);

  const dryRun = Boolean(argv["dry-run"] || argv.dryrun);
  const concurrency = Number(argv.concurrency || 4);
  const updateExisting = Boolean(argv.update);
  const deleteMode = Boolean(argv.delete);

  // Validate configuration
  if (!cfg.projects || !Array.isArray(cfg.projects)) {
    console.error("Config must contain 'projects: [...]' array.");
    process.exit(2);
  }

  if (!cfg.variables || !Array.isArray(cfg.variables)) {
    console.error("Config must contain 'variables: [...]' array.");
    process.exit(2);
  }

  // Global defaults for variables
  const globalDefaults = {
    variable_type: cfg.variable_type || "env_var", // env_var or file
    protected: cfg.protected !== undefined ? cfg.protected : false,
    masked: cfg.masked !== undefined ? cfg.masked : false,
    raw: cfg.raw !== undefined ? cfg.raw : false,
    environment_scope: cfg.environment_scope || "*", // can be string or array
  };

  // Helper to normalize environment_scope to array
  const normalizeScopes = (scope) => {
    if (Array.isArray(scope)) return scope;
    return [scope || "*"];
  };

  // Expand variables with multiple environment_scopes
  const expandedVariables = [];
  for (const variable of cfg.variables) {
    const scopes = normalizeScopes(
      variable.environment_scope ?? globalDefaults.environment_scope
    );

    for (const scope of scopes) {
      expandedVariables.push({
        ...variable,
        environment_scope: scope,
      });
    }
  }

  console.log(
    `\nProcessing ${cfg.projects.length} projects with ${cfg.variables.length} variables (${expandedVariables.length} after scope expansion)...`
  );

  if (deleteMode) {
    console.log("Mode: DELETE");
  } else if (updateExisting) {
    console.log("Mode: CREATE or UPDATE");
  } else {
    console.log("Mode: CREATE (skip existing)");
  }
  if (dryRun) {
    console.log("DRY RUN - No changes will be made\n");
  }

  const results = await mapLimit(cfg.projects, concurrency, async (p) => {
    const projectPath = p.project;
    if (!projectPath) {
      return {
        project: "(missing)",
        status: "error",
        error: "Missing 'project' key",
        variables: [],
      };
    }

    let projectInfo, projectId;
    try {
      projectInfo = await gl.getProject(projectPath);
      projectId = projectInfo.id;
    } catch (e) {
      return {
        project: projectPath,
        status: "error",
        error: `Project lookup failed: ${e.message || e}`,
        variables: [],
      };
    }

    let allProjectVariables = [];
    if (!deleteMode) {
      try {
        allProjectVariables = await gl.listProjectVariables(projectId);
      } catch (e) {
        return {
          project: projectPath,
          status: "error",
          error: `Listing variables failed: ${e.message || e}`,
          variables: [],
        };
      }
    }

    const variableResults = [];

    for (const variable of expandedVariables) {
      if (!variable.key) {
        variableResults.push({
          key: "(missing)",
          status: "error",
          error: "Variable missing 'key' field",
        });
        continue;
      }

      // Merge per-variable settings with global defaults
      const varConfig = {
        key: variable.key,
        value: variable.value ?? "",
        variable_type: variable.variable_type ?? globalDefaults.variable_type,
        protected: variable.protected ?? globalDefaults.protected,
        masked: variable.masked ?? globalDefaults.masked,
        raw: variable.raw ?? globalDefaults.raw,
        environment_scope:
          variable.environment_scope ?? globalDefaults.environment_scope,
      };

      if (deleteMode) {
        // Delete mode
        if (dryRun) {
          variableResults.push({
            key: variable.key,
            status: "dry-run",
            action: "delete",
          });
        } else {
          try {
            await gl.deleteProjectVariable(projectId, variable.key);
            variableResults.push({
              key: variable.key,
              status: "deleted",
              action: "delete",
            });
          } catch (e) {
            if (axios.isAxiosError?.(e) && e.response?.status === 404) {
              variableResults.push({
                key: variable.key,
                status: "not-found",
                action: "delete",
              });
            } else {
              variableResults.push({
                key: variable.key,
                status: "error",
                action: "delete",
                error: e.message || e,
              });
            }
          }
        }
      } else {
        // Create or Update mode
        try {
          const existing =
            allProjectVariables.find(
              (v) =>
                v.key === variable.key &&
                v.environment_scope === varConfig.environment_scope
            ) ?? null;

          if (existing && !updateExisting) {
            variableResults.push({
              key: variable.key,
              environment_scope: varConfig.environment_scope,
              status: "skipped",
              reason: "exists",
              action: "none",
            });
          } else if (existing && updateExisting) {
            if (dryRun) {
              variableResults.push({
                key: variable.key,
                environment_scope: varConfig.environment_scope,
                status: "dry-run",
                action: "update",
                config: varConfig,
              });
            } else {
              await gl.updateProjectVariable(
                projectId,
                variable.key,
                varConfig
              );
              variableResults.push({
                key: variable.key,
                environment_scope: varConfig.environment_scope,
                status: "updated",
                action: "update",
              });
            }
          } else {
            if (dryRun) {
              variableResults.push({
                key: variable.key,
                environment_scope: varConfig.environment_scope,
                status: "dry-run",
                action: "create",
                config: varConfig,
              });
            } else {
              try {
                await gl.createProjectVariable(projectId, varConfig);
                variableResults.push({
                  key: variable.key,
                  environment_scope: varConfig.environment_scope,
                  status: "created",
                  action: "create",
                });
              } catch (createError) {
                // Duplicate key: GitLab returns 409 or 400 ("already been taken")
                if (isVariableKeyConflictError(createError)) {
                  // Try to update instead
                  try {
                    await gl.updateProjectVariable(
                      projectId,
                      variable.key,
                      varConfig
                    );
                    variableResults.push({
                      key: variable.key,
                      environment_scope: varConfig.environment_scope,
                      status: "updated",
                      action: "update",
                      note: "existed, updated instead",
                    });
                  } catch (updateError) {
                    throw createError; // Throw original error if update also fails
                  }
                } else {
                  throw createError;
                }
              }
            }
          }
        } catch (e) {
          const errorDetail =
            axios.isAxiosError?.(e) && e.response
              ? `${e.response.status}: ${JSON.stringify(e.response.data)}`
              : e.message || e;
          variableResults.push({
            key: variable.key,
            environment_scope: varConfig.environment_scope,
            status: "error",
            error: errorDetail,
          });
        }
      }
    }

    return {
      project: projectPath,
      status: "processed",
      variables: variableResults,
    };
  });

  // Summary
  let totalCreated = 0,
    totalUpdated = 0,
    totalDeleted = 0,
    totalSkipped = 0,
    totalErrors = 0,
    totalDryRun = 0,
    totalNotFound = 0;

  console.log("\n" + "=".repeat(80));
  console.log("RESULTS");
  console.log("=".repeat(80) + "\n");

  for (const r of results) {
    if (!r) continue;

    console.log(`\n${r.project}`);
    console.log("-".repeat(r.project.length));

    if (r.status === "error") {
      totalErrors++;
      console.error(`  [ERROR] ${r.error}`);
    } else {
      for (const v of r.variables) {
        const keyLabel =
          v.environment_scope && v.environment_scope !== "*"
            ? `${v.key} [${v.environment_scope}]`
            : v.key;

        if (v.status === "created") {
          totalCreated++;
          console.log(`  ✓ [CREATED] ${keyLabel}`);
        } else if (v.status === "updated") {
          totalUpdated++;
          const note = v.note ? ` (${v.note})` : "";
          console.log(`  ✓ [UPDATED] ${keyLabel}${note}`);
        } else if (v.status === "deleted") {
          totalDeleted++;
          console.log(`  ✓ [DELETED] ${keyLabel}`);
        } else if (v.status === "skipped") {
          totalSkipped++;
          console.log(`  - [SKIPPED] ${keyLabel} (${v.reason})`);
        } else if (v.status === "not-found") {
          totalNotFound++;
          console.log(`  - [NOT FOUND] ${keyLabel}`);
        } else if (v.status === "dry-run") {
          totalDryRun++;
          console.log(`  • [DRY-RUN] ${keyLabel} (${v.action})`);
          if (v.config) {
            console.log(
              `    ${JSON.stringify(v.config, null, 2)
                .split("\n")
                .join("\n    ")}`
            );
          }
        } else if (v.status === "error") {
          totalErrors++;
          console.error(`  ✗ [ERROR] ${keyLabel}: ${v.error}`);
        }
      }
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(`Projects processed: ${results.length}`);
  console.log(`Variables created:  ${totalCreated}`);
  console.log(`Variables updated:  ${totalUpdated}`);
  console.log(`Variables deleted:  ${totalDeleted}`);
  console.log(`Variables skipped:  ${totalSkipped}`);
  console.log(`Variables not found: ${totalNotFound}`);
  console.log(`Dry-run operations: ${totalDryRun}`);
  console.log(`Errors:            ${totalErrors}`);
  console.log("=".repeat(80) + "\n");

  if (totalErrors > 0) process.exit(1);
})();
