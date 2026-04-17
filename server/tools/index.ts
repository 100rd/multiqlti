import { ToolRegistry } from "./registry";
import { webSearchHandler } from "./builtin/web-search";
import { urlReaderHandler } from "./builtin/url-reader";
import { knowledgeSearchHandler } from "./builtin/knowledge-search";
import { memorySearchHandler } from "./builtin/memory-search";
import { codeSearchHandler } from "./builtin/code-search";
import { fileReadHandler } from "./builtin/file-read";
import { platformTools } from "./builtin/platform/index";
import { WorkspaceToolRegistry } from "./workspace-registry";
import { DEFAULT_SANDBOX_LIMITS } from "./sandbox-vm";

// Singleton tool registry shared across the server process
export const toolRegistry = new ToolRegistry();

// Register all built-in tools
toolRegistry.register(webSearchHandler);
toolRegistry.register(urlReaderHandler);
toolRegistry.register(knowledgeSearchHandler);
toolRegistry.register(memorySearchHandler);
toolRegistry.register(codeSearchHandler);
toolRegistry.register(fileReadHandler);

// Register platform control-plane tools
for (const tool of platformTools) {
  toolRegistry.register(tool);
}

// Singleton workspace-scoped registry — wraps the global registry with
// per-workspace custom tool overlays loaded by the DynamicToolLoader.
export const workspaceToolRegistry = new WorkspaceToolRegistry(
  toolRegistry,
  DEFAULT_SANDBOX_LIMITS,
);

export { ToolRegistry } from "./registry";
export type { ToolHandler } from "./registry";
export { WorkspaceToolRegistry } from "./workspace-registry";
// DynamicToolLoader is NOT re-exported here because it imports execFile from
// child_process, which would break integration tests with partial mocks.
// Import it directly from "./loader" when needed.
export { DEFAULT_SANDBOX_LIMITS } from "./sandbox-vm";
export type { SandboxLimits } from "./sandbox-vm";
