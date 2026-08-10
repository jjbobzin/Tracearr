import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../cursor.js';

describe('cursor codec', () => {
  it('encodes and decodes a cursor', () => {
    const now = new Date('2026-07-17T12:34:56.789Z');
    const id = '123abc';

    const encoded = encodeCursor(now, id);
    expect(typeof encoded).toBe('string');

    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.startedAt).toEqual(now);
    expect(decoded?.id).toBe(id);
  });

  it('decodes a valid cursor round-trip', () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const id = 'test-id-12345';

    const encoded = encodeCursor(startedAt, id);
    const decoded = decodeCursor(encoded);

    expect(decoded).toEqual({ startedAt, id });
  });

  it('rejects garbage input', () => {
    expect(decodeCursor('not-base64-url')).toBeNull();
    expect(decodeCursor('!!!invalid!!!')).toBeNull();
  });

  it('rejects truncated base64', () => {
    expect(decodeCursor('aGVs')).toBeNull();
  });

  it('rejects wrong JSON shape', () => {
    const encoded = Buffer.from(JSON.stringify({ wrong: 'shape' }), 'utf8').toString('base64url');
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('rejects invalid date', () => {
    const encoded = Buffer.from(JSON.stringify({ t: 'not-a-date', id: '123' }), 'utf8').toString(
      'base64url'
    );
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('rejects missing id', () => {
    const encoded = Buffer.from(JSON.stringify({ t: '2026-07-17T12:34:56.789Z' }), 'utf8').toString(
      'base64url'
    );
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('rejects non-string id', () => {
    const encoded = Buffer.from(
      JSON.stringify({ t: '2026-07-17T12:34:56.789Z', id: 123 }),
      'utf8'
    ).toString('base64url');
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('rejects non-string date', () => {
    const encoded = Buffer.from(JSON.stringify({ t: 1234567890, id: '123' }), 'utf8').toString(
      'base64url'
    );
    expect(decodeCursor(encoded)).toBeNull();
  });
});
