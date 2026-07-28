import { describe, it, expect } from 'vitest';
import { compare } from '../comparisons.js';

describe('compare', () => {
  describe('eq operator', () => {
    it('returns true for equal values', () => {
      expect(compare(5, 'eq', 5)).toBe(true);
      expect(compare('test', 'eq', 'test')).toBe(true);
      expect(compare(true, 'eq', true)).toBe(true);
    });

    it('returns false for unequal values', () => {
      expect(compare(5, 'eq', 6)).toBe(false);
      expect(compare('test', 'eq', 'other')).toBe(false);
    });
  });

  describe('neq operator', () => {
    it('returns true for unequal values', () => {
      expect(compare(5, 'neq', 6)).toBe(true);
    });

    it('returns false for equal values', () => {
      expect(compare(5, 'neq', 5)).toBe(false);
    });
  });

  describe('gt operator', () => {
    it('returns true when actual > expected', () => {
      expect(compare(10, 'gt', 5)).toBe(true);
    });

    it('returns false when actual <= expected', () => {
      expect(compare(5, 'gt', 5)).toBe(false);
      expect(compare(3, 'gt', 5)).toBe(false);
    });

    it('returns false for non-numbers', () => {
      expect(compare('10', 'gt', 5)).toBe(false);
    });
  });

  describe('gte operator', () => {
    it('returns true when actual >= expected', () => {
      expect(compare(10, 'gte', 5)).toBe(true);
      expect(compare(5, 'gte', 5)).toBe(true);
    });

    it('returns false when actual < expected', () => {
      expect(compare(3, 'gte', 5)).toBe(false);
    });
  });

  describe('lt operator', () => {
    it('returns true when actual < expected', () => {
      expect(compare(3, 'lt', 5)).toBe(true);
    });

    it('returns false when actual >= expected', () => {
      expect(compare(5, 'lt', 5)).toBe(false);
      expect(compare(10, 'lt', 5)).toBe(false);
    });
  });

  describe('lte operator', () => {
    it('returns true when actual <= expected', () => {
      expect(compare(3, 'lte', 5)).toBe(true);
      expect(compare(5, 'lte', 5)).toBe(true);
    });

    it('returns false when actual > expected', () => {
      expect(compare(10, 'lte', 5)).toBe(false);
    });
  });

  describe('in operator', () => {
    it('returns true when value is in array', () => {
      expect(compare('US', 'in', ['US', 'CA', 'MX'])).toBe(true);
      expect(compare(5, 'in', [1, 5, 10])).toBe(true);
    });

    it('returns false when value is not in array', () => {
      expect(compare('UK', 'in', ['US', 'CA', 'MX'])).toBe(false);
    });

    it('falls back to eq when expected is not an array', () => {
      expect(compare('US', 'in', 'US')).toBe(true);
      expect(compare('UK', 'in', 'US')).toBe(false);
    });
  });

  describe('not_in operator', () => {
    it('returns true when value is not in array', () => {
      expect(compare('UK', 'not_in', ['US', 'CA', 'MX'])).toBe(true);
    });

    it('returns false when value is in array', () => {
      expect(compare('US', 'not_in', ['US', 'CA', 'MX'])).toBe(false);
    });

    it('falls back to neq when expected is not an array', () => {
      expect(compare('US', 'not_in', 'US')).toBe(false);
      expect(compare('UK', 'not_in', 'US')).toBe(true);
    });
  });

  describe('contains operator', () => {
    it('returns true when string contains substring', () => {
      expect(compare('Plex Web Player', 'contains', 'plex')).toBe(true);
      expect(compare('Plex Web Player', 'contains', 'Web')).toBe(true);
    });

    it('returns false when string does not contain substring', () => {
      expect(compare('Plex Web Player', 'contains', 'Jellyfin')).toBe(false);
    });

    it('is case insensitive', () => {
      expect(compare('PLEX', 'contains', 'plex')).toBe(true);
    });
  });

  describe('not_contains operator', () => {
    it('returns true when string does not contain substring', () => {
      expect(compare('Plex Web Player', 'not_contains', 'Jellyfin')).toBe(true);
    });

    it('returns false when string contains substring', () => {
      expect(compare('Plex Web Player', 'not_contains', 'Plex')).toBe(false);
    });
  });
});
