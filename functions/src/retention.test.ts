import { describe, expect, it } from 'vitest';
import type { AgentState } from './agent-engine.js';
import { buildRetentionSnapshot } from './retention.js';

function baseState(): AgentState {
  return {
    leads: [], messages: [], tasks: [], timeline: [], decisions: [], inboxes: [], emailMessages: [], retentionOutcomes: [],
    config: { bookingLink: 'https://calendar.example/book', autopilotEnabled: false },
  };
}

describe('retention account health', () => {
  it('builds a transparent priority score from overdue, unanswered, and renewal signals', () => {
    const state = baseState();
    state.leads.push({
      id: 'lead_1', name: 'Dana', company: 'Triangle Talent', service: 'follow-up workflow', budget: '3000',
      urgency: 'this month', pain: 'missed follow-ups', channel: 'Email', status: 'contacted',
      owner: 'Victor', renewalAt: '2026-08-10T12:00:00.000Z', createdAt: '2026-07-01T12:00:00.000Z', updatedAt: '2026-08-01T12:00:00.000Z',
    });
    state.messages.push({
      id: 'msg_1', leadId: 'lead_1', direction: 'outbound', status: 'sent', body: 'Checking in',
      createdAt: '2026-08-01T12:00:00.000Z', sentAt: '2026-08-01T12:00:00.000Z',
    });
    state.tasks.push({
      id: 'task_1', leadId: 'lead_1', type: 'follow_up', status: 'scheduled', note: 'Follow up',
      dueAt: '2026-08-02T12:00:00.000Z', createdAt: '2026-08-01T12:00:00.000Z',
    });

    const snapshot = buildRetentionSnapshot(state, new Date('2026-08-05T12:00:00.000Z'));
    const account = snapshot.queue[0];

    expect(account.score).toBe(90);
    expect(account.level).toBe('critical');
    expect(account.reasons.map((reason) => reason.code)).toEqual([
      'overdue_follow_up', 'unanswered_message', 'renewal_due',
    ]);
    expect(account.reasons.map((reason) => reason.weight)).toEqual([35, 30, 25]);
    expect(account.approvalState).toBe('scheduled');
    expect(snapshot.metrics).toMatchObject({ atRiskAccounts: 1, highRiskAccounts: 1, overdueFollowUps: 1 });
  });

  it('tracks the latest recorded outcome per account in recovery metrics', () => {
    const state = baseState();
    state.leads.push({
      id: 'lead_1', name: 'Dana', company: 'Triangle Talent', service: 'workflow', budget: '3000', urgency: 'soon', pain: 'follow-up',
      channel: 'Email', status: 'contacted', createdAt: '2026-08-01T12:00:00.000Z', updatedAt: '2026-08-04T12:00:00.000Z',
    });
    state.retentionOutcomes = [
      { id: 'outcome_2', leadId: 'lead_1', outcome: 'recovered', recordedAt: '2026-08-04T12:00:00.000Z' },
      { id: 'outcome_1', leadId: 'lead_1', outcome: 'lost', recordedAt: '2026-08-03T12:00:00.000Z' },
    ];

    const snapshot = buildRetentionSnapshot(state, new Date('2026-08-05T12:00:00.000Z'));
    expect(snapshot.metrics.recoveredAccounts).toBe(1);
    expect(snapshot.metrics.recoveryRate).toBe(100);
  });
});
