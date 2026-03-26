ALTER TABLE "memories" ADD COLUMN "published" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "memories_published_idx" ON "memories" ("published") WHERE "published" = true;
