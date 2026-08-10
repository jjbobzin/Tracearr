import { describe, it, expect, vi } from 'vitest';

import { createRawPgClient } from '../client.js';

describe('createRawPgClient', () => {
  it('attaches an error listener so a severed connection cannot crash the process', () => {
    const client = createRawPgClient('test-context');
    expect(client.listenerCount('error')).toBe(1);
    expect(client.database).toBe('tracearr_test'); // from setup.ts DATABASE_URL

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // With no listener this emit would throw (unhandled 'error' event).
    client.emit('error', new Error('Connection terminated unexpectedly'));
    expect(errSpy).toHaveBeenCalledWith(
      '[DB Client Error] (test-context)',
      'Connection terminated unexpectedly'
    );
    errSpy.mockRestore();
  });
});
