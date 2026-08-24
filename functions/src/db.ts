import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { type AgentState } from './agent-engine.js';

const SCHEMA_VERSION = 2;
const METADATA_COLLECTION = 'stateMetadata';
const SNAPSHOT_COLLECTION = 'stateSnapshots';
const LEGACY_STATE_PATH = ['settings', 'state'] as const;

export const ENTITY_COLLECTIONS = [
  'leads',
  'messages',
  'tasks',
  'timeline',
  'decisions',
  'inboxes',
  'emailMessages',
  'retentionOutcomes',
] as const;

type EntityCollectionName = typeof ENTITY_COLLECTIONS[number];
type EntityRecord = { id: string } & Record<string, unknown>;

export type EntityStateSnapshot = {
  config?: AgentState['config'];
} & Record<EntityCollectionName, EntityRecord[]>;

type StateMetadata = {
  schemaVersion: number;
  revision: number;
  activeGeneration: string;
  previousGeneration?: string;
  updatedAt: string;
  counts: Record<EntityCollectionName, number>;
};

export class StateRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`State revision conflict: expected ${expected}, found ${actual}. Reload before retrying.`);
    this.name = 'StateRevisionConflictError';
  }
}

let firestorePromise: Promise<Firestore | undefined> | undefined;
let loadedRevision = 0;

function isFirestoreEnabled() {
  if (process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG) return true;
  return process.env.AGENT_PERSISTENCE === 'firestore' ||
    process.env.AGENT_STATE_BACKEND === 'firestore' ||
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

async function getFirestore(): Promise<Firestore | undefined> {
  if (!isFirestoreEnabled()) return undefined;

  firestorePromise ??= (async () => {
    const [{ initializeApp, getApps, cert }, { getFirestore: createFirestore }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);

    if (!getApps().length) {
      const projectId = process.env.GCLOUD_PROJECT || process.env.FIRESTORE_PROJECT_ID || 'omoha-followup-agent-mvp';
      const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (credentialsPath) {
        const { readFileSync } = await import('node:fs');
        const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
        initializeApp({ credential: cert(credentials), projectId });
      } else {
        initializeApp({ projectId });
      }
    }

    const db = createFirestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db;
  })();

  return firestorePromise;
}

export function stateToEntitySnapshot(state: AgentState): EntityStateSnapshot {
  return {
    config: state.config,
    leads: state.leads as EntityRecord[],
    messages: state.messages as EntityRecord[],
    tasks: state.tasks as EntityRecord[],
    timeline: state.timeline as EntityRecord[],
    decisions: state.decisions as EntityRecord[],
    inboxes: state.inboxes as EntityRecord[],
    emailMessages: state.emailMessages as EntityRecord[],
    retentionOutcomes: (state.retentionOutcomes ?? []) as EntityRecord[],
  };
}

export function entitySnapshotToState(snapshot: EntityStateSnapshot): AgentState {
  return {
    leads: snapshot.leads as AgentState['leads'],
    messages: snapshot.messages as AgentState['messages'],
    tasks: snapshot.tasks as AgentState['tasks'],
    timeline: snapshot.timeline as AgentState['timeline'],
    decisions: snapshot.decisions as AgentState['decisions'],
    inboxes: snapshot.inboxes as AgentState['inboxes'],
    emailMessages: snapshot.emailMessages as AgentState['emailMessages'],
    retentionOutcomes: snapshot.retentionOutcomes as NonNullable<AgentState['retentionOutcomes']>,
    config: snapshot.config,
  };
}

function collectionCounts(snapshot: EntityStateSnapshot): Record<EntityCollectionName, number> {
  return Object.fromEntries(
    ENTITY_COLLECTIONS.map((name) => [name, snapshot[name].length]),
  ) as Record<EntityCollectionName, number>;
}

async function loadGeneration(
  db: Firestore,
  generation: string,
  expectedCounts: Record<EntityCollectionName, number>,
): Promise<AgentState> {
  const root = db.collection(SNAPSHOT_COLLECTION).doc(generation);
  const [manifestDoc, configDoc, ...collectionSnapshots] = await Promise.all([
    root.collection('manifest').doc('current').get(),
    root.collection('config').doc('global').get(),
    ...ENTITY_COLLECTIONS.map((name) => root.collection(name).get()),
  ]);

  if (!manifestDoc.exists || manifestDoc.data()?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`State generation ${generation} has a missing or unsupported manifest.`);
  }

  const snapshot = { config: configDoc.exists ? configDoc.data() as AgentState['config'] : undefined } as EntityStateSnapshot;
  ENTITY_COLLECTIONS.forEach((name, index) => {
    const documents = collectionSnapshots[index].docs;
    if (documents.length !== expectedCounts[name]) {
      throw new Error(`State generation ${generation} has ${documents.length} ${name} records; expected ${expectedCounts[name]}.`);
    }
    snapshot[name] = documents.map((doc) => {
      const record = doc.data() as EntityRecord;
      if (record.id !== doc.id) throw new Error(`State generation ${generation} has an invalid ${name}/${doc.id} record ID.`);
      return record;
    });
  });
  return entitySnapshotToState(snapshot);
}

async function loadLegacyState(db: Firestore): Promise<AgentState | undefined> {
  const legacy = await db.collection(LEGACY_STATE_PATH[0]).doc(LEGACY_STATE_PATH[1]).get();
  return legacy.exists ? legacy.data() as AgentState : undefined;
}

export async function loadStateFromFirestore(): Promise<AgentState | undefined> {
  const db = await getFirestore();
  if (!db) return undefined;

  try {
    const metadataDoc = await db.collection(METADATA_COLLECTION).doc('default').get();
    const metadata = metadataDoc.exists ? metadataDoc.data() as StateMetadata : undefined;
    if (metadata) {
      if (metadata.schemaVersion !== SCHEMA_VERSION || !metadata.activeGeneration || !metadata.counts) {
        throw new Error(`Unsupported or invalid Firestore state metadata (schema ${String(metadata.schemaVersion)}).`);
      }
      loadedRevision = metadata.revision;
      return await loadGeneration(db, metadata.activeGeneration, metadata.counts);
    }

    loadedRevision = 0;
    return await loadLegacyState(db);
  } catch (error) {
    console.error('Failed to load state from Firestore:', error);
    throw error;
  }
}

async function writeGeneration(db: Firestore, generation: string, state: AgentState) {
  const root = db.collection(SNAPSHOT_COLLECTION).doc(generation);
  const snapshot = stateToEntitySnapshot(state);
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [
    { path: 'manifest/current', data: { schemaVersion: SCHEMA_VERSION, createdAt: new Date().toISOString() } },
  ];

  if (snapshot.config) writes.push({ path: 'config/global', data: snapshot.config as Record<string, unknown> });
  for (const name of ENTITY_COLLECTIONS) {
    for (const record of snapshot[name]) writes.push({ path: `${name}/${record.id}`, data: record });
  }

  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = db.batch();
    for (const write of writes.slice(offset, offset + 400)) {
      const [collectionName, documentId] = write.path.split('/');
      batch.set(root.collection(collectionName).doc(documentId), write.data);
    }
    await batch.commit();
  }
}

async function deleteGeneration(db: Firestore, generation: string | undefined) {
  if (!generation) return;
  try {
    await db.recursiveDelete(db.collection(SNAPSHOT_COLLECTION).doc(generation));
  } catch (error) {
    console.warn(`Could not remove stale state generation ${generation}:`, error);
  }
}

export async function saveStateToFirestore(state: AgentState): Promise<void> {
  const db = await getFirestore();
  if (!db) return;

  const metadataRef = db.collection(METADATA_COLLECTION).doc('default');
  const generation = `state-${Date.now()}-${randomUUID()}`;
  const nextRevision = loadedRevision + 1;

  try {
    await writeGeneration(db, generation, state);
    let staleGeneration: string | undefined;
    await db.runTransaction(async (transaction) => {
      const currentDoc = await transaction.get(metadataRef);
      const current = currentDoc.exists ? currentDoc.data() as StateMetadata : undefined;
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== loadedRevision) throw new StateRevisionConflictError(loadedRevision, actualRevision);

      staleGeneration = current?.previousGeneration;
      const snapshot = stateToEntitySnapshot(state);
      transaction.set(metadataRef, {
        schemaVersion: SCHEMA_VERSION,
        revision: nextRevision,
        activeGeneration: generation,
        previousGeneration: current?.activeGeneration,
        updatedAt: new Date().toISOString(),
        counts: collectionCounts(snapshot),
      } satisfies StateMetadata);
    });

    loadedRevision = nextRevision;
    await deleteGeneration(db, staleGeneration);
  } catch (error) {
    await deleteGeneration(db, generation);
    console.error('Failed to save entity state to Firestore:', error);
    throw error;
  }
}
