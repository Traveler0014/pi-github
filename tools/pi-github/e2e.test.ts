/**
 * End-to-end smoke test against real GitHub API (unauthenticated, public repos)
 * Run: npx tsx tools/pi-github/e2e.test.ts
 */
import {
  apiRequest,
  buildApiUrl,
  buildHeaders,
  type PlatformConfig,
} from "./lib";

const gh: PlatformConfig = {
  type: "github",
  baseUrl: "https://api.github.com",
  token: "",
};

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    console.log(`  FAIL  ${name}: ${(e as Error).message}`);
  }
}

async function main() {
  console.log("GitHub API (unauthenticated)\n");

  await test("GET /repos/torvalds/linux", async () => {
    const { status, data } = await apiRequest(gh, "GET", "/repos/torvalds/linux");
    if (status !== 200) throw new Error(`status=${status}`);
    const r = data as Record<string, unknown>;
    if (r.full_name !== "torvalds/linux") throw new Error(`wrong repo: ${r.full_name}`);
    console.log(`         ${r.full_name} — ${r.description} — ⭐${r.stargazers_count}`);
  });

  await test("GET /repos/torvalds/linux/issues?state=open&per_page=3", async () => {
    const { status, data } = await apiRequest(
      gh, "GET", "/repos/torvalds/linux/issues?state=open&per_page=3",
    );
    if (status !== 200) throw new Error(`status=${status}`);
    const issues = data as Array<Record<string, unknown>>;
    if (!Array.isArray(issues)) throw new Error("not an array");
    console.log(`         ${issues.length} issues, first: #${issues[0]?.number} ${issues[0]?.title}`);
  });

  await test("GET /repos/torvalds/linux/pulls", async () => {
    const { status, data } = await apiRequest(
      gh, "GET", "/repos/torvalds/linux/pulls?state=open&per_page=2",
    );
    // GitHub may require auth for pulls endpoint; accept 200 or 401
    if (status === 200) {
      const prs = data as Array<Record<string, unknown>>;
      console.log(`         ${prs.length} PRs, first: #${prs[0]?.number} ${prs[0]?.title}`);
    } else if (status === 401 || status === 404) {
      console.log("         (auth required for PR listing)");
    } else {
      throw new Error(`unexpected status=${status}`);
    }
  });

  await test("GET /repos/nosuch/nothing → 404", async () => {
    const { status } = await apiRequest(gh, "GET", "/repos/nosuch-99999/nothing-99999");
    if (status !== 404) throw new Error(`expected 404, got ${status}`);
  });

  await test("GET /user with bad token → 401", async () => {
    const bad: PlatformConfig = { ...gh, token: "bad-token" };
    const { status } = await apiRequest(bad, "GET", "/user");
    if (status !== 401) throw new Error(`expected 401, got ${status}`);
  });

  // Test auth header format
  await test("buildHeaders — Bearer for github", async () => {
    const h = buildHeaders({ type: "github", baseUrl: "", token: "tok123" });
    if (h.Authorization !== "Bearer tok123") throw new Error("wrong auth: " + h.Authorization);
    if (!h.Accept.includes("vnd.github")) throw new Error("wrong accept: " + h.Accept);
  });

  await test("buildHeaders — token for gitea", async () => {
    const h = buildHeaders({ type: "gitea", baseUrl: "", token: "tok456" });
    if (h.Authorization !== "token tok456") throw new Error("wrong auth: " + h.Authorization);
    if (h.Accept !== "application/json") throw new Error("wrong accept: " + h.Accept);
  });

  console.log("\nDone.");
}

main().catch(console.error);
