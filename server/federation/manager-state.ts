/**
 * Singleton holder for the FederationManager instance.
 *
 * This module exists solely to break the circular dependency that would arise
 * from routes.ts and tools importing getFederationManager from server/index.ts.
 * Both the entry-point (index.ts) and downstream modules (routes, tools) can
 * import from here without creating a dependency cycle.
 */
import type { FederationManager } from "./index.js";

let federationManager: FederationManager | null = null;

/** Set the singleton federation manager (called once from server/index.ts). */
export function setFederationManager(fm: FederationManager): void {
  federationManager = fm;
}

/** Get the singleton federation manager. Returns null when federation is disabled. */
export function getFederationManager(): FederationManager | null {
  return federationManager;
}
