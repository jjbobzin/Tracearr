-- Accounts whose history predates the last_activity_at column read as
-- never-active and trip inactivity rules. The correlated subquery form is
-- index-driven (sessions_server_user_time_idx) and bounded by the number of
-- null-activity accounts, so installs with nothing to repair pay near zero.
UPDATE server_users su
SET last_activity_at = (
  SELECT max(started_at) FROM sessions s WHERE s.server_user_id = su.id
)
WHERE su.last_activity_at IS NULL
  AND EXISTS (
    SELECT 1 FROM sessions s WHERE s.server_user_id = su.id
  );
