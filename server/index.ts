import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createAgentEngine, type AgentState } from './agent-engine';
import { buildGmailOAuthStartFromEnv } from './gmail-oauth';

const PORT = Number(process.env.AGENT_API_PORT || 8787);
const STATE_PATH = resolve(process.cwd(), 'data', 'agent-state.json');

function readState(): AgentState | undefined {
  if (!existsSync(STATE_PATH)) return undefined;
  return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as AgentState;
}

function writeState(state: AgentState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

const engine = createAgentEngine({
  initialState: readState(),
  onChange: writeState,
});
writeState(engine.getState());

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

  try {
    if (request.method === 'GET' && url.pathname === '/api/state') {
      sendJson(response, 200, engine.getState());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/inboxes/gmail/start') {
      sendJson(response, 200, buildGmailOAuthStartFromEnv());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/leads') {
      const body = await readJson(request);
      const run = engine.createLead(body as Parameters<typeof engine.createLead>[0]);
      sendJson(response, 201, run);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/inboxes') {
      const body = await readJson(request) as Parameters<typeof engine.connectEmailInbox>[0];
      const inbox = engine.connectEmailInbox(body);
      sendJson(response, 201, inbox);
      return;
    }

    const syncInboxMatch = match(url.pathname, /^\/api\/inboxes\/([^/]+)\/sync$/);
    if (request.method === 'POST' && syncInboxMatch) {
      const result = engine.syncEmailInbox(syncInboxMatch[1]);
      sendJson(response, 200, result);
      return;
    }

    const approveMatch = match(url.pathname, /^\/api\/messages\/([^/]+)\/approve$/);
    if (request.method === 'POST' && approveMatch) {
      const message = engine.approveMessage(approveMatch[1]);
      sendJson(response, 200, message);
      return;
    }

    const replyMatch = match(url.pathname, /^\/api\/leads\/([^/]+)\/replies$/);
    if (request.method === 'POST' && replyMatch) {
      const body = await readJson(request) as { body?: string };
      const message = engine.recordReply(replyMatch[1], body.body || '');
      sendJson(response, 201, message);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/worker/run') {
      const body = await readJson(request) as { force?: boolean };
      const result = engine.runDueTasks({ force: Boolean(body.force) });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/agent/cycle') {
      const result = engine.runAutonomousCycle();
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/reset') {
      engine.reset();
      sendJson(response, 200, engine.getState());
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : 'Unknown server error' });
  }
});

setInterval(() => {
  engine.runDueTasks();
}, 15_000).unref();

server.listen(PORT, () => {
  console.log(`Omoha Follow-Up Agent API running on http://127.0.0.1:${PORT}`);
});
