import { describe, expect, it } from 'vitest';
import {
  serverScopeFromIds,
  serverScopeKey,
  serverScopeParamEntries,
  type ServerScope,
} from '../serverScope.js';

describe('serverScopeFromIds', () => {
  it('maps undefined, null, and empty to all', () => {
    expect(serverScopeFromIds(undefined)).toEqual({ mode: 'all' });
    expect(serverScopeFromIds(null)).toEqual({ mode: 'all' });
    expect(serverScopeFromIds([])).toEqual({ mode: 'all' });
  });

  it('maps a non-empty array to a subset', () => {
    expect(serverScopeFromIds(['b', 'a'])).toEqual({ mode: 'subset', serverIds: ['b', 'a'] });
  });

  it('dedupes repeated ids', () => {
    expect(serverScopeFromIds(['a', 'a'])).toEqual({ mode: 'subset', serverIds: ['a'] });
  });

  it('does not alias the input array', () => {
    const input = ['a'];
    const scope = serverScopeFromIds(input);
    input.push('b');
    expect(scope).toEqual({ mode: 'subset', serverIds: ['a'] });
  });
});

describe('serverScopeKey', () => {
  it('is the literal all for all mode', () => {
    expect(serverScopeKey({ mode: 'all' })).toBe('all');
  });

  it('sorts ids so key identity ignores selection order', () => {
    expect(serverScopeKey({ mode: 'subset', serverIds: ['b', 'a'] })).toBe('a,b');
    expect(serverScopeKey({ mode: 'subset', serverIds: ['a', 'b'] })).toBe('a,b');
  });

  it('treats a defensively-empty subset as all', () => {
    expect(serverScopeKey({ mode: 'subset', serverIds: [] })).toBe('all');
  });

  it('does not mutate a frozen serverIds array', () => {
    const serverIds = Object.freeze(['b', 'a']) as string[];
    expect(() => serverScopeKey({ mode: 'subset', serverIds })).not.toThrow();
    expect(serverScopeKey({ mode: 'subset', serverIds })).toBe('a,b');
    expect(serverIds).toEqual(['b', 'a']);
  });
});

describe('serverScopeParamEntries', () => {
  // The version-skew strategy table. All and single work on every server
  // version; the plural param needs servers >= 2026-02-20 (f1697c66).
  it('sends nothing for all', () => {
    expect(serverScopeParamEntries({ mode: 'all' })).toEqual([]);
  });

  it('sends legacy serverId for a single server', () => {
    expect(serverScopeParamEntries({ mode: 'subset', serverIds: ['a'] })).toEqual([
      ['serverId', 'a'],
    ]);
  });

  it('sends repeated serverIds for two or more', () => {
    expect(serverScopeParamEntries({ mode: 'subset', serverIds: ['b', 'a'] })).toEqual([
      ['serverIds', 'b'],
      ['serverIds', 'a'],
    ]);
  });

  it('sends nothing for a defensively-empty subset', () => {
    expect(serverScopeParamEntries({ mode: 'subset', serverIds: [] })).toEqual([]);
  });
});

describe('type', () => {
  it('round-trips through JSON for storage', () => {
    const scope: ServerScope = { mode: 'subset', serverIds: ['a'] };
    expect(JSON.parse(JSON.stringify(scope))).toEqual(scope);
  });
});
