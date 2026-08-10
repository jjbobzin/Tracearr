/**
 * Converts a wall-clock timestamp with no zone marker into UTC, interpreting it
 * in the given IANA zone. Needed because the Playback Reporting plugin stamps
 * rows with the media server host's local time.
 */

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;

function tzOffsetMs(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  return asUtc - at.getTime();
}

export function wallTimeToUtc(wall: string, timeZone: string): Date {
  const m = WALL_RE.exec(wall);
  if (!m) return new Date(NaN);
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const guess = asUtc - tzOffsetMs(timeZone, new Date(asUtc));
  return new Date(asUtc - tzOffsetMs(timeZone, new Date(guess)));
}
