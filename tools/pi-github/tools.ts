/**
 * pi-github — Tool registration (20 tools).
 *
 * All tools follow the same pattern:
 *   1. resolveConfig → parseRepo → GitClient → textResult
 *   2. renderCall + renderResult for compact TUI display
 *   3. Cross-platform: GitHub / Gitea / Forgejo
 *
 * Naming convention: gh_<resource>_<verb> (e.g. gh_issue_create, gh_pr_merge).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { GitClient } from "./client";
import {
  branchRef,
  buildListQuery,
  commitSha,
  decodeContent,
  getConfig,
  listInstances,
  loadConfig,
  maskToken,
  normalizeRepoFields,
  parseRepo,
  type PlatformConfig,
} from "./lib";

// ── Helpers ────────────────────────────────────────────────

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/** Shared "invalid repo format" error result */
function invalidRepo() {
  return textResult("Error: invalid repo format. Expected owner/repo.", { error: "invalid repo format" });
}

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

function resolveInstanceName(instance?: string): string {
  return resolveConfig(instance).name;
}

// ── Shared Parameter Schemas ───────────────────────────────

const instanceParam = {
  type: "string" as const,
  description: "Platform instance ID to operate on. Omit to use the default (set via /gh-default).",
};

const repoParam = {
  type: "string" as const,
  description: "Repository in owner/repo format (e.g. 'torvalds/linux')",
};

const titleParam = { type: "string" as const, description: "Title of the issue or pull request" };
const bodyParam = { type: "string" as const, description: "Body/description text (Markdown supported)" };
const stateParam = { type: "string" as const, enum: ["open", "closed", "all"], description: "Filter by state (default: 'open')" };
const numberParam = { type: "number" as const, description: "Issue or PR number" };

// ── Tool Registration ──────────────────────────────────────

export function registerTools(pi: ExtensionAPI) {

  // ══════════════════════════════════════════════════════════
  //  gh_issue_create
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_issue_create",
    label: "Create Issue",
    description: "Create a new issue on a Git repository.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam, repo: repoParam, title: titleParam,
        body: { ...bodyParam, description: "Issue body in Markdown (optional)" },
        labels: { type: "array", items: { type: "string" }, description: "Labels to apply (optional)" },
      },
      required: ["repo", "title"],
    },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      const client = new GitClient(platform);
      const body: Record<string, unknown> = { title: params.title };
      if (params.body) body.body = params.body;
      if (params.labels?.length) body.labels = params.labels;
      try {
        const d = await client.createIssue(parsed.owner, parsed.repoName, body) as Record<string, unknown>;
        return textResult(`[${inst}] Issue created: #${d.number} — ${d.title}\nURL: ${d.html_url}`, { number: d.number, title: d.title, url: d.html_url, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`[${inst}] issue create`)) + " " + theme.fg("accent", args.repo);
      text += " " + theme.fg("muted", `"${args.title}"`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const t = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Created";
      return new Text(theme.fg("success", t), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_issue_list
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_issue_list",
    label: "List Issues",
    description: "List issues from a Git repository with optional filters.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam, repo: repoParam,
        state: { ...stateParam, description: "Filter by state (default: 'open')" },
        labels: { type: "string", description: "Comma-separated label names (optional)" },
        page: { type: "number", description: "Page number (default: 1)" },
        perPage: { type: "number", description: "Results per page (default: 30, max: 100)" },
      },
      required: ["repo"],
    },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      const client = new GitClient(platform);
      try {
        const qs = buildListQuery(platform, { state: params.state, labels: params.labels, page: params.page, perPage: params.perPage });
        const issues = await client.listIssues(parsed.owner, parsed.repoName, qs) as Array<Record<string, unknown>>;
        const filtered = issues.filter((i) => !i.pull_request);
        if (!filtered.length) return textResult(`[${inst}] No issues found.`, { count: 0, instance: inst });
        const text = filtered.map((i) => {
          const labels = Array.isArray(i.labels) && i.labels.length ? ` [${(i.labels as Array<{ name: string }>).map((l) => l.name).join(", ")}]` : "";
          return `#${i.number} ${i.title} (${i.state})${labels}\n  ${i.html_url}`;
        }).join("\n\n");
        return textResult(text, { count: filtered.length, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] issues list`)) + " " + theme.fg("accent", args.repo), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} issue(s)`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_issue_get
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_issue_get",
    label: "Get Issue",
    description: "Get detailed information about a specific issue.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam, number: numberParam }, required: ["repo", "number"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const i = await client.getIssue(parsed.owner, parsed.repoName, params.number) as Record<string, unknown>;
        const labels = Array.isArray(i.labels) && i.labels.length ? `\nLabels: ${(i.labels as Array<{ name: string }>).map((l) => l.name).join(", ")}` : "";
        const assignee = i.assignee && typeof i.assignee === "object" ? `\nAssignee: ${(i.assignee as { login: string }).login}` : "";
        return textResult([`#${i.number} ${i.title}`, `State: ${i.state}`, `URL: ${i.html_url}${labels}${assignee}`, "", i.body || "(no description)"].join("\n"), { number: i.number, title: i.title, state: i.state, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] issue`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const t = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Done";
      return new Text(theme.fg("muted", t), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_issue_comment
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_issue_comment",
    label: "Comment",
    description: "Add a comment to an existing issue or pull request.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam, number: numberParam, body: bodyParam }, required: ["repo", "number", "body"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const c = await client.createComment(parsed.owner, parsed.repoName, params.number, params.body) as Record<string, unknown>;
        return textResult(`[${inst}] Comment added: ${c.html_url}`, { url: c.html_url, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] comment`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`), 0, 0);
    },
    renderResult(_r, _o, theme, _c) { return new Text(theme.fg("success", "Comment added"), 0, 0); },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_issue_update
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_issue_update",
    label: "Update Issue",
    description: "Update an existing issue — change title, body, state, labels, assignees, or milestone. Only provided fields are updated.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam, repo: repoParam, number: numberParam,
        title: { type: "string", description: "New title (omit to keep current)" },
        body: { type: "string", description: "New body in Markdown (omit to keep current)" },
        state: { type: "string", enum: ["open", "closed"], description: "Set state" },
        labels: { type: "array", items: { type: "string" }, description: "Replacement labels" },
        assignees: { type: "array", items: { type: "string" }, description: "Replacement assignees" },
        milestone: { anyOf: [{ type: "number" }, { type: "null" }], description: "Milestone number, or null to clear" },
      },
      required: ["repo", "number"],
    },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      const update: Record<string, unknown> = {};
      if (params.title !== undefined) update.title = params.title;
      if (params.body !== undefined) update.body = params.body;
      if (params.state !== undefined) update.state = params.state;
      if (params.labels !== undefined) update.labels = params.labels;
      if (params.assignees !== undefined) update.assignees = params.assignees;
      if (params.milestone !== undefined) update.milestone = params.milestone;
      if (!Object.keys(update).length) return textResult("Error: at least one field to update required.", { error: "no fields" });
      try {
        const client = new GitClient(platform);
        const d = await client.updateIssue(parsed.owner, parsed.repoName, params.number, update) as Record<string, unknown>;
        return textResult(`[${inst}] Issue updated: #${d.number} — ${d.title}\nState: ${d.state}\nURL: ${d.html_url}`, { number: d.number, title: d.title, state: d.state, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`[${inst}] issue update`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      if (args.state) text += " " + theme.fg(args.state === "closed" ? "error" : "success", args.state);
      return new Text(text, 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const t = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Updated";
      return new Text(theme.fg("success", t), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_pr_create
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_pr_create",
    label: "Create PR",
    description: "Create a new pull request.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam, repo: repoParam, title: titleParam,
        head: { type: "string", description: "Source branch name" },
        base: { type: "string", description: "Target branch name" },
        body: { ...bodyParam, description: "PR description in Markdown (optional)" },
        draft: { type: "boolean", description: "Create as draft PR (GitHub only, optional)" },
      },
      required: ["repo", "title", "head", "base"],
    },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const body: Record<string, unknown> = { title: params.title, head: params.head, base: params.base };
        if (params.body) body.body = params.body;
        if (params.draft && platform.type === "github") body.draft = true;
        const d = await client.createPR(parsed.owner, parsed.repoName, body) as Record<string, unknown>;
        const draftLabel = d.draft ? " [DRAFT]" : "";
        return textResult(`[${inst}] PR created: #${d.number} — ${d.title}${draftLabel}\nURL: ${d.html_url}\nBranch: ${branchRef(d.head)} → ${branchRef(d.base)}`, { number: d.number, title: d.title, url: d.html_url, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`[${inst}] PR create`)) + " " + theme.fg("accent", args.repo);
      text += " " + theme.fg("muted", `${args.head}→${args.base}`);
      text += " " + theme.fg("dim", `"${args.title}"`);
      if (args.draft) text += theme.fg("warning", " draft");
      return new Text(text, 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const t = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Created";
      return new Text(theme.fg("success", t), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_pr_list
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_pr_list",
    label: "List PRs",
    description: "List pull requests from a Git repository.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam, repo: repoParam,
        state: { ...stateParam, description: "Filter by state (default: 'open')" },
        page: { type: "number", description: "Page number (default: 1)" },
        perPage: { type: "number", description: "Results per page (default: 30, max: 100)" },
      },
      required: ["repo"],
    },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const qs = buildListQuery(platform, { state: params.state, page: params.page, perPage: params.perPage });
        const prs = await client.listPRs(parsed.owner, parsed.repoName, qs) as Array<Record<string, unknown>>;
        if (!prs.length) return textResult(`[${inst}] No pull requests found.`, { count: 0, instance: inst });
        const text = prs.map((pr) => `#${pr.number} ${pr.title} (${pr.state})${pr.draft ? " [DRAFT]" : ""}\n  ${branchRef(pr.head)} → ${branchRef(pr.base)}\n  ${pr.html_url}`).join("\n\n");
        return textResult(text, { count: prs.length, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] PRs list`)) + " " + theme.fg("accent", args.repo), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} PR(s)`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_pr_get
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_pr_get",
    label: "Get PR",
    description: "Get detailed information about a specific pull request.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam, number: numberParam }, required: ["repo", "number"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const pr = await client.getPR(parsed.owner, parsed.repoName, params.number) as Record<string, unknown>;
        const mergeable = pr.mergeable !== undefined ? `\nMergeable: ${pr.mergeable}` : "";
        return textResult([`#${pr.number} ${pr.title}${pr.draft ? " [DRAFT]" : ""}`, `State: ${pr.state}`, `Branch: ${branchRef(pr.head)} → ${branchRef(pr.base)}`, `URL: ${pr.html_url}${mergeable}`, "", pr.body || "(no description)"].join("\n"), { number: pr.number, title: pr.title, state: pr.state, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] PR`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const t = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Done";
      return new Text(theme.fg("muted", t), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_pr_update
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_pr_update",
    label: "Update PR",
    description: "Update an existing pull request — change title, body, or state.",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam, repo: repoParam, number: numberParam,
        title: { type: "string", description: "New title (omit to keep current)" },
        body: { type: "string", description: "New body (omit to keep current)" },
        state: { type: "string", enum: ["open", "closed"], description: "Set state" },
      },
      required: ["repo", "number"],
    },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      const update: Record<string, unknown> = {};
      if (params.title !== undefined) update.title = params.title;
      if (params.body !== undefined) update.body = params.body;
      if (params.state !== undefined) update.state = params.state;
      if (!Object.keys(update).length) return textResult("Error: at least one field to update required.", { error: "no fields" });
      try {
        const client = new GitClient(platform);
        const d = await client.updatePR(parsed.owner, parsed.repoName, params.number, update) as Record<string, unknown>;
        return textResult(`[${inst}] PR #${d.number} updated: ${d.title}\nState: ${d.state}\nURL: ${d.html_url}`, { number: d.number, title: d.title, state: d.state, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`[${inst}] PR update`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      if (args.state) text += " " + theme.fg(args.state === "closed" ? "error" : "success", args.state);
      return new Text(text, 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const t = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Updated";
      return new Text(theme.fg("success", t), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_pr_merge
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_pr_merge",
    label: "Merge PR",
    description: "Merge a pull request (merge, rebase, or squash). Optionally delete the source branch (Gitea/Forgejo only).",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam, repo: repoParam, number: numberParam,
        method: { type: "string", enum: ["merge", "rebase", "squash"], description: "Merge method. Default: merge" },
        deleteBranch: { type: "boolean", description: "Delete source branch after merge (Gitea/Forgejo only; ignored on GitHub). Default: false" },
      },
      required: ["repo", "number"],
    },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const result = await client.mergePR(parsed.owner, parsed.repoName, params.number, params.method, params.deleteBranch);
        return textResult(`[${inst}] ${result.merged ? "Merged" : "Failed to merge"} PR #${params.number}`, { merged: result.merged, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`[${inst}] merge PR`)) + " " + theme.fg("accent", `${args.repo}#${args.number}`);
      if (args.method) text += " " + theme.fg("muted", `(${args.method})`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const d = result.details as Record<string, unknown> | undefined;
      return new Text(theme.fg(d?.merged ? "success" : "error", d?.merged ? "Merged" : "Failed"), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_repo_get
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_repo_get",
    label: "Get Repo",
    description: "Get information about a Git repository.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam }, required: ["repo"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const r = normalizeRepoFields(platform.type, await client.getRepo(parsed.owner, parsed.repoName) as Record<string, unknown>) as Record<string, unknown>;
        const lang = r.language ? `\nLanguage: ${r.language}` : "";
        const license = r.license && typeof r.license === "object" ? `\nLicense: ${(r.license as { spdx_id: string }).spdx_id}` : "";
        const topics = Array.isArray(r.topics) && r.topics.length ? `\nTopics: ${(r.topics as string[]).join(", ")}` : "";
        return textResult([`[${inst}] ${r.full_name}`, `${r.description || "(no description)"}`, "", `Stars: ${r.stargazers_count ?? "?"} | Forks: ${r.forks_count ?? "?"}`, `Open Issues: ${r.open_issues_count ?? "?"} | Default Branch: ${r.default_branch}`, `URL: ${r.html_url} | Clone: ${r.clone_url}${lang}${license}${topics}`].join("\n"), { fullName: r.full_name, stars: r.stargazers_count, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] repo`)) + " " + theme.fg("accent", args.repo), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const t = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "Done";
      return new Text(theme.fg("muted", t), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_branch_list
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_branch_list",
    label: "List Branches",
    description: "List branches in a repository with commit info and protection status.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam, perPage: { type: "number", description: "Results per page (default: 30, max: 100)" } }, required: ["repo"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const branches = await client.listBranches(parsed.owner, parsed.repoName, params.perPage ?? 30) as Array<Record<string, unknown>>;
        if (!branches.length) return textResult(`[${inst}] No branches.`, { count: 0, instance: inst });
        const text = branches.map((b) => {
          const sha = commitSha(b);
          return `- ${b.name} (${sha})${b.protected ? " [protected]" : ""}`;
        }).join("\n");
        return textResult(text, { count: branches.length, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] branches`)) + " " + theme.fg("accent", args.repo), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} branch(es)`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_content_list
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_content_list",
    label: "List Contents",
    description: "List files and directories in a repository path (like ls).",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam, path: { type: "string", description: "Directory path. Empty for root." }, ref: { type: "string", description: "Branch or commit SHA" } }, required: ["repo"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const data = await client.listContents(parsed.owner, parsed.repoName, params.path, params.ref);
        const entries = Array.isArray(data) ? data : [data];
        if (!entries.length) return textResult(`[${inst}] Directory is empty.`, { count: 0, instance: inst });
        const text = (entries as Array<Record<string, unknown>>).map((e) => `${e.type === "dir" ? "📁" : e.type === "symlink" ? "🔗" : "📄"} ${e.name} (${e.type}) ${e.size} bytes`).join("\n");
        return textResult(text, { count: entries.length, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`[${inst}] ls`)) + " " + theme.fg("accent", args.repo);
      if (args.path) text += " " + theme.fg("muted", args.path);
      return new Text(text, 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} entr${count === 1 ? "y" : "ies"}`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_file_get
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_file_get",
    label: "Get File",
    description: "Read a file from a repository. Returns decoded file content.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam, path: { type: "string", description: "File path in the repository." }, ref: { type: "string", description: "Branch or commit SHA" } }, required: ["repo", "path"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const f = await client.getFile(parsed.owner, parsed.repoName, params.path, params.ref) as Record<string, unknown>;
        const content = decodeContent(f.content as string | undefined, f.encoding as string | undefined);
        return { content: [{ type: "text", text: content }], details: { sha: f.sha, size: f.size, path: f.path, instance: inst } };
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      let text = theme.fg("toolTitle", theme.bold(`[${inst}] cat`)) + " " + theme.fg("accent", args.repo);
      if (args.path) text += " " + theme.fg("muted", args.path);
      return new Text(text, 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const size = (result.details as Record<string, unknown>)?.size;
      return new Text(theme.fg("muted", `${size ?? "?"} bytes`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_comment_list
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_comment_list",
    label: "List Comments",
    description: "List comments on an issue or pull request.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam, number: numberParam }, required: ["repo", "number"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const data = await client.listComments(parsed.owner, parsed.repoName, params.number) as Array<Record<string, unknown>>;
        const arr = Array.isArray(data) ? data : [];
        if (!arr.length) return textResult(`No comments.`, { count: 0, instance: inst });
        const text = arr.map((c) => `@${(c.user as { login?: string } | undefined)?.login ?? "?"} at ${c.created_at}:\n${c.body}\n---`).join("\n");
        return textResult(text, { count: arr.length, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] comments`)) + theme.fg("accent", ` ${args.repo}#${args.number}`), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} comment(s)`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_label_list
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_label_list",
    label: "List Labels",
    description: "List all labels in a repository.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam }, required: ["repo"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const data = await client.listLabels(parsed.owner, parsed.repoName) as Array<Record<string, unknown>>;
        const arr = Array.isArray(data) ? data : [];
        if (!arr.length) return textResult(`No labels.`, { count: 0, instance: inst });
        const text = arr.map((l) => `- ${l.name}${l.color ? ` (#${l.color})` : ""}`).join("\n");
        return textResult(text, { count: arr.length, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] labels`)) + theme.fg("accent", ` ${args.repo}`), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} label(s)`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_milestone_list
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_milestone_list",
    label: "List Milestones",
    description: "List milestones in a repository.",
    parameters: { type: "object", properties: { instance: instanceParam, repo: repoParam }, required: ["repo"] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      const parsed = parseRepo(params.repo);
      if (!parsed) return invalidRepo();
      try {
        const client = new GitClient(platform);
        const data = await client.listMilestones(parsed.owner, parsed.repoName) as Array<Record<string, unknown>>;
        const arr = Array.isArray(data) ? data : [];
        if (!arr.length) return textResult(`No milestones.`, { count: 0, instance: inst });
        const text = arr.map((m) => `- #${m.number} "${m.title}" [${m.state}]`).join("\n");
        return textResult(text, { count: arr.length, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] milestones`)) + theme.fg("accent", ` ${args.repo}`), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} milestone(s)`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_repo_search
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_repo_search",
    label: "Search Repos",
    description: "Search repositories by keyword (Gitea/Forgejo only).",
    parameters: {
      type: "object",
      properties: {
        instance: instanceParam,
        query: { type: "string", description: "Search keyword." },
        limit: { type: "number", description: "Max results. Default: 10." },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      try {
        const client = new GitClient(platform);
        const raw = await client.searchRepos(params.query, params.limit ?? 10) as Record<string, unknown>;
        const repos = (raw.data as Array<Record<string, unknown>> | undefined) ?? (Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []);
        if (!repos.length) return textResult(`No repositories found.`, { count: 0, instance: inst });
        const text = repos.map((r) => `- ${r.full_name} ⭐${r.stargazers_count ?? r.stars_count ?? 0} ${r.description ?? ""}`).join("\n");
        return textResult(text, { count: repos.length, instance: inst });
      } catch (e) { return textResult((e as Error).message, { error: "api error", instance: inst }); }
    },
    renderCall(args, theme, _c) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] repo search`)) + theme.fg("accent", ` ${args.query}`), 0, 0);
    },
    renderResult(result, _o, theme, _c) {
      const count = (result.details as Record<string, unknown>)?.count ?? 0;
      return new Text(theme.fg("muted", `${count} result(s)`), 0, 0);
    },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_instance_list
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_instance_list",
    label: "List Instances",
    description: "List all configured platform instances with their types, URLs, and which is the default.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const config = loadConfig();
      const names = Object.keys(config.platforms);
      if (!names.length) return textResult("No instances configured. Run /gh-login to set up.", { count: 0 });
      const lines = [`Instances (${names.length}):`, ""];
      for (const name of names) {
        const p = config.platforms[name];
        const active = name === config.default ? " ★ DEFAULT" : "";
        lines.push(`  ${name}${active}`, `    type: ${p.type} | url: ${p.baseUrl}`, `    token: ${maskToken(p.token)}`, "");
      }
      return textResult(lines.join("\n"), { count: names.length, default: config.default, instances: names });
    },
    renderCall(_a, theme) { return new Text(theme.fg("toolTitle", theme.bold("instances list")), 0, 0); },
    renderResult(result, _o, theme) { return new Text(theme.fg("muted", `${(result.details as any)?.count ?? 0} instance(s)`), 0, 0); },
  });

  // ══════════════════════════════════════════════════════════
  //  gh_instance_check
  // ══════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gh_instance_check",
    label: "Check Instance",
    description: "Check connectivity and token validity for a configured platform instance.",
    parameters: { type: "object", properties: { instance: instanceParam }, required: [] },
    async execute(_id, params) {
      const { config: platform, name: inst } = resolveConfig(params.instance);
      try {
        const client = new GitClient(platform);
        const d = await client.getVersion() as Record<string, unknown>;
        const statusInfo = d.version ? `version: ${d.version}` : "connected";
        return textResult(`[${inst}] ${platform.type}\nURL: ${platform.baseUrl}\nToken: ${maskToken(platform.token)}\nStatus: OK (${statusInfo})`, { ok: true, instance: inst });
      } catch (e: any) {
        const lines = [`[${inst}] ${platform.type}`, `URL: ${platform.baseUrl}`, `Token: ${maskToken(platform.token)}`, `Status: ${(e as Error).message}`];
        return textResult(lines.join("\n"), { ok: false, instance: inst, error: (e as Error).message });
      }
    },
    renderCall(args, theme) {
      const inst = resolveInstanceName(args.instance);
      return new Text(theme.fg("toolTitle", theme.bold(`[${inst}] check`)), 0, 0);
    },
    renderResult(result, _o, theme) {
      const d = result.details as Record<string, unknown> | undefined;
      return new Text(theme.fg(d?.ok ? "success" : "error", d?.ok ? `OK (${d.instance ?? "?"})` : "Failed"), 0, 0);
    },
  });
}
