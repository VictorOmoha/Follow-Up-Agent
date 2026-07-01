import { type LeadInput } from './shared/agent.js';
import { sendSms } from './twilio.js';
import { sendEmail } from './email.js';
import { makeCall } from './voice.js';
import { AsyncLock } from './lock.js';
import { analyzeAndScoreLead, generateFollowUpPlan, analyzeReply, extractLeadFromText } from './gemini.js';

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
  credentials?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
  };
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
  tenantId?: string;
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
  config?: {
    bookingLink: string;
    autopilotEnabled?: boolean;
    geminiApiKey?: string;
    // Gmail search query used by inbox sync. Defaults to 'is:unread'; set to
    // e.g. 'is:unread label:leads' to only import labeled intake mail.
    gmailSyncQuery?: string;
  };
};

type ErrorWithStatus = Error & { statusCode?: number };

function errorWithStatus(message: string, statusCode: number): ErrorWithStatus {
  const error = new Error(message) as ErrorWithStatus;
  error.statusCode = statusCode;
  return error;
}

type EngineOptions = {
  now?: () => Date;
  initialState?: AgentState;
  tenantId?: string;
  onChange?: (state: AgentState) => void;
};

const defaultConfig = () => ({
  bookingLink: process.env.OWNER_BOOKING_LINK || process.env.BOOKING_LINK || 'https://calendar.google.com/calendar/appointments/schedules/demo',
  autopilotEnabled: false,
});

const emptyState = (): AgentState => ({ leads: [], messages: [], tasks: [], timeline: [], decisions: [], inboxes: [], emailMessages: [], config: defaultConfig() });

function normalizeState(state: Partial<AgentState>): AgentState {
  const config = {
    ...defaultConfig(),
    ...(state.config ?? {}),
  };

  return {
    leads: state.leads ?? [],
    messages: state.messages ?? [],
    tasks: state.tasks ?? [],
    timeline: state.timeline ?? [],
    decisions: state.decisions ?? [],
    inboxes: state.inboxes ?? [],
    emailMessages: state.emailMessages ?? [],
    config,
  };
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

// Delay before each next step of the 5-step plan (0-60s, 5min, 2h, 24h, 72h).
// Index by the number of outbound messages already sent: after send N the
// next step is due followUpDelays[N-1] from now; past the last step the
// sequence is complete and no further follow-up is scheduled.
const followUpDelays = [
  { hours: 5 / 60, label: '5 minutes' },
  { hours: 2, label: '2 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '72 hours' },
];

function nextFollowUpDelay(sentCount: number) {
  return sentCount >= 1 ? followUpDelays[sentCount - 1] : followUpDelays[0];
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Compare two phone numbers by digits, tolerating country-code prefixes:
 * Twilio delivers E.164 ("+11234567890") while leads are often stored as
 * "123-456-7890". Matches when the digit strings are equal or one ends with
 * the other (shorter side must be a plausible national number, ≥7 digits).
 */
export function phoneDigitsMatch(a: string, b: string): boolean {
  const digitsA = a.replace(/\D/g, '');
  const digitsB = b.replace(/\D/g, '');
  if (!digitsA || !digitsB) return false;
  if (digitsA === digitsB) return true;
  const [short, long] = digitsA.length <= digitsB.length ? [digitsA, digitsB] : [digitsB, digitsA];
  return short.length >= 7 && long.endsWith(short);
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


export function createAgentEngine(options: EngineOptions = {}) {
  let state = structuredClone(normalizeState(options.initialState ?? emptyState()));
  const now = options.now ?? (() => new Date());
  const tenantId = options.tenantId || 'default';
  const lock = new AsyncLock();

  if (!state.config) {
    state.config = defaultConfig();
  }

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

  async function deliverOutboundMessage(lead: LeadRecord, body: string, mode: 'owner-approved' | 'autopilot' | 'reply' = 'owner-approved') {
    const modeLabel = mode === 'autopilot' ? 'Autopilot' : mode === 'reply' ? 'Reply' : 'Owner approval';

    if (lead.channel === 'SMS') {
      const contactPhone = lead.contact || '+155****0000';
      const twilioResult = await sendSms(contactPhone, body);
      if (!twilioResult.success) {
        addTimeline(lead.id, `Twilio SMS failed to send (${modeLabel})`, `Error: ${twilioResult.error}`);
      } else {
        addTimeline(lead.id, `Twilio SMS sent successfully (${modeLabel})`, `SID: ${twilioResult.sid}`);
      }
      return;
    }

    if (lead.channel === 'Email') {
      const contactEmail = lead.contact || '';
      const inbox = state.inboxes.find((i) => i.status === 'connected');
      const inboxToken = inbox?.credentials?.accessToken;
      // A mock token would just 401 against the real Gmail API before the
      // dry-run fallback kicks in — skip straight to SMTP/dry-run instead.
      const gmailToken = inboxToken === 'mock_access_token' ? undefined : inboxToken;
      const result = await sendEmail(contactEmail, `Follow-up from Omoha Solutions: ${lead.service || 'your inquiry'}`, body, gmailToken);
      if (result.success) {
        addTimeline(
          lead.id,
          `Email sent (${modeLabel}) via ${result.provider}`,
          `To: ${contactEmail} · ${body}`
        );
      } else {
        addTimeline(
          lead.id,
          `Email failed (${modeLabel})`,
          `Provider: ${result.provider} · Error: ${result.error} · To: ${contactEmail}`
        );
      }
      return;
    }

    if (lead.channel === 'Call') {
      const contactPhone = lead.contact || '';
      const result = await makeCall(contactPhone, body);
      if (result.success) {
        addTimeline(
          lead.id,
          result.callSid === 'mock_call_dry_run' ? 'Call task queued' : `Call placed (${modeLabel})`,
          result.callSid === 'mock_call_dry_run'
            ? `Call ${contactPhone || lead.name || 'the lead'} and use this opener: ${body}`
            : `SID: ${result.callSid} · To: ${contactPhone}`
        );
      } else {
        addTimeline(
          lead.id,
          `Call failed (${modeLabel})`,
          `Error: ${result.error} · To: ${contactPhone}`
        );
      }
    }
  }

  async function createLead(input: LeadInput & { contact?: string }) {
    return lock.run(() => createLeadInner(input));
  }

  async function createLeadInner(input: LeadInput & { contact?: string }) {
    const timestamp = now().toISOString();
    const isAutopilot = !!state.config?.autopilotEnabled;

    // ─── Lead deduplication ───────────────────────────────────
    // Match by phone number (digits-only comparison) or email address.
    // If a matching lead exists and is not closed, update it instead of
    // creating a duplicate.
    const newContact = input.contact || '';
    const newContactEmail = newContact.toLowerCase().trim();
    const newContactIsEmail = newContactEmail.includes('@');
    if (newContact.trim()) {
      const existing = state.leads.find((l) => {
        if (l.status === 'closed') return false;
        const existingContact = l.contact || '';
        const existingEmail = existingContact.toLowerCase().trim();
        if (newContactIsEmail) return existingEmail === newContactEmail;
        return phoneDigitsMatch(newContact, existingContact);
      });
      if (existing) {
        // Update the existing lead with any new info
        if (input.service && input.service !== 'General Inquiry') existing.service = input.service;
        if (input.budget && input.budget !== 'unknown') existing.budget = input.budget;
        if (input.urgency && input.urgency !== 'unknown') existing.urgency = input.urgency;
        if (input.pain && input.pain !== 'No pain described') existing.pain = input.pain;
        existing.updatedAt = timestamp;
        addTimeline(existing.id, 'Duplicate lead detected', `Lead from ${input.contact || 'same contact'} matched existing lead. Updated info instead of creating duplicate.`);
        addDecision({
          leadId: existing.id,
          type: 'triage',
          observation: `A new inbound lead matched an existing lead by contact info: ${input.contact}.`,
          reasoning: 'Duplicate leads should not create a second pipeline entry or trigger duplicate messages.',
          action: 'Updated the existing lead with any new information. No duplicate created.',
          confidence: 95,
        });
        commit();
        const existingMessage = state.messages.find((m) => m.leadId === existing.id);
        const existingTask = state.tasks.find((t) => t.leadId === existing.id);
        return {
          lead: structuredClone(existing),
          message: existingMessage && structuredClone(existingMessage),
          task: existingTask && structuredClone(existingTask),
        };
      }
    }

    const lead: LeadRecord = {
      ...input,
      id: makeId('lead'),
      tenantId,
      status: isAutopilot ? 'contacted' : 'waiting_approval',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    
    const apiKey = state.config?.geminiApiKey;
    const score = await analyzeAndScoreLead(input, apiKey);
    const plan = await generateFollowUpPlan(input, state.config?.bookingLink || '', apiKey);

    const message: MessageRecord = {
      id: makeId('msg'),
      leadId: lead.id,
      direction: 'outbound',
      status: isAutopilot ? 'sent' : 'draft',
      body: plan.steps[0].message,
      createdAt: timestamp,
      sentAt: isAutopilot ? timestamp : undefined,
    };
    const task: TaskRecord = isAutopilot
      ? {
          id: makeId('task'),
          leadId: lead.id,
          type: 'follow_up',
          status: 'scheduled',
          dueAt: addHours(now(), nextFollowUpDelay(1).hours).toISOString(),
          note: 'If no reply arrives, draft the next follow-up autonomously.',
          createdAt: timestamp,
        }
      : {
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
      reasoning: `${score.temperature} score ${score.score}/100 from ${score.reasons.join(', ') || 'basic intake signals'}.`,
      action: isAutopilot ? 'Autopilot initiated autonomous follow-up.' : 'Created an approval-gated first response instead of silently sending.',
      confidence: score.temperature === 'Hot' ? 92 : score.temperature === 'Warm' ? 78 : 61,
    });
    addDecision({
      leadId: lead.id,
      type: 'draft',
      observation: `Preferred channel is ${lead.channel || 'SMS'} and the first contact must be fast.`,
      reasoning: 'Acknowledge the request, confirm fit, and offer a small next step without overcommitting.',
      action: isAutopilot ? `Sent autonomously: ${message.body}` : `Drafted: ${message.body}`,
      confidence: 86,
    });
    addTimeline(lead.id, 'Inbound lead captured', `${lead.name || 'A new lead'} requested ${lead.service || 'service'} through ${lead.channel || 'SMS'}.`);
    addTimeline(lead.id, 'Agent checked context', `Budget ${lead.budget || 'unknown'}, urgency ${lead.urgency || 'unknown'}, pain: ${lead.pain || 'not captured'}.`);
    if (isAutopilot) {
      addTimeline(lead.id, 'Agent sent first response autonomously', message.body);
      await deliverOutboundMessage(lead, message.body, 'autopilot');
    } else {
      addTimeline(lead.id, 'Agent drafted first response', message.body);
    }
    commit();
    return { lead: structuredClone(lead), message: structuredClone(message), task: structuredClone(task) };
  }

  async function approveMessage(messageId: string) {
    return lock.run(() => approveMessageInner(messageId));
  }

  async function approveMessageInner(messageId: string) {
    const timestamp = now().toISOString();
    const message = state.messages.find((item) => item.id === messageId);
    if (!message) throw errorWithStatus(`Message not found: ${messageId}`, 404);
    const lead = state.leads.find((item) => item.id === message.leadId);
    if (!lead) throw errorWithStatus(`Lead not found: ${message.leadId}`, 404);

    message.status = 'sent';
    message.sentAt = timestamp;
    lead.status = 'contacted';
    lead.updatedAt = timestamp;

    state.tasks = state.tasks.map((task) => task.messageId === messageId && task.type === 'approve_message'
      ? { ...task, status: 'done' }
      : task);

    addTimeline(lead.id, 'Owner approved and message sent', message.body);

    await deliverOutboundMessage(lead, message.body, 'owner-approved');

    const sentCount = state.messages.filter((m) => m.leadId === lead.id && m.direction === 'outbound' && m.status === 'sent').length;
    const delay = nextFollowUpDelay(sentCount);
    if (delay) {
      state.tasks.unshift({
        id: makeId('task'),
        leadId: lead.id,
        type: 'follow_up',
        status: 'scheduled',
        dueAt: addHours(now(), delay.hours).toISOString(),
        note: 'If no reply arrives, draft the next follow-up for owner approval.',
        createdAt: timestamp,
      });
      addTimeline(lead.id, 'Agent scheduled next follow-up', `Next follow-up task is due in ${delay.label} if the lead does not reply.`);
      addDecision({
        leadId: lead.id,
        type: 'schedule',
        observation: 'Owner approved the draft; the lead has not replied yet.',
        reasoning: 'A real follow-up agent should not stop after one message. It should create the next timed task immediately.',
        action: `Scheduled the next follow-up for ${delay.label} from now.`,
        confidence: 88,
      });
    } else {
      lead.status = 'nurture';
      addTimeline(lead.id, 'Follow-up sequence complete', 'All five plan steps were sent without a booking. Lead moved to nurture; the agent re-engages if they reply.');
      addDecision({
        leadId: lead.id,
        type: 'schedule',
        observation: 'The final step of the follow-up plan has been sent with no reply.',
        reasoning: 'Continuing to message after the sequence ends would repeat the closing note and risk annoying the lead.',
        action: 'Closed the loop and moved the lead to nurture instead of scheduling another follow-up.',
        confidence: 90,
      });
    }
    commit();
    return structuredClone(message);
  }

  async function runDueTasks({ force = false }: { force?: boolean } = {}) {
    return lock.run(() => runDueTasksInner({ force }));
  }

  async function runDueTasksInner({ force = false }: { force?: boolean } = {}) {
    const timestamp = now().toISOString();
    let createdDrafts = 0;
    const isAutopilot = !!state.config?.autopilotEnabled;
    // Snapshot the array: the loop unshifts new tasks into state.tasks and
    // mutating the array mid-iteration would revisit shifted elements.
    for (const task of [...state.tasks]) {
      if (task.type !== 'follow_up' || task.status !== 'scheduled') continue;
      if (!force && new Date(task.dueAt) > now()) continue;
      const lead = state.leads.find((item) => item.id === task.leadId);
      if (!lead || lead.status === 'needs_human' || lead.status === 'closed' || lead.status === 'nurture') continue;
      const plan = await generateFollowUpPlan(lead, state.config?.bookingLink || '', state.config?.geminiApiKey);
      const sentCount = state.messages.filter((message) => message.leadId === lead.id && message.direction === 'outbound').length;
      const nextStep = plan.steps[Math.min(sentCount, plan.steps.length - 1)];
      const message: MessageRecord = {
        id: makeId('msg'),
        leadId: lead.id,
        direction: 'outbound',
        status: isAutopilot ? 'sent' : 'draft',
        body: nextStep.message,
        createdAt: timestamp,
        sentAt: isAutopilot ? timestamp : undefined,
      };
      state.messages.unshift(message);
      task.status = 'done';

      if (isAutopilot) {
        const sentSoFar = state.messages.filter((m) => m.leadId === lead.id && m.direction === 'outbound' && m.status === 'sent').length;
        const delay = nextFollowUpDelay(sentSoFar);
        if (delay) {
          state.tasks.unshift({
            id: makeId('task'),
            leadId: lead.id,
            type: 'follow_up',
            status: 'scheduled',
            dueAt: addHours(now(), delay.hours).toISOString(),
            note: 'If no reply arrives, draft the next follow-up autonomously.',
            createdAt: timestamp,
          });
          lead.status = 'contacted';
        } else {
          lead.status = 'nurture';
          addTimeline(lead.id, 'Follow-up sequence complete', 'All five plan steps were sent without a booking. Lead moved to nurture; the agent re-engages if they reply.');
        }

        await deliverOutboundMessage(lead, message.body, 'autopilot');
      } else {
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
      }
      lead.updatedAt = timestamp;
      addDecision({
        leadId: lead.id,
        type: 'draft',
        observation: force ? 'Demo operator forced the due-task worker.' : 'A scheduled follow-up became due and no human takeover is active.',
        reasoning: `The next sequence goal is: ${nextStep.goal}. ${isAutopilot ? 'Autopilot sends the message autonomously.' : 'Keep approval mode on so the owner controls outbound sends.'}`,
        action: isAutopilot ? `Sent scheduled follow-up autonomously: ${nextStep.message}` : `Created a new approval draft: ${nextStep.message}`,
        confidence: 84,
      });
      addTimeline(lead.id, isAutopilot ? 'Agent sent scheduled follow-up autonomously' : (force ? 'Agent force-drafted scheduled follow-up' : 'Agent drafted scheduled follow-up'), nextStep.message);
      createdDrafts += 1;
    }
    if (createdDrafts > 0) commit();
    return { createdDrafts };
  }

  function connectEmailInbox(input: {
    provider: EmailProvider;
    email: string;
    credentials?: {
      accessToken: string;
      refreshToken?: string;
      expiresAt: number;
    };
  }) {
    const timestamp = now().toISOString();
    let inbox = state.inboxes.find((inbox) => inbox.email === input.email && inbox.provider === input.provider);
    
    if (inbox) {
      inbox.status = 'connected';
      if (input.credentials) {
        inbox.credentials = input.credentials;
      }
      commit();
      return structuredClone(inbox);
    }

    inbox = {
      id: makeId('inbox'),
      provider: input.provider,
      email: input.email,
      status: input.provider === 'demo' ? 'connected' : (input.credentials ? 'connected' : 'needs_auth'),
      scopes: ['read_leads', 'draft_replies', 'send_approved'],
      connectedAt: timestamp,
      credentials: input.credentials,
    };
    state.inboxes.unshift(inbox);

    if (input.provider === 'demo') {
      state.emailMessages.unshift(...demoEmailMessages(inbox.id, timestamp));
    } else if (input.provider === 'gmail' && (!input.credentials || input.credentials.accessToken === 'mock_access_token')) {
      state.emailMessages.unshift(...demoEmailMessages(inbox.id, timestamp));
    }

    addDecision({
      type: 'inbox_sync',
      observation: `${input.provider} inbox ${input.email} connected with ${inbox.status === 'connected' ? 'inbox ready' : 'auth pending'}.`,
      reasoning: 'An agent needs a source to watch, not just a manual form. Inbox connection gives it autonomous intake.',
      action: inbox.status === 'connected' ? 'Queued inbox messages for import.' : 'Marked inbox as needing provider authentication.',
      confidence: inbox.status === 'connected' ? 91 : 55,
    });
    commit();
    return structuredClone(inbox);
  }

  // An inbound email from a contact we're already talking to is a reply,
  // not a new lead — route it through reply analysis (booking/opt-out/draft)
  // instead of the lead extractor.
  function findLeadByEmail(sender: string) {
    const normalized = (sender || '').toLowerCase().trim();
    if (!normalized.includes('@')) return undefined;
    return state.leads.find((l) => l.status !== 'closed' && (l.contact || '').toLowerCase().trim() === normalized);
  }

  async function syncRealGmailInbox(inbox: ConnectedInbox, timestamp: string) {
    if (inbox.credentials && Date.now() >= inbox.credentials.expiresAt - 60000) {
      const clientId = process.env.GMAIL_CLIENT_ID;
      const clientSecret = process.env.GMAIL_CLIENT_SECRET;
      if (clientId && clientSecret && inbox.credentials.refreshToken) {
        try {
          const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              refresh_token: inbox.credentials.refreshToken,
              grant_type: 'refresh_token',
            }),
          });
          if (refreshRes.ok) {
            const newTokens = await refreshRes.json() as { access_token: string; expires_in: number };
            inbox.credentials.accessToken = newTokens.access_token;
            inbox.credentials.expiresAt = Date.now() + newTokens.expires_in * 1000;
          }
        } catch (error) {
          console.error('Failed to refresh Gmail access token:', error);
        }
      }
    }

    const accessToken = inbox.credentials?.accessToken;
    if (!accessToken) throw new Error('No access token available for Gmail sync');

    const syncQuery = state.config?.gmailSyncQuery?.trim() || 'is:unread';
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(syncQuery)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) {
      throw new Error(`Failed to list Gmail messages: ${await listRes.text()}`);
    }
    const listData = await listRes.json() as { messages?: Array<{ id: string }> };
    const messages = listData.messages || [];

    let imported = 0;
    for (const msgRef of messages) {
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgRef.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!msgRes.ok) continue;
      const msg = await msgRes.json() as {
        id: string;
        snippet: string;
        payload: {
          headers: Array<{ name: string; value: string }>;
          parts?: Array<{ mimeType: string; body: { data?: string } }>;
          body?: { data?: string };
        };
      };

      const headers = msg.payload.headers;
      const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from')?.value || '';
      const subjectHeader = headers.find((h) => h.name.toLowerCase() === 'subject')?.value || 'No Subject';

      let fromEmail = fromHeader;
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      if (emailMatch) {
        fromEmail = emailMatch[1];
      }

      let bodyText = msg.snippet || '';
      const decodeBase64Url = (str: string) => {
        const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(base64, 'base64').toString('utf8');
      };

      if (msg.payload.body?.data) {
        bodyText = decodeBase64Url(msg.payload.body.data);
      } else if (msg.payload.parts) {
        const plainPart = msg.payload.parts.find((p) => p.mimeType === 'text/plain');
        if (plainPart?.body?.data) {
          bodyText = decodeBase64Url(plainPart.body.data);
        }
      }

      const emailRecord: EmailMessageRecord = {
        id: `email_gmail_${msg.id}`,
        inboxId: inbox.id,
        from: fromEmail,
        subject: subjectHeader,
        body: bodyText,
        receivedAt: new Date().toISOString(),
      };
      const existingLead = findLeadByEmail(emailRecord.from);
      if (existingLead) {
        await recordReplyInner(existingLead.id, emailRecord.body);
        emailRecord.importedAt = timestamp;
        emailRecord.leadId = existingLead.id;
        state.emailMessages.unshift(emailRecord);
        addTimeline(existingLead.id, 'Email reply imported', `${emailRecord.subject} from ${emailRecord.from}`);
      } else {
        const apiKey = state.config?.geminiApiKey;
        const leadInput = await extractLeadFromText(emailRecord.body, emailRecord.subject, emailRecord.from, apiKey);
        const run = await createLeadInner(leadInput);
        emailRecord.importedAt = timestamp;
        emailRecord.leadId = run.lead.id;

        state.emailMessages.unshift(emailRecord);

        addTimeline(run.lead.id, 'Email lead imported', `${emailRecord.subject} from ${emailRecord.from}`);
        addDecision({
          leadId: run.lead.id,
          type: 'inbox_sync',
          observation: `Unread email matched lead pattern: ${emailRecord.subject} from ${emailRecord.from}.`,
          reasoning: 'The email contains enough name/company/service/budget/urgency/pain fields to start a follow-up run.',
          action: 'Imported the email into the lead pipeline and drafted the first response.',
          confidence: 89,
        });
      }

      await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/modify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      });

      imported += 1;
    }

    inbox.lastSyncAt = timestamp;
    commit();
    return { imported, inbox: structuredClone(inbox) };
  }

  async function syncEmailInbox(inboxId: string) {
    return lock.run(() => syncEmailInboxInner(inboxId));
  }

  async function syncEmailInboxInner(inboxId: string) {
    const timestamp = now().toISOString();
    const inbox = state.inboxes.find((item) => item.id === inboxId);
    if (!inbox) throw errorWithStatus(`Inbox not found: ${inboxId}`, 404);
    if (inbox.status !== 'connected') throw errorWithStatus(`Inbox is not connected: ${inbox.email}`, 400);

    if (inbox.provider === 'gmail' && inbox.credentials && inbox.credentials.accessToken !== 'mock_access_token') {
      return await syncRealGmailInbox(inbox, timestamp);
    }

    const apiKey = state.config?.geminiApiKey;
    let imported = 0;
    const emails = state.emailMessages.filter((email) => email.inboxId === inboxId && !email.importedAt);
    for (const email of emails) {
      const existingLead = findLeadByEmail(email.from);
      if (existingLead) {
        await recordReplyInner(existingLead.id, email.body);
        email.importedAt = timestamp;
        email.leadId = existingLead.id;
        addTimeline(existingLead.id, 'Email reply imported', `${email.subject} from ${email.from}`);
        imported += 1;
        continue;
      }
      const leadInput = await extractLeadFromText(email.body, email.subject, email.from, apiKey);
      const run = await createLeadInner(leadInput);
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

  async function recordReply(leadId: string, body: string) {
    return lock.run(() => recordReplyInner(leadId, body));
  }

  async function recordReplyInner(leadId: string, body: string) {
    const timestamp = now().toISOString();
    const lead = state.leads.find((item) => item.id === leadId);
    if (!lead) throw errorWithStatus(`Lead not found: ${leadId}`, 404);
    const message: MessageRecord = {
      id: makeId('msg'),
      leadId,
      direction: 'inbound',
      status: 'received',
      body,
      createdAt: timestamp,
    };
    state.messages.unshift(message);

    const history = state.messages
      .filter((m) => m.leadId === leadId && m.id !== message.id)
      .slice()
      .reverse()
      .map((m) => ({ direction: m.direction, body: m.body }));

    const apiKey = state.config?.geminiApiKey;
    const analysis = await analyzeReply(lead, body, history, apiKey);

    // Opt-out compliance always wins: if the analyzer flags both decline and
    // booking, treat it as a decline.
    if (analysis.isDecline) {
      lead.status = 'closed';
      state.tasks = state.tasks.map((task) =>
        task.leadId === leadId && (task.status === 'scheduled' || task.status === 'waiting_approval') ? { ...task, status: 'done' } : task
      );
      // Drop pending drafts too — an opted-out lead must never be offered
      // an "Approve & Send" action.
      state.messages = state.messages.filter((m) =>
        !(m.leadId === leadId && m.direction === 'outbound' && m.status === 'draft')
      );
      addTimeline(leadId, 'Lead replied - opt-out received', body);
      addDecision({
        leadId,
        type: 'reply_analysis',
        observation: `Inbound reply: "${body}"`,
        reasoning: analysis.reasoning,
        action: 'Closed lead and cancelled scheduled follow-ups.',
        confidence: 95,
      });
    } else if (analysis.isBookingIntent) {
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
        reasoning: analysis.reasoning,
        action: 'Paused nurture and created an owner review task.',
        confidence: 93,
      });
    } else {
      lead.status = 'contacted';
      const isAutopilot = !!state.config?.autopilotEnabled;

      // Cancel any previous pending draft and its approval task for this lead.
      // The reply supersedes the original first-response draft.
      state.messages = state.messages.filter((m) =>
        !(m.leadId === leadId && m.direction === 'outbound' && m.status === 'draft')
      );
      state.tasks = state.tasks.map((t) =>
        t.leadId === leadId && t.type === 'approve_message' && t.status === 'waiting_approval'
          ? { ...t, status: 'done' as TaskStatus }
          : t
      );

      const draftMessage: MessageRecord = {
        id: makeId('msg'),
        leadId,
        direction: 'outbound',
        status: isAutopilot ? 'sent' : 'draft',
        body: analysis.draftReply,
        createdAt: timestamp,
        sentAt: isAutopilot ? timestamp : undefined,
      };
      state.messages.unshift(draftMessage);

      if (isAutopilot) {
        addTimeline(leadId, 'Agent sent reply autonomously', draftMessage.body);
        await deliverOutboundMessage(lead, draftMessage.body, 'reply');
      } else {
        state.tasks.unshift({
          id: makeId('task'),
          leadId: lead.id,
          messageId: draftMessage.id,
          type: 'approve_message',
          status: 'waiting_approval',
          dueAt: timestamp,
          note: 'Review and approve follow-up reply draft.',
          createdAt: timestamp,
        });
        addTimeline(leadId, 'Agent drafted follow-up reply', draftMessage.body);
      }

      addDecision({
        leadId,
        type: 'reply_analysis',
        observation: `Inbound reply: "${body}"`,
        reasoning: analysis.reasoning,
        action: isAutopilot ? `Sent reply autonomously: ${draftMessage.body}` : `Drafted reply for approval: ${draftMessage.body}`,
        confidence: 88,
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

  async function runAutonomousCycle() {
    return lock.run(() => runAutonomousCycleInner());
  }

  async function runAutonomousCycleInner() {
    const startedAt = now().toISOString();
    let imported = 0;
    for (const inbox of state.inboxes.filter((item) => item.status === 'connected')) {
      const syncResult = await syncEmailInboxInner(inbox.id);
      imported += syncResult.imported;
    }
    const { createdDrafts } = await runDueTasksInner({});
    const waitingApproval = state.tasks.filter((task) => task.status === 'waiting_approval').length;
    const needsHuman = state.leads.filter((lead) => lead.status === 'needs_human').length;
    // Scheduled cycles run every few minutes; only log a decision when the
    // cycle actually did something, so idle runs don't flood the log.
    if (imported > 0 || createdDrafts > 0) {
      addDecision({
        type: 'autopilot',
        observation: `Cycle checked ${state.inboxes.length} inboxes, ${state.leads.length} leads, and ${state.tasks.length} tasks.`,
        reasoning: 'Autopilot imports new leads, drafts due follow-ups, then surfaces only decisions that need owner approval.',
        action: `Imported ${imported} email leads, created ${createdDrafts} drafts, found ${waitingApproval} approval tasks and ${needsHuman} human handoffs.`,
        confidence: 90,
      });
      commit();
    }
    return { startedAt, imported, createdDrafts, waitingApproval, needsHuman };
  }

  /**
   * Provider-agnostic inbound email ingestion (from forwarding rules or
   * inbound-parse webhooks — SendGrid, Mailgun, Postmark, etc.). Emails from
   * known contacts run through reply analysis; unknown senders become leads.
   */
  async function ingestInboundEmail(input: { from: string; subject?: string; body: string }) {
    return lock.run(async () => {
      const existing = findLeadByEmail(input.from);
      if (existing) {
        const message = await recordReplyInner(existing.id, input.body);
        addTimeline(existing.id, 'Email reply received (webhook)', `${input.subject || '(no subject)'} from ${input.from}`);
        commit();
        return { type: 'reply' as const, leadId: existing.id, message };
      }
      const leadInput = await extractLeadFromText(input.body, input.subject, input.from, state.config?.geminiApiKey);
      const run = await createLeadInner(leadInput);
      addTimeline(run.lead.id, 'Email lead received (webhook)', `${input.subject || '(no subject)'} from ${input.from}`);
      commit();
      return { type: 'lead' as const, leadId: run.lead.id, run };
    });
  }

  async function addTimelineEvent(leadId: string, label: string, detail: string) {
    return lock.run(async () => {
      const lead = state.leads.find((item) => item.id === leadId);
      if (!lead) throw errorWithStatus(`Lead not found: ${leadId}`, 404);
      addTimeline(leadId, label, detail);
      commit();
    });
  }

  return { createLead, approveMessage, runDueTasks, runAutonomousCycle, connectEmailInbox, syncEmailInbox, recordReply, ingestInboundEmail, addTimelineEvent, getState, reset };
}
