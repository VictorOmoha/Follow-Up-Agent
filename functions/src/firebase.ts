import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { app, enginePromise, getEngineForScheduler } from './index.js';

// Configurable runtime parameters. OPENAI_API_KEY is stored in Secret Manager
// and explicitly bound to every function that can process inbound leads.
// The remaining values use the existing Firebase string-parameter setup.
defineString('GEMINI_API_KEY', { default: '' });
const openaiApiKey = defineSecret('OPENAI_API_KEY');
defineString('OPENAI_EXTRACTION_MODEL', { default: 'gpt-5.6-luna' });
defineString('TWILIO_ACCOUNT_SID', { default: '' });
defineString('TWILIO_AUTH_TOKEN', { default: '' });
defineString('TWILIO_PHONE_NUMBER', { default: '' });
defineString('TWILIO_WEBHOOK_URL', { default: '' });
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
    secrets: [openaiApiKey],
  },
  async (req, res) => {
    await enginePromise;
    await new Promise<void>((resolve, reject) => {
      res.once('finish', resolve);
      res.once('error', reject);
      app(req, res);
    });
    await getEngineForScheduler()?.flushPersistence();
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
    secrets: [openaiApiKey],
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
    await engine.flushPersistence();
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
    secrets: [openaiApiKey],
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
    await engine.flushPersistence();
    console.log('[SCHEDULED] Inbox sync result:', result);
  }
);