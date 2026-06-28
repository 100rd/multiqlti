-- migration: 0028_phase0d_clean_argocd_env
-- (Renamed from 0027_phase0d to 0028_phase0d to avoid collision with 0027_phase0c.
--  Run AFTER 0027_phase0c_projectid_secret_tables.sql.)
--
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
--   psql "$DATABASE_URL" -f migrations/0028_phase0d_clean_argocd_env.sql
--
-- After running, verify with:
--   SELECT id, env FROM mcp_servers WHERE env ? 'ARGOCD_TOKEN';
--   -- should return 0 rows
--
-- R3-MED fix: COALESCE around jsonb_object_agg prevents setting env=NULL when
-- all top-level keys match the secret-shaped pattern.  Without COALESCE, a row
-- whose env contained ONLY secret keys would have env set to SQL NULL rather
-- than an empty JSON object.

-- Step 1: Quick targeted removal of ARGOCD_TOKEN specifically (idempotent).
UPDATE mcp_servers
SET    env = env - 'ARGOCD_TOKEN'
WHERE  env ? 'ARGOCD_TOKEN';

-- Step 2: Belt-and-suspenders sweep — strip any remaining secret-shaped top-level
-- keys (TOKEN, SECRET, KEY, PASSWORD, CREDENTIAL patterns).
-- COALESCE ensures that if ALL keys are stripped, env is set to '{}' rather than
-- SQL NULL (which would lose the column value for future updates).
UPDATE mcp_servers
SET    env = COALESCE(
         (
           SELECT jsonb_object_agg(k, v)
           FROM   jsonb_each(env) AS kv(k, v)
           WHERE  k !~* 'TOKEN|SECRET|PASSWORD|CREDENTIAL'
             AND  k !~* '^API_KEY$|_API_KEY$|^APIKEY$'
         ),
         '{}'::jsonb
       )
WHERE  env IS NOT NULL
  AND  EXISTS (
         SELECT 1
         FROM   jsonb_object_keys(env) k
         WHERE  k ~* 'TOKEN|SECRET|PASSWORD|CREDENTIAL'
            OR  k ~* '^API_KEY$|_API_KEY$|^APIKEY$'
       );
