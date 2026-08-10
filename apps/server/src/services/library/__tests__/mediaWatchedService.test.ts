import { describe, it, expect } from 'vitest';
import {
  buildAliasMapCte,
  mapMovieWatchedRows,
  mapShowWatchedRows,
} from '../mediaWatchedService.js';
import { renderSql } from '../../../test/helpers.js';

describe('mapMovieWatchedRows', () => {
  it('marks a movie watched when the row says so', () => {
    const result = mapMovieWatchedRows(
      ['movie-1'],
      [{ canonical_id: 'movie-1', watched: true, has_plays: true }]
    );
    expect(result.get('movie-1')).toBe('watched');
  });

  it('marks a movie partial when there are plays but no completed watch', () => {
    const result = mapMovieWatchedRows(
      ['movie-1'],
      [{ canonical_id: 'movie-1', watched: false, has_plays: true }]
    );
    expect(result.get('movie-1')).toBe('partial');
  });

  it('marks a movie unwatched when the row has no plays', () => {
    const result = mapMovieWatchedRows(
      ['movie-1'],
      [{ canonical_id: 'movie-1', watched: false, has_plays: false }]
    );
    expect(result.get('movie-1')).toBe('unwatched');
  });

  it('marks a movie unwatched when there is no row at all', () => {
    const result = mapMovieWatchedRows(['movie-1'], []);
    expect(result.get('movie-1')).toBe('unwatched');
  });
});

describe('mapShowWatchedRows', () => {
  it('marks a show watched when every known episode has been watched', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 10, has_plays: true }],
      new Map([['show-1', 10]])
    );
    expect(result.get('show-1')).toBe('watched');
  });

  it('marks a show partial when some but not all known episodes are watched', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 3, has_plays: true }],
      new Map([['show-1', 10]])
    );
    expect(result.get('show-1')).toBe('partial');
  });

  it('marks a show partial when there are plays but zero completed episodes', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 0, has_plays: true }],
      new Map([['show-1', 10]])
    );
    expect(result.get('show-1')).toBe('partial');
  });

  it('marks a show unwatched when the known episode count is zero', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 0, has_plays: false }],
      new Map([['show-1', 0]])
    );
    expect(result.get('show-1')).toBe('unwatched');
  });

  it('marks a show unwatched when the episode count is unknown', () => {
    const result = mapShowWatchedRows(
      ['show-1'],
      [{ canonical_id: 'show-1', eps_watched: 10, has_plays: true }],
      new Map()
    );
    expect(result.get('show-1')).toBe('unwatched');
  });

  it('marks a show unwatched when there is no row at all', () => {
    const result = mapShowWatchedRows(['show-1'], [], new Map([['show-1', 10]]));
    expect(result.get('show-1')).toBe('unwatched');
  });
});

describe('buildAliasMapCte', () => {
  it('produces a single-hop union of the page ids and their merged losers', () => {
    const { sql: query } = renderSql(buildAliasMapCte(['id-1', 'id-2']));
    const normalized = query.replace(/\s+/g, ' ').trim();
    expect(normalized).toContain('WITH alias_map AS (');
    expect(normalized).toContain(
      'SELECT id AS canonical_id, id AS any_id FROM unnest(ARRAY[$1::uuid, $2::uuid]::uuid[]) AS t(id)'
    );
    expect(normalized).toContain('UNION ALL');
    expect(normalized).toContain(
      'SELECT m.merged_into_id, m.id FROM media m WHERE m.merged_into_id = ANY(ARRAY[$3::uuid, $4::uuid]::uuid[])'
    );
  });

  it('binds each id once per half of the union, in order', () => {
    const { params } = renderSql(buildAliasMapCte(['id-1', 'id-2']));
    expect(params).toEqual(['id-1', 'id-2', 'id-1', 'id-2']);
  });

  it('produces an empty array literal when given no ids', () => {
    const { sql: query } = renderSql(buildAliasMapCte([]));
    const normalized = query.replace(/\s+/g, ' ').trim();
    expect(normalized).toContain('unnest(ARRAY[]::uuid[]) AS t(id)');
    expect(normalized).toContain('ANY(ARRAY[]::uuid[])');
  });
});
