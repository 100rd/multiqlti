/**
 * jira-exec auth-dialect tests — the Cloud (Basic email:token) vs Data Center
 * PAT (Bearer) selection added for self-hosted Jira instances.
 */
import { describe, it, expect } from "vitest";
import {
  readJiraAuthFromEnv,
  jiraGetJson,
  type JiraHttpFn,
} from "../../../../server/services/consilium/trackers/jira-exec";

const noLog = () => undefined;

function captureHttp(): { fn: JiraHttpFn; headers: () => Record<string, string> } {
  let captured: Record<string, string> = {};
  const fn: JiraHttpFn = async (req) => {
    captured = req.headers;
    return { status: 200, body: JSON.stringify({ ok: true }) };
  };
  return { fn, headers: () => captured };
}

describe("readJiraAuthFromEnv", () => {
  it("returns null when the token is absent (fail-closed)", () => {
    expect(readJiraAuthFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      readJiraAuthFromEnv({ JIRA_EMAIL: "a@b.co" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns email+token for the Cloud (Basic) dialect", () => {
    expect(
      readJiraAuthFromEnv({
        JIRA_EMAIL: "a@b.co",
        JIRA_API_TOKEN: "tok",
      } as NodeJS.ProcessEnv),
    ).toEqual({ email: "a@b.co", token: "tok" });
  });

  it("returns an empty email for the Data Center PAT (Bearer) dialect", () => {
    expect(
      readJiraAuthFromEnv({ JIRA_API_TOKEN: "pat" } as NodeJS.ProcessEnv),
    ).toEqual({ email: "", token: "pat" });
  });
});

describe("jiraGetJson Authorization header", () => {
  it("sends Basic base64(email:token) when an email is present", async () => {
    const { fn, headers } = captureHttp();
    const res = await jiraGetJson(
      { http: fn, auth: { email: "a@b.co", token: "tok" }, log: noLog },
      "https://jira.example.com",
      "rest/api/2/myself",
    );
    expect(res).toEqual({ ok: true });
    expect(headers().Authorization).toBe(
      "Basic " + Buffer.from("a@b.co:tok", "utf8").toString("base64"),
    );
  });

  it("sends Bearer <token> when the email is empty (Data Center PAT)", async () => {
    const { fn, headers } = captureHttp();
    const res = await jiraGetJson(
      { http: fn, auth: { email: "", token: "pat" }, log: noLog },
      "https://jira.example.com",
      "rest/api/2/myself",
    );
    expect(res).toEqual({ ok: true });
    expect(headers().Authorization).toBe("Bearer pat");
  });
});
