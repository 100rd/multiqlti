import type { IIssueTracker } from "./tracker-interface.js";

/**
 * GitHub Issues adapter stub — not yet implemented.
 */
export class GitHubAdapter implements IIssueTracker {
  async addComment(_issueKey: string, _comment: string): Promise<void> {
    throw new Error("GitHub adapter not implemented");
  }

  async createSubtask(
    _parentKey: string,
    _task: { title: string; description: string },
  ): Promise<{ externalId: string }> {
    throw new Error("GitHub adapter not implemented");
  }

  async updateSubtaskStatus(_externalId: string, _status: string): Promise<void> {
    throw new Error("GitHub adapter not implemented");
  }
}
