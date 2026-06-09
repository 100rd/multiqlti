/**
 * SSRF-safe HTTPS fetch for the Active Knowledge Base.
 *
 * Threat model: an allowlisted hostname can still resolve to a private/internal
 * IP (DNS rebinding / TOCTOU), and redirects can escape the allowlist. We defend
 * with layered checks that all run on the RESOLVED IP, and we pin the socket to
 * the exact IP we validated so the answer can't change between resolve and connect.
 *
 *   1. parse + https-only + allowlist (string gate)               -> AllowlistError
 *   2. DNS-resolve ourselves (all addresses); block if ANY is in a
 *      private / loopback / link-local / ULA / CGNAT / metadata range -> SsrfBlockedError
 *   3. connect-pin: a per-request https.Agent whose `lookup` returns ONLY the
 *      validated IP, so the socket connects to exactly what we checked
 *   4. re-validate allowlist + resolved-IP on EVERY redirect hop (cap 3); we do
 *      NOT delegate redirect-following to the agent
 *   5. hard timeout + max body size (abort the stream when exceeded)
 *
 * No new dependency: uses node:https + node:dns. The custom-agent `lookup` is the
 * connection-pinning dispatcher the design calls for.
 */
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { isAllowedSource } from "./source-allowlist";

// ─── Typed errors ──────────────────────────────────────────────────────────────

/** URL failed the scheme/host/path allowlist (string gate). */
export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistError";
  }
}

/** URL resolved to a blocked IP, exceeded redirects, or DNS failed. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_REDIRECTS = 3;

// ─── IP classification (pure, fail-closed) ──────────────────────────────────────

/** Parse a strict dotted-quad IPv4 into 4 octets, or null if not exactly that. */
function parseStrictIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject leading-zero / hex / empty obfuscations: only plain decimal 0..255.
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function isBlockedIpv4(ip: string): boolean {
  const octets = parseStrictIpv4(ip);
  if (!octets) return true; // fail closed on anything not a clean dotted quad
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** Normalize an IPv6 string into 8 16-bit groups, or null if malformed. */
function expandIpv6(ip: string): number[] | null {
  if (net.isIPv6(ip) !== true) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const toGroups = (segment: string): number[] => {
    if (segment === "") return [];
    return segment.split(":").map((g) => parseInt(g, 16));
  };

  let head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];

  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    head = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    head = [...head, ...tail];
  }
  if (head.length !== 8) return null;
  return head;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped (::ffff:a.b.c.d) — classify by the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);

  const groups = expandIpv6(lower);
  if (!groups) return true; // fail closed

  const allZero = groups.every((g) => g === 0);
  if (allZero) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local

  return false;
}

/** True if the IP literal is in any blocked range. Fails closed on bad input. */
export function isBlockedIp(ip: string): boolean {
  if (!ip) return true;
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return true; // not a clean IP literal -> block
}

// ─── DNS lookup injection ───────────────────────────────────────────────────────

/** Resolve a hostname to all A/AAAA addresses. Injectable for tests. */
export type DnsLookupAll = (hostname: string) => Promise<string[]>;

const defaultLookupAll: DnsLookupAll = async (hostname) => {
  const records = await dns.promises.lookup(hostname, { all: true });
  return records.map((r) => r.address);
};

// ─── URL validation (per hop) ────────────────────────────────────────────────────

export interface ValidatedTarget {
  url: URL;
  /** The single IP the socket will be pinned to. */
  pinnedIp: string;
  /** IP family (4 or 6) for the pinned address. */
  family: 4 | 6;
}

/**
 * Validate a URL for fetching: scheme + allowlist (string gate), then DNS-resolve
 * and ensure EVERY resolved address is public. Returns the first public IP to pin.
 */
export async function validateUrlForFetch(
  rawUrl: string,
  lookupAll: DnsLookupAll = defaultLookupAll,
): Promise<ValidatedTarget> {
  if (!isAllowedSource(rawUrl)) {
    throw new AllowlistError(`URL not on source allowlist: ${rawUrl}`);
  }
  const url = new URL(rawUrl);

  let addresses: string[];
  try {
    addresses = await lookupAll(url.hostname);
  } catch {
    throw new SsrfBlockedError(`DNS lookup failed for ${url.hostname}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new SsrfBlockedError(`No DNS addresses for ${url.hostname}`);
  }

  // Block if ANY resolved address is private — defeats split-horizon answers.
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new SsrfBlockedError(`Host ${url.hostname} resolved to blocked IP ${addr}`);
    }
  }

  const pinnedIp = addresses[0];
  const family = net.isIPv6(pinnedIp) ? 6 : 4;
  return { url, pinnedIp, family };
}

// ─── Connect-pinned HTTPS fetch ──────────────────────────────────────────────────

/** Raw single-hop response (before redirect handling). */
export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  location?: string;
  body: string;
}

/** Performs ONE validated, connect-pinned request. Injectable for tests. */
export type RequestFn = (
  target: ValidatedTarget,
  opts: { timeoutMs: number; maxBytes: number; headers: Record<string, string> },
) => Promise<RawResponse>;

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  /** Injectable DNS resolver (tests). */
  lookupAll?: DnsLookupAll;
  /** Injectable single-hop request executor (tests); defaults to the real socket. */
  requestFn?: RequestFn;
}

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}

/**
 * Build a one-shot https.Agent that pins DNS resolution to a single validated IP,
 * so the socket connects to exactly the address we checked (no rebinding window).
 */
function pinnedAgent(target: ValidatedTarget): https.Agent {
  return new https.Agent({
    maxSockets: 1,
    keepAlive: false,
    lookup: (
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ) => {
      cb(null, target.pinnedIp, target.family);
    },
  } as https.AgentOptions);
}

/** A minimal view of the response object that readResponse needs. */
export interface ResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  destroy: () => void;
}

/**
 * Stream a response into a bounded buffer, aborting if it exceeds maxBytes.
 * Pure with respect to transport — testable with a mock stream. `onAbort` is
 * called once if the body cap is hit (lets the caller tear down the socket).
 */
export function readResponse(
  res: ResponseLike,
  maxBytes: number,
  onAbort: () => void,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const status = res.statusCode ?? 0;
    const loc = res.headers.location;
    const location = typeof loc === "string" ? loc : undefined;
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    res.on("data", (chunk: unknown) => {
      const buf = chunk as Buffer;
      received += buf.length;
      if (received > maxBytes) {
        aborted = true;
        onAbort();
        reject(new SsrfBlockedError(`Response body exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    res.on("end", () => {
      if (aborted) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      resolve({ status, headers, location, body: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

export function performRequest(
  target: ValidatedTarget,
  opts: { timeoutMs: number; maxBytes: number; headers: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const agent = pinnedAgent(target);
    // SNI / Host must remain the real hostname; only the socket IP is pinned.
    const req = https.request(
      {
        protocol: "https:",
        hostname: target.url.hostname,
        servername: target.url.hostname,
        path: target.url.pathname + target.url.search,
        method: "GET",
        agent,
        headers: { Host: target.url.host, ...opts.headers },
        timeout: opts.timeoutMs,
      },
      (res) => {
        readResponse(res as unknown as ResponseLike, opts.maxBytes, () => {
          res.destroy();
          req.destroy();
          agent.destroy();
        })
          .then((parsed) => {
            agent.destroy();
            resolve(parsed);
          })
          .catch(reject);
      },
    );

    req.on("timeout", () => {
      req.destroy();
      agent.destroy();
      reject(new SsrfBlockedError("Request timed out"));
    });
    req.on("error", (err) => {
      agent.destroy();
      reject(new SsrfBlockedError(`Request failed: ${err.message}`));
    });
    req.end();
  });
}

/**
 * Fetch a URL with full SSRF protection and bounded redirect following.
 * Each hop is re-validated (allowlist + resolved-IP) and pinned independently.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const headers = opts.headers ?? {};
  const lookupAll = opts.lookupAll;
  const requestFn: RequestFn = opts.requestFn ?? performRequest;

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await validateUrlForFetch(currentUrl, lookupAll);
    const res = await requestFn(target, { timeoutMs, maxBytes, headers });

    const isRedirect = res.status >= 300 && res.status < 400 && res.location;
    if (!isRedirect) {
      return {
        status: res.status,
        headers: res.headers,
        body: res.body,
        finalUrl: target.url.toString(),
      };
    }

    if (hop === MAX_REDIRECTS) {
      throw new SsrfBlockedError(`Exceeded ${MAX_REDIRECTS} redirects`);
    }
    // Resolve relative redirects against the current URL; the next loop iteration
    // re-validates allowlist + resolved IP on the new target.
    currentUrl = new URL(res.location as string, target.url).toString();
  }

  // Unreachable, but satisfies the type checker.
  throw new SsrfBlockedError("Redirect loop terminated unexpectedly");
}
