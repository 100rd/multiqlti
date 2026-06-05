import { describe, it, expect, vi, afterEach } from "vitest";
import { toClientErrorMessage } from "../../server/routes/chat";

/** A CLI error whose message embeds host-revealing stderr. */
function cliError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("toClientErrorMessage", () => {
  afterEach(() => vi.restoreAllMocks());

  const SECRET = "CLI exited with code 1: /Users/lo/.gemini run /login to auth";

  it.each(["CliExecutionError", "CliNotInstalledError", "AntigravityCliError"])(
    "replaces %s stderr with a generic message and never leaks host detail",
    (name) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const msg = toClientErrorMessage(cliError(name, SECRET));

      expect(msg).toBe("Model backend unavailable. Please try again.");
      expect(msg).not.toContain("/Users/");
      expect(msg).not.toContain("/login");
      expect(spy).toHaveBeenCalledOnce(); // detail logged server-side only
    },
  );

  it("passes through non-CLI error messages unchanged", () => {
    expect(toClientErrorMessage(new Error("model slug not found"))).toBe(
      "model slug not found",
    );
  });

  it("returns a generic message for non-Error throwables", () => {
    expect(toClientErrorMessage("boom")).toBe("Unexpected error");
  });
});
