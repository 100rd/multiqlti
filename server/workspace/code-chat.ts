import type { Gateway } from "../gateway/index";
import type { WorkspaceRow } from "@shared/schema";
import type { ReviewResult, ReviewIssue, CodeChange } from "@shared/types";
import { WorkspaceManager } from "./manager";

const REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer. Analyze the provided code and return a JSON response with the following structure:
{
  "issues": [
    {
      "severity": "error" | "warning" | "info",
      "file": "<filename>",
      "line": <optional line number>,
      "message": "<issue description>",
      "suggestion": "<optional fix suggestion>"
    }
  ],
  "summary": "<brief overall assessment>"
}
Only return valid JSON, no markdown fences.`;

export class CodeChatService {
  private manager: WorkspaceManager;

  constructor(private gateway: Gateway) {
    this.manager = new WorkspaceManager();
  }

  async reviewCode(
    workspace: WorkspaceRow,
    filePaths: string[],
    models: string[],
    prompt?: string,
  ): Promise<Map<string, ReviewResult>> {
    const fileContents = await this.loadFiles(workspace, filePaths);
    const userMessage = this.buildReviewMessage(fileContents, prompt);
    const results = new Map<string, ReviewResult>();

    await Promise.all(
      models.map(async (modelSlug) => {
        try {
          const response = await this.gateway.complete({
            modelSlug,
            messages: [
              { role: "system", content: REVIEW_SYSTEM_PROMPT },
              { role: "user", content: userMessage },
            ],
            maxTokens: 2048,
          });

          const result = this.parseReviewResponse(response.content, modelSlug);
          results.set(modelSlug, result);
        } catch (err) {
          results.set(modelSlug, {
            model: modelSlug,
            issues: [],
            summary: `Review failed: ${(err as Error).message}`,
          });
        }
      }),
    );

    return results;
  }

  /** Non-streaming chat. Used as JSON fallback when client does not accept SSE. */
  async chat(
    workspace: WorkspaceRow,
    message: string,
    modelSlug: string,
    context?: { filePaths?: string[]; selection?: { content: string } },
  ): Promise<string> {
    const systemPrompt = await this.buildChatSystemPrompt(workspace, context);

    const response = await this.gateway.complete({
      modelSlug,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      maxTokens: 4096,
    });

    return response.content;
  }

  /**
   * Streaming chat using SSE. Calls onChunk for each token chunk.
   * Returns the full accumulated reply when complete.
   */
  async chatStream(
    workspace: WorkspaceRow,
    message: string,
    modelSlug: string,
    context: { filePaths?: string[]; selection?: { content: string } } | undefined,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    const systemPrompt = await this.buildChatSystemPrompt(workspace, context);

    const chunks: string[] = [];
    for await (const chunk of this.gateway.stream({
      modelSlug,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      maxTokens: 4096,
    })) {
      chunks.push(chunk);
      onChunk(chunk);
    }

    return chunks.join("");
  }

  async applyChange(workspace: WorkspaceRow, filePath: string, change: CodeChange): Promise<void> {
    const content = await this.manager.readFile(workspace, filePath);
    const lines = content.split("\n");
    const updated = this.applyLineChange(lines, change);
    await this.manager.writeFile(workspace, filePath, updated.join("\n"));
  }

  private async buildChatSystemPrompt(
    workspace: WorkspaceRow,
    context?: { filePaths?: string[]; selection?: { content: string } },
  ): Promise<string> {
    const contextParts: string[] = [];

    if (context?.filePaths?.length) {
      const fileContents = await this.loadFiles(workspace, context.filePaths);
      contextParts.push(fileContents);
    }

    if (context?.selection?.content) {
      contextParts.push(`Selected code:\n\`\`\`\n${context.selection.content}\n\`\`\``);
    }

    return [
      "You are an expert software engineer helping with code in a workspace.",
      contextParts.length > 0 ? `\n\nContext:\n${contextParts.join("\n\n")}` : "",
    ]
      .filter(Boolean)
      .join("");
  }

  private applyLineChange(lines: string[], change: CodeChange): string[] {
    const result = [...lines];
    const start = change.startLine - 1;

    if (change.type === "replace") {
      const end = (change.endLine ?? change.startLine) - 1;
      const newLines = (change.content ?? "").split("\n");
      result.splice(start, end - start + 1, ...newLines);
    } else if (change.type === "insert") {
      const newLines = (change.content ?? "").split("\n");
      result.splice(start, 0, ...newLines);
    } else if (change.type === "delete") {
      const end = (change.endLine ?? change.startLine) - 1;
      result.splice(start, end - start + 1);
    }

    return result;
  }

  private async loadFiles(workspace: WorkspaceRow, filePaths: string[]): Promise<string> {
    const parts: string[] = [];
    for (const fp of filePaths) {
      try {
        const content = await this.manager.readFile(workspace, fp);
        parts.push(`// File: ${fp}\n${content}`);
      } catch {
        parts.push(`// File: ${fp}\n// [Could not read file]`);
      }
    }
    return parts.join("\n\n");
  }

  private buildReviewMessage(fileContents: string, prompt?: string): string {
    const lines = ["Review the following code:"];
    if (prompt) lines.push(`Focus on: ${prompt}`);
    lines.push("", fileContents);
    return lines.join("\n");
  }

  private parseReviewResponse(content: string, modelSlug: string): ReviewResult {
    try {
      const raw = JSON.parse(content) as { issues?: ReviewIssue[]; summary?: string };
      return {
        model: modelSlug,
        issues: Array.isArray(raw.issues) ? raw.issues : [],
        summary: typeof raw.summary === "string" ? raw.summary : "No summary provided",
      };
    } catch {
      return {
        model: modelSlug,
        issues: [],
        summary: content.slice(0, 500),
      };
    }
  }
}
