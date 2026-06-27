export interface PiiPattern {
  name: string;
  regex: RegExp;
  placeholder?: string;
}

export interface PiiFilterOptions {
  patterns?: PiiPattern[];
}

export const DEFAULT_PATTERNS: PiiPattern[] = [
  {
    name: 'email',
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
  },
  {
    name: 'ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: 'creditCard',
    regex: /\b\d(?:[- ]?\d){12,15}\b/g,
  },
];

export class PiiFilter {
  private patterns: PiiPattern[];

  constructor(options?: PiiFilterOptions) {
    this.patterns = options?.patterns ?? DEFAULT_PATTERNS;
  }

  private redactText(text: string): string {
    let result = text;
    for (const pattern of this.patterns) {
      const placeholder = pattern.placeholder ?? '***';
      result = result.replace(pattern.regex, placeholder);
    }
    return result;
  }

  filter(log: string): string {
    const trimmed = log.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(log);
        const redacted = this.filterObject(parsed);
        const match = log.match(/\n([ \t]+)/);
        const indent = match ? match[1] : undefined;
        return JSON.stringify(redacted, null, indent);
      } catch (e) {
        // Fall back to plain-text regex filter if parsing fails
      }
    }
    return this.redactText(log);
  }

  filterObject<T>(obj: T): T {
    return this.redactValue(obj) as T;
  }

  private redactValue(val: unknown): unknown {
    if (typeof val === 'string') {
      return this.redactText(val);
    }
    if (Array.isArray(val)) {
      return val.map(item => this.redactValue(item));
    }
    if (val !== null && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const redacted: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        redacted[key] = this.redactValue(obj[key]);
      }
      return redacted;
    }
    return val;
  }
}
