-- Dedup existing (server_id, library_id, snapshot_time) duplicates before the
-- unique index below can be created. The duplicates came from a
-- concurrent-backfill race and hold near-identical payloads, so any
-- deterministic survivor is a safe pick: keep the highest id per group.
--
-- ctid is NOT usable as the ordering signal here even though it would track
-- insertion order: library_snapshots is a hypertable with compressed chunks,
-- and TimescaleDB 2.24 rejects system columns through transparent
-- decompression ("transparent decompression only supports tableoid system
-- column"), which made even the duplicate pre-check fail on external
-- databases. Newer versions accept it, so dev (2.28) never saw the failure.
--
-- Safe to re-run: with no duplicates left the pre-check skips everything.
-- Raising the GUC decompresses whatever the DELETE touches, so only do it
-- once duplicates are confirmed to exist; the common upgrade path has zero
-- matches and skips DML entirely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "library_snapshots"
    GROUP BY server_id, library_id, snapshot_time
    HAVING count(*) > 1
  ) THEN
    -- Older TimescaleDB (pre-2.11) lacks this GUC; ignore the error and fall back to the default limit.
    BEGIN
      SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    DELETE FROM "library_snapshots"
    WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (
          PARTITION BY server_id, library_id, snapshot_time
          ORDER BY id DESC
        ) AS rn
        FROM "library_snapshots"
      ) ranked
      WHERE rn > 1
    );
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "library_snapshots_server_library_time_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_snapshots_server_library_time_idx" ON "library_snapshots" USING btree ("server_id","library_id","snapshot_time");
