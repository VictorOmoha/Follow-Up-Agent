/**
 * API key authentication middleware.
 *
 * If AGENT_API_KEY env var is set, all incoming requests must include
 * either an `AGENT_API_KEY` header or `?key=` query param matching it.
 *
 * The webhook endpoint (/api/webhooks/lead) is exempt so external CRMs
 * can still push leads. If you want webhook auth too, set WEBHOOK_API_KEY
 * separately and it will be required on the webhook endpoint.
 *
 * If AGENT_API_KEY is not set, auth is disabled (dev mode).
 */

export function isAuthEnabled(): boolean {
  return !!process.env.AGENT_API_KEY?.trim();
}

export function checkAuth(request: { headers: Record<string, string | string[] | undefined>; url: string }): { ok: boolean; status?: number; error?: string } {
  const apiKey = process.env.AGENT_API_KEY?.trim();
  if (!apiKey) return { ok: true }; // Auth disabled

  // Check header
  const headerKey = request.headers['agent-api-key'] as string | undefined;
  if (headerKey === apiKey) return { ok: true };

  // Check query param
  const url = new URL(request.url, 'http://localhost');
  const queryKey = url.searchParams.get('key');
  if (queryKey === apiKey) return { ok: true };

  return { ok: false, status: 401, error: 'Unauthorized: valid AGENT_API_KEY required' };
}

/**
 * Webhook-specific auth. If WEBHOOK_API_KEY is set, webhook requests
 * must include it in header or query. If not set, webhooks are open.
 */
export function checkWebhookAuth(request: { headers: Record<string, string | string[] | undefined>; url: string }): { ok: boolean; status?: number; error?: string } {
  const webhookKey = process.env.WEBHOOK_API_KEY?.trim();
  if (!webhookKey) return { ok: true }; // Webhook auth disabled

  const headerKey = request.headers['webhook-api-key'] as string | undefined;
  if (headerKey === webhookKey) return { ok: true };

  const url = new URL(request.url, 'http://localhost');
  const queryKey = url.searchParams.get('webhook_key');
  if (queryKey === webhookKey) return { ok: true };

  return { ok: false, status: 401, error: 'Unauthorized: valid WEBHOOK_API_KEY required' };
}