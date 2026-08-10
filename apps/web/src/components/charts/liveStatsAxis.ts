// Shared x-axis for the live stats cards: absolute timestamps under a sliding
// viewport, since sources tick at different rates and phases.
import { useEffect, type RefObject } from 'react';
import type { HighchartsReact } from 'highcharts-react-official';
import type Highcharts from 'highcharts';
import { SERVER_STATS_CONFIG } from '@tracearr/shared';

export const LIVE_STATS_WINDOW_MS = SERVER_STATS_CONFIG.WINDOW_SECONDS * 1000;

const TICK_MS = 1000;
const LABEL_STEP_SECONDS = 20;
const LABEL_STEP_SECONDS_NARROW = 40;

function ageLabel(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole <= 0) return 'NOW';
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

// Hold the right edge behind real time, the same trick as Grafana's "now
// delay": without it the newest region is empty until a sample lands, so the
// line pulls away from the wall and snaps back.
const NOW_DELAY_MS = SERVER_STATS_CONFIG.NOW_DELAY_SECONDS * 1000;

// In the options too, so chart.update() can't drop back to autoscale
export function liveStatsExtremes(now: number) {
  const max = now - NOW_DELAY_MS;
  return { min: max - LIVE_STATS_WINDOW_MS, max };
}

// Ticks hang off the right edge: labels stay put, data flows under them
export function liveStatsTimeAxis(now: number, narrow = false): Highcharts.XAxisOptions {
  const stepMs = (narrow ? LABEL_STEP_SECONDS_NARROW : LABEL_STEP_SECONDS) * 1000;

  return {
    type: 'datetime',
    ...liveStatsExtremes(now),
    tickPositioner() {
      const max = this.max ?? 0;
      const min = this.min ?? max - LIVE_STATS_WINDOW_MS;
      const positions: number[] = [];
      for (let t = max; t >= min; t -= stepMs) positions.unshift(t);
      return positions;
    },
    labels: {
      style: { color: 'hsl(var(--muted-foreground))', fontSize: '10px' },
      formatter() {
        return ageLabel(((this.axis.max ?? 0) - Number(this.value)) / 1000);
      },
    },
    lineColor: 'hsl(var(--border))',
    tickColor: 'hsl(var(--border))',
  };
}

// Steps the viewport once a second rather than tweening between ticks
export function useSlidingWindow(
  chartRef: RefObject<HighchartsReact.RefObject | null>,
  clockSkewMs: number
): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const slide = () => {
      const axis = chartRef.current?.chart?.xAxis?.[0];
      if (!axis) return;
      const { min, max } = liveStatsExtremes(Date.now() + clockSkewMs);
      // No animation: tweening the pan repaints every series path at 60fps for
      // as long as the dashboard is open, and it reads as a pulse
      axis.setExtremes(min, max, true, false);
    };

    const start = () => {
      if (timer) return;
      slide();
      timer = setInterval(slide, TICK_MS);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => (document.hidden ? stop() : start());

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [chartRef, clockSkewMs]);
}

const TOOLTIP_MATCH_MS = 3000;

export interface NearestPoint {
  name: string;
  color: string;
  y: number;
}

// Highcharts' shared tooltip needs exact x, which servers never share
export function nearestPoints(hovered: Highcharts.Point): NearestPoint[] {
  const x = Number(hovered.x);
  const found: NearestPoint[] = [];

  for (const series of hovered.series.chart.series) {
    if (!series.visible) continue;

    let best: Highcharts.Point | undefined;
    for (const point of series.points) {
      if (point.y == null) continue;
      if (!best || Math.abs(point.x - x) < Math.abs(best.x - x)) best = point;
    }

    if (best?.y != null && Math.abs(best.x - x) <= TOOLTIP_MATCH_MS) {
      found.push({ name: series.name, color: String(series.color), y: best.y });
    }
  }

  return found;
}

export function nearestPointTooltip(formatValue: (y: number) => string) {
  return function (this: Highcharts.Point): string {
    return nearestPoints(this)
      .map((p) => `<span style="color:${p.color}">●</span> ${p.name}: <b>${formatValue(p.y)}</b>`)
      .join('<br/>');
  };
}

// Null between distant samples so the line breaks instead of bridging
export function withGaps(
  points: [number, number | null][],
  gapSeconds: number
): [number, number | null][] {
  const gapMs = gapSeconds * 1000;
  const out: [number, number | null][] = [];
  let prevX: number | null = null;

  for (const point of points) {
    if (prevX !== null && point[0] - prevX > gapMs) out.push([prevX + 1, null]);
    out.push(point);
    prevX = point[0];
  }

  return out;
}

// Absent bandwidth second means no bytes moved, not missing data
export function zeroFillSeconds(
  points: [number, number][],
  windowSeconds: number
): [number, number][] {
  if (points.length === 0) return points;

  const bySecond = new Map(points.map(([x, y]) => [Math.floor(x / 1000), y]));
  const seconds = [...bySecond.keys()];
  // Min/max, not first/last: descending input would draw nothing
  const newest = Math.max(...seconds);
  const oldest = Math.max(Math.min(...seconds), newest - windowSeconds);
  const filled: [number, number][] = [];

  for (let s = oldest; s <= newest; s++) {
    filled.push([s * 1000, bySecond.get(s) ?? 0]);
  }

  return filled;
}
