/**
 * pi-github — Multi-platform Git forge automation (GitHub / Gitea / Forgejo)
 *
 * Provides tools and commands for interacting with Git hosting platforms.
 * Supports configurable base URL and authorization for self-hosted instances.
 * Uses gh_ prefix since all three platforms follow GitHub-compatible REST conventions.
 *
 * ## What this extension provides
 *
 * - Tools: gh_issue_create, gh_issue_list, gh_issue_get, gh_issue_comment, gh_issue_update,
 *          gh_pr_create, gh_pr_list, gh_pr_get, gh_pr_update, gh_merge_pr,
 *          gh_repo_get, gh_list_contents, gh_get_file, gh_list_branches,
 *          gh_list_comments, gh_list_labels, gh_list_milestones, gh_search_repos,
 *          gh_instance_list, gh_instance_check
 * - Commands: /gh-login, /gh-default, /gh-forget, /gh-status
 *
 * ## Testing
 *
 *   pi -e ./tools/pi-github/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import {
  apiRequest,
  buildListQuery,
  buildSearchQuery,
  decodeContent,
  detectPlatform,
  formatApiError,
  getConfig,
  getConfigPath,
  getProjectConfigPath,
  GITHUB_DEFAULT_BASE,
  GITEA_DEFAULT_BASE,
  listInstances,
  loadConfig,
  maskToken,
  normalizeRepoFields,
  parseRepo,
  paginationParam,
  saveConfig,
  type GitPluginConfig,
  type PlatformConfig,
  type PlatformType,
} from "./lib";

// =============================================================================
// Helpers
// =============================================================================

/** Wrap a plain-text result into the structured format pi expects (see pi-alarm). */
function textResult(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

// =============================================================================
// Shared Parameter Schemas
// =============================================================================

const repoParam = {
  type: "string" as const,
  description: "Repository in owner/repo format (e.g. 'torvalds/linux')",
};

const titleParam = {
  type: "string" as const,
  description: "Title of the issue or pull request",
};

const bodyParam = {
  type: "string" as const,
  description: "Body/description text (Markdown supported)",
};

const stateParam = {
  type: "string" as const,
  enum: ["open", "closed", "all"],
  description: "Filter by state (default: 'open')",
};

const numberParam = {
  type: "number" as const,
  description: "Issue or PR number",
};

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ── Helper: resolve config by instance ────────────────────────────────
  function resolveConfig(instance?: string): { config: PlatformConfig; name: string } {
    const cfg = loadConfig();
    const resolved = getConfig(cfg, instance);
    if (!resolved) {
      const available = listInstances(cfg);
      const hint = instance
        ? `Instance "${instance}" not found. Available: ${available}.`
        : `No default instance configured. Run /gh-login to set up. Available: ${available}`;
      throw new Error(hint);
    }
    return resolved;
  }

  /** Resolve instance name for display (always returns the actual ID). */
  function resolveInstanceName(instance?: string): string {
    const cfg = loadConfig();
    const resolved = getConfig(cfg, instance);
    return resolved ? resolved.name : "?";
  }

  /** Shared schema for the instance parameter used across all tools */
  const instanceParam = {
    type: "string" as const,
    description:
      "Platform instance ID to operate on. Omit to use the default (set via /gh-default). Use /gh-status to list all available instance IDs.",
  };

  // ── gh_issue_create ────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue_create",
    label: "Create Issue",
    description:
      "Create a new issue on a Git repository. Use the optional 'instance' parameter to target a specific platform (e.g. 'github', 'gitea'). Configure instances via /gh-login.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        title: titleParam,
        body: { ...bodyParam, description: "Issue body in Markdown (optional)" },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to apply (optional)",
        },
      },
      required: ["repo", "title"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const body: Record<string, unknown> = { title: params.title };
      if (params.body) body.body = params.body;
      if (params.labels && params.labels.length > 0) body.labels = params.labels;

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues`;
      const { status, data } = await apiRequest(platform, "POST", apiPath, body);

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const d = data as Record<string, unknown>;
      const text = [
        `[${instanceName}] Issue created: #${d.number} — ${d.title}`,
        `URL: ${d.html_url}`,
        `State: ${d.state}`,
      ].join("\n");
      return textResult(text, { number: d.number, title: d.title, url: d.html_url, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`issue create[${inst}]`)) + " " + theme.fg("accent", args.repo);
      text += " " + theme.fg("muted", `"${args.title}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const first = content.text.split("\n")[0];
        return new Text(theme.fg("success", first), 0, 0);
      }
      return new Text(theme.fg("success", "Created"), 0, 0);
    },
  });

  // ── gh_issue_list ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue_list",
    label: "List Issues",
    description:
      "List issues from a Git repository with optional filters (state, labels). Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        state: { ...stateParam, description: "Filter by state (default: 'open')" },
        labels: {
          type: "string",
          description: "Comma-separated label names to filter by (optional)",
        },
        page: { type: "number", description: "Page number (default: 1)" },
        perPage: { type: "number", description: "Results per page (default: 30, max: 100)" },
      },
      required: ["repo"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const qs = buildListQuery(platform, params);
      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues?${qs}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const issues = data as Array<Record<string, unknown>>;
      const filtered = issues.filter((i) => !i.pull_request);
      if (filtered.length === 0) return textResult(`[${instanceName}] No issues found.`, { count: 0, instance: instanceName });

      const text = filtered
        .map((i) => {
          const labels =
            Array.isArray(i.labels) && i.labels.length > 0
              ? ` [${(i.labels as Array<{ name: string }>).map((l) => l.name).join(", ")}]`
              : "";
          return `#${i.number} ${i.title} (${i.state})${labels}\n  ${i.html_url}`;
        })
        .join("\n\n");
      return textResult(text, { count: filtered.length, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);

      let text = theme.fg("toolTitle", theme.bold(`issues list[${inst}]`)) + " " + theme.fg("accent", args.repo);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const count = content.text === "No issues found." ? 0 : content.text.split("\n\n").length;
        return new Text(theme.fg("muted", count === 0 ? "No issues" : `${count} issue(s)`), 0, 0);
      }
      return new Text(theme.fg("muted", "Done"), 0, 0);
    },
  });

  // ── gh_issue_get ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue_get",
    label: "Get Issue",
    description:
      "Get detailed information about a specific issue. Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        number: numberParam,
      },
      required: ["repo", "number"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues/${params.number}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const i = data as Record<string, unknown>;
      const labels =
        Array.isArray(i.labels) && i.labels.length > 0
          ? `\nLabels: ${(i.labels as Array<{ name: string }>).map((l) => l.name).join(", ")}`
          : "";
      const assignee =
        i.assignee && typeof i.assignee === "object"
          ? `\nAssignee: ${(i.assignee as { login: string }).login}`
          : "";
      const milestone =
        i.milestone && typeof i.milestone === "object"
          ? `\nMilestone: ${(i.milestone as { title: string }).title}`
          : "";

      const text = [
        `#${i.number} ${i.title}`,
        `State: ${i.state} | Created: ${i.created_at} | Updated: ${i.updated_at}`,
        `Author: ${i.user && typeof i.user === "object" ? (i.user as { login: string }).login : "unknown"}`,
        `URL: ${i.html_url}${labels}${assignee}${milestone}`,
        ``,
        i.body || "(no description)",
      ].join("\n");
      return textResult(text, { number: i.number, title: i.title, state: i.state, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);

      let text = theme.fg("toolTitle", theme.bold(`issue[${inst}]`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const first = content.text.split("\n")[0];
        return new Text(theme.fg("muted", first), 0, 0);
      }
      return new Text(theme.fg("muted", "Done"), 0, 0);
    },
  });

  // ── gh_issue_comment ───────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue_comment",
    label: "Comment",
    description:
      "Add a comment to an existing issue. Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        number: numberParam,
        body: { ...bodyParam, description: "Comment body in Markdown" },
      },
      required: ["repo", "number", "body"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues/${params.number}/comments`;
      const { status, data } = await apiRequest(platform, "POST", apiPath, { body: params.body });

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const c = data as Record<string, unknown>;
      return textResult(`[${instanceName}] Comment added: ${c.html_url}`, { url: c.html_url, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);

      let text = theme.fg("toolTitle", theme.bold(`comment[${inst}]`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      return new Text(text, 0, 0);
    },

    renderResult(_result, _options, theme, _context) {
      return new Text(theme.fg("success", "Comment added"), 0, 0);
    },
  });

  // ── gh_issue_update ────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue_update",
    label: "Update Issue",
    description:
      "Update an existing issue — change title, body, state (open/closed), labels, assignees, or milestone. " +
      "Use the optional 'instance' parameter to target a specific platform (e.g. 'github', 'gitea'). " +
      "Only the fields you provide will be updated; omit fields to leave them unchanged.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        number: numberParam,
        title: {
          type: "string",
          description: "New title (optional — leave unchanged if omitted)",
        },
        body: {
          type: "string",
          description: "New body/description in Markdown (optional)",
        },
        state: {
          type: "string",
          enum: ["open", "closed"],
          description: "Set to 'closed' to close the issue, 'open' to reopen",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Replacement label array (replaces all existing labels). Omit to leave unchanged.",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "Replacement assignee array (usernames). Omit to leave unchanged.",
        },
        milestone: {
          description: "Milestone number, or null to clear. Omit to leave unchanged.",
        },
      },
      required: ["repo", "number"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const body: Record<string, unknown> = {};
      if (params.title !== undefined) body.title = params.title;
      if (params.body !== undefined) body.body = params.body;
      if (params.state !== undefined) body.state = params.state;
      if (params.labels !== undefined) body.labels = params.labels;
      if (params.assignees !== undefined) body.assignees = params.assignees;
      if (params.milestone !== undefined) body.milestone = params.milestone;

      if (Object.keys(body).length === 0) {
        return textResult(
          `Error: at least one field to update must be provided (title, body, state, labels, assignees, or milestone)`,
          { error: "no fields to update", instance: instanceName },
        );
      }

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues/${params.number}`;
      const { status, data } = await apiRequest(platform, "PATCH", apiPath, body);

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const d = data as Record<string, unknown>;
      const changes: string[] = [];
      if (params.title !== undefined) changes.push("title");
      if (params.body !== undefined) changes.push("body");
      if (params.state !== undefined) changes.push(`state → ${params.state}`);
      if (params.labels !== undefined) changes.push("labels");
      if (params.assignees !== undefined) changes.push("assignees");
      if (params.milestone !== undefined) changes.push("milestone");

      const text = [
        `[${instanceName}] Issue updated: #${d.number} — ${d.title}`,
        `State: ${d.state} | Updated: ${changes.join(", ")}`,
        `URL: ${d.html_url}`,
      ].join("\n");
      return textResult(text, { number: d.number, title: d.title, state: d.state, url: d.html_url, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`issue update[${inst}]`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      if (args.state) text += " " + theme.fg(args.state === "closed" ? "error" : "success", args.state);
      if (args.title) text += " " + theme.fg("muted", `"${args.title}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const first = content.text.split("\n")[0];
        return new Text(theme.fg("success", first), 0, 0);
      }
      return new Text(theme.fg("success", "Updated"), 0, 0);
    },
  });

  // ── gh_pr_create ───────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_pr_create",
    label: "Create PR",
    description:
      "Create a new pull request. Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        title: titleParam,
        head: { type: "string", description: "Source branch name (e.g. 'feature/my-change')" },
        base: { type: "string", description: "Target branch name (e.g. 'main')" },
        body: { ...bodyParam, description: "PR description in Markdown (optional)" },
        draft: { type: "boolean", description: "Create as draft PR (GitHub only, optional)" },
      },
      required: ["repo", "title", "head", "base"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const body: Record<string, unknown> = {
        title: params.title,
        head: params.head,
        base: params.base,
      };
      if (params.body) body.body = params.body;
      if (params.draft && platform.type === "github") body.draft = true;

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/pulls`;
      const { status, data } = await apiRequest(platform, "POST", apiPath, body);

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const d = data as Record<string, unknown>;
      const draftLabel = d.draft ? " [DRAFT]" : "";
      const text = [
        `[${instanceName}] PR created: #${d.number} — ${d.title}${draftLabel}`,
        `URL: ${d.html_url}`,
        `Branch: ${d.head} → ${d.base}`,
        `State: ${d.state}`,
      ].join("\n");
      return textResult(text, { number: d.number, title: d.title, url: d.html_url, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);

      let text = theme.fg("toolTitle", theme.bold(`PR create[${inst}]`)) + " " + theme.fg("accent", args.repo);
      text += " " + theme.fg("muted", `${args.head}→${args.base}`);
      text += " " + theme.fg("dim", `"${args.title}"`);
      if (args.draft) text += theme.fg("warning", " draft");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const first = content.text.split("\n")[0];
        return new Text(theme.fg("success", first), 0, 0);
      }
      return new Text(theme.fg("success", "Created"), 0, 0);
    },
  });

  // ── gh_pr_list ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_pr_list",
    label: "List PRs",
    description:
      "List pull requests from a Git repository with optional filters. Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        state: { ...stateParam, description: "Filter by state (default: 'open')" },
        page: { type: "number", description: "Page number (default: 1)" },
        perPage: { type: "number", description: "Results per page (default: 30, max: 100)" },
      },
      required: ["repo"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const qs = buildListQuery(platform, params);
      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/pulls?${qs}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const prs = data as Array<Record<string, unknown>>;
      if (prs.length === 0) return textResult(`[${instanceName}] No pull requests found.`, { count: 0, instance: instanceName });

      const text = prs
        .map((pr) => {
          const draftLabel = pr.draft ? " [DRAFT]" : "";
          return `#${pr.number} ${pr.title} (${pr.state})${draftLabel}\n  ${pr.head} → ${pr.base}\n  ${pr.html_url}`;
        })
        .join("\n\n");
      return textResult(text, { count: prs.length, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);

      let text = theme.fg("toolTitle", theme.bold(`PRs list[${inst}]`)) + " " + theme.fg("accent", args.repo);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const count = content.text === "No pull requests found." ? 0 : content.text.split("\n\n").length;
        return new Text(theme.fg("muted", count === 0 ? "No PRs" : `${count} PR(s)`), 0, 0);
      }
      return new Text(theme.fg("muted", "Done"), 0, 0);
    },
  });

  // ── gh_pr_get ──────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_pr_get",
    label: "Get PR",
    description:
      "Get detailed information about a specific pull request. Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        number: numberParam,
      },
      required: ["repo", "number"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/pulls/${params.number}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const pr = data as Record<string, unknown>;
      const draftLabel = pr.draft ? " [DRAFT]" : "";
      const mergeable = pr.mergeable !== undefined ? `\nMergeable: ${pr.mergeable}` : "";

      const text = [
        `#${pr.number} ${pr.title}${draftLabel}`,
        `State: ${pr.state} | Created: ${pr.created_at} | Updated: ${pr.updated_at}`,
        `Author: ${pr.user && typeof pr.user === "object" ? (pr.user as { login: string }).login : "unknown"}`,
        `Branch: ${pr.head} → ${pr.base}`,
        `URL: ${pr.html_url}${mergeable}`,
        ``,
        pr.body || "(no description)",
      ].join("\n");
      return textResult(text, { number: pr.number, title: pr.title, state: pr.state, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);

      let text = theme.fg("toolTitle", theme.bold(`PR[${inst}]`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const first = content.text.split("\n")[0];
        return new Text(theme.fg("muted", first), 0, 0);
      }
      return new Text(theme.fg("muted", "Done"), 0, 0);
    },
  });

  // ── gh_repo_get ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_repo_get",
    label: "Get Repo",
    description:
      "Get information about a Git repository. Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
      },
      required: ["repo"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) {
        return textResult(
          `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`,
          { error: "invalid repo format", instance: instanceName },
        );
      }

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });
      }

      const r = normalizeRepoFields(platform.type, data as Record<string, unknown>) as Record<string, unknown>;
      const lang = r.language ? `\nLanguage: ${r.language}` : "";
      const license =
        r.license && typeof r.license === "object"
          ? `\nLicense: ${(r.license as { spdx_id: string }).spdx_id}`
          : "";
      const topics =
        Array.isArray(r.topics) && r.topics.length > 0
          ? `\nTopics: ${(r.topics as string[]).join(", ")}`
          : "";

      const text = [
        `[${instanceName}] ${r.full_name}`,
        `${r.description || "(no description)"}`,
        ``,
        `Stars: ${r.stargazers_count ?? "?"} | Forks: ${r.forks_count ?? "?"} | Watchers: ${r.watchers_count ?? "?"}`,
        `Open Issues: ${r.open_issues_count ?? "?"} | Default Branch: ${r.default_branch}`,
        `Visibility: ${r.visibility ?? (r.private ? "private" : "public")} | Archived: ${r.archived ?? false}`,
        `URL: ${r.html_url}`,
        `Clone: ${r.clone_url}${lang}${license}${topics}`,
      ].join("\n");
      return textResult(text, { fullName: r.full_name, stars: r.stargazers_count, instance: instanceName });
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);

      let text = theme.fg("toolTitle", theme.bold(`repo[${inst}]`)) + " " + theme.fg("accent", args.repo);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const lines = content.text.split("\n");
        const fullName = lines[0];
        const desc = lines[1];
        const descLabel = desc && desc !== "(no description)" ? ` — ${desc}` : "";
        return new Text(theme.fg("muted", fullName) + theme.fg("dim", descLabel), 0, 0);
      }
      return new Text(theme.fg("muted", "Done"), 0, 0);
    },
  });

  // ── gh_instance_list ──────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_instance_list",
    label: "List Instances",
    description:
      "List all configured platform instances with their types, URLs, and which is the default. Use this when you need to know what platforms are available.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(_toolCallId, _params) {
      const config = loadConfig();
      const names = Object.keys(config.platforms);
      if (names.length === 0) {
        return textResult("No instances configured. Run /gh-login to set up.", { count: 0 });
      }
      const lines: string[] = [`Instances (${names.length}):`, ""];
      for (const name of names) {
        const p = config.platforms[name];
        const active = name === config.default ? " ★ DEFAULT" : "";
        lines.push(`  ${name}${active}`);
        lines.push(`    type: ${p.type} | url: ${p.baseUrl}`);
        lines.push(`    token: ${maskToken(p.token)}`);
        lines.push("");
      }
      return textResult(lines.join("\n"), { count: names.length, default: config.default, instances: names });
    },

    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("instances list")), 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const count = (content.text.match(/  \w+/g) || []).length;
        return new Text(theme.fg("muted", `${count} instance(s)`), 0, 0);
      }
      return new Text(theme.fg("muted", "Done"), 0, 0);
    },
  });

  // ── gh_instance_check ─────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_instance_check",
    label: "Check Instance",
    description:
      "Check connectivity and token validity for a configured platform instance. Use the optional 'instance' parameter; defaults to the current default instance.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
      },
      required: [],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);

      // Probe the API version endpoint (works across platforms)
      const { status, data } = await apiRequest(platform, "GET", "/version");

      const lines: string[] = [
        `[${instanceName}] ${platform.type}`,
        `URL: ${platform.baseUrl}`,
        `Token: ${maskToken(platform.token)}`,
      ];

      if (status === 200) {
        const d = data as Record<string, unknown>;
        lines.push(`Status: OK (version: ${d.version || "unknown"})`);
        return textResult(lines.join("\n"), { ok: true, instance: instanceName, version: d.version });
      } else if (status === 401 || status === 403) {
        lines.push(`Status: Token invalid or expired (HTTP ${status})`);
        lines.push("Run /gh-login to reconfigure.");
        return textResult(lines.join("\n"), { ok: false, instance: instanceName, status });
      } else {
        lines.push(`Status: Unreachable (HTTP ${status})`);
        return textResult(lines.join("\n"), { ok: false, instance: instanceName, status });
      }
    },

    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`check [${inst}]`)), 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as Record<string, unknown> | undefined;
      if (details?.ok) {
        return new Text(theme.fg("success", `OK (${details.instance ?? "?"})`), 0, 0);
      }
      return new Text(theme.fg("error", "Failed"), 0, 0);
    },
  });

  // ── /gh-login command ──────────────────────────────────────────────────
  pi.registerCommand("gh-login", {
    description: "Add or update a platform instance (GitHub, Gitea, or Forgejo)",
    async handler(_args, ctx) {
      const existing = loadConfig();
      const existingNames = Object.keys(existing.platforms);
      if (existingNames.length > 0) {
        const label =
          `Existing instances: ${listInstances(existing)}`;
        ctx.ui.notify(label, "info");
      }

      const typeChoice = await ctx.ui.select("Select platform type:", [
        "GitHub (github.com or GitHub Enterprise)",
        "Gitea",
        "Forgejo",
      ]);
      if (!typeChoice) { ctx.ui.notify("Cancelled.", "info"); return; }
      const platformType: PlatformType = typeChoice.toLowerCase().startsWith("github")
        ? "github" : typeChoice === "Gitea" ? "gitea" : "forgejo";

      const defaultUrls: Record<string, string> = {
        github: GITHUB_DEFAULT_BASE,
        gitea: GITEA_DEFAULT_BASE,
        forgejo: "",
      };
      const defaultUrl = defaultUrls[platformType] || "";
      const hint = platformType === "github"
        ? "https://api.github.com"
        : "https://your-domain.com (e.g. https://repo.trav.one)";
      const baseUrlInput = await ctx.ui.input(`API base URL (Enter=default):`, defaultUrl || hint);
      if (baseUrlInput === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      let baseUrl = baseUrlInput.trim() || defaultUrl;
      if (!baseUrl) { ctx.ui.notify("Base URL required.", "error"); return; }
      // Strip /api/v1 suffix — buildApiUrl auto-appends for Gitea/Forgejo
      baseUrl = baseUrl.replace(/\/api\/v1\/?$/, "").replace(/\/+$/, "");

      const tokenInput = await ctx.ui.input("Access token:", "ghp_...");
      if (tokenInput === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      const token = tokenInput.trim();
      if (!token) { ctx.ui.notify("Token required.", "error"); return; }

      const defaultName = existingNames.length > 0
        ? `${platformType}-${existingNames.length + 1}` : platformType;
      const nameInput = await ctx.ui.input("Instance ID (Enter=default):", defaultName);
      if (nameInput === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      const configName = nameInput.trim() || defaultName;

      const detectedType = platformType === "github" ? detectPlatform(baseUrl) : platformType;

      const setDefault = existingNames.length === 0 ? true
        : await ctx.ui.confirm("Set as default?", `Make "${configName}" the default? (Current: ${existing.default || "none"})`);

      // Scope: project or global?
      const scopeChoice = await ctx.ui.select(
        "Save to project config or global?",
        ["Global (~/.pi/agent/) — available in all workspaces", "Project (.pi/) — this workspace only"],
      );
      if (scopeChoice === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      const isProject = scopeChoice.startsWith("Project");

      // Load fresh config with merging
      const config = loadConfig();
      config.platforms[configName] = {
        type: detectedType,
        baseUrl: baseUrl,
        token,
      };
      if (setDefault || existingNames.length === 0) config.default = configName;
      else if (!config.default) config.default = configName;
      saveConfig(config, isProject);

      const scopeLabel = isProject ? "project (.pi/)" : "global (~/.pi/agent/)";
      ctx.ui.notify(
        `Instance "${configName}" (${detectedType}) saved to ${scopeLabel}.` +
          (config.default === configName ? " Set as default." : ""),
        "info",
      );
    },
  });

  // ── /gh-default command ─────────────────────────────────────────────────
  pi.registerCommand("gh-default", {
    description: "Set the default platform instance for subsequent tool calls",
    async handler(_args, ctx) {
      const config = loadConfig();
      const scope = fs.existsSync(getProjectConfigPath()) ? "project-local (loaded: global ← project)" : "global";
      const names = Object.keys(config.platforms);
      if (names.length === 0) {
        ctx.ui.notify("No instances configured. Run /gh-login first.", "info");
        return;
      }
      const choices = names.map((n) =>
        `${n} (${config.platforms[n].type} — ${config.platforms[n].baseUrl})`);
      const chosen = await ctx.ui.select(`Select default instance (${scope} config):`, choices);
      if (!chosen) { ctx.ui.notify("Cancelled.", "info"); return; }
      config.default = chosen.split(" ")[0];
      saveConfig(config);
      ctx.ui.notify(`Default → "${config.default}" (${scope}).`, "info");
    },
  });

  // ── /gh-forget command ─────────────────────────────────────────────────
  pi.registerCommand("gh-forget", {
    description: "Remove a configured platform instance",
    async handler(_args, ctx) {
      const config = loadConfig();
      const names = Object.keys(config.platforms);
      if (names.length === 0) {
        ctx.ui.notify("No instances to remove.", "info");
        return;
      }
      const choices = names.map((n) =>
        `${n} (${config.platforms[n].type} — ${config.platforms[n].baseUrl})`);
      const target = await ctx.ui.select("Select instance to remove:", choices);
      if (!target) { ctx.ui.notify("Cancelled.", "info"); return; }
      const targetName = target.split(" ")[0];

      const ok = await ctx.ui.confirm("Confirm", `Remove "${targetName}"?`);
      if (!ok) { ctx.ui.notify("Cancelled.", "info"); return; }

      delete config.platforms[targetName];
      if (config.default === targetName) {
        const remaining = Object.keys(config.platforms);
        config.default = remaining.length > 0 ? remaining[0] : "";
      }
      saveConfig(config);
      ctx.ui.notify(config.default
        ? `Removed "${targetName}". Default → "${config.default}".`
        : `Removed "${targetName}". No instances remaining.`, "info");
    },
  });

  // ── /gh-status command ─────────────────────────────────────────────────
  pi.registerCommand("gh-status", {
    description: "Show all configured platform instances",
    async handler(_args, ctx) {
      const config = loadConfig();
      const scope = fs.existsSync(getProjectConfigPath()) ? "merged (global ← project)" : "global";
      const names = Object.keys(config.platforms);
      if (names.length === 0) {
        ctx.ui.notify("No instances configured. Run /gh-login to set up.", "info");
        return;
      }
      const lines: string[] = [`Instances (${names.length}) — ${scope}:`, ""];
      for (const name of names) {
        const p = config.platforms[name];
        const active = name === config.default ? " ★ DEFAULT" : "";
        lines.push(`  ${name}${active}`);
        lines.push(`    ${p.type} | ${p.baseUrl}`);
        lines.push(`    Token: ${maskToken(p.token)}`);
        lines.push("");
      }
      lines.push("/gh-default to switch, /gh-forget to remove.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── gh_issue_update ──────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue_update",
    label: "Update Issue",
    description:
      "Update an existing issue — change title, body, state (open/closed), labels, assignees, or milestone. " +
      "Only the fields you provide will be updated; omit fields to leave them unchanged.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        number: numberParam,
        title: { type: "string", description: "New title (omit to keep current)" },
        body: { type: "string", description: "New body/description in Markdown (omit to keep current)" },
        state: { type: "string", enum: ["open", "closed"], description: "Set state" },
        labels: { type: "array", items: { type: "string" }, description: "Replacement labels. Omit to keep unchanged." },
        assignees: { type: "array", items: { type: "string" }, description: "Replacement assignees. Omit to keep unchanged." },
        milestone: { description: "Milestone number, or null to clear. Omit to keep unchanged." },
      },
      required: ["repo", "number"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`, { error: "invalid repo format", instance: instanceName });

      const body: Record<string, unknown> = {};
      if (params.title !== undefined) body.title = params.title;
      if (params.body !== undefined) body.body = params.body;
      if (params.state !== undefined) body.state = params.state;
      if (params.labels !== undefined) body.labels = params.labels;
      if (params.assignees !== undefined) body.assignees = params.assignees;
      if (params.milestone !== undefined) body.milestone = params.milestone;

      if (Object.keys(body).length === 0) return textResult("Error: at least one field to update must be provided.", { error: "no fields", instance: instanceName });

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues/${params.number}`;
      const { status, data } = await apiRequest(platform, "PATCH", apiPath, body);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });

      const d = data as Record<string, unknown>;
      const text = [`[${instanceName}] Issue updated: #${d.number} — ${d.title}`, `State: ${d.state}`, `URL: ${d.html_url}`].join("\n");
      return textResult(text, { number: d.number, title: d.title, state: d.state, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`issue update[${inst}]`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      if (args.state) text += " " + theme.fg(args.state === "closed" ? "error" : "success", args.state);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") return new Text(theme.fg("success", content.text.split("\n")[0]), 0, 0);
      return new Text(theme.fg("success", "Updated"), 0, 0);
    },
  });

  // ── gh_pr_update ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_pr_update",
    label: "Update PR",
    description: "Update an existing pull request — change title, body, or state.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        number: numberParam,
        title: { type: "string", description: "New title (omit to keep current)" },
        body: { type: "string", description: "New body/description in Markdown (omit to keep current)" },
        state: { type: "string", enum: ["open", "closed"], description: "Set state" },
      },
      required: ["repo", "number"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`, { error: "invalid repo format", instance: instanceName });

      const body: Record<string, unknown> = {};
      if (params.title !== undefined) body.title = params.title;
      if (params.body !== undefined) body.body = params.body;
      if (params.state !== undefined) body.state = params.state;
      if (Object.keys(body).length === 0) return textResult("Error: at least one field to update must be provided.", { error: "no fields", instance: instanceName });

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/pulls/${params.number}`;
      const { status, data } = await apiRequest(platform, "PATCH", apiPath, body);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });

      const d = data as Record<string, unknown>;
      const text = [`[${instanceName}] PR #${d.number} updated: ${d.title}`, `State: ${d.state}`, `URL: ${d.html_url}`].join("\n");
      return textResult(text, { number: d.number, title: d.title, state: d.state, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`PR update[${inst}]`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      if (args.state) text += " " + theme.fg(args.state === "closed" ? "error" : "success", args.state);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") return new Text(theme.fg("success", content.text.split("\n")[0]), 0, 0);
      return new Text(theme.fg("success", "Updated"), 0, 0);
    },
  });

  // ── gh_merge_pr ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_merge_pr",
    label: "Merge PR",
    description: "Merge a pull request (merge, rebase, or squash). Optionally delete the source branch.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        number: numberParam,
        method: { type: "string", enum: ["merge", "rebase", "squash"], description: "Merge method. Default: merge" },
        deleteBranch: { type: "boolean", description: "Delete source branch after merge. Default: false" },
      },
      required: ["repo", "number"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`, { error: "invalid repo format", instance: instanceName });

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/pulls/${params.number}/merge`;
      const body: Record<string, unknown> = {};
      if (params.method) {
        // GitHub uses merge_method, Gitea/Forgejo use Do
        if (platform.type === "github") body.merge_method = params.method;
        else body.Do = params.method;
      }
      if (params.deleteBranch && platform.type !== "github") body.delete_branch_after_merge = params.deleteBranch;

      const { status, data } = await apiRequest(platform, "PUT", apiPath, body);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });

      const d = data as Record<string, unknown>;
      const merged = d.merged === true;
      return textResult(`[${instanceName}] ${merged ? "Merged" : "Failed to merge"} PR #${params.number}`, { merged, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`merge PR[${inst}]`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      if (args.method) text += " " + theme.fg("muted", `(${args.method})`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const d = result.details as Record<string, unknown> | undefined;
      return new Text(theme.fg(d?.merged ? "success" : "error", d?.merged ? "Merged" : "Failed"), 0, 0);
    },
  });

  // ── gh_list_comments ─────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_list_comments",
    label: "List Comments",
    description: "List comments on an issue or pull request.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        number: numberParam,
        perPage: { type: "number", description: "Results per page (default: 30, max: 100)" },
      },
      required: ["repo", "number"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format.`, { error: "invalid repo format", instance: instanceName });

      const pp = paginationParam(platform);
      const qs = new URLSearchParams();
      qs.set(pp, String(Math.min(params.perPage ?? 30, 100)));
      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues/${params.number}/comments?${qs}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });

      const comments = data as Array<Record<string, unknown>>;
      if (comments.length === 0) return textResult(`[${instanceName}] No comments.`, { count: 0, instance: instanceName });

      const text = comments.map((c) => {
        const author = c.user && typeof c.user === "object" ? (c.user as { login: string }).login : "unknown";
        return `@${author} at ${c.created_at}:\n${c.body}\n---`;
      }).join("\n");
      return textResult(text, { count: comments.length, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`comments[${inst}]`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`), 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} comment(s)`), 0, 0);
    },
  });

  // ── gh_list_branches ─────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_list_branches",
    label: "List Branches",
    description: "List branches in a repository with commit info and protection status.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        perPage: { type: "number", description: "Results per page (default: 30, max: 100)" },
      },
      required: ["repo"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format.`, { error: "invalid repo format", instance: instanceName });

      const pp = paginationParam(platform);
      const qs = new URLSearchParams();
      qs.set(pp, String(Math.min(params.perPage ?? 30, 100)));
      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/branches?${qs}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });

      const branches = data as Array<Record<string, unknown>>;
      if (branches.length === 0) return textResult(`[${instanceName}] No branches found.`, { count: 0 });

      const text = branches.map((b) => {
        const sha = b.commit && typeof b.commit === "object" ? (b.commit as { sha: string }).sha.slice(0, 8) : "?";
        return `- ${b.name} (${sha})${b.protected ? " [protected]" : ""}`;
      }).join("\n");
      return textResult(text, { count: branches.length, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`branches[${inst}]`)) + " " + theme.fg("accent", args.repo), 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} branch(es)`), 0, 0);
    },
  });

  // ── gh_list_contents ─────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_list_contents",
    label: "List Contents",
    description: "List files and directories in a repository path (like ls).",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        path: { type: "string", description: "Directory path. Empty for root." },
        ref: { type: "string", description: "Branch or commit SHA. Default: default branch." },
      },
      required: ["repo"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format.`, { error: "invalid repo format", instance: instanceName });

      let apiPath = `/repos/${parsed.owner}/${parsed.repoName}/contents`;
      if (params.path) apiPath += `/${params.path.replace(/^\//, "")}`;
      if (params.ref) apiPath += `?ref=${encodeURIComponent(params.ref)}`;

      const { status, data } = await apiRequest(platform, "GET", apiPath);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });

      const entries = Array.isArray(data) ? data : [data];
      if (entries.length === 0) return textResult(`[${instanceName}] Directory is empty.`, { count: 0 });

      const text = entries.map((e: Record<string, unknown>) => {
        const icon = e.type === "dir" ? "📁" : e.type === "symlink" ? "🔗" : "📄";
        return `${icon} ${e.name} (${e.type}) ${e.size} bytes`;
      }).join("\n");
      return textResult(text, { count: entries.length, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`ls[${inst}]`)) + " " + theme.fg("accent", args.repo);
      if (args.path) text += " " + theme.fg("muted", args.path);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} entr${count === 1 ? "y" : "ies"}`), 0, 0);
    },
  });

  // ── gh_get_file ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_get_file",
    label: "Get File",
    description: "Read a file from a repository. Returns decoded file content.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        path: { type: "string", description: "File path in the repository." },
        ref: { type: "string", description: "Branch or commit SHA. Default: default branch." },
      },
      required: ["repo", "path"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format.`, { error: "invalid repo format", instance: instanceName });

      let apiPath = `/repos/${parsed.owner}/${parsed.repoName}/contents/${params.path.replace(/^\//, "")}`;
      if (params.ref) apiPath += `?ref=${encodeURIComponent(params.ref)}`;

      const { status, data } = await apiRequest(platform, "GET", apiPath);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status, instance: instanceName });

      const f = data as Record<string, unknown>;
      const content = decodeContent(f.content as string | undefined, f.encoding as string | undefined);
      return { content: [{ type: "text", text: content }], details: { sha: f.sha, size: f.size, path: f.path, instance: instanceName } };
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`cat[${inst}]`)) + " " + theme.fg("accent", args.repo);
      if (args.path) text += " " + theme.fg("muted", args.path);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const size = (result.details as Record<string, unknown>)?.size;
      return new Text(theme.fg("muted", `${size ?? "?"} bytes`), 0, 0);
    },
  });

  // ── gh_list_labels ───────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_list_labels",
    label: "List Labels",
    description: "List all labels in a repository (useful to get label names for create/update).",
    parameters: {
      type: "object",
      properties: { instance: instanceParam, repo: repoParam },
      required: ["repo"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format.`, { error: "invalid repo format" });

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/labels`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status });

      const labels = data as Array<Record<string, unknown>>;
      if (labels.length === 0) return textResult(`No labels.`, { count: 0, instance: instanceName });
      const text = labels.map((l) => `- ${l.name}${l.color ? ` (#${l.color})` : ""}`).join("\n");
      return textResult(text, { count: labels.length, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`labels[${inst}]`)) + " " + theme.fg("accent", args.repo), 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} label(s)`), 0, 0);
    },
  });

  // ── gh_list_milestones ───────────────────────────────────────────────
  pi.registerTool({
    name: "gh_list_milestones",
    label: "List Milestones",
    description: "List milestones in a repository.",
    parameters: {
      type: "object",
      properties: { instance: instanceParam, repo: repoParam },
      required: ["repo"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return textResult(`Error: invalid repo format.`, { error: "invalid repo format" });

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/milestones`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status });

      const milestones = data as Array<Record<string, unknown>>;
      if (milestones.length === 0) return textResult(`No milestones.`, { count: 0, instance: instanceName });
      const text = milestones.map((m) => `- #${m.number} "${m.title}" [${m.state}]`).join("\n");
      return textResult(text, { count: milestones.length, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`milestones[${inst}]`)) + " " + theme.fg("accent", args.repo), 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} milestone(s)`), 0, 0);
    },
  });

  // ── gh_search_repos ──────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_search_repos",
    label: "Search Repos",
    description: "Search repositories on the platform by keyword (Gitea/Forgejo only; GitHub uses a different search API).",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        query: { type: "string", description: "Search keyword." },
        limit: { type: "number", description: "Max results. Default: 10." },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params) {
      const { config: platform, name: instanceName } = resolveConfig(params.instance);
      const qs = buildSearchQuery({ q: params.query, limit: params.limit ?? 10 });
      const apiPath = `/repos/search?${qs}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);
      if (status < 200 || status >= 300) return textResult(formatApiError(status, data, apiPath, platform.type), { error: "api error", status });

      const d = data as Record<string, unknown>;
      const repos = (d.data || d) as Array<Record<string, unknown>>;
      if (!Array.isArray(repos) || repos.length === 0) return textResult(`No repositories found.`, { count: 0, instance: instanceName });

      const text = repos.map((r) => `- ${r.full_name} ⭐${r.stargazers_count ?? r.stars_count ?? 0} ${r.description ?? ""}`).join("\n");
      return textResult(text, { count: repos.length, instance: instanceName });
    },
    renderCall(args, theme, _context) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`search repos[${inst}]`)) + " " + theme.fg("accent", args.query || ""), 0, 0);
    },
    renderResult(result, _options, theme, _context) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} repositor${count === 1 ? "y" : "ies"}`), 0, 0);
    },
  });
}
