import { type AgentState } from './agent-engine';

type FirestoreStateDoc = {
  get: () => Promise<{ exists: boolean; data: () => unknown }>;
  set: (state: AgentState) => Promise<void>;
};

let stateDocPromise: Promise<FirestoreStateDoc | undefined> | undefined;

function isFirestoreEnabled() {
  return process.env.AGENT_PERSISTENCE === 'firestore' || process.env.AGENT_STATE_BACKEND === 'firestore';
}

async function getStateDoc(): Promise<FirestoreStateDoc | undefined> {
  if (!isFirestoreEnabled()) {
    return undefined;
  }

  stateDocPromise ??= (async () => {
    const [{ initializeApp, getApps }, { getFirestore }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/firestore'),
    ]);

    if (!getApps().length) {
      initializeApp({
        projectId: process.env.GCLOUD_PROJECT || 'omoha-followup-agent-mvp',
      });
    }

    const db = getFirestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db.collection('settings').doc('state') as FirestoreStateDoc;
  })();

  return stateDocPromise;
}

export async function loadStateFromFirestore(): Promise<AgentState | undefined> {
  const stateDoc = await getStateDoc();
  if (!stateDoc) return undefined;

  try {
    const doc = await stateDoc.get();
    if (!doc.exists) {
      return undefined;
    }
    return doc.data() as AgentState;
  } catch (error) {
    console.error('Failed to load state from Firestore:', error);
    return undefined;
  }
}

export async function saveStateToFirestore(state: AgentState): Promise<void> {
  const stateDoc = await getStateDoc();
  if (!stateDoc) return;

  try {
    await stateDoc.set(state);
  } catch (error) {
    console.error('Failed to save state to Firestore:', error);
  }
}
