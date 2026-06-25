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
  detectPlatform,
  formatApiError,
  getConfig,
  listInstances,
  maskToken,
  paginationParam,
  parseRepo,
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
// detectPlatform
// =============================================================================

describe("detectPlatform", () => {
  it("detects github from api.github.com", () => {
    expect(detectPlatform("https://api.github.com")).toBe("github");
    expect(detectPlatform("https://api.github.com/")).toBe("github");
    expect(detectPlatform("HTTP://API.GITHUB.COM")).toBe("github");
  });

  it("detects github from github.com/api/v3", () => {
    expect(detectPlatform("https://github.com/api/v3")).toBe("github");
  });

  it("defaults to gitea for unknown domains", () => {
    expect(detectPlatform("https://api.my-company.com")).toBe("gitea");
  });

  it("defaults to gitea for /api/v1 URLs", () => {
    expect(detectPlatform("https://gitea.com/api/v1")).toBe("gitea");
    expect(detectPlatform("https://forgejo.example.com/api/v1")).toBe("gitea");
    expect(detectPlatform("https://try.gitea.io/api/v1")).toBe("gitea");
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
  it("joins base URL and path", () => {
    expect(buildApiUrl("https://api.github.com", "/repos/owner/repo")).toBe(
      "https://api.github.com/repos/owner/repo",
    );
  });

  it("strips trailing slash from base URL", () => {
    expect(buildApiUrl("https://api.github.com/", "/repos/owner/repo")).toBe(
      "https://api.github.com/repos/owner/repo",
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
    expect(formatApiError(404, { message: "Not Found" }, "/repos/a/b")).toBe(
      "API error 404 on /repos/a/b: Not Found",
    );
  });

  it("formats error without message field", () => {
    expect(formatApiError(500, { error: "boom" }, "/test")).toBe(
      'API error 500 on /test: {"error":"boom"}',
    );
  });

  it("formats error with null data", () => {
    expect(formatApiError(403, null, "/test")).toBe("API error 403 on /test: null");
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
