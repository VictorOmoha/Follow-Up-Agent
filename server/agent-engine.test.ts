import { describe, expect, it } from 'vitest';
import { createAgentEngine } from './agent-engine';

const leadInput = {
  name: 'Ada Okafor',
  company: 'Ada Legal Group',
  service: 'immigration consultation',
  budget: '2500',
  urgency: 'ASAP',
  pain: 'missing website leads after hours',
  channel: 'SMS' as const,
  contact: '+15551234567',
};

describe('real follow-up agent engine', () => {
  it('creates a persisted agent run with a draft message waiting for approval', () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });

    const run = engine.createLead(leadInput);
    const state = engine.getState();

    expect(run.lead.status).toBe('waiting_approval');
    expect(run.message.status).toBe('draft');
    expect(run.message.body).toContain('Ada');
    expect(state.tasks).toContainEqual(expect.objectContaining({ type: 'approve_message', status: 'waiting_approval' }));
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Agent drafted first response' }));
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'triage', confidence: 92 }));
  });

  it('approves the draft, simulates sending, and schedules the next follow-up task', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    const run = engine.createLead(leadInput);

    const approved = await engine.approveMessage(run.message.id);
    const state = engine.getState();

    expect(approved.status).toBe('sent');
    expect(state.leads[0].status).toBe('contacted');
    expect(state.tasks).toContainEqual(expect.objectContaining({ type: 'follow_up', status: 'scheduled' }));
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Owner approved and message sent' }));
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'schedule', action: 'Scheduled the next follow-up for 2 hours from now.' }));
  });

  it('worker turns due follow-up tasks into new approval drafts', async () => {
    const current = { value: new Date('2026-05-17T20:00:00.000Z') };
    const engine = createAgentEngine({ now: () => current.value });
    const run = engine.createLead(leadInput);
    await engine.approveMessage(run.message.id);

    current.value = new Date('2026-05-17T22:01:00.000Z');
    const result = engine.runDueTasks();
    const state = engine.getState();

    expect(result.createdDrafts).toBe(1);
    expect(state.leads[0].status).toBe('waiting_approval');
    expect(state.messages.filter((message) => message.status === 'draft')).toHaveLength(1);
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Agent drafted scheduled follow-up' }));
  });

  it('can force scheduled follow-up tasks during demos without waiting two hours', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    const run = engine.createLead(leadInput);
    await engine.approveMessage(run.message.id);

    const result = engine.runDueTasks({ force: true });
    const state = engine.getState();

    expect(result.createdDrafts).toBe(1);
    expect(state.leads[0].status).toBe('waiting_approval');
    expect(state.tasks).toContainEqual(expect.objectContaining({ type: 'approve_message', status: 'waiting_approval' }));
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Agent force-drafted scheduled follow-up' }));
  });

  it('connects a demo email inbox without storing passwords or tokens', () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });

    const inbox = engine.connectEmailInbox({ provider: 'demo', email: 'owner@adalaw.example' });
    const state = engine.getState();

    expect(inbox.status).toBe('connected');
    expect(inbox.provider).toBe('demo');
    expect(inbox.email).toBe('owner@adalaw.example');
    expect(inbox.scopes).toEqual(['read_leads', 'draft_replies', 'send_approved']);
    expect(JSON.stringify(state)).not.toMatch(/password|token|secret/i);
    expect(state.inboxes).toContainEqual(expect.objectContaining({ email: 'owner@adalaw.example', status: 'connected' }));
  });

  it('syncs new email leads into persistent agent runs and ignores already imported messages', () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    const inbox = engine.connectEmailInbox({ provider: 'demo', email: 'owner@adalaw.example' });

    const result = engine.syncEmailInbox(inbox.id);
    const duplicateResult = engine.syncEmailInbox(inbox.id);
    const state = engine.getState();

    expect(result.imported).toBe(2);
    expect(duplicateResult.imported).toBe(0);
    expect(state.leads).toHaveLength(2);
    expect(state.leads[0]).toMatchObject({ channel: 'Email', status: 'waiting_approval' });
    expect(state.emailMessages.every((message) => message.importedAt)).toBe(true);
    expect(state.tasks.filter((task) => task.type === 'approve_message')).toHaveLength(2);
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Email lead imported' }));
  });

  it('classifies a positive reply as needing human booking review', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    const run = engine.createLead(leadInput);
    await engine.approveMessage(run.message.id);

    const reply = engine.recordReply(run.lead.id, 'Yes, tomorrow at 10 works for me.');
    const state = engine.getState();

    expect(reply.direction).toBe('inbound');
    expect(state.leads[0].status).toBe('needs_human');
    expect(state.tasks).toContainEqual(expect.objectContaining({ type: 'owner_review', status: 'waiting_approval' }));
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Lead replied - human review needed' }));
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'reply_analysis', action: 'Paused nurture and created an owner review task.' }));
  });

  it('runs an autonomous cycle across inbox intake, due follow-ups, and owner approvals', () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    engine.connectEmailInbox({ provider: 'demo', email: 'owner@adalaw.example' });

    const report = engine.runAutonomousCycle();
    const state = engine.getState();

    expect(report.imported).toBe(2);
    expect(report.waitingApproval).toBe(2);
    expect(state.leads).toHaveLength(2);
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'autopilot', confidence: 90 }));
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'inbox_sync', action: 'Imported the email into the lead pipeline and drafted the first response.' }));
  });
});
