/**
 * Tests for the V2 inactivity condition helper functions.
 */

import { describe, it, expect } from 'vitest';
import type { RuleConditions } from '@tracearr/shared';
import {
  hasInactivityCondition,
  extractInactiveDaysFromConditions,
  hasSessionOnlyGroup,
  evaluateUserLevelConditions,
} from '../inactivityCheckQueue.js';

describe('hasInactivityCondition', () => {
  it('returns false for null conditions', () => {
    expect(hasInactivityCondition(null)).toBe(false);
  });

  it('returns false for conditions with no groups', () => {
    expect(hasInactivityCondition({ groups: [] })).toBe(false);
  });

  it('returns false when no inactive_days field exists', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }],
        },
      ],
    };
    expect(hasInactivityCondition(conditions)).toBe(false);
  });

  it('returns true for single group with inactive_days', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [{ field: 'inactive_days', operator: 'gt', value: 30 }],
        },
      ],
    };
    expect(hasInactivityCondition(conditions)).toBe(true);
  });

  it('returns true when inactive_days is in a later group', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }],
        },
        {
          conditions: [{ field: 'inactive_days', operator: 'gte', value: 14 }],
        },
      ],
    };
    expect(hasInactivityCondition(conditions)).toBe(true);
  });

  it('returns true when inactive_days is alongside other conditions in same group (OR)', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [
            { field: 'inactive_days', operator: 'gt', value: 30 },
            { field: 'trust_score', operator: 'lt', value: 20 },
          ],
        },
      ],
    };
    expect(hasInactivityCondition(conditions)).toBe(true);
  });
});

describe('extractInactiveDaysFromConditions', () => {
  it('returns null for null conditions', () => {
    expect(extractInactiveDaysFromConditions(null)).toBeNull();
  });

  it('returns null for conditions with no groups', () => {
    expect(extractInactiveDaysFromConditions({ groups: [] })).toBeNull();
  });

  it('returns null when no inactive_days field exists', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }],
        },
      ],
    };
    expect(extractInactiveDaysFromConditions(conditions)).toBeNull();
  });

  it('extracts value and operator from single inactive_days condition', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [{ field: 'inactive_days', operator: 'gt', value: 30 }],
        },
      ],
    };
    expect(extractInactiveDaysFromConditions(conditions)).toEqual({ value: 30, operator: 'gt' });
  });

  it('returns first inactive_days value and operator when multiple exist', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [
            { field: 'inactive_days', operator: 'gt', value: 10 },
            { field: 'inactive_days', operator: 'lt', value: 100 },
          ],
        },
      ],
    };
    expect(extractInactiveDaysFromConditions(conditions)).toEqual({ value: 10, operator: 'gt' });
  });

  it('finds inactive_days in a later group', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }],
        },
        {
          conditions: [{ field: 'inactive_days', operator: 'gte', value: 7 }],
        },
      ],
    };
    expect(extractInactiveDaysFromConditions(conditions)).toEqual({ value: 7, operator: 'gte' });
  });

  it('preserves eq operator for exact day matching', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [{ field: 'inactive_days', operator: 'eq', value: 30 }],
        },
      ],
    };
    expect(extractInactiveDaysFromConditions(conditions)).toEqual({ value: 30, operator: 'eq' });
  });

  it('returns null when inactive_days value is not a number', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [{ field: 'inactive_days', operator: 'eq', value: 'thirty' }],
        },
      ],
    };
    expect(extractInactiveDaysFromConditions(conditions)).toBeNull();
  });
});

describe('hasSessionOnlyGroup', () => {
  it('flags a group made entirely of session-only fields', () => {
    const conditions: RuleConditions = {
      groups: [
        { conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] },
        { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
      ],
    };
    expect(hasSessionOnlyGroup(conditions)).toBe(true);
  });

  it('passes when every group has at least one user-level field', () => {
    const conditions: RuleConditions = {
      groups: [
        { conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] },
        {
          conditions: [
            { field: 'is_transcoding', operator: 'eq', value: true },
            { field: 'server_id', operator: 'eq', value: 'server-jf' },
          ],
        },
      ],
    };
    expect(hasSessionOnlyGroup(conditions)).toBe(false);
  });
});

describe('evaluateUserLevelConditions', () => {
  const jellyfinUser = {
    id: 'su-jf-1',
    serverId: 'server-jf',
    trustScore: 80,
    createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
  };

  it('applies a server-scoped condition group alongside inactivity', () => {
    const conditions: RuleConditions = {
      groups: [
        { conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] },
        { conditions: [{ field: 'server_id', operator: 'eq', value: 'server-jf' }] },
      ],
    };

    expect(evaluateUserLevelConditions(conditions, jellyfinUser, 45)).toBe(true);
    expect(
      evaluateUserLevelConditions(conditions, { ...jellyfinUser, serverId: 'server-plex' }, 45)
    ).toBe(false);
  });

  it('honors OR within a group', () => {
    const conditions: RuleConditions = {
      groups: [
        {
          conditions: [
            { field: 'inactive_days', operator: 'gte', value: 30 },
            { field: 'trust_score', operator: 'lt', value: 50 },
          ],
        },
      ],
    };

    expect(evaluateUserLevelConditions(conditions, { ...jellyfinUser, trustScore: 30 }, 10)).toBe(
      true
    );
    expect(evaluateUserLevelConditions(conditions, jellyfinUser, 10)).toBe(false);
  });

  it('evaluates account age in days', () => {
    const conditions: RuleConditions = {
      groups: [
        { conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] },
        { conditions: [{ field: 'account_age_days', operator: 'gte', value: 90 }] },
      ],
    };

    expect(evaluateUserLevelConditions(conditions, jellyfinUser, 45)).toBe(true);
    expect(
      evaluateUserLevelConditions(
        conditions,
        { ...jellyfinUser, createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
        45
      )
    ).toBe(false);
  });

  it('never matches session-only fields without a session', () => {
    const conditions: RuleConditions = {
      groups: [{ conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] }],
    };
    expect(evaluateUserLevelConditions(conditions, jellyfinUser, 45)).toBe(false);
  });

  it('evaluates each inactive_days leaf with its own operator and threshold', () => {
    const band: RuleConditions = {
      groups: [
        { conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] },
        { conditions: [{ field: 'inactive_days', operator: 'lte', value: 60 }] },
      ],
    };

    expect(evaluateUserLevelConditions(band, jellyfinUser, 45)).toBe(true);
    expect(evaluateUserLevelConditions(band, jellyfinUser, 800)).toBe(false);
    expect(evaluateUserLevelConditions(band, jellyfinUser, 10)).toBe(false);
  });

  it('matches user_id against any account of the merged identity', () => {
    const conditions: RuleConditions = {
      groups: [
        { conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] },
        { conditions: [{ field: 'user_id', operator: 'eq', value: 'su-plex-1' }] },
      ],
    };

    expect(
      evaluateUserLevelConditions(conditions, jellyfinUser, 45, ['su-plex-1', jellyfinUser.id])
    ).toBe(true);
    expect(evaluateUserLevelConditions(conditions, jellyfinUser, 45, [])).toBe(false);
    expect(evaluateUserLevelConditions(conditions, jellyfinUser, 45, ['su-other'])).toBe(false);
  });

  it('treats never-active accounts as infinitely inactive per operator', () => {
    const gte: RuleConditions = {
      groups: [{ conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] }],
    };
    const band: RuleConditions = {
      groups: [
        { conditions: [{ field: 'inactive_days', operator: 'gte', value: 30 }] },
        { conditions: [{ field: 'inactive_days', operator: 'lte', value: 60 }] },
      ],
    };

    expect(evaluateUserLevelConditions(gte, jellyfinUser, null)).toBe(true);
    expect(evaluateUserLevelConditions(band, jellyfinUser, null)).toBe(false);
  });
});
