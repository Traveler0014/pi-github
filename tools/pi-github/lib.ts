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

export const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "pi-github-config.json");

export const GITHUB_DEFAULT_BASE = "https://api.github.com";
export const GITEA_DEFAULT_BASE = "https://gitea.com/api/v1";

// =============================================================================
// Platform Detection
// =============================================================================

/** Detect platform from base URL */
export function detectPlatform(baseUrl: string): PlatformType {
  const url = baseUrl.toLowerCase();
  if (
    url.includes("api.github.com") ||
    url.includes("github.com/api/v3") ||
    url === "https://api.github.com"
  ) {
    return "github";
  }
  return "gitea";
}

// =============================================================================
// Config Persistence
// =============================================================================

export function ensureConfigDir(): void {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): GitPluginConfig {
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

export function saveConfig(config: GitPluginConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
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
  if (platform.type === "github") {
    return {
      Authorization: `Bearer ${platform.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
  return {
    Authorization: `token ${platform.token}`,
    Accept: "application/json",
  };
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
  const url = buildApiUrl(platform.baseUrl, apiPath);
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

/** Build the full API URL */
export function buildApiUrl(baseUrl: string, apiPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${apiPath}`;
}

/** Format an API error for agent consumption */
export function formatApiError(status: number, data: unknown, apiPath: string): string {
  const msg =
    data && typeof data === "object" && "message" in data
      ? (data as { message: string }).message
      : JSON.stringify(data);
  return `API error ${status} on ${apiPath}: ${msg}`;
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
