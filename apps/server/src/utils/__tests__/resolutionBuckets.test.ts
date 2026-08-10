import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resolutionBucketPredicate, resolutionRankSql } from '../resolutionBuckets.js';

const dialect = new PgDialect();
const toSql = (fragment: ReturnType<typeof resolutionBucketPredicate>): string =>
  dialect.sqlToQuery(fragment).sql;

describe('resolutionBucketPredicate', () => {
  it('folds tiers above 1080p into the 4k bucket', () => {
    const rendered = toSql(resolutionBucketPredicate('video_resolution', '4k'));

    expect(rendered).toContain('video_resolution IN (');
    expect(rendered).toContain("'4k'");
    expect(rendered).toContain("'1440p'");
    expect(rendered).toContain("'8k'");
    expect(rendered).toContain("'2160p'");
    expect(rendered).not.toContain("'1080p'");
  });

  it('matches exact-tier buckets by their spellings', () => {
    expect(toSql(resolutionBucketPredicate('video_resolution', '1080p'))).toContain("'fhd'");
    expect(toSql(resolutionBucketPredicate('li.video_resolution', '720p'))).toContain(
      'li.video_resolution IN ('
    );
  });

  it('builds sd as the non-null complement of the other buckets', () => {
    const rendered = toSql(resolutionBucketPredicate('video_resolution', 'sd'));

    expect(rendered).toContain('video_resolution IS NOT NULL AND video_resolution NOT IN (');
    expect(rendered).toContain("'4k'");
    expect(rendered).toContain("'720p'");
  });

  it('counts NULL into sd only when the display rule asks for it', () => {
    const rendered = toSql(
      resolutionBucketPredicate('video_resolution', 'sd', { includeNullAsSd: true })
    );

    expect(rendered).toContain('video_resolution IS NULL OR video_resolution NOT IN (');
  });
});

describe('resolutionRankSql', () => {
  it('ranks spellings by tier with unknown and NULL at 0', () => {
    const rendered = toSql(resolutionRankSql('video_resolution'));

    expect(rendered).toContain('CASE video_resolution');
    expect(rendered).toContain("WHEN '8k' THEN 7");
    expect(rendered).toContain("WHEN '4k' THEN 6");
    expect(rendered).toContain("WHEN '1440p' THEN 5");
    expect(rendered).toContain("WHEN 'sd' THEN 1");
    expect(rendered).toContain('ELSE 0 END');
  });
});
