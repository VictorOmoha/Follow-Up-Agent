import { describe, it, expect } from 'vitest';
import { createEngineHandle } from '../functions/src/engine-handle';
import { type AgentState } from '../functions/src/agent-engine';
import { type DistributedLock } from '../functions/src/store/distributed-lock';

// A real mutex: a second acquire() waits until the first releases. Counts calls
// so we can assert every acquire is paired with a release.
function makeFakeLock() {
  let held = false;
  const waiters: Array<() => void> = [];
  let acquires = 0;
  let releases = 0;
  const lock: DistributedLock = {
    acquire: async () => {
      acquires++;
      while (held) await new Promise<void>((r) => waiters.push(r));
      held = true;
      return async () => {
        held = false;
        releases++;
        waiters.shift()?.();
      };
    },
  };
  return { lock, counts: () => ({ acquires, releases }) };
}

// Shared persisted state so each locked op reloads what the previous one wrote.
function makeStore() {
  let state: AgentState | undefined;
  return {
    loadState: async () => (state ? structuredClone(state) : undefined),
    onChange: async (s: AgentState) => { state = structuredClone(s); },
    get: () => state,
  };
}

const fullLead = (name: string, contact: string) => ({
  name, contact, budget: '1000', urgency: 'asap', pain: 'losing leads', channel: 'SMS' as const,
});

describe('engine handle (locked path)', () => {
  it('serializes concurrent writes with no lost update', async () => {
    const { lock, counts } = makeFakeLock();
    const store = makeStore();
    const handle = await createEngineHandle({ lock, loadState: store.loadState, onChange: store.onChange });

    // Two leads created concurrently. Without lock+reload, the second engine
    // would start from stale state and clobber the first lead.
    await Promise.all([
      handle.createLead(fullLead('Alice', '+15550000001')),
      handle.createLead(fullLead('Bob', '+15550000002')),
    ]);

    expect(store.get()!.leads).toHaveLength(2);
    expect(store.get()!.leads.map((l) => l.name).sort()).toEqual(['Alice', 'Bob']);

    // Lock hygiene: every acquire was released.
    const { acquires, releases } = counts();
    expect(acquires).toBe(2);
    expect(releases).toBe(2);
  });

  it('getState reflects the latest persisted state', async () => {
    const { lock } = makeFakeLock();
    const store = makeStore();
    const handle = await createEngineHandle({ lock, loadState: store.loadState, onChange: store.onChange });

    await handle.createLead(fullLead('Carol', '+15550000003'));
    expect(handle.getState().leads.map((l) => l.name)).toContain('Carol');
  });

  it('releases the lock even when an operation throws', async () => {
    const { lock, counts } = makeFakeLock();
    const store = makeStore();
    const handle = await createEngineHandle({ lock, loadState: store.loadState, onChange: store.onChange });

    // approveMessage on a non-existent id throws inside the locked section.
    await expect(handle.approveMessage('nope')).rejects.toThrow();
    const { acquires, releases } = counts();
    expect(acquires).toBe(1);
    expect(releases).toBe(1);

    // Lock is free for the next op.
    await handle.createLead(fullLead('Dave', '+15550000004'));
    expect(store.get()!.leads).toHaveLength(1);
  });
});
