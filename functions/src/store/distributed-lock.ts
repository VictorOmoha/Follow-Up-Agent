/**
 * Cross-instance mutex backed by a single Firestore document (Phase 3 of
 * docs/persistence-refactor.md).
 *
 * The engine performs external I/O (SMS / email / voice / Gmail sends) inline
 * with its state mutation, and Firestore re-runs a runTransaction callback on
 * contention — so wrapping a whole engine operation in a fine-grained per-entity
 * transaction would re-send those messages on every retry. Instead we serialize
 * mutating operations across instances with this lock and read fresh state for
 * each one: no lost updates, no double-sends, and the engine logic is reused
 * unchanged.
 *
 * The lock auto-expires after `ttlMs` so a crashed holder can't deadlock the
 * system — a later caller steals an expired lock.
 */

export interface LockDocRef { readonly path: string }
export interface LockTx {
  get(ref: LockDocRef): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(ref: LockDocRef, data: Record<string, unknown>): void;
  delete(ref: LockDocRef): void;
}
export interface LockFirestore {
  doc(path: string): LockDocRef;
  runTransaction<T>(fn: (tx: LockTx) => Promise<T>): Promise<T>;
}

export interface DistributedLock {
  /** Acquire the lock, returning a release function. Throws on timeout. */
  acquire(): Promise<() => Promise<void>>;
}

export interface LockOptions {
  path?: string;
  ttlMs?: number;       // how long a held lock stays valid before it can be stolen
  maxWaitMs?: number;   // how long acquire() waits before giving up
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let counter = 0;

export function createDistributedLock(db: LockFirestore, opts: LockOptions = {}): DistributedLock {
  const path = opts.path ?? 'locks/engine';
  const ttlMs = opts.ttlMs ?? 30_000;
  const maxWaitMs = opts.maxWaitMs ?? 25_000;
  const retryDelayMs = opts.retryDelayMs ?? 50;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const ref = db.doc(path);

  async function tryAcquire(token: string): Promise<boolean> {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data() : undefined;
      const expiresAt = typeof current?.expiresAt === 'number' ? current.expiresAt : 0;
      if (!current || expiresAt <= now()) {
        tx.set(ref, { owner: token, expiresAt: now() + ttlMs });
        return true;
      }
      return false;
    });
  }

  async function release(token: string): Promise<void> {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && snap.data()?.owner === token) tx.delete(ref);
    });
  }

  async function acquire(): Promise<() => Promise<void>> {
    const token = `${now()}-${counter++}-${Math.random().toString(36).slice(2)}`;
    const deadline = now() + maxWaitMs;
    for (;;) {
      if (await tryAcquire(token)) {
        return () => release(token);
      }
      if (now() >= deadline) throw new Error(`Timed out acquiring lock ${path}`);
      await sleep(retryDelayMs);
    }
  }

  return { acquire };
}
