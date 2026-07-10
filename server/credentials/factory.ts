/**
 * factory.ts — Phase 2 pluggable credential provider selection (secrets-manager
 * Phase 2). Chooses the concrete `CredentialProvider` implementation based on
 * `config.credentials.backend`:
 *   - "db"      (default) → DbCryptoCredentialProvider (AES-in-Postgres, Phase 1).
 *   - "openbao" → OpenBaoCredentialProvider (OpenBao KV v2 for values, Postgres
 *                 for metadata/audit — see openbao-provider.ts).
 *
 * The module-level `credentialProvider` singleton is defined HERE (not in
 * db-crypto-provider.ts) and re-exported from db-crypto-provider.ts, to avoid a
 * hard circular-import cycle between "this factory needs the DbCrypto class"
 * and "db-crypto-provider.ts needs to export the singleton". Every existing
 * importer keeps importing `credentialProvider` from
 * `./credentials/db-crypto-provider.js` unchanged.
 */

import { configLoader } from "../config/loader.js";
import type { AppConfig } from "../config/schema.js";
import { DbCryptoCredentialProvider } from "./db-crypto-provider.js";
import { OpenBaoCredentialProvider } from "./openbao-provider.js";
import type { CredentialProvider } from "./types.js";

/** Build a CredentialProvider for the configured backend. Pure function — no caching. */
export function createCredentialProvider(config: AppConfig): CredentialProvider {
  const backend = config.credentials?.backend ?? "db";
  if (backend === "openbao") {
    return new OpenBaoCredentialProvider(config);
  }
  return new DbCryptoCredentialProvider();
}

/**
 * Default singleton, resolved LAZILY on first use (not at module load) from the
 * process config. Re-exported from db-crypto-provider.ts so existing importers
 * are unaffected. Lazy resolution is required to break the ESM cycle
 * factory.ts ⇄ db-crypto-provider.ts: an eager top-level `new
 * DbCryptoCredentialProvider()` here runs while db-crypto-provider.ts is still
 * mid-load, hitting the class binding in its temporal dead zone. The Proxy
 * instantiates on the first method/property access — well after all modules
 * have finished loading.
 */
let resolvedProvider: CredentialProvider | null = null;

function getProvider(): CredentialProvider {
  return (resolvedProvider ??= createCredentialProvider(configLoader.get()));
}

export const credentialProvider: CredentialProvider = new Proxy(
  {} as CredentialProvider,
  {
    get(_target, prop) {
      const instance = getProvider() as unknown as Record<string | symbol, unknown>;
      const value = instance[prop];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  },
);
