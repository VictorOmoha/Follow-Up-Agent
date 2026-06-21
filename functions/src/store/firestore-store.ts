import { type AgentState } from '../agent-engine.js';

/**
 * Per-entity Firestore persistence (Phase 2 of docs/persistence-refactor.md).
 *
 * The legacy store wrote the ENTIRE AgentState into one document
 * (`settings/state`). That hits Firestore's 1 MB per-document cap as leads /
 * messages / timeline / decisions accumulate, and makes every write a
 * whole-state read-modify-write that loses concurrent updates across instances.
 *
 * This store instead keeps one document per entity in top-level collections, so:
 *   - no aggregate size cap (each entity doc is tiny),
 *   - two instances mutating *different* entities no longer clobber each other
 *     (they write different docs),
 *   - append-only logs (timeline, decisions) are pruned to a bound.
 *
 * It is diff-based: it remembers what it last persisted and only writes the docs
 * that actually changed, plus deletes for entities that disappeared. Same-entity
 * concurrent writes are still last-writer-wins — Phase 3 wraps per-lead mutations
 * in transactions to close that gap.
 */

export interface StateStore {
  load(): Promise<AgentState | undefined>;
  save(state: AgentState): Promise<void>;
}

// Minimal structural subset of the firebase-admin Firestore API we depend on,
// so the store can be unit-tested against an in-memory fake.
export interface DocRefLike {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
}
export interface CollectionRefLike {
  get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }>;
  doc(id: string): DocRefLike;
}
export interface WriteBatchLike {
  set(ref: DocRefLike, data: Record<string, unknown>): void;
  delete(ref: DocRefLike): void;
  commit(): Promise<void>;
}
export interface FirestoreLike {
  collection(name: string): CollectionRefLike;
  batch(): WriteBatchLike;
}

type EntityArrayKey = 'leads' | 'messages' | 'tasks' | 'timeline' | 'decisions' | 'inboxes' | 'emailMessages';
type Entity = { id: string } & Record<string, unknown>;

// collection name → { sort field (newest first), optional cap for append-only logs }
const ENTITY_CONFIG: Record<EntityArrayKey, { sortBy: string; cap?: number }> = {
  leads: { sortBy: 'createdAt' },
  messages: { sortBy: 'createdAt' },
  tasks: { sortBy: 'createdAt' },
  timeline: { sortBy: 'createdAt', cap: 1000 },
  decisions: { sortBy: 'createdAt', cap: 1000 },
  inboxes: { sortBy: 'connectedAt' },
  emailMessages: { sortBy: 'receivedAt' },
};

const CONFIG_COLLECTION = 'config';
const CONFIG_DOC = 'global';
const MAX_BATCH_OPS = 400; // Firestore hard limit is 500; stay under it.

function sortNewestFirst(items: Entity[], sortBy: string): Entity[] {
  return [...items].sort((a, b) => String(b[sortBy] ?? '').localeCompare(String(a[sortBy] ?? '')));
}

export function createCollectionStore(db: FirestoreLike): StateStore {
  // What we last persisted, per collection: id → serialized doc. Lets us write
  // only changed docs. Populated on load() and updated on save().
  const lastSaved: Record<string, Map<string, string>> = {};
  let lastSavedConfig: string | undefined;

  function getCollections(): EntityArrayKey[] {
    return Object.keys(ENTITY_CONFIG) as EntityArrayKey[];
  }

  async function load(): Promise<AgentState | undefined> {
    const result: Partial<AgentState> = {};
    let foundAnything = false;

    for (const name of getCollections()) {
      const snap = await db.collection(name).get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Entity);
      if (items.length) foundAnything = true;
      const sorted = sortNewestFirst(items, ENTITY_CONFIG[name].sortBy);
      // Seed the diff map so the first save after a load doesn't rewrite everything.
      lastSaved[name] = new Map(sorted.map((it) => [it.id, JSON.stringify(it)]));
      (result as Record<string, unknown>)[name] = sorted;
    }

    const configSnap = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
    if (configSnap.exists) {
      foundAnything = true;
      const cfg = configSnap.data() as AgentState['config'];
      result.config = cfg;
      lastSavedConfig = JSON.stringify(cfg ?? null);
    }

    if (!foundAnything) return undefined;
    return result as AgentState;
  }

  async function save(state: AgentState): Promise<void> {
    const ops: Array<(batch: WriteBatchLike) => void> = [];

    for (const name of getCollections()) {
      const cfg = ENTITY_CONFIG[name];
      const all = ((state[name] ?? []) as Entity[]);
      const toPersist = cfg.cap ? sortNewestFirst(all, cfg.sortBy).slice(0, cfg.cap) : all;

      const nextMap = new Map<string, string>();
      for (const item of toPersist) nextMap.set(item.id, JSON.stringify(item));

      const prevMap = lastSaved[name] ?? new Map<string, string>();
      const coll = db.collection(name);

      // upserts: new or changed docs only
      for (const [id, serialized] of nextMap) {
        if (prevMap.get(id) !== serialized) {
          const data = JSON.parse(serialized) as Record<string, unknown>;
          ops.push((batch) => batch.set(coll.doc(id), data));
        }
      }
      // deletes: entities that were persisted before but are gone (or pruned) now
      for (const id of prevMap.keys()) {
        if (!nextMap.has(id)) ops.push((batch) => batch.delete(coll.doc(id)));
      }

      lastSaved[name] = nextMap;
    }

    const configSerialized = JSON.stringify(state.config ?? null);
    if (configSerialized !== lastSavedConfig) {
      const configRef = db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC);
      ops.push((batch) => batch.set(configRef, (state.config ?? {}) as Record<string, unknown>));
      lastSavedConfig = configSerialized;
    }

    // Commit in chunks to respect Firestore's per-batch op limit.
    for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
      const batch = db.batch();
      for (const apply of ops.slice(i, i + MAX_BATCH_OPS)) apply(batch);
      await batch.commit();
    }
  }

  return { load, save };
}

/**
 * One-time, lossless migration from the legacy single-document blob
 * (settings/state) into the per-entity collections. Reads the blob and, if
 * present, writes it through the collection store. The blob is left in place so
 * the switch stays reversible (set AGENT_STORE=blob to revert). Returns the
 * migrated state, or undefined if there was no blob to migrate.
 */
export async function migrateBlobToCollections(db: FirestoreLike, store: StateStore): Promise<AgentState | undefined> {
  const snap = await db.collection('settings').doc('state').get();
  if (!snap.exists) return undefined;
  const blob = snap.data() as AgentState | undefined;
  if (!blob) return undefined;
  await store.save(blob);
  return blob;
}
