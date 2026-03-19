import type { TrackerProvider } from "@shared/types";
import type { IIssueTracker } from "./tracker-interface.js";
import { JiraAdapter } from "./jira-adapter.js";
import { ClickUpAdapter } from "./clickup-adapter.js";
import { LinearAdapter } from "./linear-adapter.js";
import { GitHubAdapter } from "./github-adapter.js";

export type { IIssueTracker } from "./tracker-interface.js";

/**
 * Factory: create the correct tracker adapter for a given provider.
 */
export function createTrackerAdapter(
  provider: TrackerProvider,
  opts: { baseUrl?: string | null; apiToken?: string | null },
): IIssueTracker {
  switch (provider) {
    case "jira": {
      if (!opts.baseUrl) throw new Error("Jira requires a baseUrl");
      if (!opts.apiToken) throw new Error("Jira requires an apiToken");
      return new JiraAdapter(opts.baseUrl, opts.apiToken);
    }
    case "clickup":
      return new ClickUpAdapter();
    case "linear":
      return new LinearAdapter();
    case "github":
      return new GitHubAdapter();
    default:
      throw new Error(`Unknown tracker provider: ${provider as string}`);
  }
}
