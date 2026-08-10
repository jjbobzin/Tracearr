-- Repairs media.show_media_id for episodes synced before the librarySync fix
-- that made episode->show resolution fall back to library_items when the
-- show wasn't in the same paginated sync batch as its episodes. Every
-- existing episode row has show_media_id NULL as a result, which breaks
-- "most watched" rollups (per-episode plays never reach the show) and lets
-- individual episodes leak into movie candidate lists.
--
-- Both statements are guarded by "show_media_id IS NULL", so they're safe to
-- re-run: once repaired, a second run is a no-op.
--
-- Deliberately excludes the continuous aggregate refresh. TimescaleDB's
-- refresh_continuous_aggregate() must run outside a transaction block, and
-- drizzle migrations always run inside one. AGGREGATE_SCHEMA_VERSION was
-- bumped in db/timescale.ts instead, which makes the next server boot
-- recreate the aggregate definitions and schedule the existing background
-- full-history backfill (runAggregateBackfill) - the same mechanism this
-- codebase already uses for aggregate-semantics fixes.
UPDATE media e
SET show_media_id = sli.media_id
FROM library_items eli
JOIN library_items sli
  ON sli.server_id = eli.server_id
 AND sli.rating_key = eli.grandparent_rating_key
 AND sli.media_type = 'show'
WHERE eli.media_id = e.id
  AND e.media_type = 'episode'
  AND e.show_media_id IS NULL;
--> statement-breakpoint

-- sessionIdentityBackfill.ts only repairs sessions with media_id IS NULL, so
-- it never touches these rows (their media_id was already set - only
-- show_media_id was missing). This is the only path that fixes them.
--
-- sessions is compressed and uncorrelated with media_type/show_media_id, so raising the GUC would decompress every chunk; only do it once we know a row actually matches.
-- Tradeoff: the EXISTS pre-check re-scans sessions when a match exists, but the common upgrade path has zero matches, where it saves decompressing every chunk.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sessions s
    JOIN media m ON m.id = s.media_id
    WHERE s.media_type = 'episode' AND s.show_media_id IS NULL
    LIMIT 1
  ) THEN
    -- Older TimescaleDB (pre-2.11) lacks this GUC; ignore the error and fall back to the default limit.
    BEGIN
      SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    UPDATE sessions s
    SET show_media_id = m.show_media_id
    FROM media m
    WHERE m.id = s.media_id
      AND s.media_type = 'episode'
      AND s.show_media_id IS NULL;
  END IF;
END $$;
