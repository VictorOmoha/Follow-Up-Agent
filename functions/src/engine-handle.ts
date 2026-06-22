import { createAgentEngine, type AgentState } from './agent-engine.js';
import { createEngineLockIfEnabled, loadStateFromFirestore } from './db.js';
import { type DistributedLock } from './store/distributed-lock.js';

/**
 * Concurrency wrapper around the agent engine (Phase 3 of
 * docs/persistence-refactor.md).
 *
 * In the default (in-memory / blob) mode this is a thin passthrough to a single
 * long-lived engine — identical to the previous behavior.
 *
 * In collections mode with Firestore available (the production multi-instance
 * scenario) every mutating call instead runs under a cross-instance lock against
 * a FRESHLY loaded state, then persists. That removes the lost-update race where
 * two instances each mutate a stale in-memory copy and the last writer wins —
 * without re-sending messages, because each operation runs exactly once (unlike
 * a retried Firestore transaction). Reads (`getState`) return the last state this
 * instance observed, which is eventually consistent across instances.
 */

type Engine = ReturnType<typeof createAgentEngine>;

export interface EngineHandle {
  createLead: Engine['createLead'];
  approveMessage: Engine['approveMessage'];
  runDueTasks: Engine['runDueTasks'];
  runAutonomousCycle: Engine['runAutonomousCycle'];
  syncEmailInbox: Engine['syncEmailInbox'];
  recordReply: Engine['recordReply'];
  getState: Engine['getState'];
  connectEmailInbox: (input: Parameters<Engine['connectEmailInbox']>[0]) => Promise<ReturnType<Engine['connectEmailInbox']>>;
  reset: (state?: Parameters<Engine['reset']>[0]) => Promise<void>;
}

export interface EngineHandleOptions {
  now?: () => Date;
  initialState?: AgentState;
  tenantId?: string;
  onChange?: (state: AgentState) => void | Promise<void>;
  // Advanced/testing injection. When omitted, the lock and loader come from db.ts
  // (active only in collections mode with Firestore). Providing a lock forces the
  // locked path.
  lock?: DistributedLock;
  loadState?: () => Promise<AgentState | undefined>;
}

function emptyState(): AgentState {
  return { leads: [], messages: [], tasks: [], timeline: [], decisions: [], inboxes: [], emailMessages: [] };
}

export async function createEngineHandle(opts: EngineHandleOptions = {}): Promise<EngineHandle> {
  const lock = opts.lock ?? await createEngineLockIfEnabled();
  const loadState = opts.loadState ?? loadStateFromFirestore;

  // Default path: one long-lived engine, sync getState, behavior unchanged.
  if (!lock) {
    const engine = createAgentEngine(opts);
    return {
      createLead: (input) => engine.createLead(input),
      approveMessage: (id) => engine.approveMessage(id),
      runDueTasks: (o) => engine.runDueTasks(o),
      runAutonomousCycle: () => engine.runAutonomousCycle(),
      syncEmailInbox: (id) => engine.syncEmailInbox(id),
      recordReply: (id, body) => engine.recordReply(id, body),
      connectEmailInbox: async (input) => engine.connectEmailInbox(input),
      reset: async (state) => { engine.reset(state); },
      getState: () => engine.getState(),
    };
  }

  // Locked path: fresh engine per mutation under the cross-instance lock.
  const activeLock = lock; // narrowed to non-undefined after the early return above
  let cached: AgentState = opts.initialState ?? emptyState();

  async function runLocked<R>(run: (engine: Engine) => Promise<R> | R): Promise<R> {
    const release = await activeLock.acquire();
    try {
      const fresh = await loadState();
      const engine = createAgentEngine({
        now: opts.now,
        tenantId: opts.tenantId,
        initialState: fresh ?? cached,
        onChange: async (state) => { cached = state; await opts.onChange?.(state); },
      });
      return await run(engine);
    } finally {
      await release();
    }
  }

  return {
    createLead: (input) => runLocked((e) => e.createLead(input)),
    approveMessage: (id) => runLocked((e) => e.approveMessage(id)),
    runDueTasks: (o) => runLocked((e) => e.runDueTasks(o)),
    runAutonomousCycle: () => runLocked((e) => e.runAutonomousCycle()),
    syncEmailInbox: (id) => runLocked((e) => e.syncEmailInbox(id)),
    recordReply: (id, body) => runLocked((e) => e.recordReply(id, body)),
    connectEmailInbox: (input) => runLocked((e) => e.connectEmailInbox(input)),
    reset: (state) => runLocked((e) => { e.reset(state); }),
    getState: () => structuredClone(cached),
  };
}
