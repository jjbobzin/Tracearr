/**
 * Server operational state singleton.
 *
 * Tracks whether the server is starting up, in maintenance mode
 * (DB/Redis unavailable), or fully ready.
 */

type ServerMode = 'starting' | 'maintenance' | 'ready';

type ModeChangeListener = (newMode: ServerMode, prevMode: ServerMode) => void;

let _mode: ServerMode = 'starting';
let _wasReady = false;
let _servicesInitialized = false;
let _dbHealthy = false;
let _redisHealthy = false;
const _listeners: ModeChangeListener[] = [];

export function getServerMode(): ServerMode {
  return _mode;
}

export function setServerMode(mode: ServerMode): void {
  const prev = _mode;
  _mode = mode;
  if (mode === 'ready') _wasReady = true;
  if (prev !== mode) {
    for (const listener of _listeners) {
      listener(mode, prev);
    }
  }
}

/** Register a callback that fires whenever the server mode changes. */
export function onModeChange(listener: ModeChangeListener): void {
  _listeners.push(listener);
}

export function isMaintenance(): boolean {
  return _mode === 'maintenance';
}

/**
 * Which startup phase is running while the server is not yet ready. A
 * non-null value means killing the process risks interrupting half-applied
 * work (database migrations, aggregate rebuilds); /health surfaces it so the
 * UI can warn against restarting.
 */
export type InitStep = 'migrations' | 'timescale' | 'services';

let _initStep: InitStep | null = null;

export function getInitStep(): InitStep | null {
  return _initStep;
}

export function setInitStep(step: InitStep | null): void {
  _initStep = step;
}

/** True if the server has ever reached 'ready' mode during this process lifetime. */
export function wasEverReady(): boolean {
  return _wasReady;
}

export function isServicesInitialized(): boolean {
  return _servicesInitialized;
}

export function setServicesInitialized(v: boolean): void {
  _servicesInitialized = v;
}

/** Cached DB health from the background health check interval. */
export function isDbHealthy(): boolean {
  return _dbHealthy;
}

export function setDbHealthy(v: boolean): void {
  _dbHealthy = v;
}

/** Cached Redis health — updated by startup probe, recovery loop, and ioredis events. */
export function isRedisHealthy(): boolean {
  return _redisHealthy;
}

export function setRedisHealthy(v: boolean): void {
  _redisHealthy = v;
}

// Restore state — tracks whether a database restore is in progress
import type { RestoreProgress } from '@tracearr/shared';

let _restoring = false;
let _restoreProgress: RestoreProgress | null = null;

export function isRestoring(): boolean {
  return _restoring;
}

export function setRestoring(v: boolean): void {
  _restoring = v;
}

export function getRestoreProgress(): RestoreProgress | null {
  return _restoreProgress;
}

export function setRestoreProgress(p: RestoreProgress | null): void {
  _restoreProgress = p;
}

// Migration/init failure - surfaced on /health so a stuck migration stays visible
// (both db and redis read healthy in this case, so those flags alone don't show it).
let _lastMigrationError: string | null = null;

export function getLastMigrationError(): string | null {
  return _lastMigrationError;
}

export function setLastMigrationError(message: string | null): void {
  _lastMigrationError = message;
}
