import { ToolRegistry } from "./registry";
import { webSearchHandler } from "./builtin/web-search";
import { urlReaderHandler } from "./builtin/url-reader";
import { knowledgeSearchHandler } from "./builtin/knowledge-search";
import { memorySearchHandler } from "./builtin/memory-search";

// Singleton tool registry shared across the server process
export const toolRegistry = new ToolRegistry();

// Register all built-in tools
toolRegistry.register(webSearchHandler);
toolRegistry.register(urlReaderHandler);
toolRegistry.register(knowledgeSearchHandler);
toolRegistry.register(memorySearchHandler);

export { ToolRegistry } from "./registry";
export type { ToolHandler } from "./registry";
