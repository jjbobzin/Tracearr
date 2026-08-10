CREATE TABLE "library_item_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_item_id" uuid NOT NULL,
	"server_version_key" varchar(255) NOT NULL,
	"video_resolution" varchar(20),
	"video_codec" varchar(50),
	"video_dynamic_range" varchar(20),
	"audio_codec" varchar(50),
	"audio_channels" integer,
	"container" varchar(50),
	"bitrate" integer,
	"file_size" bigint,
	"part_count" integer DEFAULT 1 NOT NULL,
	"file_path" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "version_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "versions_fingerprint" text;--> statement-breakpoint
ALTER TABLE "library_item_versions" ADD CONSTRAINT "library_item_versions_library_item_id_library_items_id_fk" FOREIGN KEY ("library_item_id") REFERENCES "public"."library_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_item_versions_item_key_unique" ON "library_item_versions" USING btree ("library_item_id","server_version_key");--> statement-breakpoint
CREATE INDEX "idx_liv_item_active" ON "library_item_versions" USING btree ("library_item_id") WHERE "library_item_versions"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_liv_resolution_active" ON "library_item_versions" USING btree ("video_resolution") WHERE "library_item_versions"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_liv_legacy_sentinel" ON "library_item_versions" USING btree ("library_item_id") WHERE "library_item_versions"."server_version_key" = 'legacy:1';--> statement-breakpoint
-- Seed a placeholder version per active item from the flat columns so facets
-- and filters reading version rows work immediately instead of waiting up to
-- a full-scan cycle. Reconciliation hard-deletes 'legacy:1' rows as real
-- versions replace them; a zero-sentinel count doubles as the backfill-done
-- signal. ON CONFLICT keeps this re-runnable (restore path re-runs migrations).
INSERT INTO library_item_versions
  (library_item_id, server_version_key, video_resolution, video_codec,
   video_dynamic_range, audio_codec, audio_channels, file_size, part_count, file_path)
SELECT id, 'legacy:1', video_resolution, video_codec,
       video_dynamic_range, audio_codec, audio_channels, file_size, 1, file_path
FROM library_items
WHERE removed_at IS NULL
ON CONFLICT (library_item_id, server_version_key) DO NOTHING;
