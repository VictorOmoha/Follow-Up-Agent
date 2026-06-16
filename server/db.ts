import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { type AgentState } from './agent-engine';

if (!getApps().length) {
  initializeApp({
    projectId: process.env.GCLOUD_PROJECT || 'omoha-followup-agent-mvp',
  });
}

const db = getFirestore();
const stateDoc = db.collection('settings').doc('state');

export async function loadStateFromFirestore(): Promise<AgentState | undefined> {
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
  try {
    await stateDoc.set(state);
  } catch (error) {
    console.error('Failed to save state to Firestore:', error);
  }
}
