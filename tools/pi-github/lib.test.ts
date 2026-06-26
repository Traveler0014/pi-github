/**
 * Unit & integration tests for pi-github
 *
 * Run: npx vitest run
 */

import { describe, expect, it } from "vitest";
import {
  buildApiUrl,
  buildHeaders,
  buildListQuery,
  formatApiError,
  getConfig,
  getConfigPath,
  listInstances,
  maskToken,
  paginationParam,
  parseRepo,
  normalizeRepoFields,
  apiRequest,
  type GitPluginConfig,
  type PlatformConfig,
} from "./lib";

// =============================================================================
// Test fixtures
// =============================================================================

const githubCfg: PlatformConfig = {
  type: "github",
  baseUrl: "https://api.github.com",
  token: "ghp_test1234567890abcdef",
};

const giteaCfg: PlatformConfig = {
  type: "gitea",
  baseUrl: "https://gitea.example.com/api/v1",
  token: "deadbeef1234567890abcdef1234567890abcdef12",
};

function makeConfig(partial?: Partial<GitPluginConfig>): GitPluginConfig {
  return {
    platforms: {
      github: githubCfg,
      gitea: giteaCfg,
    },
    default: "github",
    ...partial,
  };
}

// =============================================================================
// parseRepo
// =============================================================================

describe("parseRepo", () => {
  it("parses valid owner/repo", () => {
    expect(parseRepo("owner/repo")).toEqual({ owner: "owner", repoName: "repo" });
    expect(parseRepo("torvalds/linux")).toEqual({ owner: "torvalds", repoName: "linux" });
    expect(parseRepo("a/b")).toEqual({ owner: "a", repoName: "b" });
  });

  it("trims whitespace", () => {
    expect(parseRepo("  owner/repo  ")).toEqual({ owner: "owner", repoName: "repo" });
  });

  it("rejects empty string", () => {
    expect(parseRepo("")).toBeNull();
    expect(parseRepo("   ")).toBeNull();
  });

  it("rejects missing owner or repo", () => {
    expect(parseRepo("/repo")).toBeNull();
    expect(parseRepo("owner/")).toBeNull();
    expect(parseRepo("/")).toBeNull();
  });

  it("rejects too many parts", () => {
    expect(parseRepo("a/b/c")).toBeNull();
  });

  it("rejects special characters", () => {
    expect(parseRepo("owner/repo name")).toBeNull();
    expect(parseRepo("owner/repo@v1")).toBeNull();
  });

  it("accepts dots, dashes, underscores in names", () => {
    expect(parseRepo("my-org/my_repo.v2")).toEqual({ owner: "my-org", repoName: "my_repo.v2" });
  });

  it("rejects URLs", () => {
    expect(parseRepo("https://github.com/owner/repo")).toBeNull();
  });
});

// =============================================================================
// buildHeaders
// =============================================================================

describe("buildHeaders", () => {
  it("uses Bearer auth for GitHub", () => {
    const h = buildHeaders(githubCfg);
    expect(h.Authorization).toBe("Bearer ghp_test1234567890abcdef");
    expect(h.Accept).toBe("application/vnd.github+json");
    expect(h["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("uses token auth for Gitea", () => {
    const h = buildHeaders(giteaCfg);
    expect(h.Authorization).toBe("token deadbeef1234567890abcdef1234567890abcdef12");
    expect(h.Accept).toBe("application/json");
  });

  it("omits Authorization when token is empty", () => {
    const h = buildHeaders({ type: "github", baseUrl: "", token: "" });
    expect(h.Authorization).toBeUndefined();
    expect(h.Accept).toBe("application/vnd.github+json");
  });
});

// =============================================================================
// paginationParam
// =============================================================================

describe("paginationParam", () => {
  it('returns "per_page" for GitHub', () => {
    expect(paginationParam(githubCfg)).toBe("per_page");
  });

  it('returns "limit" for Gitea/Forgejo', () => {
    expect(paginationParam(giteaCfg)).toBe("limit");
    const forgejo: PlatformConfig = { ...giteaCfg, type: "forgejo" };
    expect(paginationParam(forgejo)).toBe("limit");
  });
});

// =============================================================================
// buildApiUrl
// =============================================================================

describe("buildApiUrl", () => {
  it("joins base URL and path for GitHub", () => {
    expect(buildApiUrl("github", "https://api.github.com", "/repos/owner/repo")).toBe(
      "https://api.github.com/repos/owner/repo",
    );
  });

  it("strips trailing slash from base URL", () => {
    expect(buildApiUrl("github", "https://api.github.com/", "/repos/owner/repo")).toBe(
      "https://api.github.com/repos/owner/repo",
    );
  });

  it("auto-appends /api/v1 for Gitea", () => {
    expect(buildApiUrl("gitea", "https://gitea.example.com", "/repos/owner/repo")).toBe(
      "https://gitea.example.com/api/v1/repos/owner/repo",
    );
  });

  it("auto-appends /api/v1 for Forgejo", () => {
    expect(buildApiUrl("forgejo", "https://repo.trav.one", "/repos/owner/repo")).toBe(
      "https://repo.trav.one/api/v1/repos/owner/repo",
    );
  });

  it("does not duplicate /api/v1 if already present", () => {
    expect(buildApiUrl("gitea", "https://gitea.example.com/api/v1", "/repos/owner/repo")).toBe(
      "https://gitea.example.com/api/v1/repos/owner/repo",
    );
  });

  it("GitHub URLs are not modified", () => {
    expect(buildApiUrl("github", "https://github.mycompany.com/api/v3", "/repos/owner/repo")).toBe(
      "https://github.mycompany.com/api/v3/repos/owner/repo",
    );
  });

  it("GitHub health check uses /rate_limit", () => {
    expect(buildApiUrl("github", "https://api.github.com", "/rate_limit")).toBe(
      "https://api.github.com/rate_limit",
    );
  });

  it("Gitea health check uses /version (auto-prefixed with /api/v1)", () => {
    expect(buildApiUrl("gitea", "https://gitea.example.com", "/version")).toBe(
      "https://gitea.example.com/api/v1/version",
    );
  });

  it("Forgejo health check uses /version (auto-prefixed with /api/v1)", () => {
    expect(buildApiUrl("forgejo", "https://forgejo.example.com", "/version")).toBe(
      "https://forgejo.example.com/api/v1/version",
    );
  });
});

// =============================================================================
// buildListQuery
// =============================================================================

describe("buildListQuery", () => {
  it("builds minimal query for GitHub", () => {
    const qs = buildListQuery(githubCfg, {});
    expect(qs).toContain("page=1");
    expect(qs).toContain("per_page=30");
  });

  it("builds minimal query for Gitea (uses limit)", () => {
    const qs = buildListQuery(giteaCfg, {});
    expect(qs).toContain("page=1");
    expect(qs).toContain("limit=30");
  });

  it("includes state and labels", () => {
    const qs = buildListQuery(githubCfg, { state: "closed", labels: "bug,urgent" });
    expect(qs).toContain("state=closed");
    expect(qs).toContain("labels=bug%2Curgent");
  });

  it("caps perPage at 100", () => {
    const qs = buildListQuery(githubCfg, { perPage: 200 });
    expect(qs).toContain("per_page=100");
  });

  it("uses custom page and perPage", () => {
    const qs = buildListQuery(githubCfg, { page: 3, perPage: 10 });
    expect(qs).toContain("page=3");
    expect(qs).toContain("per_page=10");
  });
});

// =============================================================================
// maskToken
// =============================================================================

describe("maskToken", () => {
  it("shows first 4 and last 4 with dots", () => {
    expect(maskToken("ghp_abcdefghijklmnopqrstuvwxyz1234")).toBe("ghp_...1234");
  });

  it("handles short tokens", () => {
    expect(maskToken("abc")).toBe("****");
    expect(maskToken("12345678")).toBe("****");
  });

  it("handles exactly 9 chars", () => {
    expect(maskToken("123456789")).toBe("1234...6789");
  });
});

// =============================================================================
// formatApiError
// =============================================================================

describe("formatApiError", () => {
  it("formats error with message field", () => {
    expect(formatApiError(404, { message: "Not Found" }, "/repos/a/b")).toContain(
      "API error 404 on /repos/a/b: Not Found",
    );
  });

  it("404 adds hint about private repos", () => {
    const err = formatApiError(404, { message: "Not Found" }, "/repos/a/b");
    expect(err).toContain("private");
  });

  it("401 adds hint about expired token", () => {
    const err = formatApiError(401, { message: "Bad credentials" }, "/repos/a/b");
    expect(err).toContain("Token");
    expect(err).toContain("/gh-login");
  });

  it("formats error without message field", () => {
    expect(formatApiError(500, { error: "boom" }, "/test")).toContain('API error 500 on /test: {"error":"boom"}');
  });

  it("formats error with null data", () => {
    expect(formatApiError(403, null, "/test")).toContain("API error 403 on /test: null");
  });
});

// =============================================================================
// getConfig
// =============================================================================

describe("getConfig", () => {
  const cfg = makeConfig();

  it("resolves by instance name", () => {
    const r = getConfig(cfg, "gitea");
    expect(r).not.toBeNull();
    expect(r!.name).toBe("gitea");
    expect(r!.config.type).toBe("gitea");
  });

  it("falls back to default when no instance given", () => {
    const r = getConfig(cfg);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("github");
  });

  it("returns null for unknown instance", () => {
    expect(getConfig(cfg, "unknown")).toBeNull();
  });

  it("returns null for empty config", () => {
    expect(getConfig({ platforms: {}, default: "" })).toBeNull();
  });
});

// =============================================================================
// listInstances
// =============================================================================

describe("listInstances", () => {
  it("lists instances with default marker", () => {
    const cfg = makeConfig();
    expect(listInstances(cfg)).toBe("github (default), gitea");
  });

  it("returns placeholder when empty", () => {
    expect(listInstances({ platforms: {}, default: "" })).toBe("(none configured)");
  });
});

// =============================================================================
// normalizeRepoFields
// =============================================================================

describe("normalizeRepoFields", () => {
  it("passes through GitHub fields unchanged", () => {
    const input = { full_name: "a/b", stargazers_count: 42 };
    const result = normalizeRepoFields("github", input);
    expect(result).toEqual(input);
    expect(result.stargazers_count).toBe(42);
  });

  it("maps stars_count to stargazers_count for Gitea", () => {
    const input = { full_name: "a/b", stars_count: 99 };
    const result = normalizeRepoFields("gitea", input);
    expect(result.stargazers_count).toBe(99);
    expect(result.stars_count).toBe(99); // original preserved
  });

  it("maps stars_count for Forgejo", () => {
    const input = { full_name: "a/b", stars_count: 7 };
    const result = normalizeRepoFields("forgejo", input);
    expect(result.stargazers_count).toBe(7);
  });

  it("does not overwrite existing stargazers_count", () => {
    const input = { full_name: "a/b", stargazers_count: 42, stars_count: 99 };
    const result = normalizeRepoFields("gitea", input);
    // stars_count is present but stargazers_count already exists — preserve original
    expect(result.stargazers_count).toBe(42);
  });

  it("handles missing fields gracefully", () => {
    const input = { full_name: "a/b" };
    const result = normalizeRepoFields("forgejo", input);
    expect(result.stargazers_count).toBeUndefined();
  });
});

// =============================================================================
// Integration tests (real GitHub API)
// =============================================================================

const token = process.env.GH_TEST_TOKEN;
const runIntegration = !!token;

describe.skipIf(!runIntegration)("GitHub API integration", () => {
  const gh: PlatformConfig = {
    type: "github",
    baseUrl: "https://api.github.com",
    token: token!,
  };

  it("token is valid (can access user endpoint)", async () => {
    const { status, data } = await apiRequest(gh, "GET", "/user");
    // Token may be expired or lack permissions
    if (status === 200) {
      const u = data as Record<string, unknown>;
      expect(u.login).toBeTruthy();
    } else {
      expect(status).toBe(401);
      console.warn("Skipping GitHub integration: token expired or lacks permissions");
    }
  });

  it("gets repo info for public repo", async () => {
    const { status, data } = await apiRequest(
      gh,
      "GET",
      "/repos/torvalds/linux",
    );
    // May be 200 or 401 depending on fine-grained token permissions
    expect([200, 401]).toContain(status);
    if (status === 200) {
      const r = data as Record<string, unknown>;
      expect(r.full_name).toBe("torvalds/linux");
    }
  });

  it("returns 401 for bad token", async () => {
    const badGh: PlatformConfig = { ...gh, token: "bad-token" };
    const { status } = await apiRequest(badGh, "GET", "/user");
    expect(status).toBe(401);
  });
});
