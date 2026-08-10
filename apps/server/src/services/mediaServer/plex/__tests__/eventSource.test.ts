import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlexEventSource } from '../eventSource.js';

vi.mock('../../../../utils/http.js', () => ({
  plexHeaders: vi.fn().mockReturnValue({ 'X-Plex-Token': 'test-token' }),
}));

// Minimal EventSource stub used by the tests
function createEventSourceStub() {
  const listeners = new Map<string, Array<(e: { data: string }) => void>>();
  let _onopen: ((e: Event) => void) | null = null;
  let _onerror: ((e: Event) => void) | null = null;

  return {
    close: vi.fn(),
    addEventListener: vi.fn((type: string, fn: (e: { data: string }) => void) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    }),
    removeEventListener: vi.fn(),
    get onopen() {
      return _onopen;
    },
    set onopen(fn) {
      _onopen = fn;
    },
    get onerror() {
      return _onerror;
    },
    set onerror(fn) {
      _onerror = fn;
    },
    _triggerOpen() {
      _onopen?.(new Event('open'));
    },
    _emit(type: string, data: string) {
      for (const fn of listeners.get(type) ?? []) fn({ data });
    },
  };
}

vi.mock('eventsource', () => ({
  EventSource: vi.fn(function () {
    return {};
  }),
}));

describe('PlexEventSource library timeline parsing', () => {
  let stub: ReturnType<typeof createEventSourceStub>;

  beforeEach(async () => {
    stub = createEventSourceStub();
    const { EventSource } = await import('eventsource');
    vi.mocked(EventSource).mockImplementation(function () {
      return stub as unknown as InstanceType<typeof EventSource>;
    });
  });

  async function connectedSource() {
    const src = new PlexEventSource({
      serverId: 'plex-1',
      serverName: 'My Plex',
      url: 'http://plex.local:32400',
      token: 'tok',
    });
    await src.connect();
    stub._triggerOpen();
    return src;
  }

  it('emits library:added when a library TimelineEntry reaches state 5 (fully processed)', async () => {
    const src = await connectedSource();
    const added: unknown[] = [];
    src.on('library:added', (e) => added.push(e));

    const payload = JSON.stringify({
      NotificationContainer: {
        type: 'timeline',
        size: 1,
        TimelineEntry: [
          {
            identifier: 'com.plexapp.plugins.library',
            sectionID: 1,
            itemID: 12345,
            type: 1,
            title: 'New Movie',
            state: 5,
          },
        ],
      },
    });
    stub._emit('notification', payload);

    expect(added).toEqual([{ ratingKey: '12345' }]);
  });

  it('emits library:removed when a library TimelineEntry reaches state 9 (deleted)', async () => {
    const src = await connectedSource();
    const removed: unknown[] = [];
    src.on('library:removed', (e) => removed.push(e));

    const payload = JSON.stringify({
      NotificationContainer: {
        type: 'timeline',
        size: 1,
        TimelineEntry: [
          { identifier: 'com.plexapp.plugins.library', itemID: 999, type: 1, state: 9 },
        ],
      },
    });
    stub._emit('notification', payload);

    expect(removed).toEqual([{ ratingKey: '999' }]);
  });

  it('handles an unwrapped TimelineEntry payload on the timeline event name', async () => {
    const src = await connectedSource();
    const added: unknown[] = [];
    src.on('library:added', (e) => added.push(e));

    const payload = JSON.stringify({
      TimelineEntry: [{ identifier: 'com.plexapp.plugins.library', itemID: 42, type: 1, state: 5 }],
    });
    stub._emit('timeline', payload);

    expect(added).toEqual([{ ratingKey: '42' }]);
  });

  it('ignores in-progress metadata states (0-4)', async () => {
    const src = await connectedSource();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    src.on('library:added', (e) => added.push(e));
    src.on('library:removed', (e) => removed.push(e));

    for (const state of [0, 1, 2, 3, 4]) {
      stub._emit(
        'notification',
        JSON.stringify({
          NotificationContainer: {
            type: 'timeline',
            size: 1,
            TimelineEntry: [
              { identifier: 'com.plexapp.plugins.library', itemID: 1, type: 1, state },
            ],
          },
        })
      );
    }

    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it('ignores TimelineEntry from non-library identifiers', async () => {
    const src = await connectedSource();
    const added: unknown[] = [];
    src.on('library:added', (e) => added.push(e));

    stub._emit(
      'notification',
      JSON.stringify({
        NotificationContainer: {
          type: 'timeline',
          size: 1,
          TimelineEntry: [{ identifier: 'com.plexapp.system.dvr', itemID: 1, type: 1, state: 5 }],
        },
      })
    );

    expect(added).toHaveLength(0);
  });

  it('does not throw on malformed JSON', async () => {
    await connectedSource();
    expect(() => stub._emit('notification', '{not json')).not.toThrow();
  });

  it('does not emit library events for unrelated PlaySessionStateNotification payloads', async () => {
    const src = await connectedSource();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    src.on('library:added', (e) => added.push(e));
    src.on('library:removed', (e) => removed.push(e));

    stub._emit(
      'playing',
      JSON.stringify({
        PlaySessionStateNotification: {
          sessionKey: '1',
          clientIdentifier: 'c1',
          guid: 'g1',
          ratingKey: 'r1',
          url: '',
          key: '',
          viewOffset: 0,
          playQueueItemID: 1,
          state: 'playing',
        },
      })
    );

    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });
});
