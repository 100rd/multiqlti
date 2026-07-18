/**
 * spec-writer-gitlab tests — remote-only GitLab spec-MR creation (the GitLab
 * dialect of spec-writer): origin parsing (nested groups), the REST flow,
 * dedup/idempotent re-run, degrade paths, and the spec-intake forge sniff.
 */
import { describe, it, expect } from "vitest";
import {
  parseGitlabRemote,
  writeSpecMr,
} from "../../../../server/services/consilium/trackers/spec-writer-gitlab";
import { crystallizeTicket } from "../../../../server/services/consilium/trackers/spec-intake";
import type { GitlabHttpFn } from "../../../../server/services/consilium/trackers/gitlab-exec";

const noLog = () => undefined;
const AUTH = { token: "glpat-test" };

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** Route-programmable fake GitLab API that records every call. */
function fakeGitlab(routes: Array<{ match: RegExp; method?: string; status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn: GitlabHttpFn = async (req) => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    const route = routes.find(
      (r) => r.match.test(req.url) && (!r.method || r.method === req.method),
    );
    if (!route) return { status: 404, body: JSON.stringify({ message: "404" }) };
    return { status: route.status, body: JSON.stringify(route.body) };
  };
  return { fn, calls };
}

const PARAMS = {
  targetRepoPath: "/repos/iac",
  branch: "spec/jira-PDO-1",
  filePath: "docs/specs/jira-PDO-1-test.md",
  fileContent: "# spec",
  commitMessage: "feat: add spec for PDO-1",
  prTitle: "spec: test (PDO-1)",
  prBody: "body",
};

const remote = async () => "git@gitlab.com:werush-platform/platform/iac.git";

describe("parseGitlabRemote", () => {
  it("parses ssh remotes with nested groups", () => {
    expect(parseGitlabRemote("git@gitlab.com:werush-platform/platform/iac.git")).toEqual({
      baseUrl: "https://gitlab.com",
      projectPath: "werush-platform/platform/iac",
    });
  });

  it("parses https remotes", () => {
    expect(parseGitlabRemote("https://gitlab.example.com/group/proj.git")).toEqual({
      baseUrl: "https://gitlab.example.com",
      projectPath: "group/proj",
    });
  });

  it("rejects single-segment and malformed remotes (fail-closed)", () => {
    expect(parseGitlabRemote("git@gitlab.com:proj.git")).toBeNull();
    expect(parseGitlabRemote("not a url")).toBeNull();
    expect(parseGitlabRemote("git@gitlab.com:-bad/flag.git")).toBeNull();
  });
});

describe("writeSpecMr", () => {
  it("creates branch, file, and MR on the happy path", async () => {
    const { fn, calls } = fakeGitlab([
      { match: /merge_requests\?/, method: "GET", status: 200, body: [] },
      { match: /projects\/[^/]+$/, method: "GET", status: 200, body: { default_branch: "main" } },
      { match: /repository\/branches\//, method: "GET", status: 404, body: {} },
      { match: /repository\/branches$/, method: "POST", status: 201, body: { name: PARAMS.branch } },
      { match: /repository\/files\/.*\?/, method: "GET", status: 404, body: {} },
      { match: /repository\/files\//, method: "POST", status: 201, body: {} },
      {
        match: /merge_requests$/,
        method: "POST",
        status: 201,
        body: { web_url: "https://gitlab.com/werush-platform/platform/iac/-/merge_requests/7" },
      },
    ]);
    const res = await writeSpecMr(
      { gitlabHttp: fn, gitlabAuth: AUTH, gitRemoteUrl: remote, log: noLog },
      PARAMS,
    );
    expect(res).toEqual({
      ok: true,
      prUrl: "https://gitlab.com/werush-platform/platform/iac/-/merge_requests/7",
      reused: false,
    });
    // The project path travels URL-encoded (nested groups → %2F).
    expect(calls.every((c) => c.url.includes("werush-platform%2Fplatform%2Fiac"))).toBe(true);
    const mrCreate = calls.find((c) => c.method === "POST" && /merge_requests$/.test(c.url.split("?")[0]));
    expect(JSON.parse(mrCreate!.body!)).toMatchObject({
      source_branch: PARAMS.branch,
      target_branch: "main",
      title: PARAMS.prTitle,
    });
  });

  it("reuses an existing MR for the branch (dedup — creates nothing)", async () => {
    const { fn, calls } = fakeGitlab([
      {
        match: /merge_requests\?/,
        method: "GET",
        status: 200,
        body: [{ web_url: "https://gitlab.com/x/-/merge_requests/1", state: "opened" }],
      },
    ]);
    const res = await writeSpecMr(
      { gitlabHttp: fn, gitlabAuth: AUTH, gitRemoteUrl: remote, log: noLog },
      PARAMS,
    );
    expect(res).toEqual({ ok: true, prUrl: "https://gitlab.com/x/-/merge_requests/1", reused: true });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("continues past an existing branch and file (idempotent re-run)", async () => {
    const { fn, calls } = fakeGitlab([
      { match: /merge_requests\?/, method: "GET", status: 200, body: [] },
      { match: /projects\/[^/]+$/, method: "GET", status: 200, body: { default_branch: "main" } },
      { match: /repository\/branches\//, method: "GET", status: 200, body: { name: PARAMS.branch } },
      {
        match: /repository\/files\/.*\?/,
        method: "GET",
        status: 200,
        body: { file_path: PARAMS.filePath },
      },
      { match: /merge_requests$/, method: "POST", status: 201, body: { web_url: "https://g/mr/2" } },
    ]);
    const res = await writeSpecMr(
      { gitlabHttp: fn, gitlabAuth: AUTH, gitRemoteUrl: remote, log: noLog },
      PARAMS,
    );
    expect(res).toEqual({ ok: true, prUrl: "https://g/mr/2", reused: false });
    // No branch/file POSTs — only the MR create.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("degrades to no-default-branch when the project is unreachable", async () => {
    const { fn } = fakeGitlab([
      { match: /merge_requests\?/, method: "GET", status: 200, body: [] },
      // project GET falls through to 404.
    ]);
    const res = await writeSpecMr(
      { gitlabHttp: fn, gitlabAuth: AUTH, gitRemoteUrl: remote, log: noLog },
      PARAMS,
    );
    expect(res).toEqual({ ok: false, reason: "no-default-branch" });
  });

  it("rejects a bad branch and a flag-shaped title", async () => {
    const { fn } = fakeGitlab([]);
    const bad = await writeSpecMr(
      { gitlabHttp: fn, gitlabAuth: AUTH, gitRemoteUrl: remote, log: noLog },
      { ...PARAMS, branch: "evil/branch" },
    );
    expect(bad).toEqual({ ok: false, reason: "bad-branch" });
    const flag = await writeSpecMr(
      { gitlabHttp: fn, gitlabAuth: AUTH, gitRemoteUrl: remote, log: noLog },
      { ...PARAMS, prTitle: "--flag" },
    );
    expect(flag).toEqual({ ok: false, reason: "bad-title" });
  });

  it("degrades when the MR create fails and no MR is recoverable", async () => {
    const { fn } = fakeGitlab([
      { match: /merge_requests\?/, method: "GET", status: 200, body: [] },
      { match: /projects\/[^/]+$/, method: "GET", status: 200, body: { default_branch: "main" } },
      { match: /repository\/branches\//, method: "GET", status: 404, body: {} },
      { match: /repository\/branches$/, method: "POST", status: 201, body: {} },
      { match: /repository\/files\/.*\?/, method: "GET", status: 404, body: {} },
      { match: /repository\/files\//, method: "POST", status: 201, body: {} },
      { match: /merge_requests$/, method: "POST", status: 500, body: { message: "boom" } },
    ]);
    const res = await writeSpecMr(
      { gitlabHttp: fn, gitlabAuth: AUTH, gitRemoteUrl: remote, log: noLog },
      PARAMS,
    );
    expect(res).toEqual({ ok: false, reason: "pr-create-failed" });
  });
});

describe("crystallizeTicket forge sniff", () => {
  const input = {
    source: { kind: "jira", ref: "PDO-1", url: "https://jira/browse/PDO-1" },
    targetRepoPath: "/repos/iac",
    branch: "spec/jira-PDO-1",
    filePath: "docs/specs/jira-PDO-1-test.md",
    title: "test",
    status: "ready" as const,
    problem: "p",
    criteria: ["c1"],
    commitMessage: "feat: add spec for PDO-1",
    prTitle: "spec: test (PDO-1)",
    prBody: "body",
  };
  const writeback = {
    pickup: async () => ({ posted: true }),
    needCriteria: async () => ({ posted: true }),
  };

  it("routes a gitlab origin to the MR writer (gh never invoked)", async () => {
    const { fn, calls } = fakeGitlab([
      { match: /merge_requests\?/, method: "GET", status: 200, body: [] },
      { match: /projects\/[^/]+$/, method: "GET", status: 200, body: { default_branch: "main" } },
      { match: /repository\/branches\//, method: "GET", status: 404, body: {} },
      { match: /repository\/branches$/, method: "POST", status: 201, body: {} },
      { match: /repository\/files\/.*\?/, method: "GET", status: 404, body: {} },
      { match: /repository\/files\//, method: "POST", status: 201, body: {} },
      { match: /merge_requests$/, method: "POST", status: 201, body: { web_url: "https://g/mr/9" } },
    ]);
    let ghCalled = false;
    const res = await crystallizeTicket(
      {
        gitRemoteUrl: remote,
        gitlabHttp: fn,
        gitlabAuth: AUTH,
        runGh: (async () => {
          ghCalled = true;
          return { stdout: "", stderr: "" };
        }) as never,
        writeback,
        log: noLog,
      },
      input,
    );
    expect(res).toEqual({ outcome: "spec-pr", prUrl: "https://g/mr/9", reused: false });
    expect(ghCalled).toBe(false); // the GitLab seam handled it, not gh.
    expect(calls.length).toBeGreaterThan(0);
  });
});
