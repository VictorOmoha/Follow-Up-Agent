import { describe, expect, it } from 'vitest';
import { createAgentEngine } from './agent-engine.js';
import { checkAuth, checkWebhookAuth } from './auth.js';

describe('cloud hardening', () => {
  it('waits for queued persistence before a function may terminate', async () => {
    const persisted: number[] = [];
    const engine = createAgentEngine({
      onChange: async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        persisted.push(state.leads.length);
      },
    });

    await engine.createLead({
      name: 'Persistence Test',
      contact: 'persistence@example.com',
      service: 'Website',
      company: 'Test Co',
      budget: '2500',
      urgency: 'this week',
      pain: 'manual follow-up',
      channel: 'Email',
    });
    await engine.flushPersistence();

    expect(persisted).toEqual([1]);
  });

  it('fails closed in cloud when dashboard authentication is missing', () => {
    const previousTarget = process.env.FUNCTION_TARGET;
    const previousKey = process.env.AGENT_API_KEY;
    process.env.FUNCTION_TARGET = 'api';
    delete process.env.AGENT_API_KEY;
    try {
      expect(checkAuth({ headers: {}, url: '/api/state' })).toMatchObject({ ok: false, status: 503 });
    } finally {
      if (previousTarget === undefined) delete process.env.FUNCTION_TARGET;
      else process.env.FUNCTION_TARGET = previousTarget;
      if (previousKey === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = previousKey;
    }
  });

  it('requires webhook authentication in cloud and never accepts query-string secrets', () => {
    const previousTarget = process.env.FUNCTION_TARGET;
    const previousKey = process.env.WEBHOOK_API_KEY;
    process.env.FUNCTION_TARGET = 'api';
    process.env.WEBHOOK_API_KEY = 'webhook-secret';
    try {
      expect(checkWebhookAuth({ headers: {}, url: '/api/webhooks/lead?webhook_key=webhook-secret' })).toMatchObject({ ok: false, status: 401 });
      expect(checkWebhookAuth({ headers: { 'webhook-api-key': 'webhook-secret' }, url: '/api/webhooks/lead' })).toEqual({ ok: true });
      delete process.env.WEBHOOK_API_KEY;
      expect(checkWebhookAuth({ headers: {}, url: '/api/webhooks/lead' })).toMatchObject({ ok: false, status: 503 });
    } finally {
      if (previousTarget === undefined) delete process.env.FUNCTION_TARGET;
      else process.env.FUNCTION_TARGET = previousTarget;
      if (previousKey === undefined) delete process.env.WEBHOOK_API_KEY;
      else process.env.WEBHOOK_API_KEY = previousKey;
    }
  });
});
