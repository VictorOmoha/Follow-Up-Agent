import { describe, expect, it } from 'vitest';
import { toPublicAgentState } from './public-state';
import { type AgentState } from './agent-engine';

describe('public agent state', () => {
  it('redacts provider credentials and API keys before state leaves the API', () => {
    const privateState: AgentState = {
      leads: [],
      messages: [],
      tasks: [],
      timeline: [],
      decisions: [],
      emailMessages: [],
      inboxes: [
        {
          id: 'inbox_1',
          provider: 'gmail',
          email: 'owner@example.com',
          status: 'connected',
          scopes: ['read_leads', 'draft_replies', 'send_approved'],
          connectedAt: '2026-05-17T20:00:00.000Z',
          credentials: {
            accessToken: 'secret_access_token',
            refreshToken: 'secret_refresh_token',
            expiresAt: 1790000000000,
          },
        },
      ],
      config: {
        bookingLink: 'https://calendar.example/book',
        autopilotEnabled: true,
        geminiApiKey: 'secret_gemini_key',
      },
    };

    const publicState = toPublicAgentState(privateState);
    const serialized = JSON.stringify(publicState);

    expect(serialized).not.toContain('secret_access_token');
    expect(serialized).not.toContain('secret_refresh_token');
    expect(serialized).not.toContain('secret_gemini_key');
    expect(publicState.inboxes[0]).not.toHaveProperty('credentials');
    expect(publicState.config).toMatchObject({
      bookingLink: 'https://calendar.example/book',
      autopilotEnabled: true,
      geminiApiKeyConfigured: true,
    });
  });
});
