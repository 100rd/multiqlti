import { ToolRegistry } from "./registry";
import { webSearchHandler } from "./builtin/web-search";
import { urlReaderHandler } from "./builtin/url-reader";
import { knowledgeSearchHandler } from "./builtin/knowledge-search";
import { memorySearchHandler } from "./builtin/memory-search";
import { codeSearchHandler } from "./builtin/code-search";
import { fileReadHandler } from "./builtin/file-read";
import { platformTools } from "./builtin/platform/index";

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

export { ToolRegistry } from "./registry";
export type { ToolHandler } from "./registry";
