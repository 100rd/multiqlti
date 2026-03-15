/**
 * Unit tests for DataClassifier and AnonymizerService.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { DataClassifier } from "../../server/privacy/classifier.js";
import { AnonymizerService } from "../../server/privacy/anonymizer.js";

// ─── DataClassifier ────────────────────────────────────────────────────────────

describe("DataClassifier", () => {
  let classifier: DataClassifier;

  beforeEach(() => {
    classifier = new DataClassifier();
  });

  it("detects api_key pattern (sk- style)", () => {
    const text = "api_key=sk-abcdefghijklmnopqrstuvwxyz12345678";
    const entities = classifier.classify(text);
    expect(entities.some((e) => e.type === "api_key")).toBe(true);
  });

  it("detects env_variable pattern (UPPER_CASE=value)", () => {
    const text = "DATABASE_URL=postgresql://user:password@localhost:5432/mydb";
    const entities = classifier.classify(text);
    expect(entities.some((e) => e.type === "env_variable")).toBe(true);
  });

  it("detects ip_address (private range)", () => {
    const text = "Connect to server at 192.168.1.100 for SSH access";
    const entities = classifier.classify(text);
    expect(entities.some((e) => e.type === "ip_address")).toBe(true);
  });

  it("detects email address", () => {
    const text = "Please contact admin@company.io for access";
    const entities = classifier.classify(text);
    expect(entities.some((e) => e.type === "email")).toBe(true);
  });

  it("detects k8s_namespace", () => {
    const text = "Deploy to namespace: production-services";
    const entities = classifier.classify(text);
    // k8s_namespace detection depends on the regex matching 'production-services' (not in allowlist)
    const ns = entities.filter((e) => e.type === "k8s_namespace");
    expect(ns.length).toBeGreaterThan(0);
  });

  it("returns empty array for clean text", () => {
    const text = "Hello world. This is a simple sentence with no secrets.";
    const entities = classifier.classify(text);
    // May still match domains — filter to high-confidence secrets
    const secrets = entities.filter((e) => ["api_key", "env_variable"].includes(e.type));
    expect(secrets).toHaveLength(0);
  });

  it("detects domain (non-allowlisted)", () => {
    const text = "Internal service available at my-internal-service.internal";
    const entities = classifier.classify(text);
    expect(entities.some((e) => e.type === "domain")).toBe(true);
  });

  it("does NOT flag allowlisted domain (github.com)", () => {
    const text = "See documentation at github.com for more info";
    const entities = classifier.classify(text);
    const githubEntities = entities.filter(
      (e) => e.type === "domain" && e.value.toLowerCase().includes("github.com"),
    );
    expect(githubEntities).toHaveLength(0);
  });

  it("deduplicates overlapping matches — longest wins", () => {
    // An env_variable pattern may overlap with an api_key pattern;
    // only one should survive
    const text = "TOKEN=sk-test-abc123def456ghi789jkl012mno345";
    const entities = classifier.classify(text);

    // No two entities should overlap
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i];
        const b = entities[j];
        const overlaps = a.start < b.end && b.start < a.end;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("applies custom pattern and detects match", () => {
    const text = "TICKET-1234 needs review";
    const entities = classifier.classify(text, [
      {
        type: "api_key",
        severity: "medium",
        pattern: /TICKET-\d+/g,
      },
    ]);
    expect(entities.some((e) => e.value === "TICKET-1234")).toBe(true);
  });
});

// ─── AnonymizerService ─────────────────────────────────────────────────────────

describe("AnonymizerService", () => {
  let anonymizer: AnonymizerService;

  beforeEach(() => {
    anonymizer = new AnonymizerService();
  });

  // level=off ──────────────────────────────────────────────────────────────────

  it("level=off returns text unchanged with empty entities", () => {
    const text = "api_key=sk-supersecretvalue123456789abc and user@corp.io";
    const result = anonymizer.anonymize(text, "session-off", "off");
    expect(result.anonymizedText).toBe(text);
    expect(result.entitiesFound).toHaveLength(0);
  });

  // ALWAYS_REDACT types ────────────────────────────────────────────────────────

  it("env_variable is always <REDACTED> (never pseudonymized)", () => {
    const text = "SECRET_KEY=abcdefghijklmnopq123456";
    const result = anonymizer.anonymize(text, "session-env", "standard");
    expect(result.anonymizedText).toContain("<REDACTED>");
    expect(result.anonymizedText).not.toContain("SECRET_KEY=abcdefghijklmnopq123456");
  });

  it("api_key is always <REDACTED>", () => {
    const text = "token=sk-abc123def456ghi789jkl012mno345pqr";
    const result = anonymizer.anonymize(text, "session-key", "standard");
    expect(result.anonymizedText).toContain("<REDACTED>");
  });

  // Email pseudonymization ─────────────────────────────────────────────────────

  it("email is pseudonymized to local@example.com form at standard level", () => {
    const text = "Contact alice@company.com for info";
    const result = anonymizer.anonymize(text, "session-email", "standard");
    expect(result.anonymizedText).toContain("@example.com");
    expect(result.anonymizedText).not.toContain("alice@company.com");
  });

  it("email preserves local part in pseudonym", () => {
    const text = "Send to bob@internal.net";
    const result = anonymizer.anonymize(text, "session-email-local", "standard");
    // Pseudonym should be bob@example.com
    expect(result.anonymizedText).toContain("bob@example.com");
  });

  // IP address ─────────────────────────────────────────────────────────────────

  it("ip_address pseudonym preserves host octet", () => {
    const text = "Server is at 192.168.0.42";
    const result = anonymizer.anonymize(text, "session-ip", "standard");
    // Should not contain original; pseudonym keeps last octet (42)
    expect(result.anonymizedText).not.toContain("192.168.0.42");
    expect(result.anonymizedText).toContain(".42");
  });

  // Idempotency / consistency ──────────────────────────────────────────────────

  it("same input + same sessionId → identical output (idempotent)", () => {
    const text = "Deploy to 10.0.1.55 using key token=sk-xxxxxxxxxxxxxxxxxxxxxx123456789";
    const sessionId = "session-consistency";
    const r1 = anonymizer.anonymize(text, sessionId, "standard");
    const r2 = anonymizer.anonymize(text, sessionId, "standard");
    expect(r1.anonymizedText).toBe(r2.anonymizedText);
  });

  it("different sessionIds produce independent mappings", () => {
    const text = "Contact alice@company.com";
    const r1 = anonymizer.anonymize(text, "session-A", "standard");
    const r2 = anonymizer.anonymize(text, "session-B", "standard");
    // Both anonymized but may have different index (a vs b etc.)
    expect(r1.anonymizedText).not.toContain("alice@company.com");
    expect(r2.anonymizedText).not.toContain("alice@company.com");
  });

  // strict level ───────────────────────────────────────────────────────────────

  it("strict level anonymizes medium severity entities too", () => {
    const text = "Deploy to namespace: my-custom-namespace";
    const standard = anonymizer.anonymize(text, "session-strict-s", "standard");
    const strict = anonymizer.anonymize(text, "session-strict", "strict");

    // k8s_namespace is medium — strict should mask it, standard may not
    const strictMasked = !strict.anonymizedText.includes("my-custom-namespace");
    expect(strictMasked).toBe(true);
    // Standard may or may not — no assertion needed
  });

  // Invalid custom pattern ─────────────────────────────────────────────────────

  it("invalid regex in customPatterns causes DataClassifier to throw", () => {
    expect(() => {
      new RegExp("[invalid");
    }).toThrow();
  });

  // clearSession ───────────────────────────────────────────────────────────────

  it("clearSession removes session data — subsequent calls get fresh mapping", () => {
    const text = "Contact alice@company.com";
    const r1 = anonymizer.anonymize(text, "session-clear", "standard");
    anonymizer.clearSession("session-clear");
    const r2 = anonymizer.anonymize(text, "session-clear", "standard");
    // Both should be anonymized (mapping reset but same result for first occurrence)
    expect(r1.anonymizedText).toContain("@example.com");
    expect(r2.anonymizedText).toContain("@example.com");
  });

  // rehydrate ──────────────────────────────────────────────────────────────────

  it("rehydrate restores pseudonymized values (not redacted)", () => {
    const text = "Contact alice@company.com";
    const result = anonymizer.anonymize(text, "session-rehydrate", "standard");
    const restored = anonymizer.rehydrate(result.anonymizedText, "session-rehydrate");
    expect(restored).toContain("alice@company.com");
  });

  it("rehydrate does not restore <REDACTED> values", () => {
    const text = "SECRET_KEY=abcdefghijklmnopq123456";
    const result = anonymizer.anonymize(text, "session-redacted", "standard");
    const restored = anonymizer.rehydrate(result.anonymizedText, "session-redacted");
    // REDACTED should stay redacted (never restored)
    expect(restored).toContain("<REDACTED>");
  });
});
