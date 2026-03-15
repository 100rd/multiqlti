import type { IStorage } from "../storage";
import type { Memory, MemoryType } from "@shared/types";

const SCOPE_WEIGHTS: Record<string, number> = {
  pipeline: 0.8,
  global: 0.4,
  workspace: 0.6,
  run: 1.0,
};

const CHARS_PER_TOKEN = 4;
const DECAY_AMOUNT = 0.1;
const STALE_THRESHOLD = 0.3;

function recencyBoost(updatedAt: Date | null): number {
  if (!updatedAt) return 0.5;
  const ageMs = Date.now() - updatedAt.getTime();
  const ageDays = ageMs / 86_400_000;
  if (ageDays < 1) return 1.0;
  if (ageDays < 7) return 0.9;
  if (ageDays < 30) return 0.7;
  return 0.5;
}

function scoreMemory(m: Memory): number {
  const scopeWeight = SCOPE_WEIGHTS[m.scope] ?? 0.4;
  return scopeWeight * m.confidence * recencyBoost(m.updatedAt);
}

export class MemoryProvider {
  constructor(private storage: IStorage) {}

  async getRelevantMemories(params: {
    pipelineId: number;
    runId: number;
    teamId: string;
    maxTokenBudget: number;
  }): Promise<Memory[]> {
    const [pipelineMems, globalMems] = await Promise.all([
      this.storage.getMemories("pipeline", String(params.pipelineId)),
      this.storage.getMemories("global"),
    ]);

    const all = [...pipelineMems, ...globalMems]
      .filter((m) => m.confidence >= STALE_THRESHOLD)
      .sort((a, b) => scoreMemory(b) - scoreMemory(a));

    const budget = params.maxTokenBudget * CHARS_PER_TOKEN;
    let used = 0;
    const selected: Memory[] = [];

    for (const m of all) {
      const cost = m.content.length + m.key.length + 20;
      if (used + cost > budget) break;
      selected.push(m);
      used += cost;
    }

    return selected;
  }

  formatForPrompt(memories: Memory[]): string {
    const grouped: Partial<Record<MemoryType, Memory[]>> = {};

    for (const m of memories) {
      if (!grouped[m.type]) grouped[m.type] = [];
      grouped[m.type]!.push(m);
    }

    const sectionTitles: Record<MemoryType, string> = {
      decision: "Decisions",
      fact: "Facts",
      pattern: "Patterns",
      preference: "Preferences",
      issue: "Known Issues",
      dependency: "Dependencies",
    };

    const sectionOrder: MemoryType[] = [
      "decision", "fact", "pattern", "preference", "issue", "dependency",
    ];

    const lines: string[] = ["## Project Memory", ""];

    for (const type of sectionOrder) {
      const items = grouped[type];
      if (!items || items.length === 0) continue;
      lines.push(`**${sectionTitles[type]}:**`);
      for (const m of items) {
        const meta = `confidence: ${m.confidence.toFixed(1)}, source: ${m.source ?? "unknown"}`;
        lines.push(`- [${m.key}] ${m.content} (${meta})`);
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  async decayUnconfirmedMemories(runId: number): Promise<void> {
    await this.storage.decayMemories(runId, DECAY_AMOUNT);
    await this.storage.deleteStaleMemories(STALE_THRESHOLD);
  }
}
