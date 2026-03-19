/**
 * Abstract interface for external issue tracker integrations.
 * Each provider adapter implements this interface.
 */
export interface IIssueTracker {
  /** Post a comment on an existing issue. */
  addComment(issueKey: string, comment: string): Promise<void>;

  /** Create a sub-task under a parent issue. Returns the external ID. */
  createSubtask(
    parentKey: string,
    task: { title: string; description: string },
  ): Promise<{ externalId: string }>;

  /** Transition a sub-task to a new status. */
  updateSubtaskStatus(externalId: string, status: string): Promise<void>;
}
