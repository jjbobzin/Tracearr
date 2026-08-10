export function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: startedAt.toISOString(), id }), 'utf8').toString(
    'base64url'
  );
}

export function decodeCursor(raw: string): { startedAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t?: unknown;
      id?: unknown;
    };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    const startedAt = new Date(parsed.t);
    if (Number.isNaN(startedAt.getTime())) return null;
    return { startedAt, id: parsed.id };
  } catch {
    return null;
  }
}
