import type { DetectedEntity, EntitySeverity, EntityType } from "@shared/types";

interface PatternDefinition {
  type: EntityType;
  severity: EntitySeverity;
  patterns: RegExp[];
  allowlist?: string[];
}

export interface CustomPattern {
  type: EntityType;
  severity: EntitySeverity;
  pattern: RegExp;
  allowlist?: string[];
}

// Patterns compiled once at module load — never inside function calls
const BUILTIN_PATTERNS: PatternDefinition[] = [
  {
    type: "api_key",
    severity: "critical",
    patterns: [
      /(?:sk|pk|api[_-]?key|token|secret|password|Bearer)\s*[=:]\s*['"]?[\w\-.\/]{20,}/gi,
      /AKIA[0-9A-Z]{16}/g,
      /ghp_[A-Za-z0-9_]{36}/g,
    ],
  },
  {
    type: "cloud_account",
    severity: "critical",
    patterns: [
      /arn:aws:[a-z0-9-]+:[a-z0-9-]*:(\d{12}):/g,
      /\/subscriptions\/([0-9a-f-]{36})\//gi,
    ],
  },
  {
    type: "git_url",
    severity: "high",
    patterns: [/(?:https?:\/\/|git@)(?:github|gitlab|bitbucket)[^\s]+/gi],
  },
  {
    type: "docker_image",
    severity: "high",
    patterns: [
      /[a-z0-9.-]+\.(?:azurecr|gcr|ecr\.[a-z-]+\.amazonaws)\.(?:io|com)\/[^\s]+/gi,
    ],
  },
  {
    type: "ip_address",
    severity: "high",
    patterns: [
      /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g,
    ],
  },
  {
    type: "domain",
    severity: "high",
    patterns: [
      /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|io|dev|net|org|co|app|cloud|internal)/gi,
    ],
    allowlist: [
      "github.com",
      "docker.io",
      "kubernetes.io",
      "npmjs.com",
      "anthropic.com",
      "googleapis.com",
    ],
  },
  {
    type: "k8s_namespace",
    severity: "medium",
    patterns: [/namespace:\s*['"]?([a-z0-9][a-z0-9-]{0,61}[a-z0-9])/gi],
    allowlist: [
      "default",
      "kube-system",
      "kube-public",
      "argocd",
      "monitoring",
      "cert-manager",
    ],
  },
  {
    type: "email",
    severity: "medium",
    patterns: [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi],
  },
  {
    type: "env_variable",
    severity: "high",
    patterns: [/\b[A-Z][A-Z0-9_]{3,}=[^\s]{8,}/g],
  },
];

function isAllowlisted(value: string, allowlist: string[]): boolean {
  const lower = value.toLowerCase();
  return allowlist.some((entry) => lower === entry.toLowerCase() || lower.endsWith(`.${entry.toLowerCase()}`));
}

function deduplicateOverlapping(entities: DetectedEntity[]): DetectedEntity[] {
  // Sort by start, then by length descending (keep longest match)
  const sorted = [...entities].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });

  const result: DetectedEntity[] = [];
  let lastEnd = -1;

  for (const entity of sorted) {
    if (entity.start >= lastEnd) {
      result.push(entity);
      lastEnd = entity.end;
    } else if (entity.end > lastEnd) {
      // Partial overlap — skip the shorter one (already sorted by length desc)
    }
  }

  return result;
}

function extractMatches(
  text: string,
  def: PatternDefinition | CustomPattern,
): DetectedEntity[] {
  const results: DetectedEntity[] = [];
  const patterns = "patterns" in def ? def.patterns : [def.pattern];
  const allowlist = def.allowlist ?? [];

  for (const regex of patterns) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = match[0];
      if (isAllowlisted(value, allowlist)) continue;
      results.push({
        type: def.type,
        value,
        start: match.index,
        end: match.index + value.length,
        confidence: 0.9,
        severity: def.severity,
      });
    }
  }

  return results;
}

export class DataClassifier {
  classify(text: string, customPatterns?: CustomPattern[]): DetectedEntity[] {
    const all: DetectedEntity[] = [];

    for (const def of BUILTIN_PATTERNS) {
      all.push(...extractMatches(text, def));
    }

    if (customPatterns) {
      for (const cp of customPatterns) {
        all.push(...extractMatches(text, cp));
      }
    }

    return deduplicateOverlapping(all);
  }
}
