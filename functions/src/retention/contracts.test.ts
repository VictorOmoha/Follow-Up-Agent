import { describe, expect, it } from 'vitest';
import { createAgentEngine, type AgentState } from '../agent-engine.js';
import { createRetentionReadAdapter } from './contracts.js';

const fixedNow = new Date('2026-08-06T17:00:00.000Z');

describe('retention read adapter', () => {
  it('is additive and does not mutate the lead workflow state', async () => {
    const engine = createAgentEngine({ now: () => fixedNow });
    const run = await engine.createLead({
      name: 'Amina',
      company: 'Amina Consulting',
      service: 'workflow automation',
      budget: '5000',
      urgency: 'this week',
      pain: 'follow-up is inconsistent',
      channel: 'Email',
      contact: 'amina@example.com',
    });
    const before = engine.getState();
    const adapter = createRetentionReadAdapter(engine.getState);

    const snapshot = adapter.getSnapshot(run.lead.id);

    expect(snapshot?.account.displayName).toBe('Amina Consulting');
    expect(snapshot?.contacts).toEqual([
      expect.objectContaining({
        accountId: run.lead.id,
        value: 'amina@example.com',
        kind: 'email',
        verified: false,
      }),
    ]);
    expect(snapshot?.tasks).toHaveLength(1);
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.timeline.length).toBeGreaterThan(0);
    expect(snapshot?.decisions.length).toBeGreaterThan(0);
    expect(engine.getState()).toEqual(before);
  });

  it('suppresses unavailable commitment signals instead of inventing data', () => {
    const adapter = createRetentionReadAdapter((): AgentState => ({
      leads: [],
      messages: [],
      tasks: [],
      timeline: [],
      decisions: [],
      inboxes: [],
      emailMessages: [],
      config: { bookingLink: 'https://example.com', autopilotEnabled: false },
    }));

    expect(adapter.getSourceAvailability()).toContainEqual(expect.objectContaining({
      source: 'commitments',
      available: false,
    }));
  });

  it('excludes closed leads from eligible retention account candidates', () => {
    const state: AgentState = {
      leads: [{
        id: 'lead_closed',
        tenantId: 'default',
        name: 'Closed Lead',
        company: 'Closed Co',
        budget: '0',
        urgency: 'none',
        pain: 'none',
        channel: 'Email',
        contact: 'closed@example.com',
        status: 'closed',
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      }],
      messages: [],
      tasks: [],
      timeline: [],
      decisions: [],
      inboxes: [],
      emailMessages: [],
      config: { bookingLink: 'https://example.com', autopilotEnabled: false },
    };
    const adapter = createRetentionReadAdapter(() => structuredClone(state));

    expect(adapter.listEligibleAccounts()).toEqual([]);
    expect(adapter.getSnapshot('lead_closed')).toBeUndefined();
  });
});
