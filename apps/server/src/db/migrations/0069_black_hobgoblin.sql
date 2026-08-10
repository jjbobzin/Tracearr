ALTER TABLE "library_items" ADD COLUMN "thumb_path" text;--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "dominant_color" varchar(7);--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "latest_added_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_media_type_added_active" ON "media" USING btree ("media_type","latest_added_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "media"."merged_into_id" IS NULL;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "idx_media_title_trgm" ON "media" USING gin ("normalized_title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_media_type_title_id" ON "media" USING btree ("media_type","normalized_title","id") WHERE "media"."merged_into_id" IS NULL;
--> statement-breakpoint
UPDATE media m SET latest_added_at = sub.max_added
FROM (SELECT media_id, MAX(created_at) AS max_added FROM library_items
      WHERE removed_at IS NULL AND media_id IS NOT NULL GROUP BY media_id) sub
WHERE m.id = sub.media_id;