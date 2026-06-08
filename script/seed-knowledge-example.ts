/**
 * Runnable seeder for the Active Knowledge Base example dataset.
 *
 * Seeds ~14 genuine Terraform module best-practice cards into a dedicated
 * "Example: Terraform Best Practices" workspace, idempotently (re-runs add no
 * duplicates). Projection into the vector store is best-effort — a missing
 * embedding provider does not fail the seed.
 *
 * Usage (env must carry DATABASE_URL; source .env like scripts/dev-host.sh does):
 *   DATABASE_URL=postgres://USER:PW@localhost:5432/DB npx tsx script/seed-knowledge-example.ts
 *
 * The selected storage is PgStorage when DATABASE_URL is set, else MemStorage
 * (a no-op against a throwaway in-memory store).
 */
import { storage } from "../server/storage";
import { seedExampleTerraformCards, resolveFirstAdminUserId } from "../server/knowledge/seed-terraform-cards";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "[seed-knowledge] DATABASE_URL is not set — seeding an ephemeral in-memory store. " +
        "Set DATABASE_URL to seed the real database.",
    );
  }

  const result = await seedExampleTerraformCards(storage, { resolveAdminUserId: resolveFirstAdminUserId });

  console.log("[seed-knowledge] done");
  console.log(`  workspaceId:         ${result.workspaceId}`);
  console.log(`  cards created:       ${result.created}`);
  console.log(`  already present:     ${result.alreadyPresent}`);
  console.log(`  projected to search: ${result.projected}`);
  console.log(`  projection skipped:  ${result.projectionSkipped}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("[seed-knowledge] failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
