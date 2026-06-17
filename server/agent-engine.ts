import { type LeadInput } from '../src/lib/agent';
import { sendSms } from './twilio';
import { analyzeAndScoreLead, generateFollowUpPlan, analyzeReply } from './gemini';

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
  };
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
    config: state.config,
  };
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
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

  if (!state.config) {
    state.config = {
      bookingLink: process.env.OWNER_BOOKING_LINK || process.env.BOOKING_LINK || 'https://calendar.google.com/calendar/appointments/schedules/demo',
      autopilotEnabled: false,
    };
  } else {
    if (!state.config.bookingLink) {
      state.config.bookingLink = process.env.OWNER_BOOKING_LINK || process.env.BOOKING_LINK || 'https://calendar.google.com/calendar/appointments/schedules/demo';
    }
    if (state.config.autopilotEnabled === undefined) {
      state.config.autopilotEnabled = false;
    }
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

  async function createLead(input: LeadInput & { contact?: string }) {
    const timestamp = now().toISOString();
    const isAutopilot = !!state.config?.autopilotEnabled;
    const lead: LeadRecord = {
      ...input,
      id: makeId('lead'),
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
          dueAt: addHours(now(), 2).toISOString(),
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
      if (lead.channel === 'SMS') {
        const contactPhone = lead.contact || '+15550000000';
        sendSms(contactPhone, message.body).then((twilioResult) => {
          const freshLead = state.leads.find((l) => l.id === lead.id);
          if (freshLead) {
            if (!twilioResult.success) {
              addTimeline(lead.id, 'Twilio SMS failed to send (Autopilot)', `Error: ${twilioResult.error}`);
            } else {
              addTimeline(lead.id, 'Twilio SMS sent successfully (Autopilot)', `SID: ${twilioResult.sid}`);
            }
            commit();
          }
        });
      }
    } else {
      addTimeline(lead.id, 'Agent drafted first response', message.body);
    }
    commit();
    return { lead: structuredClone(lead), message: structuredClone(message), task: structuredClone(task) };
  }

  async function approveMessage(messageId: string) {
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

    if (lead.channel === 'SMS') {
      const contactPhone = lead.contact || '+15550000000';
      const twilioResult = await sendSms(contactPhone, message.body);
      if (!twilioResult.success) {
        addTimeline(lead.id, 'Twilio SMS failed to send', `Error: ${twilioResult.error}`);
      } else {
        addTimeline(lead.id, 'Twilio SMS sent successfully', `SID: ${twilioResult.sid}`);
      }
    }

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

  async function runDueTasks({ force = false }: { force?: boolean } = {}) {
    const timestamp = now().toISOString();
    let createdDrafts = 0;
    const isAutopilot = !!state.config?.autopilotEnabled;
    for (const task of state.tasks) {
      if (task.type !== 'follow_up' || task.status !== 'scheduled') continue;
      if (!force && new Date(task.dueAt) > now()) continue;
      const lead = state.leads.find((item) => item.id === task.leadId);
      if (!lead || lead.status === 'needs_human' || lead.status === 'closed') continue;
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
        state.tasks.unshift({
          id: makeId('task'),
          leadId: lead.id,
          type: 'follow_up',
          status: 'scheduled',
          dueAt: addHours(now(), 2).toISOString(),
          note: 'If no reply arrives, draft the next follow-up autonomously.',
          createdAt: timestamp,
        });
        lead.status = 'contacted';
        
        if (lead.channel === 'SMS') {
          const contactPhone = lead.contact || '+15550000000';
          sendSms(contactPhone, message.body).then((twilioResult) => {
            const freshLead = state.leads.find((l) => l.id === lead.id);
            if (freshLead) {
              if (!twilioResult.success) {
                addTimeline(lead.id, 'Twilio SMS failed to send (Autopilot)', `Error: ${twilioResult.error}`);
              } else {
                addTimeline(lead.id, 'Twilio SMS sent successfully (Autopilot)', `SID: ${twilioResult.sid}`);
              }
              commit();
            }
          });
        }
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

    const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread', {
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

      const run = await createLead(emailToLeadInput(emailRecord));
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
    const timestamp = now().toISOString();
    const inbox = state.inboxes.find((item) => item.id === inboxId);
    if (!inbox) throw new Error(`Inbox not found: ${inboxId}`);
    if (inbox.status !== 'connected') throw new Error(`Inbox is not connected: ${inbox.email}`);

    if (inbox.provider === 'gmail' && inbox.credentials && inbox.credentials.accessToken !== 'mock_access_token') {
      return await syncRealGmailInbox(inbox, timestamp);
    }

    let imported = 0;
    const emails = state.emailMessages.filter((email) => email.inboxId === inboxId && !email.importedAt);
    for (const email of emails) {
      const run = await createLead(emailToLeadInput(email));
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

    const history = state.messages
      .filter((m) => m.leadId === leadId && m.id !== message.id)
      .slice()
      .reverse()
      .map((m) => ({ direction: m.direction, body: m.body }));

    const apiKey = state.config?.geminiApiKey;
    const analysis = await analyzeReply(lead, body, history, apiKey);

    if (analysis.isBookingIntent) {
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
    } else if (analysis.isDecline) {
      lead.status = 'closed';
      state.tasks = state.tasks.map((task) =>
        task.leadId === leadId && task.status === 'scheduled' ? { ...task, status: 'done' } : task
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
    } else {
      lead.status = 'contacted';
      const isAutopilot = !!state.config?.autopilotEnabled;
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
        if (lead.channel === 'SMS') {
          const contactPhone = lead.contact || '+15550000000';
          sendSms(contactPhone, draftMessage.body).then((twilioResult) => {
            if (!twilioResult.success) {
              addTimeline(leadId, 'Twilio SMS failed to send (Autopilot)', `Error: ${twilioResult.error}`);
            } else {
              addTimeline(leadId, 'Twilio SMS sent successfully (Autopilot)', `SID: ${twilioResult.sid}`);
            }
            commit();
          });
        }
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
    const startedAt = now().toISOString();
    let imported = 0;
    for (const inbox of state.inboxes.filter((item) => item.status === 'connected')) {
      const syncResult = await syncEmailInbox(inbox.id);
      imported += syncResult.imported;
    }
    const { createdDrafts } = await runDueTasks();
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
