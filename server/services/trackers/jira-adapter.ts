import type { IIssueTracker } from "./tracker-interface.js";

/**
 * Jira REST API v3 adapter.
 *
 * Requires `baseUrl` (e.g. "https://mycompany.atlassian.net") and a
 * Base64-encoded `email:apiToken` credential.
 */
export class JiraAdapter implements IIssueTracker {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${this.apiToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  async addComment(issueKey: string, comment: string): Promise<void> {
    const url = `${this.baseUrl}/rest/api/3/issue/${issueKey}/comment`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: comment }],
            },
          ],
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira addComment failed (${res.status}): ${body}`);
    }
  }

  async createSubtask(
    parentKey: string,
    task: { title: string; description: string },
  ): Promise<{ externalId: string }> {
    // Look up parent to get project key
    const parentUrl = `${this.baseUrl}/rest/api/3/issue/${parentKey}?fields=project`;
    const parentRes = await fetch(parentUrl, {
      method: "GET",
      headers: this.headers(),
    });
    if (!parentRes.ok) {
      throw new Error(`Jira getIssue failed (${parentRes.status})`);
    }
    const parentData = (await parentRes.json()) as {
      fields: { project: { key: string } };
    };
    const projectKey = parentData.fields.project.key;

    const url = `${this.baseUrl}/rest/api/3/issue`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          parent: { key: parentKey },
          summary: task.title,
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: task.description }],
              },
            ],
          },
          issuetype: { name: "Sub-task" },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira createSubtask failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { key: string };
    return { externalId: data.key };
  }

  async updateSubtaskStatus(externalId: string, status: string): Promise<void> {
    // First get available transitions
    const transUrl = `${this.baseUrl}/rest/api/3/issue/${externalId}/transitions`;
    const transRes = await fetch(transUrl, {
      method: "GET",
      headers: this.headers(),
    });
    if (!transRes.ok) {
      throw new Error(`Jira getTransitions failed (${transRes.status})`);
    }
    const transData = (await transRes.json()) as {
      transitions: Array<{ id: string; name: string }>;
    };
    const match = transData.transitions.find(
      (t) => t.name.toLowerCase() === status.toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `Jira transition "${status}" not found. Available: ${transData.transitions.map((t) => t.name).join(", ")}`,
      );
    }

    const res = await fetch(transUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira transition failed (${res.status}): ${body}`);
    }
  }
}
