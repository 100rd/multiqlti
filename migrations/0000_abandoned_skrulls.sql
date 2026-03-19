CREATE TABLE "anonymization_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text,
	"session_id" text NOT NULL,
	"level" text NOT NULL,
	"entities_found" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "anonymization_patterns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"entity_type" text DEFAULT 'custom_pattern' NOT NULL,
	"regex_pattern" text NOT NULL,
	"severity" text DEFAULT 'high' NOT NULL,
	"pseudonym_template" text,
	"allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "argocd_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"server_url" text,
	"token_enc" text,
	"verify_ssl" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mcp_server_id" integer,
	"last_health_check_at" timestamp,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"health_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_trigger_audit" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" varchar NOT NULL,
	"finding_id" varchar NOT NULL,
	"pipeline_run_id" varchar NOT NULL,
	"triggered_at" timestamp DEFAULT now() NOT NULL,
	"triggered_by" varchar
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar,
	"role" text NOT NULL,
	"agent_team" text,
	"model_slug" text,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "delegation_requests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"from_stage" text NOT NULL,
	"to_stage" text NOT NULL,
	"task" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" text DEFAULT 'blocking' NOT NULL,
	"timeout" integer DEFAULT 30000 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" varchar,
	"stage_execution_id" varchar,
	"model_slug" text NOT NULL,
	"provider" text NOT NULL,
	"messages" jsonb NOT NULL,
	"system_prompt" text,
	"temperature" real,
	"max_tokens" integer,
	"response_content" text DEFAULT '' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" real,
	"status" text DEFAULT 'success' NOT NULL,
	"error_message" text,
	"team_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "maintenance_policies" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" varchar,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule" text DEFAULT '0 9 * * 1' NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"severity_threshold" text DEFAULT 'high' NOT NULL,
	"auto_merge" boolean DEFAULT false NOT NULL,
	"notify_channels" jsonb DEFAULT '[]'::jsonb,
	"auto_trigger_pipeline_id" varchar,
	"auto_trigger_enabled" boolean DEFAULT false NOT NULL,
	"log_source_config" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "maintenance_scans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" varchar,
	"workspace_id" varchar,
	"status" text DEFAULT 'running' NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"important_count" integer DEFAULT 0 NOT NULL,
	"triggered_pipeline_id" varchar,
	"started_at" timestamp DEFAULT now(),
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "manager_iterations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"iteration_number" integer NOT NULL,
	"decision" jsonb NOT NULL,
	"team_result" text,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"decision_duration_ms" integer DEFAULT 0 NOT NULL,
	"team_duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "manager_iterations_run_iteration_unique" UNIQUE("run_id","iteration_number")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb,
	"url" text,
	"env" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_connect" boolean DEFAULT false NOT NULL,
	"tool_count" integer DEFAULT 0,
	"last_connected_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "mcp_servers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"content" text NOT NULL,
	"source" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[],
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"expires_at" timestamp,
	"created_by_run_id" integer,
	CONSTRAINT "memories_scope_scope_id_key_unique" UNIQUE("scope","scope_id","key")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"model_id" text,
	"endpoint" text,
	"provider" text DEFAULT 'mock' NOT NULL,
	"context_limit" integer DEFAULT 4096 NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "models_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" varchar NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" text NOT NULL,
	"output" jsonb,
	"current_stage_index" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"triggered_by" text,
	"dag_mode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dag" jsonb,
	"created_by" varchar,
	"owner_id" text,
	"is_template" boolean DEFAULT false NOT NULL,
	"manager_config" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "provider_keys_provider_unique" UNIQUE("provider")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"stage_execution_id" varchar NOT NULL,
	"question" text NOT NULL,
	"context" text,
	"answer" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"answered_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" varchar NOT NULL,
	"version" text NOT NULL,
	"config" jsonb NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_id_version_unique" UNIQUE("skill_id","version")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"team_id" text NOT NULL,
	"system_prompt_override" text DEFAULT '' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_preference" text,
	"output_schema" jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"sharing" text DEFAULT 'public' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"forked_from" varchar,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "specialization_profiles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"assignments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "stage_executions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"stage_index" integer NOT NULL,
	"team_id" text NOT NULL,
	"model_slug" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"tokens_used" integer DEFAULT 0,
	"started_at" timestamp,
	"completed_at" timestamp,
	"sandbox_result" jsonb,
	"thought_tree" jsonb,
	"approval_status" text,
	"approved_at" timestamp,
	"approved_by" text,
	"rejection_reason" text,
	"dag_stage_id" text,
	"swarm_clone_results" jsonb,
	"swarm_meta" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "task_groups" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" text NOT NULL,
	"output" jsonb,
	"created_by" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" varchar NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"execution_mode" text DEFAULT 'direct_llm' NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pipeline_id" varchar,
	"pipeline_run_id" varchar,
	"model_slug" text,
	"team_id" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"summary" text,
	"artifacts" jsonb,
	"decisions" jsonb,
	"error_message" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" text NOT NULL,
	"run_id" varchar NOT NULL,
	"spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "traces_trace_id_unique" UNIQUE("trace_id")
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" varchar NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_triggered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_symbols" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" varchar NOT NULL,
	"file_path" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"line" integer NOT NULL,
	"col" integer DEFAULT 0 NOT NULL,
	"signature" text,
	"file_hash" text NOT NULL,
	"exported_from" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_symbols_unique" UNIQUE("workspace_id","file_path","name","kind")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"path" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"owner_id" text,
	"index_status" text DEFAULT 'idle' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "argocd_config" ADD CONSTRAINT "argocd_config_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_trigger_audit" ADD CONSTRAINT "auto_trigger_audit_scan_id_maintenance_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."maintenance_scans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_trigger_audit" ADD CONSTRAINT "auto_trigger_audit_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_policies" ADD CONSTRAINT "maintenance_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_scans" ADD CONSTRAINT "maintenance_scans_policy_id_maintenance_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."maintenance_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_scans" ADD CONSTRAINT "maintenance_scans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manager_iterations" ADD CONSTRAINT "manager_iterations_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_groups" ADD CONSTRAINT "task_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_group_id_task_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."task_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_symbols" ADD CONSTRAINT "workspace_symbols_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manager_iterations_run_id_idx" ON "manager_iterations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "skill_versions_skill_id_idx" ON "skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "tasks_group_id_idx" ON "tasks" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "traces_trace_id_idx" ON "traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "traces_run_id_idx" ON "traces" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "triggers_pipeline_id_idx" ON "triggers" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "triggers_enabled_type_idx" ON "triggers" USING btree ("enabled","type");--> statement-breakpoint
CREATE INDEX "workspace_symbols_name_idx" ON "workspace_symbols" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "workspace_symbols_file_idx" ON "workspace_symbols" USING btree ("workspace_id","file_path");--> statement-breakpoint
CREATE INDEX "workspace_symbols_kind_idx" ON "workspace_symbols" USING btree ("workspace_id","kind");