/**
 * pi-github — Multi-platform Git forge automation (GitHub / Gitea / Forgejo)
 *
 * Provides tools and commands for interacting with Git hosting platforms.
 * Supports configurable base URL and authorization for self-hosted instances.
 * Uses gh_ prefix since all three platforms follow GitHub-compatible REST conventions.
 *
 * ## What this extension provides
 *
 * - Tools (21): gh_issue_create, gh_issue_list, gh_issue_get, gh_issue_comment,
 *               gh_issue_update, gh_pr_create, gh_pr_list, gh_pr_get, gh_pr_update,
 *               gh_merge_pr, gh_list_contents, gh_get_file, gh_list_branches,
 *               gh_list_comments, gh_list_labels, gh_list_milestones, gh_search_repos,
 *               gh_repo_get, gh_instance_list, gh_instance_check
 *   → Registered in tools.ts via GitClient class
 *
 * - Commands: /gh-login, /gh-default, /gh-forget, /gh-status
 *
 * ## Architecture
 *
 *   index.ts   ← Entry point + commands
 *   tools.ts   ← All 21 tool registrations
 *   client.ts  ← GitClient class (typed HTTP wrapper)
 *   lib.ts     ← Pure functions (config, auth, URL building, error formatting)
 *
 * ## Testing
 *
 *   pi -e ./tools/pi-github/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import { registerTools } from "./tools";
import {
  formatApiError,
  getConfig,
  getConfigPath,
  getProjectConfigPath,
  GITHUB_DEFAULT_BASE,
  GITEA_DEFAULT_BASE,
  listInstances,
  loadConfig,
  maskToken,
  paginationParam,
  parseRepo,
  saveConfig,
  type PlatformConfig,
  type PlatformType,
} from "./lib";
import { GitClient } from "./client";

export default function (pi: ExtensionAPI) {
  // Register all 21 tools
  registerTools(pi);

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

  function resolveInstanceName(instance?: string): string {
    return resolveConfig(instance).name;
  }

  // ── Shared parameter schema for instance ─────────────────────────────
  const instanceParam = {
    type: "string" as const,
    description: "Platform instance ID to operate on. Omit to use the default (set via /gh-default). Use /gh-status to list all available instance IDs.",
  };

  // ═══════════════════════════════════════════════════════════
  //  Commands — Interactive wizard + quick mode
  // ═══════════════════════════════════════════════════════════
  //
  //  UX principles:
  //    1. Visible defaults — prompt text shows what Enter gives you
  //    2. Example placeholders — required fields show format examples
  //    3. Purpose hints — explain what each field controls
  //    4. Structured summary — show all saved fields to verify
  //    5. Detail + confirm — remove shows full instance info before deleting

  pi.registerCommand("gh-login", {
    description: "Add or update a platform instance (GitHub, Gitea, or Forgejo)",
    async handler(_args, ctx) {
      const existing = loadConfig();
      const existingNames = Object.keys(existing.platforms);
      if (existingNames.length > 0) {
        ctx.ui.notify(`Existing instances: ${listInstances(existing)}`, "info");
      }

      // 1. Platform type
      const typeChoice = await ctx.ui.select("Select platform type", [
        "GitHub (github.com or GitHub Enterprise)",
        "Gitea",
        "Forgejo",
      ]);
      if (!typeChoice) { ctx.ui.notify("Cancelled.", "info"); return; }
      const platformType: PlatformType = typeChoice.toLowerCase().startsWith("github")
        ? "github" : typeChoice === "Gitea" ? "gitea" : "forgejo";

      // 2. Base URL — show default + examples
      const defaultUrls: Record<string, string> = { github: GITHUB_DEFAULT_BASE, gitea: GITEA_DEFAULT_BASE, forgejo: "" };
      const defaultUrl = defaultUrls[platformType] || "";
      const urlPrompt = [
        `API base URL${defaultUrl ? ` [default: ${defaultUrl}]` : " (required)"}`,
        platformType !== "github" ? "  e.g. https://gitea.mycompany.com or https://forgejo.example.com" : "  e.g. https://api.github.com or https://github.mycompany.com/api/v3",
        platformType !== "github" ? "  Auto-appends /api/v1 for Gitea/Forgejo" : "",
        "  Supports https:// and http://",
      ].filter(Boolean).join("\n");
      const baseUrlInput = await ctx.ui.input(urlPrompt, defaultUrl || "https://your-domain.com");
      if (baseUrlInput === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      let baseUrl = baseUrlInput.trim() || defaultUrl;
      if (!baseUrl) { ctx.ui.notify("Base URL is required.", "error"); return; }
      baseUrl = baseUrl.replace(/\/api\/v1\/?$/, "").replace(/\/+$/, "");

      // 3. Access token — show format example
      const tokenPrompt = [
        "Access token (required)",
        platformType === "github" ? "  e.g. ghp_xxxxxxxxxxxxxxxxxxxx or github_pat_..." : "  e.g. 83f9a1e2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8",
        "  Personal access token with repo/issue scope",
      ].join("\n");
      const tokenInput = await ctx.ui.input(tokenPrompt, platformType === "github" ? "ghp_..." : "");
      if (tokenInput === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      const token = tokenInput.trim();
      if (!token) { ctx.ui.notify("Token is required.", "error"); return; }

      // 4. Instance ID — show default
      const defaultName = existingNames.length > 0 ? `${platformType}-${existingNames.length + 1}` : platformType;
      const namePrompt = [
        "Instance ID",
        `  Default: ${defaultName}`,
        "  Used in tool calls: gh_* tools require this value",
      ].join("\n");
      const nameInput = await ctx.ui.input(namePrompt, defaultName);
      if (nameInput === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      const configName = nameInput.trim() || defaultName;

      // 5. Set as default?
      const setDefault = existingNames.length === 0 ? true
        : await ctx.ui.confirm("Set as default?", `Make "${configName}" the default? (Current: ${existing.default || "none"})`);

      // 6. Scope — show file paths
      const scopeLines = [
        "Save to:",
        `  Global:  ~/.pi/agent/pi-github-config.json  (all workspaces)`,
        `  Project: ${ctx.cwd}/.pi/pi-github-config.json (this workspace only)`,
      ].join("\n");
      ctx.ui.notify(scopeLines, "info");
      const scopeChoice = await ctx.ui.select("Save instance to project config or global?", [
        "Global (~/.pi/agent/) — available in all workspaces",
        "Project (.pi/) — this workspace only",
      ]);
      if (scopeChoice === undefined) { ctx.ui.notify("Cancelled.", "info"); return; }
      const isProject = scopeChoice.startsWith("Project");

      // Check overwrite
      const exists = existing.platforms[configName] !== undefined;
      if (exists) {
        const ok = await ctx.ui.confirm("Overwrite?", `Instance "${configName}" already exists. Overwrite?`);
        if (!ok) { ctx.ui.notify("Cancelled.", "info"); return; }
      }

      // Save
      const config = loadConfig();
      config.platforms[configName] = { type: platformType, baseUrl, token };
      if (setDefault || existingNames.length === 0) config.default = configName;
      else if (!config.default) config.default = configName;
      saveConfig(config, isProject);

      // Structured summary
      const action = exists ? "Updated" : "Added";
      const summary = [
        `${action} platform instance:`,
        `  ID:       ${configName}`,
        `  Type:     ${platformType}`,
        `  URL:      ${baseUrl}`,
        `  Token:    ${maskToken(token)}`,
        config.default === configName ? `  Default:  yes` : "",
        `  Config:   ${isProject ? ctx.cwd + "/.pi/pi-github-config.json" : "~/.pi/agent/pi-github-config.json"}`,
      ].filter(Boolean).join("\n");
      ctx.ui.notify(summary, "info");
    },
  });

  pi.registerCommand("gh-default", {
    description: "Set the default platform instance for subsequent tool calls",
    async handler(_args, ctx) {
      const config = loadConfig();
      const scope = fs.existsSync(getProjectConfigPath()) ? "merged (global ← project)" : "global";
      const names = Object.keys(config.platforms);
      if (names.length === 0) { ctx.ui.notify("No instances configured. Run /gh-login first.", "info"); return; }
      const choices = names.map((n) => `${n} (${config.platforms[n].type} — ${config.platforms[n].baseUrl})`);
      const chosen = await ctx.ui.select(`Select default instance (${scope} config):`, choices);
      if (!chosen) { ctx.ui.notify("Cancelled.", "info"); return; }
      config.default = chosen.split(" ")[0];
      saveConfig(config);
      ctx.ui.notify(`Default → "${config.default}" (${scope}).`, "info");
    },
  });

  pi.registerCommand("gh-forget", {
    description: "Remove a configured platform instance",
    async handler(_args, ctx) {
      const config = loadConfig();
      const names = Object.keys(config.platforms);
      if (names.length === 0) { ctx.ui.notify("No instances to remove.", "info"); return; }

      const choices = names.map((n) => {
        const p = config.platforms[n];
        const active = n === config.default ? " ★ DEFAULT" : "";
        return `${n}${active} — ${p.type} | ${p.baseUrl}`;
      });
      const target = await ctx.ui.select("Select instance to remove:", choices);
      if (!target) { ctx.ui.notify("Cancelled.", "info"); return; }
      const targetName = target.split(" ")[0];
      const p = config.platforms[targetName];

      // Show detail and confirm
      const detail = [
        `  ID:    ${targetName}${targetName === config.default ? " (default)" : ""}`,
        `  Type:  ${p.type}`,
        `  URL:   ${p.baseUrl}`,
        `  Token: ${maskToken(p.token)}`,
      ].join("\n");
      const ok = await ctx.ui.confirm("Confirm removal", detail);
      if (!ok) { ctx.ui.notify("Cancelled.", "info"); return; }

      delete config.platforms[targetName];
      if (config.default === targetName) {
        const remaining = Object.keys(config.platforms);
        config.default = remaining.length > 0 ? remaining[0] : "";
      }
      saveConfig(config);
      ctx.ui.notify(config.default ? `Removed "${targetName}". Default → "${config.default}".` : `Removed "${targetName}". No instances remaining.`, "info");
    },
  });

  pi.registerCommand("gh-status", {
    description: "Show all configured platform instances",
    async handler(_args, ctx) {
      const config = loadConfig();
      const scope = fs.existsSync(getProjectConfigPath()) ? "merged (global ← project)" : "global";
      const names = Object.keys(config.platforms);
      if (names.length === 0) { ctx.ui.notify("No instances configured. Run /gh-login to set up.", "info"); return; }
      const lines = [`Instances (${names.length}) — ${scope}:`, ""];
      for (const name of names) {
        const p = config.platforms[name];
        lines.push(`  ${name}${name === config.default ? " ★ DEFAULT" : ""}`, `    ${p.type} | ${p.baseUrl}`, `    Token: ${maskToken(p.token)}`, "");
      }
      lines.push("/gh-default to switch, /gh-forget to remove.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
