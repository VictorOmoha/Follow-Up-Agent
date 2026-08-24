import { describe, expect, it } from 'vitest';
import type { AgentState } from './agent-engine.js';
import { ENTITY_COLLECTIONS, entitySnapshotToState, stateToEntitySnapshot } from './db.js';

describe('entity persistence mapping', () => {
  it('round-trips every state collection without combining them into one document', () => {
    const state: AgentState = {
      leads: [{ id: 'lead-1', name: 'Dana', company: 'Triangle Talent', service: 'Recruiting automation', budget: '$3,000', urgency: 'this month', pain: 'Missed follow-ups', channel: 'Email', contact: 'dana@example.test', status: 'contacted', createdAt: '2026-08-24T12:00:00.000Z', updatedAt: '2026-08-24T12:00:00.000Z' }],
      messages: [{ id: 'message-1', leadId: 'lead-1', direction: 'outbound', status: 'draft', body: 'Hello Dana', createdAt: '2026-08-24T12:00:00.000Z' }],
      tasks: [{ id: 'task-1', leadId: 'lead-1', messageId: 'message-1', type: 'approve_message', status: 'waiting_approval', dueAt: '2026-08-24T12:00:00.000Z', note: 'Review', createdAt: '2026-08-24T12:00:00.000Z' }],
      timeline: [{ id: 'event-1', leadId: 'lead-1', label: 'Drafted', detail: 'Awaiting approval', createdAt: '2026-08-24T12:00:00.000Z' }],
      decisions: [{ id: 'decision-1', leadId: 'lead-1', type: 'retention', observation: 'At risk', reasoning: 'Overdue', action: 'Draft', confidence: 90, createdAt: '2026-08-24T12:00:00.000Z' }],
      inboxes: [],
      emailMessages: [],
      retentionOutcomes: [{ id: 'outcome-1', leadId: 'lead-1', outcome: 'monitoring', recordedAt: '2026-08-24T12:00:00.000Z' }],
      config: { bookingLink: 'https://example.test/book', autopilotEnabled: false },
    };

    const snapshot = stateToEntitySnapshot(state);
    expect(ENTITY_COLLECTIONS.every((name) => Array.isArray(snapshot[name]))).toBe(true);
    expect(entitySnapshotToState(snapshot)).toEqual(state);
  });

  it('normalizes an absent retention outcome collection to an empty array', () => {
    const state = {
      leads: [], messages: [], tasks: [], timeline: [], decisions: [], inboxes: [], emailMessages: [],
      config: { bookingLink: 'https://example.test/book' },
    } satisfies AgentState;

    expect(stateToEntitySnapshot(state).retentionOutcomes).toEqual([]);
  });
});
