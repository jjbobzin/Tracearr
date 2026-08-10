ALTER TABLE "media" ALTER COLUMN "sort_title" DROP EXPRESSION;--> statement-breakpoint
-- Backfill without normalize(): NULLs only exist on non-UTF8 clusters, where normalize() is unavailable anyway
UPDATE "media" SET "sort_title" = lower(regexp_replace(regexp_replace("title", '^\s*(the|an|a)\s+', '', 'i'), '[^[:alnum:]]+', '', 'g')) WHERE "sort_title" IS NULL;
