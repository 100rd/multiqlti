-- Migration: MCP tool call audit log (issue #271)
-- Adds mcp_tool_calls table for recording every tool invocation with redacted
-- args/results, supporting usage metrics and OTel trace observability.
-- Rollback: DROP TABLE mcp_tool_calls;

CREATE TABLE IF NOT EXISTS "mcp_tool_calls" (
  "id"              varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "pipeline_run_id" varchar,
  "stage_id"        text,
  "connection_id"   varchar NOT NULL,
  "tool_name"       text NOT NULL,
  "args_json"       jsonb NOT NULL DEFAULT '{}',
  "result_json"     jsonb,
  "error"           text,
  "duration_ms"     integer NOT NULL DEFAULT 0,
  "started_at"      timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_tool_calls_pipeline_run_fk"
    FOREIGN KEY ("pipeline_run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "mcp_tool_calls_connection_fk"
    FOREIGN KEY ("connection_id") REFERENCES "workspace_connections"("id") ON DELETE CASCADE
);

-- Fast lookups by connection (usage metrics queries)
CREATE INDEX IF NOT EXISTS "mcp_tool_calls_connection_id_idx"
  ON "mcp_tool_calls" ("connection_id");

-- Fast lookups by run
CREATE INDEX IF NOT EXISTS "mcp_tool_calls_pipeline_run_id_idx"
  ON "mcp_tool_calls" ("pipeline_run_id");

-- Retention / range queries on started_at
CREATE INDEX IF NOT EXISTS "mcp_tool_calls_started_at_idx"
  ON "mcp_tool_calls" ("started_at");

-- Composite index supporting "connection + time window" metric queries
CREATE INDEX IF NOT EXISTS "mcp_tool_calls_connection_started_idx"
  ON "mcp_tool_calls" ("connection_id", "started_at");
