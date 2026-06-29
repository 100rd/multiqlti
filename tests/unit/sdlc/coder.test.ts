/**
 * coder.test.ts — SDLC agentic coder (component 2).
 *
 * DRY checks only — NO live `claude` session is spawned (that is an integration
 * concern the Lead will smoke). Asserts:
 *   - the EXACT agentic arg array (the load-bearing security construction):
 *     `-p --output-format json --permission-mode acceptEdits
 *      --allowedTools Edit Write Read Bash --add-dir <worktreeDir>`.
 *   - the prompt carries the (clamped) UNTRUSTED action-point text and the
 *     server-fixed "do not touch git/PR" instruction. It is a plain string fed to
 *     STDIN — there is no argv/shell surface for it to escape into.
 *   - output parsing: a clean `result` JSON → ok; an `is_error` JSON → ok:false
 *     (surfaced, not thrown) with a scrubbed message.
 */
import { describe, it, expect } from "vitest";
import {
  buildCoderArgs,
  buildCoderPrompt,
  parseCoderOutput,
  sanitizedCoderEnv,
  ALLOWED_TOOLS,
  CODER_ENV_ALLOWLIST,
} from "../../../server/services/sdlc/coder.js";
import type { ActionPoint } from "@shared/types";

const WT = "/tmp/sdlc-wt-XXXX/tree";

describe("buildCoderArgs — exact agentic arg array (DRY security check)", () => {
  it("is the confined acceptEdits invocation with the minimal tool allowlist", () => {
    expect(buildCoderArgs(WT)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Edit",
      "Write",
      "Read",
      "--add-dir",
      WT,
    ]);
  });

  it("never passes --dangerously-skip-permissions, has NO Bash (C-1), confines via --add-dir", () => {
    const args = buildCoderArgs(WT);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("Bash"); // C-1: a Bash child escapes --add-dir/cwd
    expect(args[args.indexOf("--add-dir") + 1]).toBe(WT); // confinement dir
    expect(ALLOWED_TOOLS).toEqual(["Edit", "Write", "Read"]);
  });
});

describe("buildCoderPrompt — untrusted text stays in the prompt only", () => {
  const aps: ActionPoint[] = [
    { title: "Fix `; rm -rf /` injection in the parser", priority: "P0", rationale: "unsanitized input" },
    { title: "Add the redactor", priority: "P1" },
  ];

  it("includes the action-point text and the do-not-touch-git instruction", () => {
    const prompt = buildCoderPrompt(aps);
    // The untrusted title appears verbatim — but this is a STDIN string, not argv.
    expect(prompt).toContain("Fix `; rm -rf /` injection in the parser");
    expect(prompt).toContain("[P0]");
    expect(prompt).toContain("unsanitized input");
    expect(prompt).toMatch(/Do NOT run `git commit`/);
    expect(prompt).toMatch(/ISOLATED git worktree/);
  });

  it("clamps an over-long title so the prompt stays bounded", () => {
    const huge: ActionPoint[] = [{ title: "x".repeat(5_000), priority: "P0" }];
    const prompt = buildCoderPrompt(huge);
    // The 5k title is clamped well under its raw length.
    expect(prompt).not.toContain("x".repeat(1_000));
  });
});

describe("parseCoderOutput", () => {
  it("ok on a clean result JSON, with token accounting", () => {
    const stdout = JSON.stringify({
      type: "result",
      result: "Edited 3 files.",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const res = parseCoderOutput(stdout);
    expect(res.ok).toBe(true);
    expect(res.summary).toBe("Edited 3 files.");
    expect(res.tokensUsed).toBe(30);
  });

  it("ok:false (surfaced, not thrown) when the CLI reports an error", () => {
    const stdout = JSON.stringify({ type: "result", is_error: true, result: "boom at /home/user/secret" });
    const res = parseCoderOutput(stdout);
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).not.toContain("/home/user"); // fs layout scrubbed
  });

  it("ok:false on unparseable stdout", () => {
    const res = parseCoderOutput("not json at all");
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });
});

describe("sanitizedCoderEnv — H-1: no inherited secrets reach the coder", () => {
  const SOURCE: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    LANG: "en_US.UTF-8",
    // Secrets that MUST NOT be forwarded:
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "github-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AWS_ACCESS_KEY_ID: "aws-id",
    POSTGRES_PASSWORD: "pg-secret",
    DATABASE_URL: "postgres://u:p@h/db",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    SOME_OTHER_SECRET: "nope",
  };

  it("forwards ONLY the allowlisted keys (PATH/HOME/locale)", () => {
    const env = sanitizedCoderEnv(SOURCE);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/agent");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("DROPS every DB/cloud/VCS/API secret (fail-closed allowlist)", () => {
    const env = sanitizedCoderEnv(SOURCE);
    for (const leaked of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "SOME_OTHER_SECRET",
    ]) {
      expect(env[leaked]).toBeUndefined();
    }
    // No value in the sanitized env equals any known secret string.
    const values = Object.values(env);
    for (const secret of ["gh-secret", "github-secret", "aws-secret", "pg-secret", "sk-ant-secret", "nope"]) {
      expect(values).not.toContain(secret);
    }
  });

  it("the allowlist itself contains no obvious secret-bearing keys", () => {
    for (const key of CODER_ENV_ALLOWLIST) {
      expect(key).not.toMatch(/PASSWORD|SECRET|AWS_|GITHUB_TOKEN|^GH_TOKEN$|DATABASE_URL|ANTHROPIC_API_KEY/);
    }
  });
});
