/**
 * Plex EventSource Service
 *
 * Handles Server-Sent Events (SSE) connections to Plex servers for real-time
 * session notifications. This replaces aggressive polling with instant updates.
 *
 * Plex exposes SSE at: /:/eventsource/notifications
 *
 * Event types we care about:
 * - playing: Session started, resumed, or a periodic position tick - Plex
 *   re-sends state 'playing' with an advancing viewOffset during playback
 *   and has no distinct progress state, so this IS the progress stream
 * - paused: Session paused
 * - stopped: Session ended
 */

import { EventEmitter } from 'events';
import {
  SSE_CONFIG,
  type PlexSSENotification,
  type PlexPlaySessionNotification,
  type PlexTimelineEntry,
  type SSEConnectionState,
} from '@tracearr/shared';
import { plexHeaders } from '../../../utils/http.js';

// Library section scope for TimelineEntry - other identifiers (DVR, etc.) reuse
// the same 'timeline' event name for unrelated things
const LIBRARY_IDENTIFIER = 'com.plexapp.plugins.library';

// TimelineEntry.state: fully processed/added. See PlexTimelineEntry doc comment
// for why these values are inferred rather than documented.
const TIMELINE_STATE_ADDED = 5;
const TIMELINE_STATE_DELETED = 9;

// Re-probe cadence once the reconnect budget is spent; polling covers data meanwhile
const FALLBACK_RETRY_MS = 3 * 60 * 1000;

// EventSource types for Node.js (using eventsource package)
interface EventSourceMessage {
  data: string;
  lastEventId?: string;
  origin?: string;
}

type EventSourceReadyState = 0 | 1 | 2;

interface EventSourceInit {
  headers?: Record<string, string>;
  withCredentials?: boolean;
}

// Dynamic import of eventsource package
let EventSourceClass: new (url: string, init?: EventSourceInit) => EventSource;

interface EventSource {
  readonly readyState: EventSourceReadyState;
  readonly url: string;
  onopen: ((this: EventSource, ev: Event) => void) | null;
  onmessage: ((this: EventSource, ev: EventSourceMessage) => void) | null;
  onerror: ((this: EventSource, ev: Event) => void) | null;
  close(): void;
  addEventListener(type: string, listener: (ev: EventSourceMessage) => void): void;
  removeEventListener(type: string, listener: (ev: EventSourceMessage) => void): void;
}

// Event types emitted by PlexEventSource
export interface PlexEventSourceEvents {
  'session:playing': PlexPlaySessionNotification;
  'session:paused': PlexPlaySessionNotification;
  'session:stopped': PlexPlaySessionNotification;
  'session:progress': PlexPlaySessionNotification;
  'library:added': { ratingKey: string };
  'library:removed': { ratingKey: string };
  'connection:state': SSEConnectionState;
  'connection:error': Error;
}

/**
 * PlexEventSource - Manages SSE connection to a Plex server
 *
 * @example
 * const sse = new PlexEventSource({
 *   serverId: 'abc123',
 *   url: 'http://plex.local:32400',
 *   token: 'encrypted-token',
 * });
 *
 * sse.on('session:playing', (notification) => {
 *   console.log('Session started:', notification.sessionKey);
 * });
 *
 * await sse.connect();
 */
export class PlexEventSource extends EventEmitter {
  private readonly serverId: string;
  private readonly serverName: string;
  private readonly baseUrl: string;
  private readonly token: string;

  private eventSource: EventSource | null = null;
  private state: SSEConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private lastEventTime: Date | null = null;
  private connectedAt: Date | null = null;
  private lastError: Error | null = null;

  // close() doesn't remove addEventListener listeners, so we track refs for manual cleanup
  private messageListener: ((e: EventSourceMessage) => void) | null = null;
  private playingListener: ((e: EventSourceMessage) => void) | null = null;
  private notificationListener: ((e: EventSourceMessage) => void) | null = null;
  private timelineListener: ((e: EventSourceMessage) => void) | null = null;
  private pingListener: ((e: EventSourceMessage) => void) | null = null;

  constructor(config: { serverId: string; serverName: string; url: string; token: string }) {
    super();
    this.serverId = config.serverId;
    this.serverName = config.serverName;
    this.baseUrl = config.url.replace(/\/$/, '');
    this.token = config.token;
  }

  /**
   * Get current connection state
   */
  getState(): SSEConnectionState {
    return this.state;
  }

  /**
   * Get connection status for monitoring
   */
  getStatus(): {
    serverId: string;
    serverName: string;
    state: SSEConnectionState;
    connectedAt: Date | null;
    lastEventAt: Date | null;
    reconnectAttempts: number;
    error: string | null;
  } {
    return {
      serverId: this.serverId,
      serverName: this.serverName,
      state: this.state,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventTime,
      reconnectAttempts: this.reconnectAttempts,
      error: this.lastError?.message ?? null,
    };
  }

  /**
   * Connect to Plex SSE endpoint
   */
  async connect(): Promise<void> {
    // Lazy load eventsource package
    if (!EventSourceClass) {
      const module = await import('eventsource');
      // eventsource v4 exports EventSource as a named export
      EventSourceClass = module.EventSource as unknown as typeof EventSourceClass;
    }

    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.setState('connecting');
    this.clearTimers();

    try {
      // Plex SSE requires token as query param (headers may not work with EventSource)
      const url = `${this.baseUrl}/:/eventsource/notifications?X-Plex-Token=${encodeURIComponent(this.token)}`;
      const headers = plexHeaders(this.token);

      console.log(
        `[SSE] Connecting to ${this.serverName} at ${this.baseUrl}/:/eventsource/notifications`
      );

      this.eventSource = new EventSourceClass(url, {
        headers,
      });

      this.startConnectionTimeout();

      this.eventSource.onopen = () => {
        if (this.state !== 'connecting') {
          console.warn(`[SSE] Ignoring onopen for ${this.serverName} - state is ${this.state}`);
          return;
        }
        this.clearConnectionTimeout();
        console.log(`[SSE] Connected to ${this.serverName}`);
        this.setState('connected');
        this.connectedAt = new Date();
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.startHeartbeatMonitor();
      };

      this.messageListener = (event: EventSourceMessage) => this.handleMessage(event);
      this.playingListener = (event: EventSourceMessage) => this.handleMessage(event);
      this.notificationListener = (event: EventSourceMessage) => this.handleMessage(event);
      // Library add/scan/delete lifecycle - unconfirmed whether Plex names this
      // event 'timeline' or folds it into 'notification'; handleMessage checks
      // both shapes, so this listener is a best-effort extra, not a requirement
      this.timelineListener = (event: EventSourceMessage) => this.handleMessage(event);
      this.pingListener = (_event: EventSourceMessage) => this.resetHeartbeatMonitor();

      // eventsource v4 requires addEventListener instead of onmessage
      // Plex sends named 'playing' events for all playback notifications
      this.eventSource.addEventListener('message', this.messageListener);
      this.eventSource.addEventListener('playing', this.playingListener);
      this.eventSource.addEventListener('notification', this.notificationListener);
      this.eventSource.addEventListener('timeline', this.timelineListener);

      // Plex sends ping events every 10 seconds as keepalive
      this.eventSource.addEventListener('ping', this.pingListener);

      this.eventSource.onerror = (error: Event) => {
        this.handleError(error);
      };
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Disconnect from SSE
   */
  disconnect(): void {
    console.log(`[SSE] Disconnecting from ${this.serverName}`);
    this.clearTimers();
    this.cleanupEventSource();
    this.setState('disconnected');
    this.connectedAt = null;
  }

  retryFromFallback(): void {
    if (this.state !== 'fallback') return;
    console.log(`[SSE] Poll reached ${this.serverName}, retrying SSE from fallback`);
    this.clearTimers();
    this.reconnectAttempts = 0;
    void this.connect();
  }

  /**
   * Clean up EventSource instance and all listeners
   */
  private cleanupEventSource(): void {
    if (!this.eventSource) {
      return;
    }

    this.eventSource.onopen = null;
    this.eventSource.onerror = null;

    if (this.messageListener) {
      this.eventSource.removeEventListener('message', this.messageListener);
    }
    if (this.playingListener) {
      this.eventSource.removeEventListener('playing', this.playingListener);
    }
    if (this.notificationListener) {
      this.eventSource.removeEventListener('notification', this.notificationListener);
    }
    if (this.timelineListener) {
      this.eventSource.removeEventListener('timeline', this.timelineListener);
    }
    if (this.pingListener) {
      this.eventSource.removeEventListener('ping', this.pingListener);
    }

    this.eventSource.close();
    this.eventSource = null;
    this.messageListener = null;
    this.playingListener = null;
    this.notificationListener = null;
    this.timelineListener = null;
    this.pingListener = null;
  }

  /**
   * Handle incoming SSE message
   */
  private handleMessage(event: EventSourceMessage): void {
    this.lastEventTime = new Date();
    this.resetHeartbeatMonitor();

    if (!event.data) {
      return;
    }

    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;

      // Plex SSE has two formats:
      // 1. Named events ('playing'): { PlaySessionStateNotification: { sessionKey, state, ... } }
      // 2. Message events: { NotificationContainer: { type, PlaySessionStateNotification: [...] } }

      // Handle direct PlaySessionStateNotification (named 'playing' events)
      if ('PlaySessionStateNotification' in data && !('NotificationContainer' in data)) {
        const notification = data.PlaySessionStateNotification as PlexPlaySessionNotification;
        this.handlePlaySessionNotification(notification, 'playing');
        return;
      }

      // Handle direct TimelineEntry (in case Plex sends 'timeline' unwrapped, like 'playing')
      if ('TimelineEntry' in data && !('NotificationContainer' in data)) {
        const entries = data.TimelineEntry as PlexTimelineEntry | PlexTimelineEntry[];
        for (const entry of Array.isArray(entries) ? entries : [entries]) {
          this.handleTimelineEntry(entry);
        }
        return;
      }

      // Handle wrapped NotificationContainer format (legacy/message events)
      const container = (data as unknown as PlexSSENotification).NotificationContainer;
      if (container?.PlaySessionStateNotification) {
        const notifications = Array.isArray(container.PlaySessionStateNotification)
          ? container.PlaySessionStateNotification
          : [container.PlaySessionStateNotification];
        for (const notification of notifications) {
          this.handlePlaySessionNotification(notification, container.type);
        }
      }
      if (container?.TimelineEntry) {
        for (const entry of container.TimelineEntry) {
          this.handleTimelineEntry(entry);
        }
      }
    } catch (error) {
      console.error(`[SSE] Failed to parse message from ${this.serverName}:`, error);
    }
  }

  /**
   * Handle play session notification
   *
   * NOTE: Plex sends all playback events as container.type='playing'.
   * The actual state (playing/paused/stopped) is in notification.state.
   * See: https://www.plexopedia.com/plex-media-server/api/server/listen-events/
   */
  private handlePlaySessionNotification(
    notification: PlexPlaySessionNotification,
    _eventType: string
  ): void {
    // Use notification.state for the actual playback state
    // container.type is often 'playing' for ALL playback events
    switch (notification.state) {
      case 'playing':
        this.emit('session:playing', notification);
        break;
      case 'paused':
        this.emit('session:paused', notification);
        break;
      case 'stopped':
        this.emit('session:stopped', notification);
        break;
      case 'buffering':
        // Treat buffering as playing (will resume shortly)
        this.emit('session:playing', notification);
        break;
    }
  }

  /**
   * Handle a library timeline entry (item added/scanning/deleted).
   *
   * itemID doubles as the item's ratingKey. Only the terminal states are
   * acted on - in-progress metadata states (0-4) are noise; 'added' fires
   * once state reaches 5 (fully processed), not on the initial 'created' tick.
   */
  private handleTimelineEntry(entry: PlexTimelineEntry): void {
    if (entry.identifier !== LIBRARY_IDENTIFIER || !entry.itemID) {
      return;
    }
    const ratingKey = String(entry.itemID);
    if (entry.state === TIMELINE_STATE_DELETED) {
      this.emit('library:removed', { ratingKey });
    } else if (entry.state === TIMELINE_STATE_ADDED) {
      this.emit('library:added', { ratingKey });
    }
  }

  /**
   * Handle connection error
   */
  private handleError(error: unknown): void {
    this.clearTimers();

    let errorMessage = 'Connection error';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === 'object' && error !== null) {
      const errorObj = error as Record<string, unknown>;
      if ('message' in errorObj) {
        errorMessage = String(errorObj.message);
      }
      if ('status' in errorObj) {
        errorMessage += ` (status: ${errorObj.status})`;
      }
    }

    this.lastError = error instanceof Error ? error : new Error(errorMessage);
    console.error(`[SSE] Error on ${this.serverName}: ${errorMessage}`);
    this.emit('connection:error', this.lastError);

    this.cleanupEventSource();

    // Attempt reconnection with exponential backoff
    this.scheduleReconnect();
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= SSE_CONFIG.MAX_RETRIES) {
      console.error(
        `[SSE] Max retries (${SSE_CONFIG.MAX_RETRIES}) reached for ${this.serverName}, falling back to polling, retrying in ${FALLBACK_RETRY_MS / 1000}s`
      );
      this.setState('fallback');
      this.reconnectTimer = setTimeout(() => {
        if (this.state !== 'disconnected') {
          console.log(`[SSE] Retrying SSE for ${this.serverName} from fallback`);
          this.reconnectAttempts = 0;
          void this.connect();
        }
      }, FALLBACK_RETRY_MS);
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      SSE_CONFIG.INITIAL_RETRY_DELAY_MS *
        Math.pow(SSE_CONFIG.RETRY_MULTIPLIER, this.reconnectAttempts - 1),
      SSE_CONFIG.MAX_RETRY_DELAY_MS
    );
    const jitter = Math.random() * 1000; // Add up to 1s jitter
    const delay = baseDelay + jitter;

    console.log(
      `[SSE] Reconnecting to ${this.serverName} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${SSE_CONFIG.MAX_RETRIES})`
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.state === 'disconnected') {
        return;
      }
      void this.connect();
    }, delay);
  }

  /**
   * Start heartbeat monitor
   * If we don't receive any events for HEARTBEAT_TIMEOUT_MS, consider connection dead
   */
  private startHeartbeatMonitor(): void {
    this.resetHeartbeatMonitor();
  }

  /**
   * Reset heartbeat timer (called on each message)
   */
  private resetHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    this.heartbeatTimer = setTimeout(() => {
      if (this.state === 'disconnected') {
        return;
      }
      console.warn(`[SSE] Heartbeat timeout on ${this.serverName}, reconnecting`);
      this.handleError(new Error('Heartbeat timeout'));
    }, SSE_CONFIG.HEARTBEAT_TIMEOUT_MS);
  }

  /**
   * Clear all timers
   */
  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearConnectionTimeout();
  }

  private startConnectionTimeout(): void {
    this.clearConnectionTimeout();
    this.connectionTimer = setTimeout(() => {
      if (this.state === 'disconnected') {
        return;
      }
      console.warn(`[SSE] Connection timeout on ${this.serverName} (stuck in connecting state)`);
      this.handleError(new Error('Connection timeout'));
    }, SSE_CONFIG.HEARTBEAT_TIMEOUT_MS);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  /**
   * Update and emit connection state
   */
  private setState(state: SSEConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('connection:state', state);
    }
  }
}
