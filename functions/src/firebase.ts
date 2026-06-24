import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineString } from 'firebase-functions/params';
import { app, enginePromise, getEngineForScheduler } from './index.js';

// Define configurable environment parameters
const geminiApiKey = defineString('GEMINI_API_KEY', { default: '' });
const twilioAccountSid = defineString('TWILIO_ACCOUNT_SID', { default: '' });
const twilioAuthToken = defineString('TWILIO_AUTH_TOKEN', { default: '' });
const twilioPhoneNumber = defineString('TWILIO_PHONE_NUMBER', { default: '' });
const gmailClientId = defineString('GMAIL_CLIENT_ID', { default: '' });
const gmailClientSecret = defineString('GMAIL_CLIENT_SECRET', { default: '' });
const gmailRedirectUri = defineString('GMAIL_REDIRECT_URI', { default: '' });
const agentApiKey = defineString('AGENT_API_KEY', { default: '' });
const webhookApiKey = defineString('WEBHOOK_API_KEY', { default: '' });
const bookingLink = defineString('BOOKING_LINK', { default: '' });
const ownerBookingLink = defineString('OWNER_BOOKING_LINK', { default: '' });

const allSecrets = [geminiApiKey, twilioAccountSid, twilioAuthToken, twilioPhoneNumber,
  gmailClientId, gmailClientSecret, gmailRedirectUri,
  agentApiKey, webhookApiKey, bookingLink, ownerBookingLink];

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
    secrets: allSecrets,
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
    secrets: allSecrets,
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
    secrets: allSecrets,
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