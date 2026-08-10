CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_type" varchar(20) NOT NULL,
	"match_key" text NOT NULL,
	"imdb_id" varchar(20),
	"tmdb_id" integer,
	"tvdb_id" integer,
	"title" text NOT NULL,
	"normalized_title" text,
	"year" integer,
	"parent_media_id" uuid,
	"show_media_id" uuid,
	"genres" text[],
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "media_id" uuid;--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "genres" text[];--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "parent_rating_key" varchar(255);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "grandparent_rating_key" varchar(255);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "media_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "show_media_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "imdb_id" varchar(20);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tmdb_id" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "tvdb_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "media_match_key_unique" ON "media" USING btree ("match_key");--> statement-breakpoint
CREATE INDEX "idx_media_type_imdb" ON "media" USING btree ("media_type","imdb_id") WHERE "media"."imdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_media_type_tmdb" ON "media" USING btree ("media_type","tmdb_id") WHERE "media"."tmdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_media_type_tvdb" ON "media" USING btree ("media_type","tvdb_id") WHERE "media"."tvdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_media_type_title_year" ON "media" USING btree ("media_type","normalized_title","year");--> statement-breakpoint
CREATE INDEX "idx_media_show" ON "media" USING btree ("show_media_id");--> statement-breakpoint
CREATE INDEX "idx_media_parent" ON "media" USING btree ("parent_media_id");--> statement-breakpoint
CREATE INDEX "idx_media_merged_into" ON "media" USING btree ("merged_into_id") WHERE "media"."merged_into_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_library_items_media" ON "library_items" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "idx_library_items_removed" ON "library_items" USING btree ("removed_at") WHERE "library_items"."removed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_media_idx" ON "sessions" USING btree ("media_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_show_media_idx" ON "sessions" USING btree ("show_media_id","started_at");