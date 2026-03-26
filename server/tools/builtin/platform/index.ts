import type { ToolHandler } from "../../registry";
import { pipelineTools } from "./pipelines";
import { workspaceTools } from "./workspaces";
import { triggerTools } from "./triggers";
import { utilityTools } from "./utilities";

/**
 * All platform tools aggregated into a single array.
 * Each tool follows the ToolHandler interface and is ready
 * for registration with the ToolRegistry singleton.
 */
export const platformTools: ToolHandler[] = [
  ...pipelineTools,
  ...workspaceTools,
  ...triggerTools,
  ...utilityTools,
];

export { pipelineTools } from "./pipelines";
export { workspaceTools } from "./workspaces";
export { triggerTools } from "./triggers";
export { utilityTools } from "./utilities";
