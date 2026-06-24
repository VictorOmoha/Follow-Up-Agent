import { type AgentState } from './agent-engine.js';

type FirestoreStateDoc = {
  get: () => Promise<{ exists: boolean; data: () => unknown }>;
  set: (state: AgentState) => Promise<unknown>;
};

let stateDocPromise: Promise<FirestoreStateDoc | undefined> | undefined;

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

async function getStateDoc(): Promise<FirestoreStateDoc | undefined> {
  if (!isFirestoreEnabled()) {
    return undefined;
  }

  stateDocPromise ??= (async () => {
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
    return db.collection('settings').doc('state') as unknown as FirestoreStateDoc;
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