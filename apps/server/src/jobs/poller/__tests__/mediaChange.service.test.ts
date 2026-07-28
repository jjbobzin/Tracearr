import { describe, it, expect } from 'vitest';
import { detectMediaChange } from '../stateTracker.js';

describe('Media Change Detection', () => {
  describe('detectMediaChange', () => {
    it('returns true when ratingKey changes', () => {
      expect(detectMediaChange('episode-100', 'episode-101')).toBe(true);
    });

    it('returns false when ratingKey is the same', () => {
      expect(detectMediaChange('episode-100', 'episode-100')).toBe(false);
    });

    it('returns false when existing ratingKey is null', () => {
      expect(detectMediaChange(null, 'episode-100')).toBe(false);
    });

    it('returns false when new ratingKey is null', () => {
      expect(detectMediaChange('episode-100', null)).toBe(false);
    });

    describe('Live TV UUID handling', () => {
      it('returns false when ratingKey changes but liveUuid matches (channel change)', () => {
        expect(detectMediaChange('channel-1', 'channel-2', 'live-abc', 'live-abc')).toBe(false);
      });

      it('returns true when both ratingKey and liveUuid differ (different sessions)', () => {
        expect(detectMediaChange('channel-1', 'channel-2', 'live-abc', 'live-xyz')).toBe(true);
      });

      it('returns true when ratingKey changes and only existing has liveUuid', () => {
        expect(detectMediaChange('channel-1', 'channel-2', 'live-abc', undefined)).toBe(true);
      });

      it('returns true when ratingKey changes and only new has liveUuid', () => {
        expect(detectMediaChange('channel-1', 'channel-2', undefined, 'live-xyz')).toBe(true);
      });

      it('returns false when ratingKey is same regardless of liveUuid', () => {
        expect(detectMediaChange('channel-1', 'channel-1', 'live-abc', 'live-xyz')).toBe(false);
      });
    });
  });
});
