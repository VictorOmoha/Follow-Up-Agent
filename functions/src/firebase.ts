import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineString } from 'firebase-functions/params';
import { app, enginePromise, getEngineForScheduler } from './index.js';

// Configurable environment parameters. Values come from
// functions/.env.<project> at deploy time and are written to the function's
// runtime environment by the Firebase CLI. These are string params, NOT
// Secret Manager secrets — do not pass them via the `secrets:` option, which
// would force the Secret Manager API onto the project.
defineString('GEMINI_API_KEY', { default: '' });
defineString('TWILIO_ACCOUNT_SID', { default: '' });
defineString('TWILIO_AUTH_TOKEN', { default: '' });
defineString('TWILIO_PHONE_NUMBER', { default: '' });
defineString('GMAIL_CLIENT_ID', { default: '' });
defineString('GMAIL_CLIENT_SECRET', { default: '' });
defineString('GMAIL_REDIRECT_URI', { default: '' });
defineString('AGENT_API_KEY', { default: '' });
defineString('WEBHOOK_API_KEY', { default: '' });
defineString('BOOKING_LINK', { default: '' });
defineString('OWNER_BOOKING_LINK', { default: '' });

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
    return app(req, res);
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