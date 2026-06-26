/**
 * GitClient — Multi-platform Git forge HTTP client.
 *
 * Wraps the low-level apiRequest/buildApiUrl helpers from lib.ts
 * into a typed class, handling URL construction, auth headers,
 * and contextual error formatting per platform.
 */

import type { PlatformConfig, PlatformType } from "./lib";
import { apiRequest, buildApiUrl, buildHeaders, formatApiError } from "./lib";

export class GitClient {
  constructor(private platform: PlatformConfig) {}

  get type(): PlatformType { return this.platform.type; }
  get baseUrl(): string { return this.platform.baseUrl; }
  get token(): string { return this.platform.token; }

  // ── low-level request ──────────────────────────────────

  /**
   * Make an API request.
   * - request(path)           → GET
   * - request(method, path)   → specified method
   * - request(method, path, body) → specified method with JSON body
   */
  private async request<T = unknown>(methodOrPath: string, pathOrBody?: unknown, bodyOrNothing?: unknown): Promise<T> {
    let method: string;
    let path: string;
    let body: unknown;

    if (pathOrBody === undefined && bodyOrNothing === undefined) {
      // GET shorthand: request(path)
      method = "GET";
      path = methodOrPath;
    } else if (bodyOrNothing === undefined) {
      // POST/PATCH/PUT/GET with explicit method
      method = methodOrPath;
      path = pathOrBody as string;
    } else {
      method = methodOrPath;
      path = pathOrBody as string;
      body = bodyOrNothing;
    }
    const url = buildApiUrl(this.platform.type, this.platform.baseUrl, path);
    const headers = buildHeaders(this.platform);
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    let data: unknown;
    try { data = await response.json(); } catch { data = null; }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(formatApiError(response.status, data, path, this.platform.type));
    }

    return data as T;
  }

  // Overload that returns raw status+data (for merge check etc.)
  async rawRequest(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    return apiRequest(this.platform, method, path, body);
  }

  // ── Repo ───────────────────────────────────────────────

  async getRepo(owner: string, repo: string) { return this.request(`/repos/${e(owner)}/${e(repo)}`); }
  async listBranches(owner: string, repo: string, perPage = 30) { return this.request(`/repos/${e(owner)}/${e(repo)}/branches?${pp(this,"per_page")}=${perPage}`); }
  async listContents(owner: string, repo: string, path?: string, ref?: string) {
    let p = `/repos/${e(owner)}/${e(repo)}/contents`;
    if (path) p += `/${path.replace(/^\//, "")}`;
    if (ref) p += `?ref=${encodeURIComponent(ref)}`;
    return this.request(p);
  }
  async getFile(owner: string, repo: string, filepath: string, ref?: string) {
    let p = `/repos/${e(owner)}/${e(repo)}/contents/${filepath.replace(/^\//, "")}`;
    if (ref) p += `?ref=${encodeURIComponent(ref)}`;
    return this.request(p);
  }
  async searchRepos(q: string, limit = 10) { return this.request(`/repos/search?q=${encodeURIComponent(q)}&limit=${limit}`); }
  async listLabels(owner: string, repo: string) { return this.request(`/repos/${e(owner)}/${e(repo)}/labels`); }
  async listMilestones(owner: string, repo: string) { return this.request(`/repos/${e(owner)}/${e(repo)}/milestones`); }

  // ── Issues ─────────────────────────────────────────────

  async createIssue(owner: string, repo: string, body: Record<string, unknown>) { return this.request("POST", `/repos/${e(owner)}/${e(repo)}/issues`, body); }
  async listIssues(owner: string, repo: string, query: string) { return this.request(`/repos/${e(owner)}/${e(repo)}/issues?${query}`); }
  async getIssue(owner: string, repo: string, number: number) { return this.request(`/repos/${e(owner)}/${e(repo)}/issues/${number}`); }
  async updateIssue(owner: string, repo: string, number: number, body: Record<string, unknown>) { return this.request("PATCH", `/repos/${e(owner)}/${e(repo)}/issues/${number}`, body); }
  async listComments(owner: string, repo: string, number: number, perPage = 30) { return this.request(`/repos/${e(owner)}/${e(repo)}/issues/${number}/comments?${pp(this,"per_page")}=${Math.min(perPage, 100)}`); }
  async createComment(owner: string, repo: string, number: number, body: string) { return this.request("POST", `/repos/${e(owner)}/${e(repo)}/issues/${number}/comments`, { body }); }

  // ── PRs ────────────────────────────────────────────────

  async createPR(owner: string, repo: string, body: Record<string, unknown>) { return this.request("POST", `/repos/${e(owner)}/${e(repo)}/pulls`, body); }
  async listPRs(owner: string, repo: string, query: string) { return this.request(`/repos/${e(owner)}/${e(repo)}/pulls?${query}`); }
  async getPR(owner: string, repo: string, number: number) { return this.request(`/repos/${e(owner)}/${e(repo)}/pulls/${number}`); }
  async updatePR(owner: string, repo: string, number: number, body: Record<string, unknown>) { return this.request("PATCH", `/repos/${e(owner)}/${e(repo)}/pulls/${number}`, body); }

  async mergePR(owner: string, repo: string, number: number, method?: string, deleteBranch?: boolean): Promise<{ merged: boolean; message?: string }> {
    const body: Record<string, unknown> = {};
    if (method) {
      if (this.platform.type === "github") body.merge_method = method;
      else body.Do = method;
    }
    if (deleteBranch && this.platform.type !== "github") body.delete_branch_after_merge = deleteBranch;
    return this.request("PUT", `/repos/${e(owner)}/${e(repo)}/pulls/${number}/merge`, body);
  }

  // ── Health ─────────────────────────────────────────────

  /** Probe connectivity. GitHub has no /version endpoint — use /rate_limit instead. */
  async getVersion() {
    return this.request(this.type === "github" ? "/rate_limit" : "/version");
  }
}

// ── tiny helpers ──────────────────────────────────────────

const e = encodeURIComponent;
function pp(client: GitClient, name: string): string {
  return client.type === "github" ? "per_page" : "limit";
}
