/**
 * pi-github — Core library (pure functions, no pi API dependency)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// =============================================================================
// Types
// =============================================================================

export type PlatformType = "github" | "gitea" | "forgejo";

export interface PlatformConfig {
  type: PlatformType;
  baseUrl: string;
  token: string;
}

export interface GitPluginConfig {
  platforms: Record<string, PlatformConfig>;
  default: string;
}

// =============================================================================
// Constants
// =============================================================================

const GLOBAL_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "pi-github-config.json");

/** Get project-local config path */
export function getProjectConfigPath(): string {
  return path.join(process.cwd(), ".pi", "pi-github-config.json");
}

/**
 * Resolve config path:
 * - If explicit path set via setConfigPath(), use that
 * - Otherwise use global config (loadConfig merges project + global)
 */
export function getConfigPath(): string {
  return GLOBAL_CONFIG_FILE;
}

export const GITHUB_DEFAULT_BASE = "https://api.github.com";
export const GITEA_DEFAULT_BASE = "https://gitea.com";

// =============================================================================
// Config Persistence
// =============================================================================

let _configPath: string | null = null;

/** Set explicit config path (for testing or project-scoped usage) */
export function setConfigPath(p: string): void {
  _configPath = p;
}

export function loadConfig(): GitPluginConfig {
  if (_configPath) {
    try {
      if (fs.existsSync(_configPath)) return JSON.parse(fs.readFileSync(_configPath, "utf-8"));
    } catch { /* corrupted */ }
    return { platforms: {}, default: "" };
  }

  // Merge: global ← project (project overrides global for same ID)
  const merged: GitPluginConfig = { platforms: {}, default: "" };

  // Load global config first
  if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
    try {
      const global = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8"));
      merged.platforms = { ...global.platforms };
      merged.default = global.default || "";
    } catch { /* corrupted */ }
  }

  // Overlay project config
  const projectPath = getProjectConfigPath();
  if (fs.existsSync(projectPath)) {
    try {
      const project = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
      if (project.platforms) {
        merged.platforms = { ...merged.platforms, ...project.platforms };
      }
      if (project.default) merged.default = project.default;
    } catch { /* corrupted */ }
  }

  return merged;
}

/** Save config to a specific scope */
export function saveConfig(config: GitPluginConfig, project?: boolean): void {
  const file = _configPath ?? (project ? getProjectConfigPath() : GLOBAL_CONFIG_FILE);
  ensureConfigDirFor(file);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
}

function ensureConfigDirFor(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Resolve config by instance name. Falls back to default. */
export function getConfig(
  cfg: GitPluginConfig,
  instance?: string,
): { config: PlatformConfig; name: string } | null {
  const name = instance || cfg.default;
  if (!name || !cfg.platforms[name]) return null;
  return { config: cfg.platforms[name], name };
}

/** List available instance names for error messages */
export function listInstances(cfg: GitPluginConfig): string {
  const names = Object.keys(cfg.platforms);
  if (names.length === 0) return "(none configured)";
  return names.map((n) => (n === cfg.default ? `${n} (default)` : n)).join(", ");
}

// =============================================================================
// HTTP Helpers
// =============================================================================

export function buildHeaders(platform: PlatformConfig): Record<string, string> {
  const headers: Record<string, string> = {};

  if (platform.token) {
    headers.Authorization = platform.type === "github"
      ? `Bearer ${platform.token}`
      : `token ${platform.token}`;
  }

  if (platform.type === "github") {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  } else {
    headers.Accept = "application/json";
  }

  return headers;
}

/** Per_page vs limit for pagination */
export function paginationParam(platform: PlatformConfig): string {
  return platform.type === "github" ? "per_page" : "limit";
}

/** Make an API request to the platform */
export async function apiRequest(
  platform: PlatformConfig,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = buildApiUrl(platform.type, platform.baseUrl, apiPath);
  const headers = buildHeaders(platform);

  const options: RequestInit = { method, headers };

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

// =============================================================================
// Parsing & Validation
// =============================================================================

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/** Parse "owner/repo" string, return { owner, repoName } or null */
export function parseRepo(repo: string): { owner: string; repoName: string } | null {
  const trimmed = repo.trim();
  if (!REPO_PATTERN.test(trimmed)) return null;
  const [owner, repoName] = trimmed.split("/");
  return { owner, repoName };
}

/** Mask a token for display (show first 4 + last 4 chars) */
export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

/** Build the full API URL, auto-appending /api/v1 for Gitea/Forgejo */
export function buildApiUrl(platformType: PlatformType, baseUrl: string, apiPath: string): string {
  let url = baseUrl.replace(/\/+$/, "");
  if ((platformType === "gitea" || platformType === "forgejo") && !url.endsWith("/api/v1")) {
    url += "/api/v1";
  }
  return `${url}${apiPath}`;
}

/** Format an API error for agent consumption with contextual hints */
export function formatApiError(status: number, data: unknown, apiPath: string, platformType?: PlatformType): string {
  const msg =
    data && typeof data === "object" && "message" in data
      ? (data as { message: string }).message
      : JSON.stringify(data);
  let hint = "";
  if (status === 401) {
    hint = " — Token may be expired or invalid. Run /gh-login to reconfigure.";
  } else if (status === 404) {
    hint = " — Repository may not exist, be private, or you may lack access.";
  } else if ((platformType === "gitea" || platformType === "forgejo") && status === 404) {
    hint = " — Also check: Gitea/Forgejo API requires /api/v1 prefix in baseUrl (auto-applied by buildApiUrl).";
  }
  return `API error ${status} on ${apiPath}: ${msg}${hint}`;
}

/** Build query string with correct pagination param per platform */
export function buildListQuery(
  platform: PlatformConfig,
  params: { state?: string; labels?: string; page?: number; perPage?: number },
): string {
  const q = new URLSearchParams();
  if (params.state) q.set("state", params.state);
  if (params.labels) q.set("labels", params.labels);
  q.set("page", String(params.page ?? 1));
  const pp = paginationParam(platform);
  q.set(pp, String(Math.min(params.perPage ?? 30, 100)));
  return q.toString();
}

// =============================================================================
// Field Normalization (cross-platform compatibility)
// =============================================================================

/**
 * Normalize repository fields across platforms.
 * GitHub uses `stargazers_count`, Forgejo/Gitea use `stars_count`.
 */
export function normalizeRepoFields(
  platformType: PlatformType,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...data };
  if (platformType !== "github") {
    // Only add stargazers_count if it's not already present from the response
    if (!("stargazers_count" in data) && "stars_count" in data && data.stars_count !== undefined) {
      result.stargazers_count = data.stars_count;
    }
  }
  return result;
}

/** Decode base64-encoded file content (from GitHub/Gitea contents API) */
export function decodeContent(content: string | undefined, encoding: string | undefined): string {
  if (encoding === "base64" && content) {
    return Buffer.from(content, "base64").toString("utf-8");
  }
  return content ?? "(no content)";
}

/** Build search query params for repo search */
export function buildSearchQuery(params: { q: string; limit?: number; page?: number }): string {
  const q = new URLSearchParams({ q: params.q });
  if (params.limit) q.set("limit", String(params.limit));
  if (params.page) q.set("page", String(params.page));
  return q.toString();
}
