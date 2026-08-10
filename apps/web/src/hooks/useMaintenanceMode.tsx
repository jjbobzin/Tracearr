import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import type { RestoreProgress } from '@tracearr/shared';
import { BASE_PATH } from '@/lib/basePath';

type InitStep = 'migrations' | 'timescale' | 'services';

interface HealthResponse {
  mode?: string;
  wasReady?: boolean;
  db?: boolean;
  redis?: boolean;
  restore?: RestoreProgress;
  initStep?: InitStep | null;
}

interface MaintenanceState {
  isInMaintenance: boolean;
  /** True if the app was previously in ready mode before entering maintenance */
  wasReady: boolean;
  db: boolean;
  redis: boolean;
  /** Present when a database restore is in progress */
  restore: RestoreProgress | null;
  /** Startup phase currently applying; migrations and timescale phases must
   * not be interrupted by a restart */
  initStep: InitStep | null;
}

const MAINTENANCE_POLL_MS = 5000;
const NORMAL_POLL_MS = 60000;
const MAINTENANCE_EVENT = 'tracearr:maintenance-mode';

const MaintenanceContext = createContext<MaintenanceState>({
  isInMaintenance: false,
  wasReady: false,
  db: true,
  redis: true,
  restore: null,
  initStep: null,
});

export function MaintenanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MaintenanceState>({
    isInMaintenance: false,
    wasReady: false,
    db: true,
    redis: true,
    restore: null,
    initStep: null,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sawRestoreRef = useRef(false);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/health`);
      const data = (await res.json()) as HealthResponse;
      const inMaintenance = data.mode === 'maintenance' || data.mode === 'starting';

      // Track if we ever saw a restore in progress
      if (data.restore && data.restore.phase !== 'failed') {
        sawRestoreRef.current = true;
      }

      // After a restore completes and server is ready, force a full reload
      // so the user lands on the login page (sessions were purged)
      if (sawRestoreRef.current && !inMaintenance) {
        sawRestoreRef.current = false;
        window.location.reload();
        return;
      }

      setState({
        isInMaintenance: inMaintenance,
        wasReady: data.wasReady === true || !inMaintenance,
        db: data.db ?? false,
        redis: data.redis ?? false,
        restore: data.restore ?? null,
        initStep: data.initStep ?? null,
      });
    } catch {
      // Server completely unreachable. Clear initStep too: keeping a stale
      // 'migrations'/'timescale' value would leave the do-not-restart warning
      // on screen for a process that is already dead
      setState((prev) => ({
        ...prev,
        isInMaintenance: true,
        db: false,
        redis: false,
        restore: null,
        initStep: null,
      }));
    }
  }, []);

  // Initial check
  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // Polling interval — faster when in maintenance, slower when healthy
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    const interval = state.isInMaintenance ? MAINTENANCE_POLL_MS : NORMAL_POLL_MS;
    intervalRef.current = setInterval(() => {
      void checkHealth();
    }, interval);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [state.isInMaintenance, checkHealth]);

  // Listen for 503 maintenance events from the API client
  useEffect(() => {
    const handler = () => {
      setState((prev) => ({ ...prev, isInMaintenance: true }));
      // Trigger an immediate health check to get accurate db/redis status
      void checkHealth();
    };
    globalThis.addEventListener(MAINTENANCE_EVENT, handler);
    return () => globalThis.removeEventListener(MAINTENANCE_EVENT, handler);
  }, [checkHealth]);

  return <MaintenanceContext.Provider value={state}>{children}</MaintenanceContext.Provider>;
}

export function useMaintenanceMode(): MaintenanceState {
  return useContext(MaintenanceContext);
}

export { MAINTENANCE_EVENT };
