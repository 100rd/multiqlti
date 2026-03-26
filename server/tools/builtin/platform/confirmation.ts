import type { ToolHandler } from "../../registry";

/**
 * Result shape returned by destructive tools when confirmation is needed.
 * Stateless: the caller must re-invoke with `{ confirmed: true }` to proceed.
 */
interface ConfirmationPending {
  needsConfirmation: true;
  action: string;
  details: string;
}

interface DestructiveToolConfig {
  /** Tool definition (name, description, inputSchema, etc.) */
  definition: ToolHandler["definition"];
  /** Human-readable action description, e.g. "Delete pipeline" */
  action: string;
  /** Builds the confirmation details string from the tool input */
  describeAction(args: Record<string, unknown>): string;
  /** Actual execution once confirmed */
  executeConfirmed(args: Record<string, unknown>): Promise<string>;
}

/**
 * Wraps a destructive tool with a stateless confirmation protocol.
 *
 * First call (no `confirmed: true`):  returns JSON with needsConfirmation.
 * Second call (with `confirmed: true`): executes the destructive action.
 */
export function withConfirmation(config: DestructiveToolConfig): ToolHandler {
  return {
    definition: config.definition,
    async execute(args: Record<string, unknown>): Promise<string> {
      if (args["confirmed"] === true) {
        return config.executeConfirmed(args);
      }

      const pending: ConfirmationPending = {
        needsConfirmation: true,
        action: config.action,
        details: config.describeAction(args),
      };
      return JSON.stringify(pending);
    },
  };
}
