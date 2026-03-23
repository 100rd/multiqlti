CREATE TABLE "remote_agents" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text UNIQUE NOT NULL,
  "environment" text NOT NULL DEFAULT 'kubernetes',
  "transport" text NOT NULL DEFAULT 'a2a-http',
  "endpoint" text NOT NULL,
  "cluster" text,
  "namespace" text,
  "labels" jsonb,
  "auth_token_enc" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "auto_connect" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'offline',
  "last_heartbeat_at" timestamp,
  "health_error" text,
  "agent_card" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "a2a_tasks" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" varchar NOT NULL REFERENCES "remote_agents"("id"),
  "run_id" varchar,
  "stage_execution_id" varchar,
  "skill" text,
  "input" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'submitted',
  "output" jsonb,
  "error" text,
  "duration_ms" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
