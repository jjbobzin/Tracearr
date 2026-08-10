/**
 * Stats Route Utilities
 *
 * Shared helpers for statistics routes including date range calculation
 * and TimescaleDB aggregate availability checking.
 */

import { TIME_MS } from '@tracearr/shared';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { getTimescaleStatus } from '../../db/timescale.js';

// Cache whether aggregates are available (checked once at startup)
let aggregatesAvailable: boolean | null = null;
let hyperLogLogAvailable: boolean | null = null;

/**
 * Check if TimescaleDB continuous aggregates are available.
 * Result is cached after first check.
 */
export async function hasAggregates(): Promise<boolean> {
  if (aggregatesAvailable !== null) {
    return aggregatesAvailable;
  }
  try {
    const status = await getTimescaleStatus();
    aggregatesAvailable = status.continuousAggregates.length >= 3;
    return aggregatesAvailable;
  } catch {
    aggregatesAvailable = false;
    return false;
  }
}

/**
 * Check if TimescaleDB Toolkit (HyperLogLog) is available AND the aggregates
 * have HLL columns. This is important because:
 * 1. Extension might be installed but aggregates created without HLL
 * 2. Aggregates might exist but without HLL columns if toolkit wasn't available at migration time
 *
 * Result is cached after first check.
 */
export async function hasHyperLogLog(): Promise<boolean> {
  if (hyperLogLogAvailable !== null) {
    return hyperLogLogAvailable;
  }
  try {
    // Check both: extension installed AND aggregate has plays_hll column
    // Note: Uses daily_content_engagement (active aggregate) instead of deprecated daily_stats_summary
    const result = await db.execute(sql`
      SELECT
        EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'timescaledb_toolkit') as extension_installed,
        EXISTS(
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'daily_content_engagement'
            AND column_name = 'plays_hll'
        ) as hll_column_exists
    `);
    const row = result.rows[0] as
      { extension_installed: boolean; hll_column_exists: boolean } | undefined;
    hyperLogLogAvailable = (row?.extension_installed && row?.hll_column_exists) ?? false;
    return hyperLogLogAvailable;
  } catch {
    hyperLogLogAvailable = false;
    return false;
  }
}

/**
 * Reset cached state (useful for testing)
 */
export function resetCachedState(): void {
  aggregatesAvailable = null;
  hyperLogLogAvailable = null;
}

/**
 * Calculate start date based on period string.
 *
 * @param period - Time period: 'day', 'week', 'month', or 'year'
 * @returns Date representing the start of the period
 * @deprecated Use resolveDateRange() instead for new code
 */
export function getDateRange(period: 'day' | 'week' | 'month' | 'year'): Date {
  const now = new Date();
  switch (period) {
    case 'day':
      return new Date(now.getTime() - TIME_MS.DAY);
    case 'week':
      return new Date(now.getTime() - TIME_MS.WEEK);
    case 'month':
      return new Date(now.getTime() - 30 * TIME_MS.DAY);
    case 'year':
      return new Date(now.getTime() - 365 * TIME_MS.DAY);
  }
}

// ============================================================================
// Timezone Utilities
// ============================================================================

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Read an instant's wall-clock date/time in a given timezone.
 */
function getLocalDateTimeParts(tz: string, date: Date): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some ICU implementations format midnight as hour "24" with hour12: false.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * Resolve the UTC instant of local midnight for a given calendar day in a
 * timezone. DST-safe: a naive "subtract time-of-day from now" approach is
 * wrong whenever a DST transition falls between local midnight and the
 * reference instant, because the elapsed wall-clock duration no longer
 * equals the elapsed real duration on that day. This instead makes a first
 * guess, checks what wall-clock instant that guess actually lands on in
 * `tz`, and corrects by the discrepancy - which converges in at most two
 * passes since real-world DST shifts are always a small, fixed number of
 * hours.
 */
function zonedMidnightToUtc(tz: string, year: number, month: number, day: number): Date {
  const targetUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guessMs = targetUtcMs;

  for (let i = 0; i < 2; i++) {
    const parts = getLocalDateTimeParts(tz, new Date(guessMs));
    const guessAsUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const diff = guessAsUtcMs - targetUtcMs;
    if (diff === 0) break;
    guessMs -= diff;
  }

  return new Date(guessMs);
}

/**
 * Get the start of "today" in a specific timezone, returned as a UTC Date.
 *
 * For example, if it's 2024-01-15 10:00 in America/Los_Angeles (UTC-8),
 * this returns 2024-01-15 08:00 UTC (which is midnight PST).
 *
 * @param tz - IANA timezone identifier (e.g., 'America/Los_Angeles')
 * @returns Date representing midnight in the specified timezone
 */
export function getStartOfDayInTimezone(tz: string): Date {
  const now = new Date();
  const { year, month, day } = getLocalDateTimeParts(tz, now);
  return zonedMidnightToUtc(tz, year, month, day);
}

/**
 * Start of the local day AFTER `todayStart` (also midnight in `tz`), as a
 * UTC Date. `todayStart` is assumed to already be local midnight (e.g. the
 * output of getStartOfDayInTimezone) - its own local calendar date is used
 * as the base, and the following day is resolved through the same DST-safe
 * core so the interval is exactly 23/24/25 hours as the transition dictates,
 * never a fixed 24-hour offset that can land before or after local midnight
 * on a DST transition day.
 */
export function getStartOfNextDayInTimezone(tz: string, todayStart: Date): Date {
  const { year, month, day } = getLocalDateTimeParts(tz, todayStart);
  return zonedMidnightToUtc(tz, year, month, day + 1);
}

// ============================================================================
// New Date Range API (supports 'all' and 'custom' periods)
// ============================================================================

export type StatsPeriod = 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';

export interface DateRange {
  /** Start date, or null for "all time" (no lower bound) */
  start: Date | null;
  /** End date (typically "now") */
  end: Date;
}

/**
 * Resolves period/custom dates into a concrete date range.
 * All queries use raw sessions table (no aggregates needed at current data volume).
 *
 * @param period - The period type
 * @param startDate - Custom start date (ISO string), required when period='custom'
 * @param endDate - Custom end date (ISO string), required when period='custom'
 * @returns DateRange with start (null for all-time) and end dates
 */
export function resolveDateRange(
  period: StatsPeriod,
  startDate?: string,
  endDate?: string
): DateRange {
  const now = new Date();

  switch (period) {
    case 'day':
      return { start: new Date(now.getTime() - TIME_MS.DAY), end: now };
    case 'week':
      return { start: new Date(now.getTime() - TIME_MS.WEEK), end: now };
    case 'month':
      return { start: new Date(now.getTime() - 30 * TIME_MS.DAY), end: now };
    case 'year':
      return { start: new Date(now.getTime() - 365 * TIME_MS.DAY), end: now };
    case 'all':
      return { start: null, end: now };
    case 'custom':
      if (!startDate || !endDate) {
        throw new Error('Custom period requires startDate and endDate');
      }
      return {
        start: new Date(startDate),
        end: new Date(endDate),
      };
  }
}

/**
 * Builds SQL WHERE clause fragment for date range filtering.
 *
 * For preset periods (day, week, month, year): WHERE started_at >= ${start}
 * For all-time (start is null): Returns empty SQL (no time filter)
 * For custom range: WHERE started_at >= ${start} AND started_at < ${end}
 *
 * @param range - DateRange from resolveDateRange()
 * @param includeEndBound - Whether to include upper bound (for custom ranges)
 * @returns SQL fragment to append to WHERE clause (includes leading AND)
 */
export function buildDateRangeFilter(range: DateRange, includeEndBound = false): SQL {
  if (!range.start) {
    // All-time: no time filter
    return sql``;
  }

  if (includeEndBound) {
    // Custom range: filter both bounds
    return sql` AND started_at >= ${range.start} AND started_at < ${range.end}`;
  }

  // Preset period: only lower bound (end is always "now")
  return sql` AND started_at >= ${range.start}`;
}
