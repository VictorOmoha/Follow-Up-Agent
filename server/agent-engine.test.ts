import { describe, expect, it } from 'vitest';
import { createAgentEngine, phoneDigitsMatch } from './agent-engine';

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

describe('phoneDigitsMatch', () => {
  it('matches phone numbers across common formats and country-code prefixes', () => {
    expect(phoneDigitsMatch('+11234567890', '123-456-7890')).toBe(true);
    expect(phoneDigitsMatch('(123) 456-7890', '123.456.7890')).toBe(true);
    expect(phoneDigitsMatch('+15551234567', '+15551234567')).toBe(true);
    expect(phoneDigitsMatch('+15551234567', '+15559876543')).toBe(false);
    // Short digit runs (e.g. from an email like ada2500@x.com) must not match
    expect(phoneDigitsMatch('2500', '+15551232500')).toBe(false);
    expect(phoneDigitsMatch('', '+15551234567')).toBe(false);
  });
});

describe('real follow-up agent engine', () => {
  it('creates a persisted agent run with a draft message waiting for approval', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });

    const run = await engine.createLead(leadInput);
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
    const run = await engine.createLead(leadInput);

    const approved = await engine.approveMessage(run.message.id);
    const state = engine.getState();

    expect(approved.status).toBe('sent');
    expect(state.leads[0].status).toBe('contacted');
    expect(state.tasks).toContainEqual(expect.objectContaining({ type: 'follow_up', status: 'scheduled' }));
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Owner approved and message sent' }));
    // After the first send, the next plan step ("5 minutes") drives the delay.
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'schedule', action: 'Scheduled the next follow-up for 5 minutes from now.' }));
    const followUp = state.tasks.find((task) => task.type === 'follow_up' && task.status === 'scheduled');
    expect(followUp?.dueAt).toBe('2026-05-17T20:05:00.000Z');
  });

  it('walks the plan cadence (5min, 2h, 24h, 72h) and moves to nurture after the final step', async () => {
    const current = { value: new Date('2026-05-17T20:00:00.000Z') };
    const engine = createAgentEngine({ now: () => current.value });
    const run = await engine.createLead(leadInput);
    await engine.approveMessage(run.message.id);

    const expectedDelaysMs = [
      5 * 60 * 1000,
      2 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000,
      72 * 60 * 60 * 1000,
    ];
    // First delay was scheduled by the approval above; walk the remaining steps.
    for (let step = 1; step < 5; step += 1) {
      const scheduled = engine.getState().tasks.find((task) => task.type === 'follow_up' && task.status === 'scheduled');
      expect(scheduled).toBeDefined();
      expect(new Date(scheduled!.dueAt).getTime() - current.value.getTime()).toBe(expectedDelaysMs[step - 1]);

      current.value = new Date(new Date(scheduled!.dueAt).getTime() + 1000);
      const result = await engine.runDueTasks();
      expect(result.createdDrafts).toBe(1);
      const draft = engine.getState().messages.find((message) => message.status === 'draft');
      expect(draft).toBeDefined();
      await engine.approveMessage(draft!.id);
    }

    const state = engine.getState();
    // All five steps sent, no sixth follow-up scheduled, lead parked in nurture.
    expect(state.messages.filter((message) => message.direction === 'outbound' && message.status === 'sent')).toHaveLength(5);
    expect(state.tasks.filter((task) => task.type === 'follow_up' && task.status === 'scheduled')).toHaveLength(0);
    expect(state.leads[0].status).toBe('nurture');
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Follow-up sequence complete' }));
  });

  it('closes the lead and cancels follow-ups when the reply is an opt-out, even with booking words', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    const run = await engine.createLead(leadInput);
    await engine.approveMessage(run.message.id);

    // "call" matches the booking regex, but the opt-out must win.
    await engine.recordReply(run.lead.id, "Please don't contact me again, and do not call.");
    const state = engine.getState();

    expect(state.leads[0].status).toBe('closed');
    expect(state.tasks.filter((task) => task.status === 'scheduled' || task.status === 'waiting_approval')).toHaveLength(0);
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Lead replied - opt-out received' }));
  });

  it('removes the pending draft when a lead opts out before approval', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    const run = await engine.createLead(leadInput);

    await engine.recordReply(run.lead.id, 'Not interested, remove me.');
    const state = engine.getState();

    expect(state.leads[0].status).toBe('closed');
    expect(state.messages.filter((message) => message.status === 'draft')).toHaveLength(0);
    expect(state.tasks.filter((task) => task.status === 'waiting_approval')).toHaveLength(0);
  });

  it('updates the existing lead instead of duplicating when the same contact comes in twice', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    await engine.createLead(leadInput);
    const second = await engine.createLead({ ...leadInput, budget: '4000' });
    const state = engine.getState();

    expect(state.leads).toHaveLength(1);
    expect(state.leads[0].budget).toBe('4000');
    expect(second.lead.id).toBe(state.leads[0].id);
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Duplicate lead detected' }));
  });

  it('worker turns due follow-up tasks into new approval drafts', async () => {
    const current = { value: new Date('2026-05-17T20:00:00.000Z') };
    const engine = createAgentEngine({ now: () => current.value });
    const run = await engine.createLead(leadInput);
    await engine.approveMessage(run.message.id);

    current.value = new Date('2026-05-17T22:01:00.000Z');
    const result = await engine.runDueTasks();
    const state = engine.getState();

    expect(result.createdDrafts).toBe(1);
    expect(state.leads[0].status).toBe('waiting_approval');
    expect(state.messages.filter((message) => message.status === 'draft')).toHaveLength(1);
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Agent drafted scheduled follow-up' }));
  });

  it('can force scheduled follow-up tasks during demos without waiting two hours', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    const run = await engine.createLead(leadInput);
    await engine.approveMessage(run.message.id);

    const result = await engine.runDueTasks({ force: true });
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

  it('syncs new email leads into persistent agent runs and ignores already imported messages', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    const inbox = engine.connectEmailInbox({ provider: 'demo', email: 'owner@adalaw.example' });

    const result = await engine.syncEmailInbox(inbox.id);
    const duplicateResult = await engine.syncEmailInbox(inbox.id);
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
    const run = await engine.createLead(leadInput);
    await engine.approveMessage(run.message.id);

    const reply = await engine.recordReply(run.lead.id, 'Yes, tomorrow at 10 works for me.');
    const state = engine.getState();

    expect(reply.direction).toBe('inbound');
    expect(state.leads[0].status).toBe('needs_human');
    expect(state.tasks).toContainEqual(expect.objectContaining({ type: 'owner_review', status: 'waiting_approval' }));
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Lead replied - human review needed' }));
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'reply_analysis', action: 'Paused nurture and created an owner review task.' }));
  });

  it('runs an autonomous cycle across inbox intake, due follow-ups, and owner approvals', async () => {
    const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
    engine.connectEmailInbox({ provider: 'demo', email: 'owner@adalaw.example' });

    const report = await engine.runAutonomousCycle();
    const state = engine.getState();

    expect(report.imported).toBe(2);
    expect(report.waitingApproval).toBe(2);
    expect(state.leads).toHaveLength(2);
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'autopilot', confidence: 90 }));
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'inbox_sync', action: 'Imported the email into the lead pipeline and drafted the first response.' }));
  });

  it('sets bookingLink from env/config and uses it in follow-up plan draft', async () => {
    const originalBooking = process.env.BOOKING_LINK;
    const originalOwnerBooking = process.env.OWNER_BOOKING_LINK;

    process.env.BOOKING_LINK = 'https://example.com/booking';
    try {
      const engine = createAgentEngine({ now: () => new Date('2026-05-17T20:00:00.000Z') });
      const state = engine.getState();
      expect(state.config?.bookingLink).toBe('https://example.com/booking');

      const run = await engine.createLead(leadInput);
      await engine.approveMessage(run.message.id);

      let result = await engine.runDueTasks({ force: true });
      expect(result.createdDrafts).toBe(1);
      const state2 = engine.getState();
      const draft2 = state2.messages.find((m) => m.status === 'draft');
      expect(draft2).toBeDefined();

      await engine.approveMessage(draft2!.id);

      result = await engine.runDueTasks({ force: true });
      expect(result.createdDrafts).toBe(1);
      const state3 = engine.getState();
      const draft3 = state3.messages.find((m) => m.status === 'draft');
      expect(draft3).toBeDefined();
      expect(draft3?.body).toContain('https://example.com/booking');
    } finally {
      if (originalBooking) process.env.BOOKING_LINK = originalBooking;
      else delete process.env.BOOKING_LINK;
      if (originalOwnerBooking) process.env.OWNER_BOOKING_LINK = originalOwnerBooking;
      else delete process.env.OWNER_BOOKING_LINK;
    }
  });

  it('autonomously triages and sends initial response when Autopilot is enabled', async () => {
    const engine = createAgentEngine({
      now: () => new Date('2026-05-17T20:00:00.000Z'),
      initialState: {
        leads: [],
        messages: [],
        tasks: [],
        timeline: [],
        decisions: [],
        inboxes: [],
        emailMessages: [],
        config: {
          bookingLink: 'https://calendar.google.com/calendar/appointments/schedules/demo',
          autopilotEnabled: true,
        },
      },
    });

    const run = await engine.createLead(leadInput);
    const state = engine.getState();

    expect(run.lead.status).toBe('contacted');
    expect(run.message.status).toBe('sent');
    expect(run.message.sentAt).toBeDefined();

    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toMatchObject({
      type: 'follow_up',
      status: 'scheduled',
    });
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Agent sent first response autonomously' }));
    expect(state.decisions).toContainEqual(expect.objectContaining({ type: 'triage', action: 'Autopilot initiated autonomous follow-up.' }));
  });

  it('autonomously sends scheduled follow-up tasks when Autopilot is enabled', async () => {
    const engine = createAgentEngine({
      now: () => new Date('2026-05-17T20:00:00.000Z'),
      initialState: {
        leads: [],
        messages: [],
        tasks: [],
        timeline: [],
        decisions: [],
        inboxes: [],
        emailMessages: [],
        config: {
          bookingLink: 'https://calendar.google.com/calendar/appointments/schedules/demo',
          autopilotEnabled: true,
        },
      },
    });

    await engine.createLead(leadInput);
    const result = await engine.runDueTasks({ force: true });
    const state = engine.getState();

    expect(result.createdDrafts).toBe(1);
    const sentMessages = state.messages.filter((m) => m.status === 'sent');
    expect(sentMessages).toHaveLength(2);

    expect(state.tasks.filter((t) => t.type === 'follow_up' && t.status === 'scheduled')).toHaveLength(1);
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Agent sent scheduled follow-up autonomously' }));
  });

  it('records delivery timelines for email and call channels', async () => {
    const engine = createAgentEngine({
      now: () => new Date('2026-05-17T20:00:00.000Z'),
      initialState: {
        leads: [],
        messages: [],
        tasks: [],
        timeline: [],
        decisions: [],
        inboxes: [],
        emailMessages: [],
        config: {
          bookingLink: 'https://calendar.google.com/calendar/appointments/schedules/demo',
          autopilotEnabled: true,
        },
      },
    });

    await engine.createLead({ ...leadInput, channel: 'Email', contact: 'ada@example.com' });
    await engine.createLead({ ...leadInput, name: 'Call Lead', channel: 'Call', contact: '+155****0000' });
    const state = engine.getState();

    expect(state.timeline).toContainEqual(expect.objectContaining({ label: expect.stringMatching(/Email sent.*Autopilot/) }));
    expect(state.timeline).toContainEqual(expect.objectContaining({ label: 'Call task queued' }));
  });
});
