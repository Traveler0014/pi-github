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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// =============================================================================
// Types
// =============================================================================

type PlatformType = "github" | "gitea" | "forgejo";

interface PlatformConfig {
  type: PlatformType;
  baseUrl: string;
  token: string;
}

interface GitPluginConfig {
  platforms: Record<string, PlatformConfig>;
  default: string;
}

// =============================================================================
// Constants
// =============================================================================

const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "pi-github-config.json");

const GITHUB_DEFAULT_BASE = "https://api.github.com";

/** Detect platform from base URL */
function detectPlatform(baseUrl: string): PlatformType {
  const url = baseUrl.toLowerCase();
  // Well-known GitHub domains
  if (
    url.includes("api.github.com") ||
    url.includes("github.com/api/v3") ||
    url === "https://api.github.com"
  ) {
    return "github";
  }
  // Gitea / Forgejo both use /api/v1 convention; treat as gitea by default.
  // Users can override by explicitly setting type during /git-login.
  return "gitea";
}

// =============================================================================
// Config Helpers
// =============================================================================

function ensureConfigDir(): void {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig(): GitPluginConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // Corrupted config — return empty
  }
  return { platforms: {}, default: "" };
}

function saveConfig(config: GitPluginConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/** Resolve config by instance name. Falls back to default. */
function getConfig(instance?: string): { config: PlatformConfig; name: string } | null {
  const cfg = loadConfig();
  const name = instance || cfg.default;
  if (!name || !cfg.platforms[name]) return null;
  return { config: cfg.platforms[name], name };
}

/** List available instance names for error messages */
function listInstances(): string {
  const cfg = loadConfig();
  const names = Object.keys(cfg.platforms);
  if (names.length === 0) return "(none configured)";
  return names.map((n) => (n === cfg.default ? `${n} (default)` : n)).join(", ");
}

// =============================================================================
// HTTP Helpers
// =============================================================================

interface ApiHeaders {
  Authorization: string;
  Accept: string;
  [key: string]: string;
}

function buildHeaders(platform: PlatformConfig): ApiHeaders {
  if (platform.type === "github") {
    return {
      Authorization: `Bearer ${platform.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
  // Gitea / Forgejo
  return {
    Authorization: `token ${platform.token}`,
    Accept: "application/json",
  };
}

async function apiRequest(
  platform: PlatformConfig,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = `${platform.baseUrl.replace(/\/+$/, "")}${apiPath}`;
  const headers = buildHeaders(platform);

  const options: RequestInit = {
    method,
    headers: headers as Record<string, string>,
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
    (options.headers as Record<string, string>)["Content-Type"] = "application/json";
  }

  const response = await fetch(url, options);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { status: response.status, data };
}

function formatApiError(status: number, data: unknown, path: string): string {
  const msg =
    data && typeof data === "object" && "message" in data
      ? (data as { message: string }).message
      : JSON.stringify(data);
  return `API error ${status} on ${path}: ${msg}`;
}

// Per_page vs limit for pagination
function paginationParam(platform: PlatformConfig): string {
  return platform.type === "github" ? "per_page" : "limit";
}

// =============================================================================
// Shared Parameter Schemas
// =============================================================================

/** Parse "owner/repo" string, return { owner, repo } or null */
function parseRepo(repo: string): { owner: string; repo: string } | null {
  const trimmed = repo.trim();
  const parts = trimmed.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

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
    const resolved = getConfig(instance);
    if (!resolved) {
      const available = listInstances();
      const hint = instance
        ? `Instance "${instance}" not found. Available: ${available}.`
        : `No default instance configured. Run /gh-login to set up. Available: ${available}`;
      throw new Error(hint);
    }
    return resolved;
  }

  /** Resolve instance name for display (always returns the actual ID). */
  function resolveInstanceName(instance?: string): string {
    const resolved = getConfig(instance);
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

      const body: Record<string, unknown> = {
        title: params.title,
      };
      if (params.body) body.body = params.body;
      if (params.labels && params.labels.length > 0) body.labels = params.labels;

      const { status, data } = await apiRequest(
        platform,
        "POST",
        `/repos/${parsed.owner}/${parsed.repo}/issues`,
        body,
      );

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, `/repos/${parsed.owner}/${parsed.repo}/issues`);
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
        const lines = content.text.split("\n");
        const first = lines[0];
        return new Text(theme.fg("success", "✓ ") + theme.fg("muted", first), 0, 0);
      }
      return new Text(theme.fg("success", "✓ Created"), 0, 0);
    },
  });

  // ── gh_issue_list ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue_list",
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
        page: {
          type: "number",
          description: "Page number (default: 1)",
        },
        perPage: {
          type: "number",
          description: "Results per page (default: 30, max: 100)",
        },
      },
      required: ["repo"],
    },
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const query = new URLSearchParams();
      if (params.state) query.set("state", params.state);
      if (params.labels) query.set("labels", params.labels);
      query.set("page", String(params.page ?? 1));
      const pp = paginationParam(platform);
      query.set(pp, String(Math.min(params.perPage ?? 30, 100)));

      const apiPath = `/repos/${parsed.owner}/${parsed.repo}/issues?${query.toString()}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, apiPath);
      }

      const issues = data as Array<Record<string, unknown>>;
      if (issues.length === 0) return "No issues found.";

      return issues
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

      const apiPath = `/repos/${parsed.owner}/${parsed.repo}/issues/${params.number}`;
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
        const lines = content.text.split("\n");
        const first = lines[0];
        return new Text(theme.fg("muted", first), 0, 0);
      }
      return new Text(theme.fg("muted", "Done"), 0, 0);
    },
  });

  // ── gh_issue_comment ───────────────────────────────────────────────────
  pi.registerTool({
    name: "gh_issue_comment",
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
        `/repos/${parsed.owner}/${parsed.repo}/issues/${params.number}/comments`,
        { body: params.body },
      );

      if (status < 200 || status >= 300) {
        return formatApiError(
          status,
          data,
          `/repos/${parsed.owner}/${parsed.repo}/issues/${params.number}/comments`,
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
    description:
      "Create a new pull request. Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        title: titleParam,
        head: {
          type: "string",
          description: "Source branch name (e.g. 'feature/my-change')",
        },
        base: {
          type: "string",
          description: "Target branch name (e.g. 'main')",
        },
        body: { ...bodyParam, description: "PR description in Markdown (optional)" },
        draft: {
          type: "boolean",
          description: "Create as draft PR (GitHub only, optional)",
        },
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
        `/repos/${parsed.owner}/${parsed.repo}/pulls`,
        body,
      );

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, `/repos/${parsed.owner}/${parsed.repo}/pulls`);
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
    description:
      "List pull requests from a Git repository with optional filters. Use the optional 'instance' parameter to target a specific platform.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        repo: repoParam,
        state: { ...stateParam, description: "Filter by state (default: 'open')" },
        page: {
          type: "number",
          description: "Page number (default: 1)",
        },
        perPage: {
          type: "number",
          description: "Results per page (default: 30, max: 100)",
        },
      },
      required: ["repo"],
    },
    async execute(params) {
      const platform = resolveConfig(params.instance).config;
      const parsed = parseRepo(params.repo);
      if (!parsed) return `Error: invalid repo format. Expected "owner/repo", got "${params.repo}"`;

      const query = new URLSearchParams();
      if (params.state) query.set("state", params.state);
      query.set("page", String(params.page ?? 1));
      const pp = paginationParam(platform);
      query.set(pp, String(Math.min(params.perPage ?? 30, 100)));

      const apiPath = `/repos/${parsed.owner}/${parsed.repo}/pulls?${query.toString()}`;
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

      const apiPath = `/repos/${parsed.owner}/${parsed.repo}/pulls/${params.number}`;
      const { status, data } = await apiRequest(platform, "GET", apiPath);

      if (status < 200 || status >= 300) {
        return formatApiError(status, data, apiPath);
      }

      const pr = data as Record<string, unknown>;
      const draftLabel = pr.draft ? " [DRAFT]" : "";
      const mergeable =
        pr.mergeable !== undefined ? `\nMergeable: ${pr.mergeable}` : "";

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

      const apiPath = `/repos/${parsed.owner}/${parsed.repo}`;
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
    async execute(_args, ctx) {
      // Show existing instances
      const existing = loadConfig();
      const existingNames = Object.keys(existing.platforms);
      if (existingNames.length > 0) {
        const label =
          `Existing instances: ${existingNames.map((n) => (n === existing.default ? `${n} ★` : n)).join(", ")}`;
        ctx.ui.notify(label, "info");
      }

      // Step 1: Choose platform type
      const typeChoice = await ctx.ui.select("Select platform type:", [
        { value: "github", label: "GitHub (github.com or GitHub Enterprise)" },
        { value: "gitea", label: "Gitea" },
        { value: "forgejo", label: "Forgejo" },
      ]);
      if (!typeChoice) {
        ctx.ui.notify("Configuration cancelled.", "info");
        return;
      }

      // Step 2: Base URL
      const defaultUrls: Record<string, string> = {
        github: GITHUB_DEFAULT_BASE,
        gitea: "https://gitea.com/api/v1",
        forgejo: "",
      };
      const baseUrl = await ctx.ui.input(
        "Enter API base URL:",
        defaultUrls[typeChoice] || "",
      );
      if (baseUrl === undefined) {
        ctx.ui.notify("Configuration cancelled.", "info");
        return;
      }
      if (!baseUrl.trim()) {
        ctx.ui.notify("Base URL is required.", "error");
        return;
      }

      // Step 3: Token
      const token = await ctx.ui.input("Enter access token:", "");
      if (token === undefined) {
        ctx.ui.notify("Configuration cancelled.", "info");
        return;
      }
      if (!token.trim()) {
        ctx.ui.notify("Access token is required.", "error");
        return;
      }

      // Step 4: Instance name
      const defaultName = existingNames.length > 0 ? `${typeChoice}-${existingNames.length + 1}` : typeChoice;
      const name = await ctx.ui.input("Instance name (used as the 'instance' value in tools):", defaultName);
      if (name === undefined) {
        ctx.ui.notify("Configuration cancelled.", "info");
        return;
      }
      const configName = name.trim() || defaultName;

      const detectedType =
        typeChoice === "github" ? detectPlatform(baseUrl.trim()) : typeChoice;

      // Step 5: Set as default?
      const setDefault =
        existingNames.length === 0
          ? true
          : await ctx.ui.confirm(
              "Set as default?",
              `Make "${configName}" the default instance? (Current: ${existing.default || "none"})`,
            );

      // Save
      const config = loadConfig();
      config.platforms[configName] = {
        type: detectedType as PlatformType,
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        token: token.trim(),
      };
      if (setDefault || existingNames.length === 0) {
        config.default = configName;
      } else if (!config.default) {
        config.default = configName;
      }

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
    async execute(_args, ctx) {
      const config = loadConfig();
      const names = Object.keys(config.platforms);

      if (names.length === 0) {
        ctx.ui.notify("No instances configured. Run /gh-login first.", "info");
        return;
      }

      const choices = names.map((n) => ({
        value: n,
        label: `${n} (${config.platforms[n].type} — ${config.platforms[n].baseUrl})`,
      }));

      const chosen = await ctx.ui.select("Select default instance:", choices);
      if (!chosen) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      config.default = chosen;
      saveConfig(config);
      ctx.ui.notify(`Default instance → "${chosen}". All tools will use this unless 'instance' is specified.`, "info");
    },
  });

  // ── /gh-forget command ─────────────────────────────────────────────────
  pi.registerCommand("gh-forget", {
    description: "Remove a configured platform instance",
    async execute(_args, ctx) {
      const config = loadConfig();
      const names = Object.keys(config.platforms);

      if (names.length === 0) {
        ctx.ui.notify("No instances to remove.", "info");
        return;
      }

      const choices = names.map((n) => ({
        value: n,
        label: `${n} (${config.platforms[n].type} — ${config.platforms[n].baseUrl})`,
      }));

      const target = await ctx.ui.select("Select instance to remove:", choices);
      if (!target) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const ok = await ctx.ui.confirm(
        "Confirm removal",
        `Remove instance "${target}" (${config.platforms[target].type})? This cannot be undone.`,
      );
      if (!ok) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      delete config.platforms[target];
      if (config.default === target) {
        const remaining = Object.keys(config.platforms);
        config.default = remaining.length > 0 ? remaining[0] : "";
      }
      saveConfig(config);

      const msg = config.default
        ? `Removed "${target}". Default is now "${config.default}".`
        : `Removed "${target}". No instances remaining.`;
      ctx.ui.notify(msg, "info");
    },
  });

  // ── /gh-status command ─────────────────────────────────────────────────
  pi.registerCommand("gh-status", {
    description: "Show all configured platform instances",
    async execute(_args, ctx) {
      const config = loadConfig();
      const names = Object.keys(config.platforms);

      if (names.length === 0) {
        ctx.ui.notify("No instances configured. Run /gh-login to set up.", "info");
        return;
      }

      const lines: string[] = [];
      lines.push(`Instances (${names.length} configured):`);
      lines.push("");

      for (const name of names) {
        const p = config.platforms[name];
        const active = name === config.default ? " ★ DEFAULT" : "";
        const maskedToken = p.token.slice(0, 4) + "..." + p.token.slice(-4);
        lines.push(`  ${name}${active}`);
        lines.push(`    Type: ${p.type} | ${p.baseUrl}`);
        lines.push(`    Token: ${maskedToken}`);
        lines.push("");
      }

      lines.push(`Use /gh-default to change the default, /gh-forget to remove an instance.`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
