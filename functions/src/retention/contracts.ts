import {
  type AgentDecisionRecord,
  type AgentState,
  type LeadRecord,
  type MessageRecord,
  type TaskRecord,
  type TimelineRecord,
} from '../agent-engine.js';

/**
 * FU-RET-01 boundary for Phase 1 client-retention work.
 *
 * The current product is lead-centric. These contracts expose a read-only,
 * retention-shaped view over existing records without changing lead status,
 * ownership, tasks, timeline entries, messages, or persistence. Unsupported
 * sources are reported explicitly instead of being inferred.
 */

export type RetentionSourceName =
  | 'accounts'
  | 'contacts'
  | 'tasks'
  | 'timeline'
  | 'commitments'
  | 'messaging'
  | 'audit';

export type RetentionSourceAvailability = {
  source: RetentionSourceName;
  available: boolean;
  detail: string;
};

export type RetentionAccountSnapshot = {
  accountId: string;
  displayName: string;
  status: LeadRecord['status'];
  createdAt: string;
  updatedAt: string;
  contact?: string;
  preferredChannel: LeadRecord['channel'];
  service?: string;
};

export type RetentionContactSnapshot = {
  accountId: string;
  contactId: string;
  value: string;
  kind: 'email' | 'phone' | 'unknown';
  verified: false;
  preferredChannel: LeadRecord['channel'];
};

export type RetentionReadSnapshot = {
  account: RetentionAccountSnapshot;
  contacts: RetentionContactSnapshot[];
  tasks: ReadonlyArray<TaskRecord>;
  timeline: ReadonlyArray<TimelineRecord>;
  messages: ReadonlyArray<MessageRecord>;
  decisions: ReadonlyArray<AgentDecisionRecord>;
  sources: RetentionSourceAvailability[];
};

export interface RetentionReadAdapter {
  listEligibleAccounts(): ReadonlyArray<RetentionAccountSnapshot>;
  getAccount(accountId: string): RetentionAccountSnapshot | undefined;
  getContacts(accountId: string): ReadonlyArray<RetentionContactSnapshot>;
  getTasks(accountId: string): ReadonlyArray<TaskRecord>;
  getTimeline(accountId: string): ReadonlyArray<TimelineRecord>;
  getMessages(accountId: string): ReadonlyArray<MessageRecord>;
  getDecisions(accountId: string): ReadonlyArray<AgentDecisionRecord>;
  getSourceAvailability(): ReadonlyArray<RetentionSourceAvailability>;
  getSnapshot(accountId: string): RetentionReadSnapshot | undefined;
}

function contactKind(value: string): RetentionContactSnapshot['kind'] {
  if (value.includes('@')) return 'email';
  if (value.replace(/\D/g, '').length >= 7) return 'phone';
  return 'unknown';
}

function toAccount(lead: LeadRecord): RetentionAccountSnapshot {
  return {
    accountId: lead.id,
    displayName: lead.company?.trim() || lead.name?.trim() || 'Unnamed account',
    status: lead.status,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    contact: lead.contact,
    preferredChannel: lead.channel,
    service: lead.service,
  };
}

const sourceAvailability = (): RetentionSourceAvailability[] => [
  {
    source: 'accounts',
    available: true,
    detail: 'Phase 1 temporarily adapts eligible non-closed LeadRecord entries as account candidates.',
  },
  {
    source: 'contacts',
    available: true,
    detail: 'One unverified contact value may be read from LeadRecord.contact; no primary-contact or consent model exists yet.',
  },
  {
    source: 'tasks',
    available: true,
    detail: 'Existing follow-up and owner-review tasks are readable by leadId.',
  },
  {
    source: 'timeline',
    available: true,
    detail: 'Existing timeline events are readable by leadId, but event labels are not yet a normalized retention taxonomy.',
  },
  {
    source: 'commitments',
    available: false,
    detail: 'No structured client commitment, milestone, renewal, invoice, payment, or delivery-status record exists. Associated retention signals must remain suppressed.',
  },
  {
    source: 'messaging',
    available: true,
    detail: 'Inbound and outbound messages are readable by leadId. Delivery attempts are also described in timeline events.',
  },
  {
    source: 'audit',
    available: true,
    detail: 'Agent decisions and timeline events are readable, but neither store actor identity, idempotency keys, previous/new state, or immutable audit guarantees.',
  },
];

export function createRetentionReadAdapter(getState: () => AgentState): RetentionReadAdapter {
  const listEligibleAccounts = () => getState().leads
    .filter((lead) => lead.status !== 'closed')
    .map(toAccount);

  const findLead = (accountId: string) => getState().leads.find((lead) => lead.id === accountId);

  const getAccount = (accountId: string) => {
    const lead = findLead(accountId);
    return lead && lead.status !== 'closed' ? toAccount(lead) : undefined;
  };

  const getContacts = (accountId: string): RetentionContactSnapshot[] => {
    const lead = findLead(accountId);
    const value = lead?.contact?.trim();
    if (!lead || lead.status === 'closed' || !value) return [];
    return [{
      accountId,
      contactId: `lead-contact:${accountId}`,
      value,
      kind: contactKind(value),
      verified: false,
      preferredChannel: lead.channel,
    }];
  };

  const getTasks = (accountId: string) => getState().tasks.filter((record) => record.leadId === accountId);
  const getTimeline = (accountId: string) => getState().timeline.filter((record) => record.leadId === accountId);
  const getMessages = (accountId: string) => getState().messages.filter((record) => record.leadId === accountId);
  const getDecisions = (accountId: string) => getState().decisions.filter((record) => record.leadId === accountId);
  const getSourceAvailability = () => sourceAvailability();

  const getSnapshot = (accountId: string): RetentionReadSnapshot | undefined => {
    const account = getAccount(accountId);
    if (!account) return undefined;
    return {
      account,
      contacts: getContacts(accountId),
      tasks: getTasks(accountId),
      timeline: getTimeline(accountId),
      messages: getMessages(accountId),
      decisions: getDecisions(accountId),
      sources: getSourceAvailability(),
    };
  };

  return {
    listEligibleAccounts,
    getAccount,
    getContacts,
    getTasks,
    getTimeline,
    getMessages,
    getDecisions,
    getSourceAvailability,
    getSnapshot,
  };
}
