import { BaseAgent } from "../base-agent.js";

export class ReleaseAgent extends BaseAgent {
  constructor() {
    super({
      name: "release-agent",
      description: "Release lifecycle — build, push, test, git status, ArgoCD sync, deployment status",
      version: "0.1.0",
      port: parseInt(process.env.AGENT_PORT ?? "8083", 10),
    });
  }

  protected setupTools(): void {
    const ns = process.env.AGENT_NAMESPACE ?? "default";

    this.registerTool({
      name: "build_image",
      description: "Build a Docker container image",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Image tag (e.g. myapp:v1.0.0)" },
          context: { type: "string", description: "Build context path" },
          buildArgs: {
            type: "array",
            items: { type: "string" },
            description: "Build arguments (KEY=VALUE)",
          },
          noCache: { type: "boolean", description: "Disable build cache" },
        },
        required: ["tag", "context"],
      },
      handler: async (input) => {
        const args = ["build", "-t", input.tag as string];
        if (input.noCache) args.push("--no-cache");
        if (input.buildArgs && Array.isArray(input.buildArgs)) {
          for (const arg of input.buildArgs) {
            args.push("--build-arg", arg as string);
          }
        }
        args.push(input.context as string);
        return this.exec("docker", args);
      },
    });

    this.registerTool({
      name: "push_image",
      description: "Push a Docker image to a registry",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Image tag to push" },
        },
        required: ["tag"],
      },
      handler: async (input) => {
        return this.exec("docker", ["push", input.tag as string]);
      },
    });

    this.registerTool({
      name: "run_tests",
      description: "Run a test command with configurable workdir and environment",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Test command to run" },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command arguments",
          },
          workdir: { type: "string", description: "Working directory" },
          env: {
            type: "object",
            description: "Environment variables (key-value pairs)",
          },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const cmd = input.command as string;
        const cmdArgs = (input.args as string[]) ?? [];
        return this.exec(cmd, cmdArgs);
      },
    });

    this.registerTool({
      name: "git_status",
      description: "Get comprehensive git repository status (status, log, branch, diff stats)",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const sections: string[] = [];

        try {
          const status = await this.exec("git", ["status"]);
          sections.push(`=== GIT STATUS ===\n${status.content}`);
        } catch (err: unknown) {
          sections.push(`=== GIT STATUS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          const log = await this.exec("git", ["log", "--oneline", "-10"]);
          sections.push(`=== RECENT COMMITS ===\n${log.content}`);
        } catch (err: unknown) {
          sections.push(`=== RECENT COMMITS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          const branch = await this.exec("git", ["branch", "--show-current"]);
          sections.push(`=== CURRENT BRANCH ===\n${branch.content}`);
        } catch (err: unknown) {
          sections.push(`=== CURRENT BRANCH ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          const diff = await this.exec("git", ["diff", "--stat"]);
          sections.push(`=== DIFF STAT ===\n${diff.content}`);
        } catch (err: unknown) {
          sections.push(`=== DIFF STAT ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        return { content: sections.join("\n\n") };
      },
    });

    this.registerTool({
      name: "argocd_sync",
      description: "Sync an ArgoCD application",
      inputSchema: {
        type: "object",
        properties: {
          appName: { type: "string", description: "ArgoCD application name" },
          revision: { type: "string", description: "Target revision to sync to" },
          prune: { type: "boolean", description: "Prune resources that are no longer in git" },
        },
        required: ["appName"],
      },
      handler: async (input) => {
        const args = ["app", "sync", input.appName as string];
        if (input.revision) args.push("--revision", input.revision as string);
        if (input.prune) args.push("--prune");
        return this.exec("argocd", args);
      },
    });

    this.registerTool({
      name: "deployment_status",
      description: "Get comprehensive deployment status (deployments, pods, events)",
      inputSchema: {
        type: "object",
        properties: {
          deployment: { type: "string", description: "Deployment name" },
          namespace: { type: "string", description: "Namespace override" },
        },
        required: ["deployment"],
      },
      handler: async (input) => {
        const deployment = input.deployment as string;
        const targetNs = (input.namespace as string) ?? ns;
        const sections: string[] = [];

        try {
          const result = await this.exec("kubectl", ["get", "deployment", deployment, "-n", targetNs, "-o", "wide"]);
          sections.push(`=== DEPLOYMENT ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== DEPLOYMENT ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          const result = await this.exec("kubectl", ["get", "pods", "-n", targetNs, "-l", `app=${deployment}`]);
          sections.push(`=== PODS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== PODS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          const result = await this.exec("kubectl", [
            "get", "events", "-n", targetNs,
            "--field-selector", `involvedObject.name=${deployment}`,
            "--sort-by", ".lastTimestamp",
          ]);
          sections.push(`=== EVENTS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== EVENTS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        return { content: sections.join("\n\n") };
      },
    });
  }
}
