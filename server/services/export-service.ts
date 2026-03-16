import type { PipelineRun, StageExecution, Pipeline, LlmRequest } from "@shared/schema";

// ─── Markdown Export ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function formatTimestamp(date: Date | null | string): string {
  if (!date) return "N/A";
  return new Date(date).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatCostUsd(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

// ─── Cost Breakdown Section ─────────────────────────────────────────────────

interface StageCostEntry {
  stageIndex: number;
  teamId: string;
  modelSlug: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

function aggregateCostByStage(
  stages: StageExecution[],
  llmRequests: LlmRequest[],
): StageCostEntry[] {
  const stageMap = new Map<string, StageCostEntry>();

  for (const stage of stages) {
    const stageReqs = llmRequests.filter((r) => r.stageExecutionId === stage.id);
    if (stageReqs.length === 0 && stage.status !== "completed") continue;

    stageMap.set(stage.id, {
      stageIndex: stage.stageIndex,
      teamId: stage.teamId,
      modelSlug: stage.modelSlug,
      requests: stageReqs.length,
      inputTokens: stageReqs.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      outputTokens: stageReqs.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
      costUsd: stageReqs.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0),
      latencyMs: stageReqs.reduce((s, r) => s + (r.latencyMs ?? 0), 0),
    });
  }

  return Array.from(stageMap.values()).sort((a, b) => a.stageIndex - b.stageIndex);
}

function renderCostBreakdownSection(
  stages: StageExecution[],
  llmRequests: LlmRequest[],
): string[] {
  const entries = aggregateCostByStage(stages, llmRequests);
  if (entries.length === 0) return [];

  const lines: string[] = [
    `## Cost Breakdown`,
    ``,
    `| Stage | Model | Requests | Input Tokens | Output Tokens | Est. Cost |`,
    `|-------|-------|----------|-------------|--------------|-----------|`,
  ];

  let totalReqs = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  for (const entry of entries) {
    lines.push(
      `| ${entry.stageIndex + 1}. ${entry.teamId} | ${entry.modelSlug} | ${entry.requests} | ${entry.inputTokens.toLocaleString()} | ${entry.outputTokens.toLocaleString()} | ${formatCostUsd(entry.costUsd)} |`,
    );
    totalReqs += entry.requests;
    totalInput += entry.inputTokens;
    totalOutput += entry.outputTokens;
    totalCost += entry.costUsd;
  }

  lines.push(
    `| **Total** | | **${totalReqs}** | **${totalInput.toLocaleString()}** | **${totalOutput.toLocaleString()}** | **${formatCostUsd(totalCost)}** |`,
  );
  lines.push(``);

  return lines;
}

// ─── Approval Gate Log Section ──────────────────────────────────────────────

function renderApprovalGateLog(stages: StageExecution[]): string[] {
  const approvalStages = stages.filter((s) => s.approvalStatus != null);
  if (approvalStages.length === 0) return [];

  const lines: string[] = [
    `## Approval Gates`,
    ``,
    `| Stage | Gate Type | Decision | Decided By | Reason | Wait Time |`,
    `|-------|-----------|----------|-----------|--------|-----------|`,
  ];

  for (const stage of approvalStages) {
    const gateConfig = stage.approvalGateConfig as Record<string, unknown> | null;
    const gateType = (gateConfig?.type as string) ?? "manual";
    const decision = stage.approvalStatus ?? "pending";

    const decidedBy = stage.approvedBy ?? "-";
    const reason = stage.autoApprovalReason
      ?? stage.rejectionReason
      ?? "-";

    let waitTime = "-";
    if (stage.startedAt && stage.approvedAt) {
      const ms = new Date(stage.approvedAt).getTime() - new Date(stage.startedAt).getTime();
      waitTime = formatDuration(Math.max(0, ms));
    }

    lines.push(
      `| ${stage.stageIndex + 1}. ${stage.teamId} | ${gateType} | ${decision} | ${decidedBy} | ${reason} | ${waitTime} |`,
    );
  }

  lines.push(``);
  return lines;
}

// ─── Main Markdown Report ───────────────────────────────────────────────────

export function generateMarkdownReport(
  run: PipelineRun,
  stages: StageExecution[],
  pipeline: Pipeline,
  llmRequests?: LlmRequest[],
): string {
  const completedStages = stages.filter((s) => s.status === "completed");
  const totalTokens = stages.reduce((sum, s) => sum + (s.tokensUsed ?? 0), 0);

  const durationMs =
    run.startedAt && run.completedAt
      ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
      : 0;

  const lines: string[] = [
    `# Pipeline Run Report`,
    ``,
    `## Executive Summary`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Pipeline | ${pipeline.name} |`,
    `| Run ID | \`${run.id}\` |`,
    `| Status | ${run.status} |`,
    `| Total Tokens | ${totalTokens.toLocaleString()} |`,
    `| Duration | ${durationMs > 0 ? formatDuration(durationMs) : "N/A"} |`,
    `| Started | ${formatTimestamp(run.startedAt)} |`,
    `| Completed | ${formatTimestamp(run.completedAt)} |`,
    `| Stages Completed | ${completedStages.length} / ${stages.filter((s) => s.status !== "skipped").length} |`,
    ``,
  ];

  // Model breakdown
  const modelBreakdown = new Map<string, { tokens: number; stages: number }>();
  for (const stage of completedStages) {
    const existing = modelBreakdown.get(stage.modelSlug) ?? { tokens: 0, stages: 0 };
    existing.tokens += stage.tokensUsed ?? 0;
    existing.stages++;
    modelBreakdown.set(stage.modelSlug, existing);
  }

  if (modelBreakdown.size > 0) {
    lines.push(`## Model Breakdown`, ``);
    lines.push(`| Model | Stages | Tokens |`);
    lines.push(`|-------|--------|--------|`);
    for (const [model, stats] of modelBreakdown) {
      lines.push(`| ${model} | ${stats.stages} | ${stats.tokens.toLocaleString()} |`);
    }
    lines.push(``);
  }

  // Timeline
  lines.push(`## Timeline`, ``);
  lines.push(`| # | Team | Status | Tokens | Started | Completed |`);
  lines.push(`|---|------|--------|--------|---------|-----------|`);
  for (const stage of stages) {
    lines.push(
      `| ${stage.stageIndex + 1} | ${stage.teamId} | ${stage.status} | ${(stage.tokensUsed ?? 0).toLocaleString()} | ${formatTimestamp(stage.startedAt)} | ${formatTimestamp(stage.completedAt)} |`,
    );
  }
  lines.push(``);

  // Cost breakdown (Phase 3.4)
  if (llmRequests && llmRequests.length > 0) {
    lines.push(...renderCostBreakdownSection(stages, llmRequests));
  }

  // Approval gate log (Phase 3.4)
  lines.push(...renderApprovalGateLog(stages));

  // Per-stage outputs
  lines.push(`## Stage Outputs`, ``);
  for (const stage of completedStages) {
    const output = stage.output as Record<string, unknown> | null;
    lines.push(`### Stage ${stage.stageIndex + 1}: ${stage.teamId}`);
    lines.push(``);
    lines.push(`- **Model**: ${stage.modelSlug}`);
    lines.push(`- **Tokens**: ${(stage.tokensUsed ?? 0).toLocaleString()}`);
    lines.push(``);

    if (output) {
      const summary = output.summary as string | undefined;
      if (summary) {
        lines.push(`#### Summary`, ``);
        lines.push(summary, ``);
      }

      const rawContent = output.raw as string | undefined;
      if (rawContent && rawContent !== summary) {
        lines.push(`#### Full Output`, ``, rawContent, ``);
      }
    }
  }

  // Input
  lines.push(`## Input`, ``, run.input, ``);

  return lines.join("\n");
}

// ─── Cost Breakdown JSON ────────────────────────────────────────────────────

export interface RunCostBreakdown {
  runId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  stages: StageCostEntry[];
}

function buildCostBreakdownJson(
  runId: string,
  stages: StageExecution[],
  llmRequests: LlmRequest[],
): RunCostBreakdown {
  const entries = aggregateCostByStage(stages, llmRequests);
  return {
    runId,
    totalCostUsd: entries.reduce((s, e) => s + e.costUsd, 0),
    totalInputTokens: entries.reduce((s, e) => s + e.inputTokens, 0),
    totalOutputTokens: entries.reduce((s, e) => s + e.outputTokens, 0),
    totalRequests: entries.reduce((s, e) => s + e.requests, 0),
    stages: entries,
  };
}

// ─── Code Block Extraction ───────────────────────────────────────────────────

interface CodeBlock {
  lang: string;
  content: string;
  stageIndex: number;
  blockIndex: number;
}

const CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;

const LANG_TO_EXT: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  go: "go",
  rust: "rs",
  java: "java",
  bash: "sh",
  shell: "sh",
  sh: "sh",
  yaml: "yaml",
  yml: "yml",
  json: "json",
  sql: "sql",
  html: "html",
  css: "css",
  markdown: "md",
  md: "md",
  dockerfile: "dockerfile",
  tf: "tf",
};

function extractCodeBlocks(stages: StageExecution[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const stage of stages) {
    if (stage.status !== "completed") continue;
    const output = stage.output as Record<string, unknown> | null;
    if (!output) continue;

    const text = (output.raw as string) ?? JSON.stringify(output);
    let match: RegExpExecArray | null;
    let blockIndex = 0;
    const re = new RegExp(CODE_BLOCK_RE.source, "g");
    while ((match = re.exec(text)) !== null) {
      const lang = match[1] ?? "";
      const content = match[2] ?? "";
      if (content.trim().length > 0) {
        blocks.push({ lang: lang.toLowerCase(), content, stageIndex: stage.stageIndex, blockIndex });
        blockIndex++;
      }
    }
  }
  return blocks;
}

// ─── Minimal ZIP Builder ──────────────────────────────────────────────────────
// Implements ZIP format (PKZIP spec) with STORE compression (no deflate).

function uint16LE(n: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function uint32LE(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

function crc32(buf: Buffer): number {
  const TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    TABLE[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const now = new Date();
  const { date: dosDate, time: dosTime } = dosDateTime(now);

  const localHeaders: Buffer[] = [];
  const centralDirs: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header (signature 0x04034b50)
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // signature
      uint16LE(20),          // version needed: 2.0
      uint16LE(0),           // flags
      uint16LE(0),           // compression: STORE
      uint16LE(dosTime),
      uint16LE(dosDate),
      uint32LE(crc),
      uint32LE(size),        // compressed size
      uint32LE(size),        // uncompressed size
      uint16LE(nameBuffer.length),
      uint16LE(0),           // extra field length
      nameBuffer,
      entry.data,
    ]);

    offsets.push(offset);
    localHeaders.push(local);
    offset += local.length;
  }

  // Central directory
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const cd = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // signature
      uint16LE(20),           // version made by
      uint16LE(20),           // version needed
      uint16LE(0),            // flags
      uint16LE(0),            // compression: STORE
      uint16LE(dosTime),
      uint16LE(dosDate),
      uint32LE(crc),
      uint32LE(size),
      uint32LE(size),
      uint16LE(nameBuffer.length),
      uint16LE(0),            // extra length
      uint16LE(0),            // comment length
      uint16LE(0),            // disk start
      uint16LE(0),            // internal attr
      uint32LE(0),            // external attr
      uint32LE(offsets[i]),   // local header offset
      nameBuffer,
    ]);
    centralDirs.push(cd);
  }

  const centralDirBuffer = Buffer.concat(centralDirs);
  const centralDirSize = centralDirBuffer.length;
  const centralDirOffset = offset;

  // End of central directory record
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), // signature
    uint16LE(0),                             // disk number
    uint16LE(0),                             // start disk
    uint16LE(entries.length),                // entries on disk
    uint16LE(entries.length),                // total entries
    uint32LE(centralDirSize),
    uint32LE(centralDirOffset),
    uint16LE(0),                             // comment length
  ]);

  return Buffer.concat([...localHeaders, centralDirBuffer, eocd]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateZipExport(
  run: PipelineRun,
  stages: StageExecution[],
  pipeline: Pipeline,
  llmRequests?: LlmRequest[],
): Buffer {
  const markdown = generateMarkdownReport(run, stages, pipeline, llmRequests);
  const entries: ZipEntry[] = [
    { name: "report.md", data: Buffer.from(markdown, "utf8") },
  ];

  // Cost breakdown JSON (Phase 3.4)
  if (llmRequests && llmRequests.length > 0) {
    const costBreakdown = buildCostBreakdownJson(run.id, stages, llmRequests);
    entries.push({
      name: "cost-breakdown.json",
      data: Buffer.from(JSON.stringify(costBreakdown, null, 2), "utf8"),
    });
  }

  const codeBlocks = extractCodeBlocks(stages);
  for (const block of codeBlocks) {
    const ext = (LANG_TO_EXT[block.lang] ?? block.lang) || "txt";
    const fileName = `stage-${block.stageIndex + 1}-code-${block.blockIndex + 1}.${ext}`;
    entries.push({ name: fileName, data: Buffer.from(block.content, "utf8") });
  }

  return buildZip(entries);
}

// ─── PDF Export (Phase 3.4) ─────────────────────────────────────────────────

/**
 * Generates a PDF buffer from a markdown string.
 * Uses md-to-pdf which wraps puppeteer/chromium.
 * Throws if chromium is unavailable at runtime.
 */
export async function generatePdfReport(markdown: string): Promise<Buffer> {
  // Dynamic import to avoid hard dependency if md-to-pdf is not installed
  const { mdToPdf } = await import("md-to-pdf");
  const result = await mdToPdf({ content: markdown }, { dest: undefined as unknown as string });
  if (!result?.content) {
    throw new Error("PDF generation produced no content");
  }
  return Buffer.from(result.content);
}
