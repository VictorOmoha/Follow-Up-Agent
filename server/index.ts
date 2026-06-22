import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AgentState } from './agent-engine';
import { createEngineHandle } from './engine-handle';
import { buildGmailOAuthStartFromEnv } from './gmail-oauth';
import { loadStateFromFirestore, saveStateToFirestore } from './db';
import { toPublicAgentState, toPublicInbox } from './public-state';
import { extractLeadFromText } from './gemini';
import { checkAuth, checkWebhookAuth, isAuthEnabled } from './auth';
import { createRateLimiter } from './rate-limiter';

// Load .env file programmatically (built-in Node 20.12+)
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // Ignore if .env doesn't exist
  }
}

const PORT = Number(process.env.AGENT_API_PORT || 8787);
const STATE_PATH = resolve(process.cwd(), 'data', 'agent-state.json');

const webhookLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 100 });

function getClientIp(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return request.socket.remoteAddress || 'unknown';
}

function readState(): AgentState | undefined {
  if (!existsSync(STATE_PATH)) return undefined;
  return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as AgentState;
}

function writeState(state: AgentState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  response.end(JSON.stringify(body));
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function match(pathname: string, pattern: RegExp) {
  return pathname.match(pattern);
}

async function start() {
  console.log('Loading state from Firestore...');
  const firestoreState = await loadStateFromFirestore();
  if (firestoreState) {
    console.log('Successfully loaded state from Firestore.');
  } else {
    console.log('No Firestore state found, checking local backup...');
  }
  
  const initialState = firestoreState || readState();
  
  const engine = await createEngineHandle({
    initialState,
    onChange: async (state) => {
      await saveStateToFirestore(state);
      writeState(state);
    },
  });

  // Ensure initial state is stored in Firestore if it was empty/new
  if (!firestoreState) {
    await saveStateToFirestore(engine.getState());
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

    // Auth check (skip for webhook endpoint — it has its own auth)
    const isWebhook = url.pathname === '/api/webhooks/lead';
    if (!isWebhook) {
      const authResult = checkAuth({ headers: request.headers as Record<string, string | string[] | undefined>, url: request.url || '' });
      if (!authResult.ok) {
        sendJson(response, authResult.status || 401, { error: authResult.error });
        return;
      }
      // Rate limit general API
      const ip = getClientIp(request);
      const rateResult = apiLimiter.check(ip);
      if (!rateResult.ok) {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(rateResult.retryAfterMs / 1000)) });
        response.end(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }));
        return;
      }
    }

    // Webhook-specific auth + rate limiting
    if (isWebhook) {
      const webhookAuthResult = checkWebhookAuth({ headers: request.headers as Record<string, string | string[] | undefined>, url: request.url || '' });
      if (!webhookAuthResult.ok) {
        sendJson(response, webhookAuthResult.status || 401, { error: webhookAuthResult.error });
        return;
      }
      const ip = getClientIp(request);
      const rateResult = webhookLimiter.check(ip);
      if (!rateResult.ok) {
        response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(rateResult.retryAfterMs / 1000)) });
        response.end(JSON.stringify({ error: 'Webhook rate limit exceeded. Try again later.' }));
        return;
      }
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, toPublicAgentState(engine.getState()));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/inboxes/gmail/start') {
        const emailParam = url.searchParams.get('email') || undefined;
        sendJson(response, 200, buildGmailOAuthStartFromEnv(process.env, emailParam));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/inboxes/gmail/mock-auth') {
        const email = url.searchParams.get('email') || '';
        const stateVal = url.searchParams.get('state') || '';
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Mock Google Sign-In</title>
            <style>
              body {
                background-color: #030712;
                color: #f3f4f6;
                font-family: system-ui, -apple-system, sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
              }
              .card {
                background: rgba(30, 41, 59, 0.7);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 12px;
                padding: 32px;
                max-width: 400px;
                width: 100%;
                text-align: center;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
              }
              h1 {
                font-size: 1.5rem;
                margin-bottom: 8px;
                background: linear-gradient(135deg, #4ade80, #3b82f6);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
              }
              p {
                color: #94a3b8;
                font-size: 0.875rem;
                line-height: 1.5;
                margin-bottom: 24px;
              }
              .email-badge {
                display: inline-block;
                background: rgba(59, 130, 246, 0.1);
                border: 1px solid rgba(59, 130, 246, 0.2);
                color: #60a5fa;
                padding: 6px 12px;
                border-radius: 20px;
                font-size: 0.85rem;
                margin-bottom: 24px;
                font-weight: 500;
              }
              .scopes {
                text-align: left;
                background: rgba(0, 0, 0, 0.2);
                padding: 16px;
                border-radius: 8px;
                margin-bottom: 24px;
                border: 1px solid rgba(255, 255, 255, 0.05);
              }
              .scopes-title {
                font-size: 0.75rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: #64748b;
                margin-bottom: 8px;
                font-weight: 700;
              }
              .scope-item {
                font-size: 0.8rem;
                margin: 4px 0;
                color: #cbd5e1;
                display: flex;
                align-items: center;
              }
              .scope-item::before {
                content: "✓";
                color: #4ade80;
                margin-right: 8px;
                font-weight: bold;
              }
              .buttons {
                display: flex;
                gap: 12px;
              }
              button, a.btn {
                flex: 1;
                padding: 10px 16px;
                border-radius: 6px;
                font-size: 0.875rem;
                font-weight: 600;
                cursor: pointer;
                text-decoration: none;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
              }
              .btn-primary {
                background: #4ade80;
                color: #030712;
                border: none;
              }
              .btn-primary:hover {
                background: #22c55e;
              }
              .btn-secondary {
                background: transparent;
                color: #94a3b8;
                border: 1px solid rgba(255, 255, 255, 0.1);
              }
              .btn-secondary:hover {
                background: rgba(255, 255, 255, 0.05);
                color: #f3f4f6;
              }
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
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/inboxes/gmail/callback') {
        const code = url.searchParams.get('code') || '';

        let email = '';
        let accessToken = 'mock_access_token';
        let refreshToken = 'mock_refresh_token';
        let expiresAt = Date.now() + 3600 * 1000;

        if (code.startsWith('mock_code_')) {
          email = decodeURIComponent(code.substring('mock_code_'.length));
        } else {
          const clientId = process.env.GMAIL_CLIENT_ID;
          const clientSecret = process.env.GMAIL_CLIENT_SECRET;
          
          if (!clientId || !clientSecret) {
            throw new Error('GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET is missing');
          }

          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              grant_type: 'authorization_code',
              redirect_uri: 'http://127.0.0.1:8787/api/inboxes/gmail/callback',
            }),
          });

          if (!tokenRes.ok) {
            const errBody = await tokenRes.text();
            throw new Error(`Failed to exchange OAuth code: ${errBody}`);
          }

          const tokens = await tokenRes.json() as {
            access_token: string;
            refresh_token?: string;
            expires_in: number;
          };

          accessToken = tokens.access_token;
          if (tokens.refresh_token) {
            refreshToken = tokens.refresh_token;
          }
          expiresAt = Date.now() + tokens.expires_in * 1000;

          const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          if (!profileRes.ok) {
            throw new Error(`Failed to fetch Google user profile: ${await profileRes.text()}`);
          }

          const profile = await profileRes.json() as { emailAddress: string };
          email = profile.emailAddress;
        }

        await engine.connectEmailInbox({
          provider: 'gmail',
          email,
          credentials: {
            accessToken,
            refreshToken,
            expiresAt,
          },
        });

        // Redirect back to frontend
        const referer = request.headers.referer;
        const redirectUrl = (referer && !referer.includes('/api/inboxes/gmail/mock-auth'))
          ? referer
          : `http://localhost:5173/`;
        response.writeHead(302, { Location: redirectUrl });
        response.end();
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/leads') {
        const body = await readJson(request);
        const run = await engine.createLead(body as Parameters<typeof engine.createLead>[0]);
        sendJson(response, 201, run);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/webhooks/lead') {
        interface WebhookPayload {
          name?: string;
          fullName?: string;
          firstName?: string;
          lastName?: string;
          company?: string;
          org?: string;
          organization?: string;
          service?: string;
          requestedService?: string;
          interest?: string;
          budget?: string | number;
          budgetAmount?: string | number;
          value?: string | number;
          urgency?: string;
          timeframe?: string;
          timeline?: string;
          pain?: string;
          description?: string;
          message?: string;
          notes?: string;
          channel?: string;
          preferredChannel?: string;
          contact?: string;
          email?: string;
          phone?: string;
        }

        const rawBody = await readJson(request);
        // If the body is a JSON object with only a message/text/body field,
        // pass that field's content directly to the extractor for free-text parsing
        let bodyText: string;
        let subjectHint: string | undefined = 'CRM Webhook Intake';
        if (typeof rawBody === 'object' && rawBody !== null) {
          const obj = rawBody as Record<string, unknown>;
          // Check if it has standard lead fields
          const hasStandardFields = ['name', 'fullName', 'firstName', 'company', 'org', 'organization',
            'service', 'requestedService', 'interest', 'budget', 'budgetAmount', 'value',
            'urgency', 'timeframe', 'timeline', 'channel', 'preferredChannel', 'contact', 'email', 'phone'].some(key => {
            const v = obj[key];
            return v !== undefined && v !== null && String(v).trim();
          });
          if (!hasStandardFields) {
            // Only has message/text/body - use that as free text
            bodyText = String(obj.message || obj.body || obj.text || obj.content || obj.description || JSON.stringify(rawBody, null, 2));
          } else {
            bodyText = JSON.stringify(rawBody, null, 2);
          }
        } else {
          bodyText = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody, null, 2);
        }

        const stateBefore = engine.getState();
        const apiKey = stateBefore.config?.geminiApiKey;

        // Use AI lead extraction with robust rules fallback inside extractLeadFromText
        const leadInput = await extractLeadFromText(bodyText, subjectHint, undefined, apiKey);
        
        // If we ran in fallback mode (or if AI failed/returned default values), let's ensure we try to map common CRM keys from JSON
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

        const run = await engine.createLead(leadInput);

        const state = engine.getState();
        const lead = state.leads.find((l) => l.id === run.lead.id);
        if (lead) {
          state.timeline.unshift({
            id: `event_webhook_${Date.now()}`,
            leadId: lead.id,
            label: 'CRM Webhook intake',
            detail: `Lead push ingested. Mapped using ${apiKey ? 'Gemini GenAI Extraction' : 'CRM Rule Mapper'}.`,
            createdAt: new Date().toISOString(),
          });
          await engine.reset(state);
        }

        sendJson(response, 201, run);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/inboxes') {
        const body = await readJson(request) as Parameters<typeof engine.connectEmailInbox>[0];
        const inbox = await engine.connectEmailInbox(body);
        sendJson(response, 201, toPublicInbox(inbox));
        return;
      }

      const syncInboxMatch = match(url.pathname, /^\/api\/inboxes\/([^/]+)\/sync$/);
      if (request.method === 'POST' && syncInboxMatch) {
        const result = await engine.syncEmailInbox(syncInboxMatch[1]);
        sendJson(response, 200, { ...result, inbox: toPublicInbox(result.inbox) });
        return;
      }

      const approveMatch = match(url.pathname, /^\/api\/messages\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approveMatch) {
        const message = await engine.approveMessage(approveMatch[1]);
        sendJson(response, 200, message);
        return;
      }

      const replyMatch = match(url.pathname, /^\/api\/leads\/([^/]+)\/replies$/);
      if (request.method === 'POST' && replyMatch) {
        const body = await readJson(request) as { body?: string };
        const message = await engine.recordReply(replyMatch[1], body.body || '');
        sendJson(response, 201, message);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/worker/run') {
        const body = await readJson(request) as { force?: boolean };
        const result = await engine.runDueTasks({ force: Boolean(body.force) });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/agent/cycle') {
        const result = await engine.runAutonomousCycle();
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/config') {
        const body = await readJson(request) as { bookingLink?: string; autopilotEnabled?: boolean; geminiApiKey?: string };
        const state = engine.getState();
        if (state.config) {
          if (body.bookingLink !== undefined) state.config.bookingLink = body.bookingLink;
          if (body.autopilotEnabled !== undefined) state.config.autopilotEnabled = body.autopilotEnabled;
          if (body.geminiApiKey !== undefined) state.config.geminiApiKey = body.geminiApiKey;
        } else {
          state.config = {
            bookingLink: body.bookingLink || 'https://calendar.google.com/calendar/appointments/schedules/demo',
            autopilotEnabled: body.autopilotEnabled ?? false,
            geminiApiKey: body.geminiApiKey || '',
          };
        }
        await engine.reset(state);
        sendJson(response, 200, toPublicAgentState(engine.getState()));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/reset') {
        await engine.reset();
        sendJson(response, 200, toPublicAgentState(engine.getState()));
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const statusCode = (error as any)?.statusCode || 500;
      sendJson(response, statusCode, { error: error instanceof Error ? error.message : 'Unknown server error' });
    }
  });

  setInterval(() => {
    engine.runDueTasks();
  }, 15_000).unref();

  server.listen(PORT, () => {
    console.log(`Omoha Follow-Up Agent API running on http://127.0.0.1:${PORT}`);
  });
}

start().catch(console.error);
