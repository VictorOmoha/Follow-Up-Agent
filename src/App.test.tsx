import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { buildAgentRun, buildFollowUpPlan, scoreLead } from './lib/agent';

type TestState = {
  leads: Array<Record<string, string>>;
  messages: Array<Record<string, string>>;
  tasks: Array<Record<string, string>>;
  timeline: Array<Record<string, string>>;
  decisions: Array<Record<string, string | number>>;
  inboxes: Array<Record<string, string | string[]>>;
  emailMessages: Array<Record<string, string>>;
  config?: {
    bookingLink: string;
  };
};

function makeState(): TestState {
  return {
    leads: [],
    messages: [],
    tasks: [],
    timeline: [],
    decisions: [],
    inboxes: [],
    emailMessages: [],
    config: {
      bookingLink: 'https://calendar.google.com/calendar/appointments/schedules/demo',
    },
  };
}

function installApiMock() {
  let state = makeState();
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('http://127.0.0.1:8787/api', '');
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (path === '/state') return Response.json(state);
    if (path.startsWith('/inboxes/gmail/start')) {
      return Response.json({
        status: 'setup_required',
        provider: 'gmail',
        missing: ['GMAIL_CLIENT_ID'],
        message: 'Set GMAIL_CLIENT_ID before connecting Gmail. Keep credentials server-side and never enter them in the app UI.',
        scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'],
      });
    }
    if (path === '/inboxes') {
      const inbox = { id: 'inbox_1', provider: body.provider, email: body.email, status: 'connected', scopes: ['read_leads', 'draft_replies', 'send_approved'], connectedAt: '2026-05-17T20:00:00Z' };
      state.inboxes = [inbox];
      state.emailMessages = [
        { id: 'email_1', inboxId: 'inbox_1', from: 'ada.okafor@example.com', subject: 'Need immigration consultation ASAP', body: 'Name: Ada Okafor', receivedAt: '2026-05-17T20:00:00Z' },
        { id: 'email_2', inboxId: 'inbox_1', from: 'maya@example.com', subject: 'Roof repair estimate this week', body: 'Name: Maya Johnson', receivedAt: '2026-05-17T20:00:00Z' },
      ];
      return Response.json(inbox, { status: 201 });
    }
    if (path === '/inboxes/inbox_1/sync') {
      const imported = state.emailMessages.filter((message) => !message.importedAt).length;
      state.leads = [
        { id: 'lead_email_1', name: 'Ada Okafor', company: 'Ada Legal Group', service: 'immigration consultation', budget: '2500', urgency: 'ASAP', pain: 'Missing website leads', channel: 'Email', status: 'waiting_approval', createdAt: '2026-05-17T20:00:00Z', updatedAt: '2026-05-17T20:00:00Z' },
        ...state.leads,
      ];
      state.messages.unshift({ id: 'msg_email_1', leadId: 'lead_email_1', direction: 'outbound', status: 'draft', body: 'Hi Ada Okafor, following up by email.', createdAt: '2026-05-17T20:00:00Z' });
      state.tasks.unshift({ id: 'task_email_1', leadId: 'lead_email_1', messageId: 'msg_email_1', type: 'approve_message', status: 'waiting_approval', dueAt: '2026-05-17T20:00:00Z', note: 'Review imported email lead response.', createdAt: '2026-05-17T20:00:00Z' });
      state.timeline.unshift({ id: 'event_email_1', leadId: 'lead_email_1', label: 'Email lead imported', detail: 'Need immigration consultation ASAP from ada.okafor@example.com', createdAt: '2026-05-17T20:00:00Z' });
      state.decisions.unshift({ id: 'decision_email_1', leadId: 'lead_email_1', type: 'inbox_sync', observation: 'Unread email matched lead pattern: Need immigration consultation ASAP from ada.okafor@example.com.', reasoning: 'The email contains enough fields to start a follow-up run.', action: 'Imported the email and drafted the first response.', confidence: 89, createdAt: '2026-05-17T20:00:00Z' });
      state.emailMessages = state.emailMessages.map((message) => ({ ...message, importedAt: '2026-05-17T20:00:00Z' }));
      state.inboxes[0].lastSyncAt = '2026-05-17T20:00:00Z';
      return Response.json({ imported, inbox: state.inboxes[0] });
    }
    if (path === '/leads') {
      const lead = { ...body, id: 'lead_1', status: 'waiting_approval', createdAt: '2026-05-17T20:00:00Z', updatedAt: '2026-05-17T20:00:00Z' };
      const message = { id: 'msg_1', leadId: 'lead_1', direction: 'outbound', status: 'draft', body: `Hi ${body.name}, this is the Omoha Follow-Up Agent.`, createdAt: '2026-05-17T20:00:00Z' };
      const task = { id: 'task_1', leadId: 'lead_1', messageId: 'msg_1', type: 'approve_message', status: 'waiting_approval', dueAt: '2026-05-17T20:00:00Z', note: 'Review and approve.', createdAt: '2026-05-17T20:00:00Z' };
      const event = { id: 'event_1', leadId: 'lead_1', label: 'Agent drafted first response', detail: message.body, createdAt: '2026-05-17T20:00:00Z' };
      const decision = { id: 'decision_1', leadId: 'lead_1', type: 'triage', observation: 'Ada Okafor needs immigration consultation; budget 2500; urgency ASAP.', reasoning: 'Hot score from urgent timeline and revenue leakage pain.', action: 'Created an approval-gated first response instead of silently sending.', confidence: 92, createdAt: '2026-05-17T20:00:00Z' };
      state = { ...state, leads: [lead], messages: [message], tasks: [task], timeline: [event], decisions: [decision] };
      return Response.json({ lead, message, task }, { status: 201 });
    }
    if (path === '/messages/msg_1/approve') {
      state.messages[0].status = 'sent';
      state.leads[0].status = 'contacted';
      state.tasks[0].status = 'done';
      state.tasks.unshift({ id: 'task_2', leadId: 'lead_1', type: 'follow_up', status: 'scheduled', dueAt: '2026-05-17T22:00:00Z', note: 'Next follow-up.', createdAt: '2026-05-17T20:00:00Z' });
      return Response.json(state.messages[0]);
    }
    if (path === '/worker/run') {
      if (body.force) {
        state.messages.unshift({ id: 'msg_2', leadId: 'lead_1', direction: 'outbound', status: 'draft', body: 'Still happy to help with immigration consultation. Do you want to book a time?', createdAt: '2026-05-17T20:02:00Z' });
        state.leads[0].status = 'waiting_approval';
        state.tasks[0].status = 'done';
        state.tasks.unshift({ id: 'task_3', leadId: 'lead_1', messageId: 'msg_2', type: 'approve_message', status: 'waiting_approval', dueAt: '2026-05-17T20:02:00Z', note: 'Review scheduled follow-up.', createdAt: '2026-05-17T20:02:00Z' });
        state.timeline.unshift({ id: 'event_2', leadId: 'lead_1', label: 'Agent force-drafted scheduled follow-up', detail: 'Still happy to help with immigration consultation. Do you want to book a time?', createdAt: '2026-05-17T20:02:00Z' });
        return Response.json({ createdDrafts: 1 });
      }
      return Response.json({ createdDrafts: 0 });
    }
    if (path === '/agent/cycle') {
      state.decisions.unshift({ id: 'decision_cycle_1', type: 'autopilot', observation: 'Cycle checked 1 inbox, 2 leads, and 3 tasks.', reasoning: 'Autopilot imports new leads, drafts due follow-ups, then surfaces owner approvals.', action: 'Imported 0 email leads, created 0 drafts, found 1 approval task and 0 human handoffs.', confidence: 90, createdAt: '2026-05-17T20:03:00Z' });
      return Response.json({ startedAt: '2026-05-17T20:03:00Z', imported: 0, createdDrafts: 0, waitingApproval: 1, needsHuman: 0 });
    }
    if (path === '/reset') { state = makeState(); return Response.json(state); }
    if (path === '/leads/lead_1/replies') {
      state.leads[0].status = 'needs_human';
      state.messages.unshift({ id: 'msg_2', leadId: 'lead_1', direction: 'inbound', status: 'received', body: body.body, createdAt: '2026-05-17T20:01:00Z' });
      state.tasks.unshift({ id: 'task_3', leadId: 'lead_1', type: 'owner_review', status: 'waiting_approval', dueAt: '2026-05-17T20:01:00Z', note: 'Lead replied with booking intent.', createdAt: '2026-05-17T20:01:00Z' });
      return Response.json(state.messages[0], { status: 201 });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Omoha Follow-Up Agent', () => {
  beforeEach(() => {
    vi.useRealTimers();
    installApiMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scores hot leads based on budget, urgency, and pain', () => {
    const score = scoreLead({ budget: '5000', urgency: 'ASAP this week', pain: 'missed leads and no follow up' });
    expect(score.temperature).toBe('Hot');
    expect(score.score).toBeGreaterThanOrEqual(80);
    expect(score.reasons).toContain('High stated budget');
  });

  it('builds a practical follow-up sequence for a qualified service lead', () => {
    const plan = buildFollowUpPlan({ name: 'Maya Johnson', company: 'Johnson Roofing', service: 'roof repair estimates', budget: '3500', urgency: 'this week', pain: 'web leads are not answered quickly', channel: 'SMS' });
    expect(plan.summary).toContain('Johnson Roofing');
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps[0].message).toContain('Maya');
  });

  it('turns an inbound lead into an agent run with reasoning, action drafts, and approval gates', () => {
    const run = buildAgentRun({ name: 'Maya Johnson', company: 'Johnson Roofing', service: 'roof repair estimates', budget: '3500', urgency: 'this week', pain: 'web leads are not answered quickly', channel: 'SMS' });
    expect(run.events.map((event) => event.label)).toEqual(['Inbound lead captured', 'Context checked', 'Lead scored', 'Drafted first response', 'Waiting for owner approval']);
    expect(run.ownerDecision).toContain('Approve SMS draft');
  });

  it('renders the real backend-driven agent workbench and creates a lead through the API', async () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: /Follow-Up Agent/i })).toBeInTheDocument();
    expect(screen.getByText(/Next:/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/API Online/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/Lead name/i), 'Ada Okafor');
    await userEvent.type(screen.getByLabelText(/Company/i), 'Ada Legal Group');
    await userEvent.type(screen.getByLabelText(/Service requested/i), 'immigration consultation');
    await userEvent.type(screen.getByLabelText(/Budget/i), '2500');
    await userEvent.type(screen.getByLabelText(/Urgency/i), 'ASAP');
    await userEvent.type(screen.getByLabelText(/Pain/i), 'missing website leads');
    await userEvent.click(screen.getByRole('button', { name: /Create lead/i }));

    await waitFor(() => expect(screen.getAllByText(/Ada Legal Group/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/Draft waiting for owner approval/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve & Send/i })).toBeInTheDocument();
  });

  it('shows Gmail OAuth setup readiness without asking users for secrets', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/API Online/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Check Gmail/i }));

    await waitFor(() => expect(screen.getByText(/Set GMAIL_CLIENT_ID before connecting Gmail/i)).toBeInTheDocument());
    expect(screen.getByText(/gmail.readonly, gmail.send, gmail.modify/i)).toBeInTheDocument();
    expect(screen.queryByText(/password/i)).not.toBeInTheDocument();
  });

  it('connects a demo inbox and syncs email leads through the backend', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/API Online/i)).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText(/Inbox email/i), 'owner@omohasolutions.demo');
    await userEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
    await waitFor(() => expect(screen.getByText(/owner@omohasolutions.demo/i)).toBeInTheDocument());
    expect(screen.getByText(/2 unsynced emails/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Sync inbox now/i }));
    await waitFor(() => expect(screen.getByText(/Email lead imported/i)).toBeInTheDocument());
    expect(screen.getAllByText(/Ada Legal Group/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Unread email matched lead pattern/i).length).toBeGreaterThan(0);
  });

  it('runs an autonomous cycle and exposes the agent decision stream', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/API Online/i)).toBeInTheDocument());

    await userEvent.click(screen.getAllByRole('button', { name: /Run cycle/i })[0]);

    await waitFor(() => expect(screen.getByText(/Imported 0, drafted 0, approvals 1, handoffs 0/i)).toBeInTheDocument());
    expect(screen.getByText(/Cycle checked 1 inbox, 2 leads, and 3 tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/Autopilot imports new leads/i)).toBeInTheDocument();
  });

  it('moves a draft through owner approval and lets the demo worker immediately create the next approval draft', async () => {
    render(<App />);
    await userEvent.type(screen.getByLabelText(/Lead name/i), 'Ada Okafor');
    await userEvent.type(screen.getByLabelText(/Company/i), 'Ada Legal Group');
    await userEvent.type(screen.getByLabelText(/Service requested/i), 'immigration consultation');
    await userEvent.type(screen.getByLabelText(/Budget/i), '2500');
    await userEvent.type(screen.getByLabelText(/Urgency/i), 'ASAP');
    await userEvent.type(screen.getByLabelText(/Pain/i), 'missing website leads');
    await userEvent.click(screen.getByRole('button', { name: /Create lead/i }));
    await waitFor(() => expect(screen.getByText(/Draft waiting for owner approval/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Approve & Send/i }));

    await waitFor(() => expect(screen.getByText(/follow_up · scheduled/i)).toBeInTheDocument());
    expect(screen.getByText(/Follow-up scheduled/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Draft next follow-up now/i }));

    await waitFor(() => expect(screen.getByText(/Agent force-drafted scheduled follow-up/i)).toBeInTheDocument());
    expect(screen.getAllByText(/Still happy to help with immigration consultation/i).length).toBeGreaterThan(0);
  });

  it('renders the Owner Daily Digest and Calendar Link cards', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/API Online/i)).toBeInTheDocument());

    expect(screen.getByRole('heading', { name: /Owner Daily Digest/i })).toBeInTheDocument();
    expect(screen.getByText(/Money on Table/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Hot Leads/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Stalled Leads/i)).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: /Calendar Link/i })).toBeInTheDocument();
    expect(screen.getByText('https://calendar.google.com/calendar/appointments/schedules/demo')).toBeInTheDocument();
  });
});
