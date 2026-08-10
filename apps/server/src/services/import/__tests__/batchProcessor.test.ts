import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db/client.js', () => ({
  db: { transaction: vi.fn() },
}));

vi.mock('../../../db/timescale.js', () => ({
  uncapDecompressionForTx: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../../db/client.js';
import { uncapDecompressionForTx } from '../../../db/timescale.js';
import { flushInsertBatch, type NewSession } from '../batchProcessor.js';

function makeSessions(count: number): NewSession[] {
  return Array.from({ length: count }, (_, i) => ({
    serverId: 'server-1',
    serverUserId: 'server-user-1',
    sessionKey: `session-${i}`,
    state: 'stopped' as const,
    mediaType: 'movie' as const,
    mediaTitle: `Movie ${i}`,
    ipAddress: '10.0.0.1',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T01:00:00Z'),
  }));
}

describe('flushInsertBatch', () => {
  const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
  const txInsert = vi.fn().mockReturnValue(insertChain);

  beforeEach(() => {
    vi.clearAllMocks();
    insertChain.values.mockResolvedValue(undefined);
    txInsert.mockReturnValue(insertChain);
    vi.mocked(db.transaction).mockImplementation(async (callback: any) =>
      callback({ insert: txInsert })
    );
  });

  it('opens one transaction per chunk and lifts the decompression cap before inserting', async () => {
    const inserted = await flushInsertBatch(makeSessions(3), { chunkSize: 2 });

    expect(inserted).toBe(3);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(uncapDecompressionForTx).toHaveBeenCalledTimes(2);
    expect(txInsert).toHaveBeenCalledTimes(2);

    // Order matters within each transaction: SET LOCAL after the insert has
    // already started decompressing is too late to raise that statement's
    // budget.
    const uncapOrder = vi.mocked(uncapDecompressionForTx).mock.invocationCallOrder;
    const insertOrder = txInsert.mock.invocationCallOrder;
    expect(uncapOrder[0]!).toBeLessThan(insertOrder[0]!);
    expect(uncapOrder[1]!).toBeLessThan(insertOrder[1]!);
  });
});
