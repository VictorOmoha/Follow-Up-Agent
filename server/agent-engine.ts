import { buildFollowUpPlan, type LeadInput } from '../src/lib/agent';

export type LeadStatus = 'new' | 'waiting_approval' | 'contacted' | 'needs_human' | 'nurture' | 'closed';
export type MessageStatus = 'draft' | 'sent' | 'received';
export type TaskStatus = 'scheduled' | 'waiting_approval' | 'done';
export type TaskType = 'approve_message' | 'follow_up' | 'owner_review';
export type EmailProvider = 'demo' | 'gmail' | 'outlook' | 'imap';

export type ConnectedInbox = {
  id: string;
  provider: EmailProvider;
  email: string;
  status: 'connected' | 'needs_auth' | 'disconnected';
  scopes: Array<'read_leads' | 'draft_replies' | 'send_approved'>;
  connectedAt: string;
  lastSyncAt?: string;
};

export type EmailMessageRecord = {
  id: string;
  inboxId: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  importedAt?: string;
  leadId?: string;
};

export type LeadRecord = LeadInput & {
  id: string;
  contact?: string;
  status: LeadStatus;
  createdAt: string;
  updatedAt: string;
};

export type MessageRecord = {
  id: string;
  leadId: string;
  direction: 'outbound' | 'inbound';
  status: MessageStatus;
  body: string;
  createdAt: string;
  sentAt?: string;
};

export type TaskRecord = {
  id: string;
  leadId: string;
  messageId?: string;
  type: TaskType;
  status: TaskStatus;
  dueAt: string;
  note: string;
  createdAt: string;
};

export type TimelineRecord = {
  id: string;
  leadId: string;
  label: string;
  detail: string;
  createdAt: string;
};

export type AgentDecisionRecord = {
  id: string;
  leadId?: string;
  type: 'triage' | 'draft' | 'schedule' | 'inbox_sync' | 'reply_analysis' | 'autopilot';
  observation: string;
  reasoning: string;
  action: string;
  confidence: number;
  createdAt: string;
};

export type AgentState = {
  leads: LeadRecord[];
  messages: MessageRecord[];
  tasks: TaskRecord[];
  timeline: TimelineRecord[];
  decisions: AgentDecisionRecord[];
  inboxes: ConnectedInbox[];
  emailMessages: EmailMessageRecord[];
};

type EngineOptions = {
  now?: () => Date;
  initialState?: AgentState;
  onChange?: (state: AgentState) => void;
};

const emptyState = (): AgentState => ({ leads: [], messages: [], tasks: [], timeline: [], decisions: [], inboxes: [], emailMessages: [] });

function normalizeState(state: Partial<AgentState>): AgentState {
  return {
    leads: state.leads ?? [],
    messages: state.messages ?? [],
    tasks: state.tasks ?? [],
    timeline: state.timeline ?? [],
    decisions: state.decisions ?? [],
    inboxes: state.inboxes ?? [],
    emailMessages: state.emailMessages ?? [],
  };
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function isBookingIntent(text: string) {
  return /\b(yes|works|book|schedule|tomorrow|today|available|call|appointment|10|3:30)\b/i.test(text);
}

function demoEmailMessages(inboxId: string, timestamp: string): EmailMessageRecord[] {
  return [
    {
      id: `email_demo_immigration_${inboxId}`,
      inboxId,
      from: 'ada.okafor@example.com',
      subject: 'Need immigration consultation ASAP',
      body: 'Name: Ada Okafor\nCompany: Ada Legal Group\nService: immigration consultation\nBudget: 2500\nUrgency: ASAP\nPain: Missing website leads after hours',
      receivedAt: timestamp,
    },
    {
      id: `email_demo_roofing_${inboxId}`,
      inboxId,
      from: 'maya@example.com',
      subject: 'Roof repair estimate this week',
      body: 'Name: Maya Johnson\nCompany: Johnson Roofing\nService: roof repair estimates\nBudget: 3500\nUrgency: this week\nPain: web leads are not answered quickly',
      receivedAt: timestamp,
    },
  ];
}

function fieldFromEmail(body: string, field: string, fallback = '') {
  const match = body.match(new RegExp(`${field}:\\s*(.+)`, 'i'));
  return match?.[1]?.trim() || fallback;
}

function emailToLeadInput(email: EmailMessageRecord): LeadInput & { contact?: string } {
  return {
    name: fieldFromEmail(email.body, 'Name', email.from.split('@')[0]),
    company: fieldFromEmail(email.body, 'Company', email.from.split('@')[0]),
    service: fieldFromEmail(email.body, 'Service', email.subject),
    budget: fieldFromEmail(email.body, 'Budget', 'unknown'),
    urgency: fieldFromEmail(email.body, 'Urgency', 'unknown'),
    pain: fieldFromEmail(email.body, 'Pain', email.subject),
    channel: 'Email',
    contact: email.from,
  };
}

export function createAgentEngine(options: EngineOptions = {}) {
  let state = structuredClone(normalizeState(options.initialState ?? emptyState()));
  const now = options.now ?? (() => new Date());

  function commit() {
    options.onChange?.(getState());
  }

  function getState(): AgentState {
    return structuredClone(state);
  }

  function addTimeline(leadId: string, label: string, detail: string) {
    state.timeline.unshift({ id: makeId('event'), leadId, label, detail, createdAt: now().toISOString() });
  }

  function addDecision(input: Omit<AgentDecisionRecord, 'id' | 'createdAt'>) {
    state.decisions.unshift({ ...input, id: makeId('decision'), createdAt: now().toISOString() });
  }

  function createLead(input: LeadInput & { contact?: string }) {
    const timestamp = now().toISOString();
    const lead: LeadRecord = {
      ...input,
      id: makeId('lead'),
      status: 'waiting_approval',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const plan = buildFollowUpPlan(input);
    const message: MessageRecord = {
      id: makeId('msg'),
      leadId: lead.id,
      direction: 'outbound',
      status: 'draft',
      body: plan.steps[0].message,
      createdAt: timestamp,
    };
    const task: TaskRecord = {
      id: makeId('task'),
      leadId: lead.id,
      messageId: message.id,
      type: 'approve_message',
      status: 'waiting_approval',
      dueAt: timestamp,
      note: 'Review and approve the first outbound follow-up before sending.',
      createdAt: timestamp,
    };

    state.leads.unshift(lead);
    state.messages.unshift(message);
    state.tasks.unshift(task);
    addDecision({
      leadId: lead.id,
      type: 'triage',
      observation: `${lead.name || 'New lead'} needs ${lead.service || 'service'}; budget ${lead.budget || 'unknown'}; urgency ${lead.urgency || 'unknown'}.`,
      reasoning: `${plan.score.temperature} score ${plan.score.score}/100 from ${plan.score.reasons.join(', ') || 'basic intake signals'}.`,
      action: 'Created an approval-gated first response instead of silently sending.',
      confidence: plan.score.temperature === 'Hot' ? 92 : plan.score.temperature === 'Warm' ? 78 : 61,
    });
    addDecision({
      leadId: lead.id,
      type: 'draft',
      observation: `Preferred channel is ${lead.channel || 'SMS'} and the first contact must be fast.`,
      reasoning: 'Acknowledge the request, confirm fit, and offer a small next step without overcommitting.',
      action: `Drafted: ${message.body}`,
      confidence: 86,
    });
    addTimeline(lead.id, 'Inbound lead captured', `${lead.name || 'A new lead'} requested ${lead.service || 'service'} through ${lead.channel || 'SMS'}.`);
    addTimeline(lead.id, 'Agent checked context', `Budget ${lead.budget || 'unknown'}, urgency ${lead.urgency || 'unknown'}, pain: ${lead.pain || 'not captured'}.`);
    addTimeline(lead.id, 'Agent drafted first response', message.body);
    commit();
    return { lead: structuredClone(lead), message: structuredClone(message), task: structuredClone(task) };
  }

  function approveMessage(messageId: string) {
    const timestamp = now().toISOString();
    const message = state.messages.find((item) => item.id === messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    const lead = state.leads.find((item) => item.id === message.leadId);
    if (!lead) throw new Error(`Lead not found: ${message.leadId}`);

    message.status = 'sent';
    message.sentAt = timestamp;
    lead.status = 'contacted';
    lead.updatedAt = timestamp;

    state.tasks = state.tasks.map((task) => task.messageId === messageId && task.type === 'approve_message'
      ? { ...task, status: 'done' }
      : task);

    state.tasks.unshift({
      id: makeId('task'),
      leadId: lead.id,
      type: 'follow_up',
      status: 'scheduled',
      dueAt: addHours(now(), 2).toISOString(),
      note: 'If no reply arrives, draft the next follow-up for owner approval.',
      createdAt: timestamp,
    });
    addTimeline(lead.id, 'Owner approved and message sent', message.body);
    addTimeline(lead.id, 'Agent scheduled next follow-up', 'Next follow-up task is due in 2 hours if the lead does not reply.');
    addDecision({
      leadId: lead.id,
      type: 'schedule',
      observation: 'Owner approved the draft; the lead has not replied yet.',
      reasoning: 'A real follow-up agent should not stop after one message. It should create the next timed task immediately.',
      action: 'Scheduled the next follow-up for 2 hours from now.',
      confidence: 88,
    });
    commit();
    return structuredClone(message);
  }

  function runDueTasks({ force = false }: { force?: boolean } = {}) {
    const timestamp = now().toISOString();
    let createdDrafts = 0;
    for (const task of state.tasks) {
      if (task.type !== 'follow_up' || task.status !== 'scheduled') continue;
      if (!force && new Date(task.dueAt) > now()) continue;
      const lead = state.leads.find((item) => item.id === task.leadId);
      if (!lead || lead.status === 'needs_human' || lead.status === 'closed') continue;
      const plan = buildFollowUpPlan(lead);
      const sentCount = state.messages.filter((message) => message.leadId === lead.id && message.direction === 'outbound').length;
      const nextStep = plan.steps[Math.min(sentCount, plan.steps.length - 1)];
      const message: MessageRecord = {
        id: makeId('msg'),
        leadId: lead.id,
        direction: 'outbound',
        status: 'draft',
        body: nextStep.message,
        createdAt: timestamp,
      };
      state.messages.unshift(message);
      task.status = 'done';
      state.tasks.unshift({
        id: makeId('task'),
        leadId: lead.id,
        messageId: message.id,
        type: 'approve_message',
        status: 'waiting_approval',
        dueAt: timestamp,
        note: `Review scheduled follow-up: ${nextStep.goal}`,
        createdAt: timestamp,
      });
      lead.status = 'waiting_approval';
      lead.updatedAt = timestamp;
      addDecision({
        leadId: lead.id,
        type: 'draft',
        observation: force ? 'Demo operator forced the due-task worker.' : 'A scheduled follow-up became due and no human takeover is active.',
        reasoning: `The next sequence goal is: ${nextStep.goal}. Keep approval mode on so the owner controls outbound sends.`,
        action: `Created a new approval draft: ${nextStep.message}`,
        confidence: 84,
      });
      addTimeline(lead.id, force ? 'Agent force-drafted scheduled follow-up' : 'Agent drafted scheduled follow-up', nextStep.message);
      createdDrafts += 1;
    }
    if (createdDrafts > 0) commit();
    return { createdDrafts };
  }

  function connectEmailInbox(input: { provider: EmailProvider; email: string }) {
    const timestamp = now().toISOString();
    const existing = state.inboxes.find((inbox) => inbox.email === input.email && inbox.provider === input.provider);
    if (existing) return structuredClone(existing);

    const inbox: ConnectedInbox = {
      id: makeId('inbox'),
      provider: input.provider,
      email: input.email,
      status: input.provider === 'demo' ? 'connected' : 'needs_auth',
      scopes: ['read_leads', 'draft_replies', 'send_approved'],
      connectedAt: timestamp,
    };
    state.inboxes.unshift(inbox);
    if (input.provider === 'demo') {
      state.emailMessages.unshift(...demoEmailMessages(inbox.id, timestamp));
    }
    addDecision({
      type: 'inbox_sync',
      observation: `${input.provider} inbox ${input.email} connected with ${input.provider === 'demo' ? 'seed lead emails ready' : 'auth pending'}.`,
      reasoning: 'An agent needs a source to watch, not just a manual form. Inbox connection gives it autonomous intake.',
      action: input.provider === 'demo' ? 'Queued demo inbox messages for import.' : 'Marked inbox as needing provider authentication.',
      confidence: input.provider === 'demo' ? 91 : 55,
    });
    commit();
    return structuredClone(inbox);
  }

  function syncEmailInbox(inboxId: string) {
    const timestamp = now().toISOString();
    const inbox = state.inboxes.find((item) => item.id === inboxId);
    if (!inbox) throw new Error(`Inbox not found: ${inboxId}`);
    if (inbox.status !== 'connected') throw new Error(`Inbox is not connected: ${inbox.email}`);

    let imported = 0;
    const emails = state.emailMessages.filter((email) => email.inboxId === inboxId && !email.importedAt);
    for (const email of emails) {
      const run = createLead(emailToLeadInput(email));
      email.importedAt = timestamp;
      email.leadId = run.lead.id;
      addTimeline(run.lead.id, 'Email lead imported', `${email.subject} from ${email.from}`);
      addDecision({
        leadId: run.lead.id,
        type: 'inbox_sync',
        observation: `Unread email matched lead pattern: ${email.subject} from ${email.from}.`,
        reasoning: 'The email contains enough name/company/service/budget/urgency/pain fields to start a follow-up run.',
        action: 'Imported the email into the lead pipeline and drafted the first response.',
        confidence: 89,
      });
      imported += 1;
    }
    inbox.lastSyncAt = timestamp;
    commit();
    return { imported, inbox: structuredClone(inbox) };
  }

  function recordReply(leadId: string, body: string) {
    const timestamp = now().toISOString();
    const lead = state.leads.find((item) => item.id === leadId);
    if (!lead) throw new Error(`Lead not found: ${leadId}`);
    const message: MessageRecord = {
      id: makeId('msg'),
      leadId,
      direction: 'inbound',
      status: 'received',
      body,
      createdAt: timestamp,
    };
    state.messages.unshift(message);

    if (isBookingIntent(body)) {
      lead.status = 'needs_human';
      state.tasks.unshift({
        id: makeId('task'),
        leadId,
        type: 'owner_review',
        status: 'waiting_approval',
        dueAt: timestamp,
        note: `Lead replied with booking intent: "${body}"`,
        createdAt: timestamp,
      });
      addTimeline(leadId, 'Lead replied - human review needed', body);
      addDecision({
        leadId,
        type: 'reply_analysis',
        observation: `Inbound reply: "${body}"`,
        reasoning: 'Reply contains booking or availability intent. The safest next move is a human handoff.',
        action: 'Paused nurture and created an owner review task.',
        confidence: 93,
      });
    } else {
      lead.status = 'contacted';
      addTimeline(leadId, 'Lead replied - agent logged context', body);
      addDecision({
        leadId,
        type: 'reply_analysis',
        observation: `Inbound reply: "${body}"`,
        reasoning: 'Reply does not contain clear booking intent. Keep context and continue follow-up path.',
        action: 'Logged the reply and kept the lead in contacted status.',
        confidence: 68,
      });
    }
    lead.updatedAt = timestamp;
    commit();
    return structuredClone(message);
  }

  function reset(nextState: AgentState = emptyState()) {
    state = structuredClone(normalizeState(nextState));
    commit();
  }

  function runAutonomousCycle() {
    const startedAt = now().toISOString();
    let imported = 0;
    for (const inbox of state.inboxes.filter((item) => item.status === 'connected')) {
      imported += syncEmailInbox(inbox.id).imported;
    }
    const { createdDrafts } = runDueTasks();
    const waitingApproval = state.tasks.filter((task) => task.status === 'waiting_approval').length;
    const needsHuman = state.leads.filter((lead) => lead.status === 'needs_human').length;
    addDecision({
      type: 'autopilot',
      observation: `Cycle checked ${state.inboxes.length} inboxes, ${state.leads.length} leads, and ${state.tasks.length} tasks.`,
      reasoning: 'Autopilot imports new leads, drafts due follow-ups, then surfaces only decisions that need owner approval.',
      action: `Imported ${imported} email leads, created ${createdDrafts} drafts, found ${waitingApproval} approval tasks and ${needsHuman} human handoffs.`,
      confidence: 90,
    });
    commit();
    return { startedAt, imported, createdDrafts, waitingApproval, needsHuman };
  }

  return { createLead, approveMessage, runDueTasks, runAutonomousCycle, connectEmailInbox, syncEmailInbox, recordReply, getState, reset };
}
