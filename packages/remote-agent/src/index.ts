export { BaseAgent } from "./base-agent.js";
export type { AgentToolHandler } from "./base-agent.js";
export { K8sAgent } from "./agents/k8s-agent.js";
export { HelmAgent } from "./agents/helm-agent.js";
export { ObservabilityAgent } from "./agents/observability-agent.js";
export { TriageAgent } from "./agents/triage-agent.js";
export { ReleaseAgent } from "./agents/release-agent.js";

// Entry point — when run directly, start based on AGENT_TYPE
const agentType = process.env.AGENT_TYPE ?? "k8s";

async function main() {
  let agent;
  switch (agentType) {
    case "k8s":
      agent = new (await import("./agents/k8s-agent.js")).K8sAgent();
      break;
    case "helm":
      agent = new (await import("./agents/helm-agent.js")).HelmAgent();
      break;
    case "observability":
      agent = new (await import("./agents/observability-agent.js")).ObservabilityAgent();
      break;
    case "release":
      agent = new (await import("./agents/release-agent.js")).ReleaseAgent();
      break;
    case "triage":
      agent = new (await import("./agents/triage-agent.js")).TriageAgent();
      break;
    default:
      console.error(`Unknown AGENT_TYPE: ${agentType}`);
      process.exit(1);
  }
  await agent.start();
}

// Only run if this is the entry point
if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
