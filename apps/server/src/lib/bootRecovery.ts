/**
 * Pure helpers for the boot recovery loop's retry cadence.
 *
 * Split out of index.ts so the retry-interval decision has unit test
 * coverage without booting the real Fastify app - index.ts runs dotenv and
 * DNS-cache side effects at module load and isn't import-safe in tests.
 */

export type InitFailureKind = 'connectivity' | 'migration';

/**
 * A connectivity outage (DB restart, network blip) is often transient and
 * self-heals within seconds, so probe often. A migration failure is usually
 * deterministic (bad SQL, missing privilege, a lock_timeout expiry behind a
 * stuck writer) and won't be fixed by waiting a few seconds - poll it more
 * slowly so a stuck deploy doesn't spam the database and logs forever.
 */
export function pickRecoveryIntervalMs(
  kind: InitFailureKind,
  connectivityIntervalMs: number,
  migrationIntervalMs: number
): number {
  return kind === 'migration' ? migrationIntervalMs : connectivityIntervalMs;
}
