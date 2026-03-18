-- Phase 6.10: ArgoCD MCP Integration
-- Adds argocd_config singleton table for ArgoCD connection settings

CREATE TABLE argocd_config (
  id           INTEGER PRIMARY KEY DEFAULT 1,
  server_url   TEXT,
  token_enc    TEXT,
  verify_ssl   BOOLEAN NOT NULL DEFAULT TRUE,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  mcp_server_id INTEGER REFERENCES mcp_servers(id) ON DELETE SET NULL,
  last_health_check_at TIMESTAMP,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  health_error TEXT,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT argocd_config_singleton CHECK (id = 1)
);

COMMENT ON TABLE argocd_config IS
  'Singleton row storing ArgoCD connection config. Phase 6.10.';
COMMENT ON COLUMN argocd_config.token_enc IS
  'AES-256-GCM encrypted ArgoCD API token.';
COMMENT ON COLUMN argocd_config.health_status IS
  'connected | error | unknown';
