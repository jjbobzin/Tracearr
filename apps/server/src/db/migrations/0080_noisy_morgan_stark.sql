ALTER TABLE "server_users" DROP COLUMN "session_count";--> statement-breakpoint
UPDATE "users" u
SET
  aggregate_trust_score = coalesce(a.trust, 100),
  total_violations = a.violation_count,
  updated_at = now()
FROM (
  SELECT
    su.user_id,
    coalesce(
      min(su.trust_score) FILTER (WHERE su.removed_at IS NULL),
      min(su.trust_score)
    ) AS trust,
    count(v.id)::int AS violation_count
  FROM server_users su
  LEFT JOIN violations v ON v.server_user_id = su.id
  GROUP BY su.user_id
) a
WHERE a.user_id = u.id;