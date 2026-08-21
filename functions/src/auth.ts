import { createHmac, timingSafeEqual } from 'node:crypto';

const DASHBOARD_COOKIE = 'follow_up_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

type AuthRequest = {
  headers: Record<string, string | string[] | undefined>;
  url: string;
};

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signSession(timestamp: string, apiKey: string): string {
  return createHmac('sha256', apiKey).update(`follow-up-agent:${timestamp}`).digest('base64url');
}

function getCookie(headers: AuthRequest['headers'], name: string): string | undefined {
  const raw = headers.cookie;
  const cookie = Array.isArray(raw) ? raw.join(';') : raw;
  return cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function createDashboardSession(apiKey: string, now = Date.now()): string {
  const timestamp = String(now);
  return `${timestamp}.${signSession(timestamp, apiKey)}`;
}

export function verifyDashboardSession(token: string | undefined, apiKey: string, now = Date.now()): boolean {
  if (!token) return false;
  const [timestamp, signature, extra] = token.split('.');
  if (!timestamp || !signature || extra) return false;
  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > SESSION_TTL_MS) return false;
  return constantTimeEqual(signature, signSession(timestamp, apiKey));
}

export function dashboardSessionCookie(token: string, secure: boolean): string {
  return `${DASHBOARD_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearDashboardSessionCookie(secure: boolean): string {
  return `${DASHBOARD_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function isAuthEnabled(): boolean {
  return !!process.env.AGENT_API_KEY?.trim();
}

export function isCloudEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.FUNCTION_TARGET || env.FIREBASE_CONFIG || env.K_SERVICE);
}

export function warnIfInsecureAuthPosture(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isCloudEnvironment(env) && !env.AGENT_API_KEY?.trim()) {
    console.warn('[AUTH] Production dashboard is unavailable because AGENT_API_KEY is unset.');
    return true;
  }
  return false;
}

export function checkAuth(request: AuthRequest): { ok: boolean; status?: number; error?: string } {
  const apiKey = process.env.AGENT_API_KEY?.trim();
  if (!apiKey) {
    if (isCloudEnvironment()) return { ok: false, status: 503, error: 'API authentication is not configured' };
    return { ok: true };
  }

  const headerKey = request.headers['agent-api-key'];
  if (typeof headerKey === 'string' && constantTimeEqual(headerKey, apiKey)) return { ok: true };
  if (verifyDashboardSession(getCookie(request.headers, DASHBOARD_COOKIE), apiKey)) return { ok: true };
  return { ok: false, status: 401, error: 'Dashboard sign-in required' };
}

export function checkDashboardCredential(candidate: unknown): boolean {
  const apiKey = process.env.AGENT_API_KEY?.trim();
  return !!apiKey && typeof candidate === 'string' && constantTimeEqual(candidate, apiKey);
}

export function checkWebhookAuth(request: AuthRequest): { ok: boolean; status?: number; error?: string } {
  const webhookKey = process.env.WEBHOOK_API_KEY?.trim();
  if (!webhookKey) {
    if (isCloudEnvironment()) return { ok: false, status: 503, error: 'Webhook authentication is not configured' };
    return { ok: true };
  }

  const headerKey = request.headers['webhook-api-key'];
  if (typeof headerKey === 'string' && constantTimeEqual(headerKey, webhookKey)) return { ok: true };
  return { ok: false, status: 401, error: 'Unauthorized: valid WEBHOOK_API_KEY header required' };
}