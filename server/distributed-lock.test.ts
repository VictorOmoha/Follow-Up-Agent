import { describe, it, expect } from 'vitest';
import { createDistributedLock, type LockFirestore, type LockTx, type LockDocRef } from '../functions/src/store/distributed-lock';

// In-memory single-document Firestore fake. JS is single-threaded, so running
// the transaction callback directly is already atomic.
function makeFakeDb(): LockFirestore {
  const docs = new Map<string, Record<string, unknown>>();
  const tx: LockTx = {
    get: async (ref: LockDocRef) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
    set: (ref: LockDocRef, data: Record<string, unknown>) => { docs.set(ref.path, data); },
    delete: (ref: LockDocRef) => { docs.delete(ref.path); },
  };
  return {
    doc: (path: string) => ({ path }),
    runTransaction: async <T>(fn: (t: LockTx) => Promise<T>) => fn(tx),
  };
}

describe('distributed lock', () => {
  it('acquires when free and releases', async () => {
    const lock = createDistributedLock(makeFakeDb(), { maxWaitMs: 100, retryDelayMs: 1 });
    const release = await lock.acquire();
    await release();
    // Re-acquire after release succeeds.
    const release2 = await lock.acquire();
    await release2();
  });

  it('blocks a second acquire while held, then succeeds after release', async () => {
    const db = makeFakeDb();
    const lock = createDistributedLock(db, { maxWaitMs: 30, retryDelayMs: 5 });
    const release = await lock.acquire();

    await expect(lock.acquire()).rejects.toThrow(/Timed out/);

    await release();
    const release2 = await lock.acquire(); // now free
    await release2();
  });

  it('steals an expired lock so a crashed holder cannot deadlock', async () => {
    const db = makeFakeDb();
    let t = 1000;
    const sleep = async (ms: number) => { t += ms; }; // advance the fake clock instead of waiting
    const lock = createDistributedLock(db, { ttlMs: 1000, maxWaitMs: 100, retryDelayMs: 10, now: () => t, sleep });

    await lock.acquire(); // holder never releases (simulated crash); expires at t=2000
    // Before expiry, a fresh acquire times out (maxWaitMs < ttlMs).
    await expect(lock.acquire()).rejects.toThrow(/Timed out/);

    // Advance past the TTL → the stale lock can be stolen.
    t = 2500;
    const release = await lock.acquire();
    await release();
  });

  it('only the owner can release (stale release is a no-op)', async () => {
    const db = makeFakeDb();
    let t = 1000;
    const sleep = async (ms: number) => { t += ms; };
    const lock = createDistributedLock(db, { ttlMs: 1000, maxWaitMs: 100, retryDelayMs: 10, now: () => t, sleep });

    const release1 = await lock.acquire(); // holder 1, expires at t=2000
    t = 2500; // expire holder 1
    const release2 = await lock.acquire(); // holder 2 steals, expires at t=3500

    await release1(); // holder 1's stale release must NOT free holder 2's lock (owner mismatch)
    await expect(lock.acquire()).rejects.toThrow(/Timed out/); // still held by holder 2

    await release2();
    const release3 = await lock.acquire();
    await release3();
  });
});
