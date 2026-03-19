import type { IStorage } from "../storage.js";
import { createTrackerAdapter, type IIssueTracker } from "./trackers/index.js";
import type { TrackerConnectionRow } from "@shared/schema";

/**
 * TrackerSyncService bridges internal task events to external issue trackers.
 *
 * It loads the tracker connection for a task group and relays comments,
 * sub-task creation, and status updates to the configured provider.
 */
export class TrackerSyncService {
  constructor(private readonly storage: IStorage) {}

  /**
   * Get the adapter for a given tracker connection row.
   */
  private adapterFor(conn: TrackerConnectionRow): IIssueTracker {
    return createTrackerAdapter(conn.provider, {
      baseUrl: conn.baseUrl,
      apiToken: conn.apiToken,
    });
  }

  /**
   * Post a comment on the connected issue when a task event occurs.
   */
  async syncComment(taskGroupId: string, comment: string): Promise<void> {
    const connections = await this.storage.getTrackerConnectionsByGroup(taskGroupId);
    for (const conn of connections) {
      if (!conn.syncComments) continue;
      try {
        const adapter = this.adapterFor(conn);
        await adapter.addComment(conn.issueKey, comment);
      } catch {
        // Swallow adapter errors to avoid breaking the main flow
      }
    }
  }

  /**
   * Create sub-tasks in the external tracker for each task in the group.
   */
  async syncSubtasks(
    taskGroupId: string,
    tasks: Array<{ title: string; description: string }>,
  ): Promise<Array<{ title: string; externalId: string | null }>> {
    const connections = await this.storage.getTrackerConnectionsByGroup(taskGroupId);
    const results: Array<{ title: string; externalId: string | null }> = [];

    for (const task of tasks) {
      let externalId: string | null = null;
      for (const conn of connections) {
        if (!conn.syncSubtasks) continue;
        try {
          const adapter = this.adapterFor(conn);
          const result = await adapter.createSubtask(conn.issueKey, task);
          externalId = result.externalId;
        } catch {
          // continue with other connections
        }
      }
      results.push({ title: task.title, externalId });
    }

    return results;
  }

  /**
   * Update the status of a sub-task in the external tracker.
   */
  async syncSubtaskStatus(
    taskGroupId: string,
    externalId: string,
    status: string,
  ): Promise<void> {
    const connections = await this.storage.getTrackerConnectionsByGroup(taskGroupId);
    for (const conn of connections) {
      if (!conn.syncSubtasks) continue;
      try {
        const adapter = this.adapterFor(conn);
        await adapter.updateSubtaskStatus(externalId, status);
      } catch {
        // Swallow adapter errors
      }
    }
  }
}
