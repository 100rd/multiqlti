/**
 * Unit tests for the SSRF-safe fetch guard.
 *
 * We test the pure decision layers exhaustively (no real network):
 *   - isBlockedIp: every private / loopback / link-local / ULA / CGNAT / metadata
 *     range, plus IPv4-mapped IPv6 and the unspecified address.
 *   - validateUrlForFetch: scheme + allowlist + DNS-resolved-IP gate, with the
 *     DNS lookup injected and mocked. Covers DNS-rebinding-style answers where the
 *     host is allowlisted but resolves to a private IP.
 *
 * The transport/redirect loop itself is exercised in integration where a real
 * connection is pinned; here we assert the gate that the loop calls per hop.
 */
import { describe, it, expect } from "vitest";
import {
  isBlockedIp,
  validateUrlForFetch,
  safeFetch,
  SsrfBlockedError,
  AllowlistError,
  readResponse,
  type RawResponse,
  type RequestFn,
  type ResponseLike,
} from "../../../server/knowledge/safe-fetch";

describe("isBlockedIp — IPv4 ranges", () => {
  it("blocks loopback 127/8", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.255.255.254")).toBe(true);
  });
  it("blocks private 10/8, 172.16/12, 192.168/16", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
  });
  it("does NOT block 172.15/172.32 (outside 172.16/12)", () => {
    expect(isBlockedIp("172.15.0.1")).toBe(false);
    expect(isBlockedIp("172.32.0.1")).toBe(false);
  });
  it("blocks link-local 169.254/16 incl metadata 169.254.169.254", () => {
    expect(isBlockedIp("169.254.0.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });
  it("blocks 0.0.0.0/8 unspecified", () => {
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("0.1.2.3")).toBe(true);
  });
  it("blocks CGNAT 100.64/10", () => {
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("100.127.255.255")).toBe(true);
  });
  it("does NOT block 100.63 / 100.128 (outside 100.64/10)", () => {
    expect(isBlockedIp("100.63.255.255")).toBe(false);
    expect(isBlockedIp("100.128.0.1")).toBe(false);
  });
  it("allows ordinary public IPv4", () => {
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("140.82.112.3")).toBe(false);
  });
});

describe("isBlockedIp — IPv6 ranges", () => {
  it("blocks ::1 loopback and :: unspecified", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("::")).toBe(true);
  });
  it("blocks ULA fc00::/7", () => {
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456::1")).toBe(true);
  });
  it("blocks link-local fe80::/10", () => {
    expect(isBlockedIp("fe80::1")).toBe(true);
  });
  it("blocks IPv4-mapped IPv6 pointing at private space", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });
  it("allows public IPv6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isBlockedIp — malformed / literal-obfuscation", () => {
  it("blocks anything it cannot parse as a clean dotted/colon IP", () => {
    // decimal, octal, hex literals are not valid plain IPs -> blocked (fail closed)
    expect(isBlockedIp("2130706433")).toBe(true); // 127.0.0.1 decimal
    expect(isBlockedIp("0x7f000001")).toBe(true); // hex
    expect(isBlockedIp("0177.0.0.1")).toBe(true); // octal
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("validateUrlForFetch — scheme + allowlist", () => {
  const okLookup = async () => ["140.82.112.3"];

  it("throws AllowlistError for non-https", async () => {
    await expect(validateUrlForFetch("http://developer.hashicorp.com/", okLookup))
      .rejects.toBeInstanceOf(AllowlistError);
  });

  it("throws AllowlistError for non-allowlisted host", async () => {
    await expect(validateUrlForFetch("https://evil.com/", okLookup))
      .rejects.toBeInstanceOf(AllowlistError);
  });

  it("returns the pinned public IP for an allowlisted host", async () => {
    const result = await validateUrlForFetch("https://opentofu.org/docs", okLookup);
    expect(result.pinnedIp).toBe("140.82.112.3");
    expect(result.url.hostname).toBe("opentofu.org");
  });
});

describe("validateUrlForFetch — DNS-resolved-IP gate (rebinding)", () => {
  it("throws SsrfBlockedError when an allowlisted host resolves to loopback", async () => {
    const lookup = async () => ["127.0.0.1"];
    await expect(validateUrlForFetch("https://opentofu.org/", lookup))
      .rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws SsrfBlockedError when ANY resolved addr is private", async () => {
    const lookup = async () => ["140.82.112.3", "10.0.0.5"];
    await expect(validateUrlForFetch("https://opentofu.org/", lookup))
      .rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws SsrfBlockedError when the host resolves to the metadata IP", async () => {
    const lookup = async () => ["169.254.169.254"];
    await expect(validateUrlForFetch("https://developer.hashicorp.com/", lookup))
      .rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("throws SsrfBlockedError when DNS returns no addresses", async () => {
    const lookup = async () => [];
    await expect(validateUrlForFetch("https://opentofu.org/", lookup))
      .rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("propagates SsrfBlockedError when DNS lookup itself fails", async () => {
    const lookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(validateUrlForFetch("https://opentofu.org/", lookup))
      .rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe("safeFetch — redirect handling (injected transport, mocked DNS)", () => {
  const publicLookup = async () => ["140.82.112.3"];

  function requestStub(seq: RawResponse[]): RequestFn {
    let i = 0;
    return async () => {
      const r = seq[Math.min(i, seq.length - 1)];
      i++;
      return r;
    };
  }

  it("returns a non-redirect response and the final URL", async () => {
    const requestFn = requestStub([{ status: 200, headers: { "content-type": "text/html" }, body: "ok" }]);
    const res = await safeFetch("https://opentofu.org/docs", { lookupAll: publicLookup, requestFn });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
    expect(res.finalUrl).toContain("opentofu.org");
  });

  it("follows a redirect to another allowlisted host, re-validating the hop", async () => {
    const requestFn = requestStub([
      { status: 301, headers: {}, location: "https://developer.hashicorp.com/terraform", body: "" },
      { status: 200, headers: {}, body: "landed" },
    ]);
    const res = await safeFetch("https://opentofu.org/docs", { lookupAll: publicLookup, requestFn });
    expect(res.status).toBe(200);
    expect(res.body).toBe("landed");
    expect(res.finalUrl).toContain("developer.hashicorp.com");
  });

  it("blocks a redirect that escapes the allowlist (AllowlistError on next hop)", async () => {
    const requestFn = requestStub([
      { status: 302, headers: {}, location: "https://evil.com/pwn", body: "" },
    ]);
    await expect(
      safeFetch("https://opentofu.org/docs", { lookupAll: publicLookup, requestFn }),
    ).rejects.toBeInstanceOf(AllowlistError);
  });

  it("blocks a redirect whose target host resolves to a private IP", async () => {
    let n = 0;
    const lookupAll = async () => (n++ === 0 ? ["140.82.112.3"] : ["10.0.0.9"]);
    const requestFn = requestStub([
      { status: 302, headers: {}, location: "https://developer.hashicorp.com/x", body: "" },
    ]);
    await expect(
      safeFetch("https://opentofu.org/docs", { lookupAll, requestFn }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("caps redirects at 3 hops", async () => {
    const requestFn = requestStub([
      { status: 301, headers: {}, location: "https://opentofu.org/a", body: "" },
    ]);
    await expect(
      safeFetch("https://opentofu.org/docs", { lookupAll: publicLookup, requestFn }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});

describe("readResponse — bounded body consumption (mock stream)", () => {
  function mockRes(opts: {
    statusCode?: number;
    headers?: Record<string, string | string[] | undefined>;
    chunks?: Buffer[];
  }): { res: ResponseLike; destroyed: { value: boolean } } {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const destroyed = { value: false };
    const res: ResponseLike = {
      statusCode: opts.statusCode ?? 200,
      headers: opts.headers ?? {},
      on: (event, cb) => {
        handlers[event] = cb as (arg?: unknown) => void;
      },
      destroy: () => {
        destroyed.value = true;
      },
    };
    // Drive the stream asynchronously after listeners attach.
    queueMicrotask(() => {
      for (const c of opts.chunks ?? []) handlers.data?.(c);
      handlers.end?.();
    });
    return { res, destroyed };
  }

  it("accumulates body and maps string headers", async () => {
    const { res } = mockRes({
      statusCode: 200,
      headers: { "content-type": "text/html", "x-array": ["a", "b"] },
      chunks: [Buffer.from("hel"), Buffer.from("lo")],
    });
    const out = await readResponse(res, 1000, () => {});
    expect(out.status).toBe(200);
    expect(out.body).toBe("hello");
    expect(out.headers["content-type"]).toBe("text/html");
    expect(out.headers["x-array"]).toBeUndefined(); // array headers dropped
  });

  it("extracts a string location header", async () => {
    const { res } = mockRes({ statusCode: 301, headers: { location: "https://opentofu.org/x" } });
    const out = await readResponse(res, 1000, () => {});
    expect(out.location).toBe("https://opentofu.org/x");
  });

  it("aborts and rejects when the body exceeds maxBytes", async () => {
    const { res, destroyed } = mockRes({ chunks: [Buffer.alloc(10), Buffer.alloc(10)] });
    let onAbortCalled = false;
    await expect(
      readResponse(res, 15, () => {
        onAbortCalled = true;
        res.destroy();
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(onAbortCalled).toBe(true);
    expect(destroyed.value).toBe(true);
  });
});
