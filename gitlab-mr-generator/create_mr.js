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
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function renderTitle(cfgTitle, template, ctx) {
  if (cfgTitle) return cfgTitle;
  if (!template)
    throw new Error("Missing 'title' or 'title_template' in config.");
  return template
    .replace(/\{repo\}/g, ctx.repo)
    .replace(/\{project\}/g, ctx.project)
    .replace(/\{source\}/g, ctx.source)
    .replace(/\{target\}/g, ctx.target)
    .replace(/\{date\}/g, ctx.date || todayISO());
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
    this.emailIdCache = new Map(); // email -> userId
    this.usernameIdCache = new Map(); // username -> userId
    this.groupMembersCache = new Map(); // groupPath -> array
  }

  async _get(url, params) {
    const res = await this.http.get(url, { params });
    return res.data;
  }
  async _post(url, data, asForm = true) {
    if (asForm) {
      const form = new URLSearchParams();
      Object.entries(data).forEach(([k, v]) => {
        if (Array.isArray(v)) {
          v.forEach((val) => form.append(`${k}[]`, String(val)));
        } else if (v !== undefined && v !== null) {
          form.append(k, String(v));
        }
      });
      const res = await this.http.post(url, form, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 60000,
      });
      return res.data;
    }
    const res = await this.http.post(url, data, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });
    return res.data;
  }

  async getProject(projectPathOrId) {
    if (/^\d+$/.test(String(projectPathOrId))) {
      return this._get(`/projects/${projectPathOrId}`);
    }
    const encoded = encodeProjectPath(projectPathOrId);
    return this._get(`/projects/${encoded}`);
  }

  async searchUsers(query, perPage = 50) {
    return this._get(`/users`, { search: query, per_page: perPage });
  }
  async getUsersByUsername(username) {
    if (this.usernameIdCache.has(username))
      return [{ id: this.usernameIdCache.get(username) }];
    const users = await this._get(`/users`, { username });
    if (users?.[0]?.id) this.usernameIdCache.set(username, users[0].id);
    return users;
  }
  async listGroupMembersAll(groupPath) {
    if (!groupPath) return [];
    if (this.groupMembersCache.has(groupPath))
      return this.groupMembersCache.get(groupPath);

    const encoded = encodeURIComponent(groupPath);
    let page = 1;
    const out = [];
    while (true) {
      try {
        const chunk = await this._get(`/groups/${encoded}/members/all`, {
          per_page: 100,
          page,
        });
        if (!Array.isArray(chunk) || chunk.length === 0) break;
        out.push(...chunk);
        page += 1;
      } catch {
        break;
      }
    }
    this.groupMembersCache.set(groupPath, out);
    return out;
  }

  async findUserIdByEmail(email, { groupPath, overrides, failOnError }) {
    const key = email.toLowerCase();
    if (this.emailIdCache.has(key)) return this.emailIdCache.get(key);

    // 1) explicit username override
    if (overrides && overrides[email]) {
      const users = await this.getUsersByUsername(overrides[email]);
      if (users?.length) {
        this.emailIdCache.set(key, users[0].id);
        return users[0].id;
      }
    }

    // 2) /users?search= (public_email exact)
    const candidates = await this.searchUsers(email);
    const exact = candidates.filter(
      (u) => (u.public_email || "").toLowerCase() === key
    );
    if (exact.length) {
      this.emailIdCache.set(key, exact[0].id);
      return exact[0].id;
    }

    // 3) group members (best-effort; visibility varies)
    const gm = (await this.listGroupMembersAll(groupPath)).find((m) => {
      const e = (m.email || m.public_email || "").toLowerCase();
      return e === key;
    });
    if (gm) {
      this.emailIdCache.set(key, gm.id);
      return gm.id;
    }

    // 4) heuristic: single user in search
    if (candidates.length === 1) {
      this.emailIdCache.set(key, candidates[0].id);
      return candidates[0].id;
    }

    const msg = `Could not resolve '${email}' to a GitLab user ID. Add 'email_username_overrides' or use usernames/IDs.`;
    if (failOnError) throw new Error(msg);
    console.warn("WARN:", msg);
    return null;
  }

  async findUserIdsByEmails(emails, opts) {
    const ids = [];
    for (const email of emails || []) {
      const id = await this.findUserIdByEmail(email, opts);
      if (id != null) ids.push(id);
    }
    return ids;
  }

  async findExistingOpenMR(projectId, sourceBranch, targetBranch) {
    const mrs = await this._get(`/projects/${projectId}/merge_requests`, {
      state: "opened",
      source_branch: sourceBranch,
      target_branch: targetBranch,
      per_page: 50,
    });
    return Array.isArray(mrs) && mrs.length ? mrs[0] : null;
  }

  async compare(projectId, fromRef, toRef) {
    // from = target, to = source (commits to be merged)
    return this._get(`/projects/${projectId}/repository/compare`, {
      from: fromRef,
      to: toRef,
      straight: false,
    });
  }

  async createMergeRequest(projectId, payload) {
    return this._post(`/projects/${projectId}/merge_requests`, payload, true);
  }
}

// ---------- main ----------
(async () => {
  const argv = minimist(process.argv.slice(2));
  if (!argv.config && !argv.c) {
    console.error(
      "Usage: node create_mrs.js --config mrs.yml [--dry-run] [--concurrency 4] [--project p --source s --target t]"
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

  // Determine the workload: single vs batch
  const forcedSingle = argv.project || cfg.project;
  let projects = [];
  if (argv.project) {
    projects = [
      {
        project: argv.project,
        source_branch: argv.source || cfg.source_branch,
        target_branch: argv.target || cfg.target_branch,
        // allow CLI to still use cfg.title or template
        title: cfg.title,
      },
    ];
  } else if (
    cfg.projects &&
    Array.isArray(cfg.projects) &&
    cfg.projects.length
  ) {
    projects = cfg.projects;
  } else if (cfg.project) {
    projects = [cfg];
  } else {
    console.error("Config must contain either 'project' or 'projects: [...]'.");
    process.exit(2);
  }

  const globalDefaults = {
    source_branch: cfg.source_branch,
    target_branch: cfg.target_branch,
    title: cfg.title,
    title_template: cfg.title_template,
    description: cfg.description,
    labels: cfg.labels || [],
    remove_source_branch: cfg.remove_source_branch,
    squash: cfg.squash,
    draft: cfg.draft,
    assignee_emails: cfg.assignee_emails || [],
    reviewer_emails: cfg.reviewer_emails || [],
    group_path: cfg.group_path,
    email_username_overrides: cfg.email_username_overrides || {},
    fail_on_user_lookup_error: Boolean(cfg.fail_on_user_lookup_error),
    skip_when_no_diff: cfg.skip_when_no_diff !== false, // default true
  };

  const results = await mapLimit(projects, concurrency, async (p) => {
    const projectPath = p.project;
    if (!projectPath)
      return {
        project: "(missing)",
        status: "error",
        error: "Missing 'project' key",
      };

    // Effective values (per-project override -> global defaults)
    const sourceBranch = p.source_branch || globalDefaults.source_branch;
    const targetBranch = p.target_branch || globalDefaults.target_branch;
    if (!sourceBranch || !targetBranch) {
      return {
        project: projectPath,
        status: "error",
        error: "Missing source_branch/target_branch",
      };
    }

    const repoName = projectPath.split("/").pop();
    const title = renderTitle(
      p.title || globalDefaults.title,
      p.title_template || globalDefaults.title_template,
      {
        repo: repoName,
        project: projectPath,
        source: sourceBranch,
        target: targetBranch,
      }
    );

    const description = p.description ?? globalDefaults.description;
    const labels = (p.labels ?? globalDefaults.labels).join(",");
    const remove_source_branch =
      p.remove_source_branch ?? globalDefaults.remove_source_branch;
    const squash = p.squash ?? globalDefaults.squash;
    const draft = p.draft ?? globalDefaults.draft;

    const assigneeEmails = p.assignee_emails ?? globalDefaults.assignee_emails;
    const reviewerEmails = p.reviewer_emails ?? globalDefaults.reviewer_emails;

    const groupPath = p.group_path ?? globalDefaults.group_path;
    const overrides = {
      ...globalDefaults.email_username_overrides,
      ...(p.email_username_overrides || {}),
    };
    const failOnLookup =
      p.fail_on_user_lookup_error ?? globalDefaults.fail_on_user_lookup_error;
    const skipNoDiff = p.skip_when_no_diff ?? globalDefaults.skip_when_no_diff;

    let projectInfo, projectId;
    try {
      projectInfo = await gl.getProject(projectPath);
      projectId = projectInfo.id;
    } catch (e) {
      return {
        project: projectPath,
        status: "error",
        error: `Project lookup failed: ${e.message || e}`,
      };
    }

    // Resolve users (cached across repos)
    let assignee_ids = [],
      reviewer_ids = [];
    try {
      assignee_ids = await gl.findUserIdsByEmails(assigneeEmails, {
        groupPath,
        overrides,
        failOnError: failOnLookup,
      });
      reviewer_ids = await gl.findUserIdsByEmails(reviewerEmails, {
        groupPath,
        overrides,
        failOnError: failOnLookup,
      });
    } catch (e) {
      if (failOnLookup) {
        return { project: projectPath, status: "error", error: e.message || e };
      }
      // else continue with whatever IDs we got
    }

    // Skip if no diff (optional)
    if (skipNoDiff) {
      try {
        const comp = await gl.compare(projectId, targetBranch, sourceBranch);
        const commitCount = Array.isArray(comp.commits)
          ? comp.commits.length
          : 0;
        if (commitCount === 0) {
          return { project: projectPath, status: "skipped", reason: "no-diff" };
        }
      } catch (e) {
        // non-fatal: maybe branch missing; MR creation will surface error anyway
      }
    }

    // Check existing MR
    try {
      const existing = await gl.findExistingOpenMR(
        projectId,
        sourceBranch,
        targetBranch
      );
      if (existing) {
        return {
          project: projectPath,
          status: "exists",
          url: existing.web_url || existing.html_url,
          iid: existing.iid,
        };
      }
    } catch (e) {
      // non-fatal
    }

    if (dryRun) {
      return {
        project: projectPath,
        status: "dry-run",
        payloadPreview: {
          title,
          source_branch: sourceBranch,
          target_branch: targetBranch,
          labels,
          assignee_ids,
          reviewer_ids,
          remove_source_branch,
          squash,
          draft,
        },
      };
    }

    // Create MR
    try {
      const mr = await gl.createMergeRequest(projectId, {
        title: draft ? `Draft: ${title}` : title,
        source_branch: sourceBranch,
        target_branch: targetBranch,
        description,
        labels,
        remove_source_branch:
          remove_source_branch != null
            ? Boolean(remove_source_branch)
            : undefined,
        squash: squash != null ? Boolean(squash) : undefined,
        assignee_ids: assignee_ids,
        reviewer_ids: reviewer_ids,
      });

      return {
        project: projectPath,
        status: "created",
        url: mr.web_url || mr.html_url,
        iid: mr.iid,
      };
    } catch (e) {
      if (axios.isAxiosError?.(e) && e.response) {
        return {
          project: projectPath,
          status: "error",
          error: `GitLab API ${e.response.status}: ${JSON.stringify(
            e.response.data
          )}`,
        };
      }
      return { project: projectPath, status: "error", error: e.message || e };
    }
  });

  // Summary
  let created = 0,
    skipped = 0,
    exists = 0,
    dry = 0,
    errors = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.status === "created") {
      created++;
      console.log(`[CREATED] ${r.project}  -> ${r.url}`);
    } else if (r.status === "exists") {
      exists++;
      console.log(`[EXISTS ] ${r.project}  -> ${r.url}`);
    } else if (r.status === "skipped") {
      skipped++;
      console.log(`[SKIP   ] ${r.project}  (reason: ${r.reason})`);
    } else if (r.status === "dry-run") {
      dry++;
      console.log(
        `[DRYRUN ] ${r.project}  -> would create MR:`,
        r.payloadPreview
      );
    } else if (r.status === "error") {
      errors++;
      console.error(`[ERROR  ] ${r.project}  -> ${r.error}`);
    }
  }

  console.log(
    `\nSummary: created=${created}, exists=${exists}, skipped=${skipped}, dryrun=${dry}, errors=${errors}`
  );
  if (created === 0 && errors > 0) process.exit(1);
})();
