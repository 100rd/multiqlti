import { Model } from "@shared/schema";

export interface ProviderNode {
  provider: string;
  weight: number;
  isHealthy: boolean;
  lastChecked: Date;
}

export class ProviderPoolRouter {
  private pool: ProviderNode[] = [];

  constructor(initialPool?: ProviderNode[]) {
    if (initialPool) {
      this.pool = initialPool;
    }
  }

  addNode(node: ProviderNode): void {
    this.pool.push(node);
  }

  getHealthyNodes(): ProviderNode[] {
    return this.pool.filter((node) => node.isHealthy);
  }

  routeRequest(model: Model): ProviderNode {
    const healthy = this.getHealthyNodes();
    if (healthy.length === 0) {
      throw new Error(
        `No healthy provider nodes available for routing request for model: ${model.slug}`,
      );
    }

    // Simple routing matching model provider
    const matched = healthy.find((node) => node.provider === model.provider);
    return matched || healthy[0];
  }

  markUnhealthy(provider: string): void {
    const node = this.pool.find((n) => n.provider === provider);
    if (node) {
      node.isHealthy = false;
      node.lastChecked = new Date();
    }
  }

  markHealthy(provider: string): void {
    const node = this.pool.find((n) => n.provider === provider);
    if (node) {
      node.isHealthy = true;
      node.lastChecked = new Date();
    }
  }
}
