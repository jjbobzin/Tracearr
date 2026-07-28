/**
 * Rule evaluation must not count sessions the system itself considers
 * probably gone (grace-flagged: at least one confirmed missed poll) or not
 * yet real (pending, unconfirmed). Counting either makes concurrent-stream
 * rules kill the stream a user just switched to, or lets phantoms inflate
 * counts. Sessions missing for the first time in the CURRENT tick are still
 * counted: one anomalous poll must not distort detection.
 */
import { describe, it, expect } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';
import { excludeUncountableSessions } from '../utils.js';

function session(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    id: 'a',
    serverId: 'srv-1',
    serverUserId: 'su-1',
    sessionKey: 'k',
    ...overrides,
  } as ActiveSession;
}

describe('excludeUncountableSessions', () => {
  it('drops grace-flagged sessions', () => {
    const live = session({ id: 'live' });
    const gone = session({ id: 'gone' });
    expect(excludeUncountableSessions([live, gone], new Set(['gone']))).toEqual([live]);
  });

  it('drops pending sessions', () => {
    const confirmed = session({ id: 'c' });
    const pending = session({ id: 'p', pending: true });
    expect(excludeUncountableSessions([confirmed, pending], new Set())).toEqual([confirmed]);
  });

  it('returns the same array when nothing is excluded', () => {
    const a = session({ id: 'a' });
    const input = [a];
    expect(excludeUncountableSessions(input, new Set())).toBe(input);
  });
});
