import { type AgentState } from './agent-engine.js';
import { createCollectionStore, migrateBlobToCollections, type FirestoreLike, type StateStore } from './store/firestore-store.js';
import { createDistributedLock, type DistributedLock, type LockFirestore } from './store/distributed-lock.js';

/**
 * Firestore is always enabled in production (Cloud Functions).
 * In local dev, it's enabled when AGENT_PERSISTENCE=firestore or
 * AGENT_STATE_BACKEND=firestore is set, or when GOOGLE_APPLICATION_CREDENTIALS
 * is present.
 */
function isFirestoreEnabled() {
  if (process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG) return true;
  return process.env.AGENT_PERSISTENCE === 'firestore' ||
    process.env.AGENT_STATE_BACKEND === 'firestore' ||
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

/**
 * Persistence layout. Default `blob` keeps the legacy single-document behavior
 * (settings/state). `collections` uses one document per entity, which removes
 * the 1 MB-per-document cap and stops disjoint concurrent writes from clobbering
 * each other. See docs/persistence-refactor.md.
 */
function storeMode(): 'blob' | 'collections' {
  return process.env.AGENT_STORE?.toLowerCase() === 'collections' ? 'collections' : 'blob';
}

// Superset of FirestoreLike that also exposes the doc-level get/set used by the
// legacy blob store. Structurally assignable to FirestoreLike, so it can be
// passed straight to createCollectionStore.
interface FirestoreDb extends FirestoreLike {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
      set(data: unknown): Promise<unknown>;
    };
    get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }>;
  };
}

let dbPromise: Promise<FirestoreDb | undefined> | undefined;

async function getDb(): Promise<FirestoreDb | undefined> {
  if (!isFirestoreEnabled()) return undefined;

  dbPromise ??= (async () => {
    const [{ initializeApp, getApps, cert }, { getFirestore }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);

    if (!getApps().length) {
      const projectId = process.env.GCLOUD_PROJECT || process.env.FIRESTORE_PROJECT_ID || 'omoha-followup-agent-mvp';
      const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

      if (credentialsPath) {
        // Local dev with an explicit service account key file. Read + parse the
        // JSON directly (a dynamic `import()` of an absolute JSON path requires an
        // import attribute on newer Node and is not portable).
        const { readFileSync } = await import('node:fs');
        const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
        initializeApp({ credential: cert(credentials), projectId });
      } else {
        // Cloud Functions - ADC is automatic
        initializeApp({ projectId });
      }
    }

    const db = getFirestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db as unknown as FirestoreDb;
  })();

  return dbPromise;
}

// ─── Legacy single-document store ────────────────────────────
function createBlobStore(db: FirestoreDb): StateStore {
  const stateDoc = db.collection('settings').doc('state');
  return {
    async load() {
      const doc = await stateDoc.get();
      if (!doc.exists) return undefined;
      return doc.data() as AgentState;
    },
    async save(state: AgentState) {
      await stateDoc.set(state);
    },
  };
}

let storePromise: Promise<StateStore | undefined> | undefined;

async function getStore(): Promise<StateStore | undefined> {
  storePromise ??= (async () => {
    const db = await getDb();
    if (!db) return undefined;
    return storeMode() === 'collections' ? createCollectionStore(db) : createBlobStore(db);
  })();
  return storePromise;
}

export async function loadStateFromFirestore(): Promise<AgentState | undefined> {
  const store = await getStore();
  if (!store) return undefined;
  try {
    const loaded = await store.load();
    if (loaded) return loaded;

    // First boot in collections mode with no collections yet: migrate the legacy
    // blob (if any) so switching AGENT_STORE=collections never loses data.
    if (storeMode() === 'collections') {
      const db = await getDb();
      if (db) {
        const migrated = await migrateBlobToCollections(db, store);
        if (migrated) {
          console.log('[DB] Migrated legacy blob state into per-entity collections.');
          return migrated;
        }
      }
    }
    return undefined;
  } catch (error) {
    console.error('Failed to load state from Firestore:', error);
    return undefined;
  }
}

export async function saveStateToFirestore(state: AgentState): Promise<void> {
  const store = await getStore();
  if (!store) return;
  try {
    await store.save(state);
  } catch (error) {
    console.error('Failed to save state to Firestore:', error);
  }
}

/**
 * A cross-instance lock for serializing engine mutations, enabled only in
 * collections mode with Firestore available (the production multi-instance
 * scenario). Returns undefined otherwise, so the in-memory / blob path keeps its
 * existing single-instance behavior. See store/distributed-lock.ts.
 */
export async function createEngineLockIfEnabled(): Promise<DistributedLock | undefined> {
  if (storeMode() !== 'collections') return undefined;
  const db = await getDb();
  if (!db) return undefined;
  return createDistributedLock(db as unknown as LockFirestore);
}
