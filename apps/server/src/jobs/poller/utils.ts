/**
 * Poller Utility Functions
 *
 * Pure utility functions for IP detection, client parsing, and formatting.
 * These functions have no side effects and are easily testable.
 */

import type { ActiveSession } from '@tracearr/shared';
import { normalizeClient } from '../../utils/platformNormalizer.js';

export const parseJellyfinClient = normalizeClient;

// ============================================================================
// IP Address Utilities
// ============================================================================

/**
 * Check if an IP address is private/local (won't have GeoIP data)
 *
 * @param ip - IP address to check
 * @returns true if the IP is private/local
 *
 * @example
 * isPrivateIP('192.168.1.100'); // true
 * isPrivateIP('8.8.8.8');       // false
 */
export function isPrivateIP(ip: string): boolean {
  if (!ip) return true;

  // IPv4 private ranges
  const privateIPv4 = [
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^127\./, // Loopback
    /^169\.254\./, // Link-local
    /^0\./, // Current network
  ];

  // IPv6 private ranges
  const privateIPv6 = [
    /^::1$/i, // Loopback
    /^fe80:/i, // Link-local
    /^fc/i, // Unique local
    /^fd/i, // Unique local
  ];

  return privateIPv4.some((r) => r.test(ip)) || privateIPv6.some((r) => r.test(ip));
}

// ============================================================================
// Rule Evaluation Session Filtering
// ============================================================================

/**
 * Drops sessions rule evaluation must not count: grace-flagged ones (at
 * least one confirmed missed poll, the system's own signal that the stream
 * probably stopped) and unconfirmed pending ones. Counting either makes
 * concurrent-stream rules fire on phantoms, e.g. killing the stream a user
 * just switched to. Sessions missing for the first time in the current tick
 * are not flagged yet and still count, which keeps one anomalous poll from
 * distorting detection. Returns the input array untouched when nothing is
 * excluded so hot-path callers avoid a copy.
 */
export function excludeUncountableSessions(
  sessions: ActiveSession[],
  graceSessionIds: Set<string>
): ActiveSession[] {
  const needsFilter = sessions.some((s) => s.pending || graceSessionIds.has(s.id));
  if (!needsFilter) return sessions;
  return sessions.filter((s) => !s.pending && !graceSessionIds.has(s.id));
}
