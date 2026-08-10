import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JellyfinEmbyEventSource } from '../jellyfinEmbyEventSource.js';
import type { SSEConnectionState } from '@tracearr/shared';

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
    // Test helpers
    _triggerOpen() {
      _onopen?.(new Event('open'));
    },
    _triggerError(obj: unknown) {
      _onerror?.(obj as Event);
    },
    _emit(type: string, data: string) {
      for (const fn of listeners.get(type) ?? []) fn({ data });
    },
  };
}

vi.mock('eventsource', () => ({
  // Must be a regular function (not arrow) so it can be called with `new`
  EventSource: vi.fn(function () {
    return {};
  }),
}));

describe('JellyfinEmbyEventSource detection', () => {
  let stub: ReturnType<typeof createEventSourceStub>;

  beforeEach(async () => {
    stub = createEventSourceStub();
    const { EventSource } = await import('eventsource');
    // Use a regular function so `new EventSource(...)` works correctly
    vi.mocked(EventSource).mockImplementation(function () {
      return stub as unknown as InstanceType<typeof EventSource>;
    });
  });

  it('transitions to connected when stream opens', async () => {
    const states: SSEConnectionState[] = [];
    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('connection:state', (s: SSEConnectionState) => states.push(s));
    await src.connect();
    stub._triggerOpen();

    expect(states).toContain('connected');
  });

  it('treats a single 404 as a normal reconnect, not proof the plugin is missing', async () => {
    vi.useFakeTimers();
    const states: SSEConnectionState[] = [];
    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('connection:state', (s: SSEConnectionState) => states.push(s));
    await src.connect();
    // Real eventsource v4 ErrorEvent shape: .code holds the HTTP status, not .status
    stub._triggerError({ message: 'Non-200 status code (404)', code: 404 });

    expect(states).toContain('reconnecting');
    expect(states).not.toContain('unsupported');
    vi.useRealTimers();
    src.disconnect();
  });

  it('transitions to unsupported only after three consecutive 404s', async () => {
    vi.useFakeTimers();
    const states: SSEConnectionState[] = [];
    const { EventSource } = await import('eventsource');
    const stubs: ReturnType<typeof createEventSourceStub>[] = [];
    vi.mocked(EventSource).mockImplementation(function () {
      const s = createEventSourceStub();
      stubs.push(s);
      return s as unknown as InstanceType<typeof EventSource>;
    });

    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('connection:state', (s: SSEConnectionState) => states.push(s));
    await src.connect();

    stubs[0]!._triggerError({ message: 'Non-200 status code (404)', code: 404 });
    expect(states).not.toContain('unsupported');
    await vi.advanceTimersByTimeAsync(5_000);

    stubs[1]!._triggerError({ message: 'Non-200 status code (404)', code: 404 });
    expect(states).not.toContain('unsupported');
    await vi.advanceTimersByTimeAsync(10_000);

    stubs[2]!._triggerError({ message: 'Non-200 status code (404)', code: 404 });
    expect(states).toContain('unsupported');

    vi.useRealTimers();
    src.disconnect();
  });

  it('resets the 404 streak when a different error interleaves', async () => {
    vi.useFakeTimers();
    const states: SSEConnectionState[] = [];
    const { EventSource } = await import('eventsource');
    const stubs: ReturnType<typeof createEventSourceStub>[] = [];
    vi.mocked(EventSource).mockImplementation(function () {
      const s = createEventSourceStub();
      stubs.push(s);
      return s as unknown as InstanceType<typeof EventSource>;
    });

    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('connection:state', (s: SSEConnectionState) => states.push(s));
    await src.connect();

    // 404, 404, connection refused, 404, 404: never three 404s in a row
    stubs[0]!._triggerError({ message: 'Non-200 status code (404)', code: 404 });
    await vi.advanceTimersByTimeAsync(5_000);
    stubs[1]!._triggerError({ message: 'Non-200 status code (404)', code: 404 });
    await vi.advanceTimersByTimeAsync(10_000);
    stubs[2]!._triggerError({ message: 'TypeError: fetch failed' });
    await vi.advanceTimersByTimeAsync(15_000);
    stubs[3]!._triggerError({ message: 'Non-200 status code (404)', code: 404 });
    await vi.advanceTimersByTimeAsync(20_000);
    stubs[4]!._triggerError({ message: 'Non-200 status code (404)', code: 404 });

    expect(states).not.toContain('unsupported');

    vi.useRealTimers();
    src.disconnect();
  });

  it('retries from unsupported when nudged, and recovers when the endpoint is back', async () => {
    vi.useFakeTimers();
    const states: SSEConnectionState[] = [];
    const { EventSource } = await import('eventsource');
    const stubs: ReturnType<typeof createEventSourceStub>[] = [];
    vi.mocked(EventSource).mockImplementation(function () {
      const s = createEventSourceStub();
      stubs.push(s);
      return s as unknown as InstanceType<typeof EventSource>;
    });

    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('connection:state', (s: SSEConnectionState) => states.push(s));
    await src.connect();

    for (let i = 0; i < 3; i++) {
      stubs[stubs.length - 1]!._triggerError({ message: 'Non-200 status code (404)', code: 404 });
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(src.getState()).toBe('unsupported');

    src.retryFromFallback();
    await vi.advanceTimersByTimeAsync(0);
    stubs[stubs.length - 1]!._triggerOpen();

    expect(src.getState()).toBe('connected');

    vi.useRealTimers();
    src.disconnect();
  });

  it('schedules reconnect on non-404 error', async () => {
    vi.useFakeTimers();
    const states: SSEConnectionState[] = [];
    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('connection:state', (s: SSEConnectionState) => states.push(s));
    await src.connect();
    stub._triggerOpen();
    stub._triggerError({ message: 'Non-200 status code (500)', code: 500 });

    expect(states).toContain('reconnecting');
    vi.useRealTimers();
    src.disconnect();
  });

  it('transitions to fallback after max retries', async () => {
    vi.useFakeTimers();
    const states: SSEConnectionState[] = [];

    // Replace the mock so each new EventSource immediately errors
    let callCount = 0;
    const { EventSource } = await import('eventsource');
    vi.mocked(EventSource).mockImplementation(function () {
      callCount++;
      const s = createEventSourceStub();
      // Delay the error so the source finishes its setup first
      setTimeout(() => {
        s._triggerError({ message: 'Non-200 status code (500)', code: 500 });
      }, 0);
      return s as unknown as InstanceType<typeof EventSource>;
    });

    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('connection:state', (s: SSEConnectionState) => states.push(s));
    await src.connect();

    // Advance through all reconnect delays (bounded: fallback keeps a retry
    // timer armed, so runAllTimers would never settle)
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(31_000);
    }

    expect(states).toContain('fallback');
    expect(callCount).toBeGreaterThan(1);

    // Fallback is not terminal: the retry timer redials after the cooldown
    const callsAtFallback = callCount;
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 1000);
    expect(callCount).toBeGreaterThan(callsAtFallback);

    vi.useRealTimers();
    src.disconnect();
  });

  it('emits session:event when plugin events arrive', async () => {
    const events: unknown[] = [];
    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('session:event', (e: unknown) => events.push(e));
    await src.connect();
    stub._triggerOpen();

    const payload = JSON.stringify({
      sessionId: 'abc123',
      itemId: 'item-1',
      userId: 'user-1',
      state: 'playing',
      positionTicks: 10000,
    });
    stub._emit('playing', payload);

    expect(events).toHaveLength(1);
    expect((events[0] as { sessionId: string }).sessionId).toBe('abc123');
  });

  it('emits library:event for library.item.added and library.item.removed', async () => {
    const events: unknown[] = [];
    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('library:event', (e: unknown) => events.push(e));
    await src.connect();
    stub._triggerOpen();

    stub._emit('library.item.added', JSON.stringify({ itemId: 'item-added-1' }));
    stub._emit('library.item.removed', JSON.stringify({ itemId: 'item-removed-1' }));

    expect(events).toEqual([
      { type: 'added', itemId: 'item-added-1' },
      { type: 'removed', itemId: 'item-removed-1' },
    ]);
  });

  it('never emits library:event when the plugin does not send library events', async () => {
    const events: unknown[] = [];
    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    src.on('library:event', (e: unknown) => events.push(e));
    await src.connect();
    stub._triggerOpen();
    // Only session events, as the plugin sends today
    stub._emit('playing', JSON.stringify({ sessionId: 's1', state: 'playing' }));

    expect(events).toHaveLength(0);
  });

  it('ignores a malformed library event payload without throwing', async () => {
    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-1',
      serverName: 'My JF',
      url: 'http://jf.local:8096',
      serverType: 'jellyfin',
      token: 'abc',
    });

    await src.connect();
    stub._triggerOpen();

    expect(() => stub._emit('library.item.added', '{not json')).not.toThrow();
  });

  describe('auth header injection', () => {
    it('injects Authorization header for jellyfin and preserves Accept', async () => {
      const { EventSource } = await import('eventsource');
      let capturedFetch:
        | ((input: string | URL, init: { headers: Record<string, string> }) => Promise<Response>)
        | undefined;
      const localStub = createEventSourceStub();
      vi.mocked(EventSource).mockImplementation(function (_url, init) {
        capturedFetch = init?.fetch as typeof capturedFetch;
        return localStub as unknown as InstanceType<typeof EventSource>;
      });

      const src = new JellyfinEmbyEventSource({
        serverId: 'srv-jf',
        serverName: 'JF Server',
        url: 'http://jf.local:8096',
        serverType: 'jellyfin',
        token: 'tok-jf',
      });
      await src.connect();
      expect(capturedFetch).toBeDefined();

      let capturedHeaders: Headers | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn((_input, init) => {
        capturedHeaders =
          init?.headers instanceof Headers
            ? init.headers
            : new Headers(init?.headers as Record<string, string>);
        return Promise.resolve(new Response(null, { status: 200 }));
      }) as typeof fetch;

      try {
        await capturedFetch!('http://jf.local:8096/api/sse/events', {
          headers: { Accept: 'text/event-stream' },
        });
        expect(capturedHeaders?.get('Authorization')).toBe('MediaBrowser Token="tok-jf"');
        expect(capturedHeaders?.get('Accept')).toBe('text/event-stream');
      } finally {
        globalThis.fetch = originalFetch;
        src.disconnect();
      }
    });

    it('injects X-Emby-Token header for emby and preserves Accept', async () => {
      const { EventSource } = await import('eventsource');
      let capturedFetch:
        | ((input: string | URL, init: { headers: Record<string, string> }) => Promise<Response>)
        | undefined;
      const localStub = createEventSourceStub();
      vi.mocked(EventSource).mockImplementation(function (_url, init) {
        capturedFetch = init?.fetch as typeof capturedFetch;
        return localStub as unknown as InstanceType<typeof EventSource>;
      });

      const src = new JellyfinEmbyEventSource({
        serverId: 'srv-emby',
        serverName: 'Emby Server',
        url: 'http://emby.local:8096',
        serverType: 'emby',
        token: 'tok-emby',
      });
      await src.connect();
      expect(capturedFetch).toBeDefined();

      let capturedHeaders: Headers | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn((_input, init) => {
        capturedHeaders =
          init?.headers instanceof Headers
            ? init.headers
            : new Headers(init?.headers as Record<string, string>);
        return Promise.resolve(new Response(null, { status: 200 }));
      }) as typeof fetch;

      try {
        await capturedFetch!('http://emby.local:8096/emby/sse/events', {
          headers: { Accept: 'text/event-stream' },
        });
        expect(capturedHeaders?.get('X-Emby-Token')).toBe('tok-emby');
        expect(capturedHeaders?.get('Accept')).toBe('text/event-stream');
        expect(capturedHeaders?.get('Authorization')).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
        src.disconnect();
      }
    });
  });

  it('getStatus reflects current state', async () => {
    const src = new JellyfinEmbyEventSource({
      serverId: 'srv-jf',
      serverName: 'Test Server',
      url: 'http://jf.local',
      serverType: 'jellyfin',
      token: 'test-token',
    });

    await src.connect();
    stub._triggerOpen();

    const status = src.getStatus();
    expect(status.serverId).toBe('srv-jf');
    expect(status.state).toBe('connected');
    expect(status.error).toBeNull();

    src.disconnect();
  });
});
