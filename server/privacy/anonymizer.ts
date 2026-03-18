import type {
  AnonymizationLevel,
  AnonymizationResult,
  DetectedEntity,
  EntitySeverity,
  EntityType,
} from "@shared/types";
import { DataClassifier } from "./classifier";
import type { CustomPattern } from "./classifier";

// Severity ordering for level-based filtering
const SEVERITY_RANK: Record<EntitySeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// Entities that must always be redacted, never pseudonymized
const ALWAYS_REDACT: Set<EntityType> = new Set(["api_key", "env_variable"]);

// Counter per session for generating indexed pseudonyms
type SessionCounters = Map<EntityType, number>;

function nextIndex(counters: SessionCounters, type: EntityType): number {
  const current = counters.get(type) ?? 0;
  counters.set(type, current + 1);
  return current;
}

function letterLabel(index: number): string {
  // a, b, c, ... z, aa, ab, ...
  const base = "abcdefghijklmnopqrstuvwxyz";
  if (index < base.length) return base[index];
  return base[Math.floor(index / base.length) - 1] + base[index % base.length];
}

function generatePseudonym(
  type: EntityType,
  value: string,
  index: number,
): string {
  const label = letterLabel(index);

  switch (type) {
    case "domain":
      return `service-${label}.example.internal`;

    case "ip_address": {
      // Preserve host octet for readability
      const parts = value.split(".");
      const host = parts[3] ?? "1";
      return `10.0.${index}.${host}`;
    }

    case "k8s_namespace": {
      // Preserve env prefix (prod-, dev-, staging-)
      const prefixMatch = /^(prod|dev|staging|qa)-/.exec(value);
      const prefix = prefixMatch ? prefixMatch[1] : "env";
      return `${prefix}-svc-${label}`;
    }

    case "git_url":
      return `github.com/org-${label}/repo-${label}`;

    case "docker_image":
      return `registry-${label}.example.io/svc-${label}`;

    case "email": {
      const atIdx = value.indexOf("@");
      const localPart = atIdx > 0 ? value.slice(0, atIdx) : "user";
      return `${localPart}@example.com`;
    }

    case "cloud_account": {
      if (value.startsWith("arn:aws:")) {
        // Replace account ID (12 digits) with zero-padded counter
        return value.replace(/:\d{12}:/, `:${String(index + 1).padStart(12, "0")}:`);
      }
      // Azure subscription UUID → zero UUID variant
      return value.replace(
        /[0-9a-f-]{36}/i,
        `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
      );
    }

    case "api_key":
    case "env_variable":
      return "<REDACTED>";

    // ─── K8s + ArgoCD pseudonyms (Phase 6.10) ──────────────────────────────────
    case "k8s_pod":
      return `pod-${label}-example`;

    case "k8s_service":
      return `svc-${label}.ns-${label}.svc.cluster.local`;

    case "k8s_configmap":
      return `cm-${label}`;

    case "k8s_secret_ref":
      return `secret-${label}`;

    case "k8s_ingress":
      return `ingress-${label}`;

    case "k8s_cluster":
      if (value.startsWith("arn:aws:eks:")) {
        return value.replace(/cluster\/[^/\s]+/, `cluster/cluster-${label}`);
      }
      return `cluster-${label}`;

    case "argocd_project":
      return `project-${label}`;

    default:
      return `[${type.toUpperCase()}_${index + 1}]`;
  }
}

export class AnonymizerService {
  private vault: Map<string, Map<string, string>> = new Map();
  private counters: Map<string, SessionCounters> = new Map();
  private ttlTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private classifier = new DataClassifier();

  private getOrCreateSession(sessionId: string): Map<string, string> {
    if (!this.vault.has(sessionId)) {
      this.vault.set(sessionId, new Map());
      this.counters.set(sessionId, new Map());
    }
    return this.vault.get(sessionId)!;
  }

  private scheduleExpiry(sessionId: string, ttlMs: number): void {
    const existing = this.ttlTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => this.clearSession(sessionId), ttlMs);
    this.ttlTimers.set(sessionId, timer);
  }

  private getPseudonym(
    sessionId: string,
    type: EntityType,
    value: string,
  ): string {
    const sessionMap = this.getOrCreateSession(sessionId);
    if (sessionMap.has(value)) return sessionMap.get(value)!;

    const sessionCounters = this.counters.get(sessionId)!;
    const index = nextIndex(sessionCounters, type);
    const pseudonym = generatePseudonym(type, value, index);
    sessionMap.set(value, pseudonym);
    return pseudonym;
  }

  private minSeverityForLevel(level: AnonymizationLevel): number {
    if (level === "strict") return SEVERITY_RANK.low;
    return SEVERITY_RANK.high; // standard: mask critical + high
  }

  anonymize(
    text: string,
    sessionId: string,
    level: AnonymizationLevel,
    ttlMs = 3_600_000,
    customPatterns?: CustomPattern[],
  ): AnonymizationResult {
    if (level === "off") {
      return { anonymizedText: text, sessionId, entitiesFound: [] };
    }

    this.getOrCreateSession(sessionId);
    this.scheduleExpiry(sessionId, ttlMs);

    const entities = this.classifier.classify(text, customPatterns);
    const minRank = this.minSeverityForLevel(level);

    // Filter by severity threshold
    const toMask = entities.filter(
      (e) => SEVERITY_RANK[e.severity] >= minRank || ALWAYS_REDACT.has(e.type),
    );

    // Replace from end to start to preserve offsets
    const sorted = [...toMask].sort((a, b) => b.start - a.start);
    let result = text;
    for (const entity of sorted) {
      const pseudonym = this.getPseudonym(sessionId, entity.type, entity.value);
      result = result.slice(0, entity.start) + pseudonym + result.slice(entity.end);
    }

    return {
      anonymizedText: result,
      sessionId,
      entitiesFound: entities,
    };
  }

  rehydrate(text: string, sessionId: string): string {
    const sessionMap = this.vault.get(sessionId);
    if (!sessionMap) return text;

    let result = text;
    // Sort by pseudonym length descending to avoid partial replacements
    const entries = [...sessionMap.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );
    for (const [real, pseudonym] of entries) {
      if (pseudonym === "<REDACTED>") continue; // never restore redacted values
      result = result.split(pseudonym).join(real);
    }
    return result;
  }

  clearSession(sessionId: string): void {
    this.vault.delete(sessionId);
    this.counters.delete(sessionId);
    const timer = this.ttlTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.ttlTimers.delete(sessionId);
    }
  }
}
