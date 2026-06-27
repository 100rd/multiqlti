-- Phase 0d: Remove plaintext ARGOCD_TOKEN from mcp_servers.env JSONB.
--
-- Background: server/routes/argocd-settings.ts previously wrote the decrypted
-- ArgoCD token directly into the `env` JSONB column of the argocd MCP server
-- row.  This was a plaintext secret leak; the column is now left without the
-- token (the encrypted copy lives in argocd_config.token_enc).
--
-- This migration is idempotent: the `-` operator is a no-op when the key is
-- absent.  It is safe to run multiple times.
--
-- Run before restarting the application with the Phase-0d code:
--   psql "$DATABASE_URL" -f migrations/0027_phase0d_clean_argocd_env.sql
--   -- or --
--   npx drizzle-kit migrate  (if this file is applied via drizzle migrate)
--
-- After running, verify with:
--   SELECT id, env FROM mcp_servers WHERE env ? 'ARGOCD_TOKEN';
--   -- should return 0 rows

UPDATE mcp_servers
SET    env = env - 'ARGOCD_TOKEN'
WHERE  env ? 'ARGOCD_TOKEN';

-- Belt-and-suspenders: also strip any other secret-shaped keys that should
-- never reside in this column (TOKEN, SECRET, KEY, PASSWORD, CREDENTIAL).
-- These patterns match top-level JSONB keys only.
UPDATE mcp_servers
SET    env = (
  SELECT jsonb_object_agg(k, v)
  FROM   jsonb_each(env) AS kv(k, v)
  WHERE  k !~* 'TOKEN|SECRET|PASSWORD|CREDENTIAL'
    AND  k !~* '^API_KEY$|_API_KEY$|^APIKEY$'
)
WHERE  env IS NOT NULL
  AND  EXISTS (
    SELECT 1
    FROM   jsonb_object_keys(env) k
    WHERE  k ~* 'TOKEN|SECRET|PASSWORD|CREDENTIAL'
       OR  k ~* '^API_KEY$|_API_KEY$|^APIKEY$'
  );
