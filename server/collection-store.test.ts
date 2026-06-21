import { describe, it, expect, beforeEach } from 'vitest';
import { createCollectionStore, migrateBlobToCollections, type FirestoreLike } from '../functions/src/store/firestore-store';
import { type AgentState } from '../functions/src/agent-engine';

/**
 * In-memory Firestore fake implementing the structural subset the collection
 * store depends on, plus counters so we can assert the diff logic only writes
 * what changed.
 */
class FakeFirestore implements FirestoreLike {
  store = new Map<string, Map<string, Record<string, unknown>>>();
  sets = 0;
  deletes = 0;
  commits = 0;

  private coll(name: string) {
    let m = this.store.get(name);
    if (!m) { m = new Map(); this.store.set(name, m); }
    return m;
  }

  collection(name: string) {
    const m = this.coll(name);
    return {
      get: async () => ({ docs: [...m.entries()].map(([id, data]) => ({ id, data: () => data })) }),
      doc: (id: string) => ({
        _name: name,
        _id: id,
        get: async () => ({ exists: m.has(id), data: () => m.get(id) }),
      }),
    };
  }

  batch() {
    const m = this.store;
    const ensure = (name: string) => {
      let c = m.get(name);
      if (!c) { c = new Map(); m.set(name, c); }
      return c;
    };
    return {
      set: (ref: unknown, data: Record<string, unknown>) => {
        const r = ref as { _name: string; _id: string };
        ensure(r._name).set(r._id, data);
        this.sets++;
      },
      delete: (ref: unknown) => {
        const r = ref as { _name: string; _id: string };
        ensure(r._name).delete(r._id);
        this.deletes++;
      },
      commit: async () => { this.commits++; },
    };
  }

  count(name: string) { return this.store.get(name)?.size ?? 0; }
}

function emptyState(over: Partial<AgentState> = {}): AgentState {
  return {
    leads: [], messages: [], tasks: [], timeline: [], decisions: [],
    inboxes: [], emailMessages: [],
    config: { bookingLink: 'https://x.test', autopilotEnabled: false },
    ...over,
  };
}

function lead(id: string, createdAt: string) {
  return { id, name: id, status: 'new', createdAt, updatedAt: createdAt } as unknown as AgentState['leads'][number];
}

describe('collection store', () => {
  let db: FakeFirestore;

  beforeEach(() => { db = new FakeFirestore(); });

  it('writes one document per entity, not one blob', async () => {
    const store = createCollectionStore(db);
    await store.save(emptyState({
      leads: [lead('lead_a', '2026-01-01T00:00:00Z'), lead('lead_b', '2026-01-02T00:00:00Z')],
    }));
    expect(db.count('leads')).toBe(2);
    expect(db.count('settings')).toBe(0); // no legacy blob
    expect(db.count('config')).toBe(1);
  });

  it('only writes documents that actually changed (diff)', async () => {
    const store = createCollectionStore(db);
    const state = emptyState({ leads: [lead('a', '2026-01-01T00:00:00Z'), lead('b', '2026-01-02T00:00:00Z')] });
    await store.save(state);
    const setsAfterFirst = db.sets;

    // Save identical state again → no writes.
    await store.save(state);
    expect(db.sets).toBe(setsAfterFirst);

    // Mutate one lead → exactly one more set.
    state.leads[0].status = 'contacted';
    await store.save(state);
    expect(db.sets).toBe(setsAfterFirst + 1);
  });

  it('deletes documents for entities that disappear', async () => {
    const store = createCollectionStore(db);
    const state = emptyState({ leads: [lead('a', '2026-01-01T00:00:00Z'), lead('b', '2026-01-02T00:00:00Z')] });
    await store.save(state);
    state.leads = state.leads.filter((l) => l.id !== 'a');
    await store.save(state);
    expect(db.count('leads')).toBe(1);
    expect(db.deletes).toBe(1);
  });

  it('prunes append-only logs to the cap', async () => {
    const store = createCollectionStore(db);
    const timeline = Array.from({ length: 1200 }, (_, i) => ({
      id: `event_${i}`,
      leadId: 'a',
      label: 'x',
      detail: 'y',
      createdAt: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${String(i).padStart(4, '0')}Z`,
    })) as unknown as AgentState['timeline'];
    await store.save(emptyState({ timeline }));
    expect(db.count('timeline')).toBe(1000); // capped
  });

  it('round-trips: load reassembles newest-first and seeds the diff map', async () => {
    const store = createCollectionStore(db);
    await store.save(emptyState({
      leads: [lead('old', '2026-01-01T00:00:00Z'), lead('new', '2026-06-01T00:00:00Z')],
    }));

    const loaded = await store.load();
    expect(loaded).toBeDefined();
    expect(loaded!.leads.map((l) => l.id)).toEqual(['new', 'old']); // newest first
    expect(loaded!.config?.bookingLink).toBe('https://x.test');

    // A fresh store that loads should not rewrite unchanged data on next save.
    const store2 = createCollectionStore(db);
    const reloaded = await store2.load();
    const setsBefore = db.sets;
    await store2.save(reloaded!);
    expect(db.sets).toBe(setsBefore);
  });

  it('returns undefined when nothing is persisted', async () => {
    const store = createCollectionStore(db);
    expect(await store.load()).toBeUndefined();
  });

  it('migrates a legacy blob into collections losslessly', async () => {
    // Seed the legacy single-document blob.
    const blob = emptyState({ leads: [lead('a', '2026-01-01T00:00:00Z'), lead('b', '2026-02-01T00:00:00Z')] });
    db.store.set('settings', new Map([['state', blob as unknown as Record<string, unknown>]]));

    const store = createCollectionStore(db);
    expect(await store.load()).toBeUndefined(); // no collections yet

    const migrated = await migrateBlobToCollections(db, store);
    expect(migrated).toBeDefined();
    expect(db.count('leads')).toBe(2);

    // After migration, a fresh store loads the same leads from collections.
    const reloaded = await createCollectionStore(db).load();
    expect(reloaded!.leads.map((l) => l.id).sort()).toEqual(['a', 'b']);

    // The blob is left intact so the switch stays reversible.
    expect(db.count('settings')).toBe(1);
  });
});
