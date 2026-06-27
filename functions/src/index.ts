import express, { type Request, type Response } from 'express';
import { createEngineHandle, type EngineHandle } from './engine-handle.js';
import { buildGmailOAuthStartFromEnv } from './gmail-oauth.js';
import { loadStateFromFirestore, saveStateToFirestore } from './db.js';
import { toPublicAgentState, toPublicInbox } from './public-state.js';
import { extractLeadFromText } from './gemini.js';
import { checkAuth, checkWebhookAuth, warnIfInsecureAuthPosture } from './auth.js';
import { createRateLimiter } from './rate-limiter.js';
import { validateTwilioSignature } from './twilio.js';

// Load .env file programmatically (built-in Node 20.12+)
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // Ignore if .env doesn't exist
  }
}

const webhookLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 100 });

function getClientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded.length > 0) return forwarded[0].trim();
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

let engine: EngineHandle | undefined;
const enginePromise = initializeEngine();

async function initializeEngine() {
  warnIfInsecureAuthPosture();
  console.log('Loading state from Firestore...');
  const firestoreState = await loadStateFromFirestore();
  if (firestoreState) {
    console.log('Successfully loaded state from Firestore.');
  } else {
    console.log('No Firestore state found, starting fresh.');
  }

  const eng = await createEngineHandle({
    initialState: firestoreState ?? undefined,
    onChange: async (state) => {
      await saveStateToFirestore(state);
    },
  });

  // In production, inject secrets from env vars into the engine config
  const isProduction = !!(process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG);
  if (isProduction) {
    const state = eng.getState();
    if (state.config) {
      if (process.env.GEMINI_API_KEY) state.config.geminiApiKey = process.env.GEMINI_API_KEY;
      if (process.env.BOOKING_LINK || process.env.OWNER_BOOKING_LINK) {
        state.config.bookingLink = process.env.OWNER_BOOKING_LINK || process.env.BOOKING_LINK || state.config.bookingLink;
      }
    }
    await eng.reset(state);
  }

  // Ensure initial state is stored in Firestore if it was empty/new
  if (!firestoreState) {
    await saveStateToFirestore(eng.getState());
  }

  engine = eng;
  return eng;
}

function getEngine() {
  if (!engine) throw new Error('Engine not yet initialized');
  return engine;
}

export const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true })); // For Twilio webhook form posts

// CORS
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,AGENT_API_KEY,WEBHOOK_API_KEY');
  if (_req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  next();
});

// Auth middleware (skip for webhook endpoints and Twilio inbound)
const publicPaths = new Set(['/api/webhooks/lead', '/api/sms/inbound']);
app.use((req, res, next) => {
  if (publicPaths.has(req.path)) return next();

  const authResult = checkAuth({ headers: req.headers as Record<string, string | string[] | undefined>, url: req.url });
  if (!authResult.ok) {
    res.status(authResult.status || 401).json({ error: authResult.error });
    return;
  }

  const ip = getClientIp(req);
  const rateResult = apiLimiter.check(ip);
  if (!rateResult.ok) {
    res.status(429).set('Retry-After', String(Math.ceil(rateResult.retryAfterMs / 1000))).json({ error: 'Rate limit exceeded. Try again later.' });
    return;
  }
  next();
});

// ─── GET /api/state ──────────────────────────────────────────
app.get('/api/state', (_req, res) => {
  res.json(toPublicAgentState(getEngine().getState()));
});

// ─── Gmail OAuth Start ───────────────────────────────────────
app.get('/api/inboxes/gmail/start', (req, res) => {
  const emailParam = req.query.email as string | undefined;
  res.json(buildGmailOAuthStartFromEnv(process.env, emailParam));
});

// ─── Gmail Mock Auth (demo mode) ─────────────────────────────
app.get('/api/inboxes/gmail/mock-auth', (req, res) => {
  const email = (req.query.email as string) || '';
  const stateVal = (req.query.state as string) || '';
  res.type('html').send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mock Google Sign-In</title>
      <style>
        body { background-color: #030712; color: #f3f4f6; font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 32px; max-width: 400px; width: 100%; text-align: center; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        h1 { font-size: 1.5rem; margin-bottom: 8px; background: linear-gradient(135deg, #4ade80, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p { color: #94a3b8; font-size: 0.875rem; line-height: 1.5; margin-bottom: 24px; }
        .email-badge { display: inline-block; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2); color: #60a5fa; padding: 6px 12px; border-radius: 20px; font-size: 0.85rem; margin-bottom: 24px; font-weight: 500; }
        .scopes { text-align: left; background: rgba(0, 0, 0, 0.2); padding: 16px; border-radius: 8px; margin-bottom: 24px; border: 1px solid rgba(255, 255, 255, 0.05); }
        .scopes-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 8px; font-weight: 700; }
        .scope-item { font-size: 0.8rem; margin: 4px 0; color: #cbd5e1; display: flex; align-items: center; }
        .scope-item::before { content: "✓"; color: #4ade80; margin-right: 8px; font-weight: bold; }
        .buttons { display: flex; gap: 12px; }
        button, a.btn { flex: 1; padding: 10px 16px; border-radius: 6px; font-size: 0.875rem; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; transition: all 0.2s; }
        .btn-primary { background: #4ade80; color: #030712; border: none; }
        .btn-primary:hover { background: #22c55e; }
        .btn-secondary { background: transparent; color: #94a3b8; border: 1px solid rgba(255, 255, 255, 0.1); }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.05); color: #f3f4f6; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Mock Google Sign-In</h1>
        <p>Omoha Follow-Up Agent is requesting permission to access your Google Account:</p>
        <div class="email-badge">${email || 'unknown@example.com'}</div>
        <div class="scopes">
          <div class="scopes-title">Requested Permissions</div>
          <div class="scope-item">View your email messages (gmail.readonly)</div>
          <div class="scope-item">Send email on your behalf (gmail.send)</div>
          <div class="scope-item">Manage your mail metadata (gmail.modify)</div>
        </div>
        <div class="buttons">
          <a class="btn btn-secondary" href="/#cancelled">Cancel</a>
          <a class="btn btn-primary" href="/api/inboxes/gmail/callback?code=mock_code_${encodeURIComponent(email)}&state=${encodeURIComponent(stateVal)}">Grant Access</a>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ─── Gmail OAuth Callback ────────────────────────────────────
app.get('/api/inboxes/gmail/callback', async (req, res) => {
  const code = (req.query.code as string) || '';
  let email = '';
  let accessToken = 'mock_access_token';
  let refreshToken = 'mock_refresh_token';
  let expiresAt = Date.now() + 3600 * 1000;

  if (code.startsWith('mock_code_')) {
    email = decodeURIComponent(code.substring('mock_code_'.length));
  } else {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET is missing');

    const redirectUri = process.env.GMAIL_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/inboxes/gmail/callback`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      throw new Error(`Failed to exchange OAuth code: ${errBody}`);
    }

    const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in: number };
    accessToken = tokens.access_token;
    if (tokens.refresh_token) refreshToken = tokens.refresh_token;
    expiresAt = Date.now() + tokens.expires_in * 1000;

    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileRes.ok) throw new Error(`Failed to fetch Google user profile: ${await profileRes.text()}`);
    const profile = await profileRes.json() as { emailAddress: string };
    email = profile.emailAddress;
  }

  await getEngine().connectEmailInbox({ provider: 'gmail', email, credentials: { accessToken, refreshToken, expiresAt } });

  const referer = req.headers.referer;
  const redirectUrl = (referer && !referer.includes('/api/inboxes/gmail/mock-auth')) ? referer : '/';
  res.redirect(302, redirectUrl);
});

// ─── POST /api/leads ─────────────────────────────────────────
app.post('/api/leads', async (req, res) => {
  const run = await getEngine().createLead(req.body);
  res.status(201).json(run);
});

// ─── POST /api/webhooks/lead (CRM webhook intake) ────────────
app.post('/api/webhooks/lead', async (req, res) => {
  // Webhook-specific auth
  const webhookAuthResult = checkWebhookAuth({ headers: req.headers as Record<string, string | string[] | undefined>, url: req.url });
  if (!webhookAuthResult.ok) {
    res.status(webhookAuthResult.status || 401).json({ error: webhookAuthResult.error });
    return;
  }
  const ip = getClientIp(req);
  const rateResult = webhookLimiter.check(ip);
  if (!rateResult.ok) {
    res.status(429).json({ error: 'Webhook rate limit exceeded. Try again later.' });
    return;
  }

  interface WebhookPayload {
    name?: string; fullName?: string; firstName?: string; lastName?: string;
    company?: string; org?: string; organization?: string;
    service?: string; requestedService?: string; interest?: string;
    budget?: string | number; budgetAmount?: string | number; value?: string | number;
    urgency?: string; timeframe?: string; timeline?: string;
    pain?: string; description?: string; message?: string; notes?: string;
    channel?: string; preferredChannel?: string;
    contact?: string; email?: string; phone?: string;
  }

  const rawBody = req.body;
  let bodyText: string;
  let subjectHint: string | undefined = 'CRM Webhook Intake';

  if (typeof rawBody === 'object' && rawBody !== null) {
    const obj = rawBody as Record<string, unknown>;
    const hasStandardFields = ['name', 'fullName', 'firstName', 'company', 'org', 'organization',
      'service', 'requestedService', 'interest', 'budget', 'budgetAmount', 'value',
      'urgency', 'timeframe', 'timeline', 'channel', 'preferredChannel', 'contact', 'email', 'phone'].some(key => {
      const v = obj[key];
      return v !== undefined && v !== null && String(v).trim();
    });
    if (!hasStandardFields) {
      bodyText = String(obj.message || obj.body || obj.text || obj.content || obj.description || JSON.stringify(rawBody, null, 2));
    } else {
      bodyText = JSON.stringify(rawBody, null, 2);
    }
  } else {
    bodyText = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody, null, 2);
  }

  const stateBefore = getEngine().getState();
  const apiKey = stateBefore.config?.geminiApiKey;
  const leadInput = await extractLeadFromText(bodyText, subjectHint, undefined, apiKey);

  // Map common CRM keys from JSON
  if (typeof rawBody === 'object' && rawBody !== null) {
    const body = rawBody as WebhookPayload;
    if (leadInput.name === 'Unknown Lead') {
      leadInput.name = body.name || body.fullName || [body.firstName, body.lastName].filter(Boolean).join(' ') || leadInput.name;
    }
    if (leadInput.company === 'Self-Employed' || leadInput.company === 'Unknown') {
      leadInput.company = body.company || body.org || body.organization || leadInput.company;
    }
    if (leadInput.service === 'General Inquiry' || leadInput.service === 'CRM Webhook Intake') {
      leadInput.service = body.service || body.requestedService || body.interest || leadInput.service;
    }
    if (leadInput.budget === 'unknown') {
      leadInput.budget = String(body.budget || body.budgetAmount || body.value || leadInput.budget);
    }
    if (leadInput.urgency === 'unknown') {
      leadInput.urgency = body.urgency || body.timeframe || body.timeline || leadInput.urgency;
    }
    if (leadInput.pain === 'No pain described' || leadInput.pain === 'CRM Webhook Intake') {
      leadInput.pain = body.pain || body.description || body.message || body.notes || leadInput.pain;
    }
    if (leadInput.contact === 'none') {
      leadInput.contact = body.contact || body.email || body.phone || leadInput.contact;
    }
    if (leadInput.channel === 'Email') {
      const rawChannel = String(body.channel || body.preferredChannel || '').toUpperCase();
      if (rawChannel === 'SMS') leadInput.channel = 'SMS';
      else if (rawChannel === 'CALL') leadInput.channel = 'Call';
      else if (rawChannel === 'EMAIL') leadInput.channel = 'Email';
    }
  }

  const run = await getEngine().createLead(leadInput);

  // Add webhook-specific timeline event
  const state = getEngine().getState();
  const lead = state.leads.find((l) => l.id === run.lead.id);
  if (lead) {
    state.timeline.unshift({
      id: `event_webhook_${Date.now()}`,
      leadId: lead.id,
      label: 'CRM Webhook intake',
      detail: `Lead push ingested. Mapped using ${apiKey ? 'Gemini GenAI Extraction' : 'CRM Rule Mapper'}.`,
      createdAt: new Date().toISOString(),
    });
    await getEngine().reset(state);
  }

  res.status(201).json(run);
});

// ─── POST /api/inboxes ───────────────────────────────────────
app.post('/api/inboxes', async (req, res) => {
  const inbox = await getEngine().connectEmailInbox(req.body);
  res.status(201).json(toPublicInbox(inbox));
});

// ─── POST /api/inboxes/:inboxId/sync ─────────────────────────
app.post('/api/inboxes/:inboxId/sync', async (req, res) => {
  const result = await getEngine().syncEmailInbox(req.params.inboxId);
  res.json({ ...result, inbox: toPublicInbox(result.inbox) });
});

// ─── POST /api/messages/:messageId/approve ───────────────────
app.post('/api/messages/:messageId/approve', async (req, res) => {
  const message = await getEngine().approveMessage(req.params.messageId);
  res.json(message);
});

// ─── POST /api/leads/:leadId/replies ─────────────────────────
app.post('/api/leads/:leadId/replies', async (req, res) => {
  const body = req.body as { body?: string };
  const message = await getEngine().recordReply(req.params.leadId, body.body || '');
  res.status(201).json(message);
});

// ─── POST /api/leads/:leadId/delete ──────────────────────────
app.post('/api/leads/:leadId/delete', async (req, res) => {
  const result = await getEngine().deleteLead(req.params.leadId);
  res.json(result);
});

// ─── POST /api/worker/run ────────────────────────────────────
app.post('/api/worker/run', async (req, res) => {
  const body = req.body as { force?: boolean };
  const result = await getEngine().runDueTasks({ force: Boolean(body.force) });
  res.json(result);
});

// ─── POST /api/agent/cycle ───────────────────────────────────
app.post('/api/agent/cycle', async (req, res) => {
  const result = await getEngine().runAutonomousCycle();
  res.json(result);
});

// ─── POST /api/config ────────────────────────────────────────
// In production, geminiApiKey is read from env (Firebase Secrets) and
// cannot be set via the API. In dev mode, it can be set via the UI.
app.post('/api/config', async (req, res) => {
  const body = req.body as { bookingLink?: string; autopilotEnabled?: boolean; geminiApiKey?: string };
  const isProduction = !!(process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG);

  if (isProduction && body.geminiApiKey !== undefined) {
    res.status(400).json({ error: 'Gemini API key must be set via environment variable in production. Use Firebase Secrets.' });
    return;
  }

  const state = getEngine().getState();
  if (state.config) {
    if (body.bookingLink !== undefined) state.config.bookingLink = body.bookingLink;
    if (body.autopilotEnabled !== undefined) state.config.autopilotEnabled = body.autopilotEnabled;
    if (!isProduction && body.geminiApiKey !== undefined) state.config.geminiApiKey = body.geminiApiKey;
  } else {
    state.config = {
      bookingLink: body.bookingLink || process.env.BOOKING_LINK || process.env.OWNER_BOOKING_LINK || 'https://calendar.google.com/calendar/appointments/schedules/demo',
      autopilotEnabled: body.autopilotEnabled ?? false,
      geminiApiKey: !isProduction ? (body.geminiApiKey || '') : undefined,
    };
  }
  await getEngine().reset(state);
  res.json(toPublicAgentState(getEngine().getState()));
});

// ─── POST /api/reset ─────────────────────────────────────────
app.post('/api/reset', async (_req, res) => {
  await getEngine().reset();
  res.json(toPublicAgentState(getEngine().getState()));
});

// ─── Twilio Inbound SMS Webhook ──────────────────────────────
// Twilio posts form-urlencoded data when an SMS is received.
// We match the sender's phone to an existing lead and record the reply.
app.post('/api/sms/inbound', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    // Verify the request genuinely came from Twilio. Enforced whenever an auth
    // token is configured; in production without one, the signature can't be
    // checked, so we warn loudly rather than silently trusting any caller.
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (authToken) {
      const signature = (req.header('X-Twilio-Signature') as string) || '';
      const url = process.env.TWILIO_WEBHOOK_URL
        || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}${req.originalUrl}`;
      if (!validateTwilioSignature({ signature, url, params: req.body, authToken })) {
        console.warn('[TWILIO INBOUND] Rejected request with invalid X-Twilio-Signature.');
        res.status(403).type('text/xml').send('<Response></Response>');
        return;
      }
    } else if (process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG) {
      console.warn('[TWILIO INBOUND] TWILIO_AUTH_TOKEN not set — inbound SMS signature cannot be verified.');
    }

    const from = (req.body.From as string) || '';
    const body = (req.body.Body as string) || '';

    if (!from || !body) {
      res.status(400).type('text/xml').send('<Response></Response>');
      return;
    }

    console.log(`[TWILIO INBOUND] SMS from ${from}: ${body}`);

    // Find the most recent lead with this phone number as contact
    const state = getEngine().getState();
    const normalizedFrom = from.replace(/\D/g, '');
    const lead = state.leads.find((l) => {
      const normalizedContact = (l.contact || '').replace(/\D/g, '');
      return normalizedContact && normalizedContact === normalizedFrom;
    });

    if (!lead) {
      // No matching lead - create a new one from the inbound SMS
      console.log(`[TWILIO INBOUND] No matching lead for ${from}, creating new lead from SMS.`);
      const leadInput = await extractLeadFromText(body, 'Inbound SMS', from);
      leadInput.channel = 'SMS';
      leadInput.contact = from;
      await getEngine().createLead(leadInput);
    } else {
      // Record the reply on the existing lead
      await getEngine().recordReply(lead.id, body);
    }

    // Respond with empty TwiML so Twilio doesn't retry
    res.type('text/xml').send('<Response></Response>');
  } catch (error) {
    console.error('[TWILIO INBOUND] Error processing inbound SMS:', error);
    res.type('text/xml').send('<Response></Response>');
  }
});

// ─── Error handler ───────────────────────────────────────────
app.use((err: any, _req: Request, res: Response, _next: express.NextFunction) => {
  const statusCode = err?.statusCode || 500;
  res.status(statusCode).json({ error: err instanceof Error ? err.message : 'Unknown server error' });
});

// NOTE: This module is the Cloud Function codebase — it must NOT start its own
// HTTP listener. (Doing so crashed `firebase deploy` source analysis with
// EADDRINUSE.) Local development is served by server/index.ts instead.

export function getEngineForScheduler() {
  return engine;
}

export { enginePromise };