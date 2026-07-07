import type { ToolHandler } from "../../registry";
import { workspaceTools } from "./workspaces";
import { triggerTools } from "./triggers";
import { utilityTools } from "./utilities";

/**
 * All platform tools aggregated into a single array.
 * Each tool follows the ToolHandler interface and is ready
 * for registration with the ToolRegistry singleton.
 */
export const platformTools: ToolHandler[] = [
  ...workspaceTools,
  ...triggerTools,
  ...utilityTools,
];

export { workspaceTools } from "./workspaces";
export { triggerTools } from "./triggers";
export { utilityTools } from "./utilities";
