import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { app, enginePromise, getEngineForScheduler } from './index.js';

// Configuration (GEMINI_API_KEY, TWILIO_*, GMAIL_*, BOOKING_LINK, etc.) is
// loaded automatically by the Firebase CLI from functions/.env.<projectId> and
// injected as environment variables — the code reads them via process.env.
// We intentionally do NOT declare them under the `secrets:` option: they are
// plain env params, and binding them as Secret Manager secrets would require the
// Secret Manager API plus secret-create permissions. For stronger protection,
// migrate the truly sensitive ones (Twilio auth token, Gmail secret) to
// defineSecret()/Secret Manager once the deploy identity has those roles.

// ─── API Cloud Function ──────────────────────────────────────
// Serves the entire Express app as a single Cloud Function.
// Frontend Hosting rewrites /api/* to this function.
export const api = onRequest(
  {
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 60,
    minInstances: 0,
    maxInstances: 10,
  },
  async (req, res) => {
    await enginePromise;
    return app(req as any, res as any);
  }
);

// ─── Scheduled Task Worker ───────────────────────────────────
// Runs every 5 minutes to process due follow-up tasks.
// This replaces the old setInterval(15s) from the local dev server.
export const runDueTasks = onSchedule(
  {
    schedule: 'every 5 minutes',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 120,
  },
  async () => {
    await enginePromise;
    const engine = getEngineForScheduler();
    if (!engine) {
      console.error('[SCHEDULED] Engine not initialized');
      return;
    }
    console.log('[SCHEDULED] Running due tasks...');
    const result = await engine.runDueTasks({ force: false });
    console.log('[SCHEDULED] Due tasks result:', result);
  }
);

// ─── Scheduled Inbox Sync ────────────────────────────────────
// Runs every 10 minutes to poll Gmail for new replies.
export const syncInboxes = onSchedule(
  {
    schedule: 'every 10 minutes',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 120,
  },
  async () => {
    await enginePromise;
    const engine = getEngineForScheduler();
    if (!engine) {
      console.error('[SCHEDULED] Engine not initialized');
      return;
    }
    console.log('[SCHEDULED] Syncing inboxes...');
    const result = await engine.runAutonomousCycle();
    console.log('[SCHEDULED] Inbox sync result:', result);
  }
);
