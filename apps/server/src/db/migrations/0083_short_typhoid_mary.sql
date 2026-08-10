-- Drop verified-unused sessions indexes (zero scans over 2 months of prod stats,
-- every query shape confirmed served by a surviving index)
DROP INDEX IF EXISTS "sessions_external_session_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "sessions_geo_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "sessions_stale_detection_idx";--> statement-breakpoint
-- Boot-created in timescale.ts before this release; absent on plain-Postgres installs
DROP INDEX IF EXISTS "idx_sessions_media_time";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_sessions_active_partial";
