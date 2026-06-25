/**
 * pi-github — Multi-platform Git forge automation (GitHub / Gitea / Forgejo)
 *
 * Provides tools and commands for interacting with Git hosting platforms.
 * Supports configurable base URL and authorization for self-hosted instances.
 * Uses gh_ prefix since all three platforms follow GitHub-compatible REST conventions.
 *
 * ## What this extension provides
 *
 * - Tools: gh_issue_create, gh_issue_list, gh_issue_get, gh_issue_comment,
 *          gh_pr_create, gh_pr_list, gh_pr_get, gh_repo_get
 * - Commands: /gh-login, /gh-default, /gh-forget, /gh-status
 *
 * ## Testing
 *
 *   pi -e ./tools/pi-github/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  apiRequest,
  buildListQuery,
  detectPlatform,
  formatApiError,
  getConfig,
  GITHUB_DEFAULT_BASE,
  listInstances,
  loadConfig,
  maskToken,
  parseRepo,
  paginationParam,
  saveConfig,
  type GitPluginConfig,
  type PlatformConfig,
  type PlatformType,
} from "./lib";

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
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const body: Record<string, unknown> = { title: params.title };
      if (params.body) body.body = params.body;
      if (params.labels && params.labels.length > 0) body.labels = params.labels;

      const { status, data } = await apiRequest(
        platform,
        "POST",
        `/repos/${parsed.owner}/${parsed.repoName}/issues`,
        body,
      );

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, `/repos/${parsed.owner}/${parsed.repoName}/issues`);
      }

      const d = data as Record<string, unknown>;
      return [
        `Issue created: #${d.number} — ${d.title}`,
        `URL: ${d.html_url}`,
        `State: ${d.state}`,
      ].join("\n");
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("✚ issue ")) + theme.fg("accent", args.repo);
      text += " " + theme.fg("muted", `"${args.title}"`);
      text += theme.fg("dim", ` @${resolveInstanceName(args.instance)}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const first = content.text.split("\n")[0];
        return new Text(theme.fg("success", "✓ ") + theme.fg("muted", first), 0, 0);
      }
      return new Text(theme.fg("success", "✓ Created"), 0, 0);
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
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const qs = buildListQuery(platform, params);
      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues?${qs}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, apiPath);
      }

      const issues = data as Array<Record<string, unknown>>;
      const filtered = issues.filter((i) => !i.pull_request);
      if (filtered.length === 0) return "No issues found.";

      return filtered
        .map((i) => {
          const labels =
            Array.isArray(i.labels) && i.labels.length > 0
              ? ` [${(i.labels as Array<{ name: string }>).map((l) => l.name).join(", ")}]`
              : "";
          return `#${i.number} ${i.title} (${i.state})${labels}\n  ${i.html_url}`;
        })
        .join("\n\n");
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("☰ issues ")) + theme.fg("accent", args.repo);
      if (args.state && args.state !== "open") text += theme.fg("dim", ` state=${args.state}`);
      if (args.labels) text += theme.fg("dim", ` labels=${args.labels}`);
      text += theme.fg("dim", ` @${resolveInstanceName(args.instance)}`);
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
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/issues/${params.number}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, apiPath);
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

      return [
        `#${i.number} ${i.title}`,
        `State: ${i.state} | Created: ${i.created_at} | Updated: ${i.updated_at}`,
        `Author: ${(i.user as { login: string }).login}`,
        `URL: ${i.html_url}${labels}${assignee}${milestone}`,
        ``,
        i.body || "(no description)",
      ].join("\n");
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("● issue ")) + theme.fg("accent", `${args.repo}#${args.number}`);
      text += theme.fg("dim", ` @${resolveInstanceName(args.instance)}`);
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
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const { status, data } = await apiRequest(
        platform,
        "POST",
        `/repos/${parsed.owner}/${parsed.repoName}/issues/${params.number}/comments`,
        { body: params.body },
      );

      if (status < 200 || status >= 300) {
        return formatApiError(
          status,
          data,
          `/repos/${parsed.owner}/${parsed.repoName}/issues/${params.number}/comments`,
        );
      }

      const c = data as Record<string, unknown>;
      return `Comment added: ${c.html_url}`;
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("✎ comment ")) + theme.fg("accent", `${args.repo}#${args.number}`);
      text += theme.fg("dim", ` @${resolveInstanceName(args.instance)}`);
      return new Text(text, 0, 0);
    },

    renderResult(_result, _options, theme, _context) {
      return new Text(theme.fg("success", "✓ Comment added"), 0, 0);
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
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const body: Record<string, unknown> = {
        title: params.title,
        head: params.head,
        base: params.base,
      };
      if (params.body) body.body = params.body;
      if (params.draft && platform.type === "github") body.draft = true;

      const { status, data } = await apiRequest(
        platform,
        "POST",
        `/repos/${parsed.owner}/${parsed.repoName}/pulls`,
        body,
      );

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, `/repos/${parsed.owner}/${parsed.repoName}/pulls`);
      }

      const d = data as Record<string, unknown>;
      const draftLabel = d.draft ? " [DRAFT]" : "";
      return [
        `PR created: #${d.number} — ${d.title}${draftLabel}`,
        `URL: ${d.html_url}`,
        `Branch: ${d.head} → ${d.base}`,
        `State: ${d.state}`,
      ].join("\n");
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("⎆ PR ")) + theme.fg("accent", args.repo);
      text += " " + theme.fg("muted", `${args.head}→${args.base}`);
      text += " " + theme.fg("dim", `"${args.title}"`);
      if (args.draft) text += theme.fg("warning", " draft");
      text += theme.fg("dim", ` @${resolveInstanceName(args.instance)}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const content = result.content[0];
      if (content?.type === "text") {
        const first = content.text.split("\n")[0];
        return new Text(theme.fg("success", "✓ ") + theme.fg("muted", first), 0, 0);
      }
      return new Text(theme.fg("success", "✓ Created"), 0, 0);
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
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const qs = buildListQuery(platform, params);
      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/pulls?${qs}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, apiPath);
      }

      const prs = data as Array<Record<string, unknown>>;
      if (prs.length === 0) return "No pull requests found.";

      return prs
        .map((pr) => {
          const draftLabel = pr.draft ? " [DRAFT]" : "";
          return `#${pr.number} ${pr.title} (${pr.state})${draftLabel}\n  ${pr.head} → ${pr.base}\n  ${pr.html_url}`;
        })
        .join("\n\n");
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("☰ PRs ")) + theme.fg("accent", args.repo);
      if (args.state && args.state !== "open") text += theme.fg("dim", ` state=${args.state}`);
      text += theme.fg("dim", ` @${resolveInstanceName(args.instance)}`);
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
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}/pulls/${params.number}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, apiPath);
      }

      const pr = data as Record<string, unknown>;
      const draftLabel = pr.draft ? " [DRAFT]" : "";
      const mergeable = pr.mergeable !== undefined ? `\nMergeable: ${pr.mergeable}` : "";

      return [
        `#${pr.number} ${pr.title}${draftLabel}`,
        `State: ${pr.state} | Created: ${pr.created_at} | Updated: ${pr.updated_at}`,
        `Author: ${(pr.user as { login: string }).login}`,
        `Branch: ${pr.head} → ${pr.base}`,
        `URL: ${pr.html_url}${mergeable}`,
        ``,
        pr.body || "(no description)",
      ].join("\n");
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("● PR ")) + theme.fg("accent", `${args.repo}#${args.number}`);
      text += theme.fg("dim", ` @${resolveInstanceName(args.instance)}`);
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
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const apiPath = `/repos/${parsed.owner}/${parsed.repoName}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, apiPath);
      }

      const r = data as Record<string, unknown>;
      const lang = r.language ? `\nLanguage: ${r.language}` : "";
      const license =
        r.license && typeof r.license === "object"
          ? `\nLicense: ${(r.license as { spdx_id: string }).spdx_id}`
          : "";
      const topics =
        Array.isArray(r.topics) && r.topics.length > 0
          ? `\nTopics: ${(r.topics as string[]).join(", ")}`
          : "";

      return [
        `${r.full_name}`,
        `${r.description || "(no description)"}`,
        ``,
        `Stars: ${r.stargazers_count} | Forks: ${r.forks_count} | Watchers: ${r.watchers_count}`,
        `Open Issues: ${r.open_issues_count} | Default Branch: ${r.default_branch}`,
        `Visibility: ${r.visibility ?? r.private ? "private" : "public"} | Archived: ${r.archived ?? false}`,
        `URL: ${r.html_url}`,
        `Clone: ${r.clone_url}${lang}${license}${topics}`,
      ].join("\n");
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("◉ repo ")) + theme.fg("accent", args.repo);
      text += theme.fg("dim", ` @${resolveInstanceName(args.instance)}`);
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
        gitea: "https://gitea.com/api/v1",
        forgejo: "",
      };
      const defaultUrl = defaultUrls[platformType] || "";
      const baseUrlInput = await ctx.ui.input("API base URL (Enter=default):", defaultUrl || "https://example.com/api/v1");
      if (baseUrlInput === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      const baseUrl = baseUrlInput.trim() || defaultUrl;
      if (!baseUrl) { ctx.ui.notify("Base URL required.", "error"); return; }

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

      const config = loadConfig();
      config.platforms[configName] = {
        type: detectedType,
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        token,
      };
      if (setDefault || existingNames.length === 0) config.default = configName;
      else if (!config.default) config.default = configName;
      saveConfig(config);

      ctx.ui.notify(
        `Instance "${configName}" (${detectedType}) saved.` +
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
      const names = Object.keys(config.platforms);
      if (names.length === 0) {
        ctx.ui.notify("No instances configured. Run /gh-login first.", "info");
        return;
      }
      const choices = names.map((n) =>
        `${n} (${config.platforms[n].type} — ${config.platforms[n].baseUrl})`);
      const chosen = await ctx.ui.select("Select default instance:", choices);
      if (!chosen) { ctx.ui.notify("Cancelled.", "info"); return; }
      config.default = chosen.split(" ")[0];
      saveConfig(config);
      ctx.ui.notify(`Default → "${config.default}".`, "info");
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
      const names = Object.keys(config.platforms);
      if (names.length === 0) {
        ctx.ui.notify("No instances configured. Run /gh-login to set up.", "info");
        return;
      }
      const lines: string[] = [`Instances (${names.length}):`, ""];
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
}
