import type {
  AgentState,
  LeadRecord,
  RetentionOutcomeRecord,
  TaskRecord,
} from './agent-engine.js';

export type RetentionRiskCode =
  | 'overdue_follow_up'
  | 'unanswered_message'
  | 'negative_sentiment'
  | 'open_issue'
  | 'renewal_due'
  | 'inactive_account';

export type RetentionRiskLevel = 'critical' | 'high' | 'watch' | 'healthy';

export type RetentionRiskReason = {
  code: RetentionRiskCode;
  label: string;
  detail: string;
  weight: number;
};

export type RetentionQueueItem = {
  leadId: string;
  name: string;
  company: string;
  owner: string;
  score: number;
  level: RetentionRiskLevel;
  reasons: RetentionRiskReason[];
  recommendedAction: string;
  approvalState: 'waiting_approval' | 'scheduled' | 'none';
  dueAt?: string;
  draftMessageId?: string;
  lastActivityAt: string;
};

export type RetentionMetrics = {
  totalAccounts: number;
  atRiskAccounts: number;
  highRiskAccounts: number;
  overdueFollowUps: number;
  waitingApproval: number;
  recoveredAccounts: number;
  recoveryRate: number;
};

export type RetentionSnapshot = {
  generatedAt: string;
  queue: RetentionQueueItem[];
  metrics: RetentionMetrics;
  outcomes: RetentionOutcomeRecord[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const negativeTerms = [
  'angry', 'cancel', 'complaint', 'disappointed', 'frustrated', 'not happy',
  'not working', 'poor service', 'refund', 'upset', 'unacceptable',
];

function ageInDays(timestamp: string, now: Date): number {
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, (now.getTime() - value) / DAY_MS);
}

function latestTimestamp(values: Array<string | undefined>, fallback: string): string {
  const valid = values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(new Date(value).getTime()))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  return valid[0] || fallback;
}

function earliestDueTask(tasks: TaskRecord[]): TaskRecord | undefined {
  return tasks
    .filter((task) => task.status !== 'done')
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())[0];
}

function riskLevel(score: number): RetentionRiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'watch';
  return 'healthy';
}

function recommendedAction(reasons: RetentionRiskReason[], lead: LeadRecord): string {
  const codes = new Set(reasons.map((reason) => reason.code));
  if (codes.has('negative_sentiment') || codes.has('open_issue')) {
    return 'Review the unresolved concern and prepare a personal recovery response.';
  }
  if (codes.has('overdue_follow_up')) {
    return 'Review and approve the overdue follow-up now.';
  }
  if (codes.has('renewal_due')) {
    return `Start the renewal conversation for ${lead.company || lead.name || 'this account'}.`;
  }
  if (codes.has('unanswered_message')) {
    return 'Prepare a value-led check-in and confirm the next step.';
  }
  if (codes.has('inactive_account')) {
    return 'Check account health before the relationship goes quiet.';
  }
  return 'No retention action is due. Continue monitoring.';
}

function buildQueueItem(state: AgentState, lead: LeadRecord, now: Date): RetentionQueueItem {
  const messages = state.messages.filter((message) => message.leadId === lead.id);
  const tasks = state.tasks.filter((task) => task.leadId === lead.id && task.status !== 'done');
  const timeline = state.timeline.filter((event) => event.leadId === lead.id);
  const reasons: RetentionRiskReason[] = [];
  const dueTask = earliestDueTask(tasks);
  const overdueTasks = tasks.filter((task) => new Date(task.dueAt).getTime() < now.getTime());

  if (overdueTasks.length > 0) {
    const oldest = overdueTasks.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())[0];
    reasons.push({
      code: 'overdue_follow_up',
      label: 'Overdue follow-up',
      detail: `${overdueTasks.length} task${overdueTasks.length === 1 ? '' : 's'} overdue; oldest due ${new Date(oldest.dueAt).toLocaleDateString('en-US')}.`,
      weight: 35,
    });
  }

  const latestSent = messages
    .filter((message) => message.direction === 'outbound' && message.status === 'sent')
    .sort((a, b) => new Date(b.sentAt || b.createdAt).getTime() - new Date(a.sentAt || a.createdAt).getTime())[0];
  const latestInbound = messages
    .filter((message) => message.direction === 'inbound')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  if (latestSent) {
    const sentAt = latestSent.sentAt || latestSent.createdAt;
    const answered = latestInbound && new Date(latestInbound.createdAt).getTime() > new Date(sentAt).getTime();
    const unansweredDays = ageInDays(sentAt, now);
    if (!answered && unansweredDays >= 1) {
      const weight = unansweredDays >= 3 ? 30 : 20;
      reasons.push({
        code: 'unanswered_message',
        label: 'Unanswered message',
        detail: `No reply for ${Math.floor(unansweredDays)} day${Math.floor(unansweredDays) === 1 ? '' : 's'} after the latest outbound message.`,
        weight,
      });
    }
  }

  const negativeMessage = messages
    .filter((message) => message.direction === 'inbound')
    .filter((message) => ageInDays(message.createdAt, now) <= 30)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .find((message) => negativeTerms.some((term) => message.body.toLowerCase().includes(term)));
  if (negativeMessage) {
    reasons.push({
      code: 'negative_sentiment',
      label: 'Negative sentiment',
      detail: 'A recent inbound message contains a clear dissatisfaction or cancellation signal.',
      weight: 30,
    });
  }

  const openIssueTasks = tasks.filter((task) => task.type === 'owner_review');
  const openIssueCount = (lead.openIssues?.length || 0) + openIssueTasks.length;
  if (lead.status === 'needs_human' || openIssueCount > 0) {
    reasons.push({
      code: 'open_issue',
      label: 'Open issue',
      detail: `${Math.max(openIssueCount, 1)} issue${Math.max(openIssueCount, 1) === 1 ? '' : 's'} requires owner review.`,
      weight: 30,
    });
  }

  if (lead.renewalAt && Number.isFinite(new Date(lead.renewalAt).getTime())) {
    const daysUntilRenewal = (new Date(lead.renewalAt).getTime() - now.getTime()) / DAY_MS;
    if (daysUntilRenewal <= 30) {
      const weight = daysUntilRenewal < 0 ? 35 : daysUntilRenewal <= 14 ? 25 : 15;
      reasons.push({
        code: 'renewal_due',
        label: daysUntilRenewal < 0 ? 'Renewal overdue' : 'Renewal approaching',
        detail: daysUntilRenewal < 0
          ? `Renewal date passed ${Math.ceil(Math.abs(daysUntilRenewal))} day${Math.ceil(Math.abs(daysUntilRenewal)) === 1 ? '' : 's'} ago.`
          : `Renewal is due in ${Math.max(0, Math.ceil(daysUntilRenewal))} day${Math.ceil(daysUntilRenewal) === 1 ? '' : 's'}.`,
        weight,
      });
    }
  }

  const lastActivityAt = latestTimestamp([
    lead.updatedAt,
    ...messages.map((message) => message.sentAt || message.createdAt),
    ...timeline.map((event) => event.createdAt),
  ], lead.createdAt);
  const inactiveDays = ageInDays(lastActivityAt, now);
  if (inactiveDays >= 14) {
    reasons.push({
      code: 'inactive_account',
      label: 'Account quiet',
      detail: `No recorded activity for ${Math.floor(inactiveDays)} days.`,
      weight: 15,
    });
  }

  const score = Math.min(100, reasons.reduce((total, reason) => total + reason.weight, 0));
  const draft = messages.find((message) => message.direction === 'outbound' && message.status === 'draft');
  const approvalTask = tasks.find((task) => task.status === 'waiting_approval');
  const scheduledTask = tasks.find((task) => task.status === 'scheduled');

  return {
    leadId: lead.id,
    name: lead.name || 'Unknown contact',
    company: lead.company || 'Unknown account',
    owner: lead.owner || 'Victor Omoha',
    score,
    level: riskLevel(score),
    reasons,
    recommendedAction: recommendedAction(reasons, lead),
    approvalState: approvalTask || draft ? 'waiting_approval' : scheduledTask ? 'scheduled' : 'none',
    dueAt: dueTask?.dueAt || lead.renewalAt,
    draftMessageId: draft?.id,
    lastActivityAt,
  };
}

export function buildRetentionSnapshot(state: AgentState, now: Date = new Date()): RetentionSnapshot {
  const activeLeads = state.leads.filter((lead) => lead.status !== 'closed');
  const queue = activeLeads
    .map((lead) => buildQueueItem(state, lead, now))
    .sort((a, b) => b.score - a.score || new Date(a.dueAt || '9999-12-31').getTime() - new Date(b.dueAt || '9999-12-31').getTime());
  const outcomes = [...(state.retentionOutcomes || [])]
    .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());
  const latestOutcomeByLead = new Map<string, RetentionOutcomeRecord>();
  for (const outcome of outcomes) {
    if (!latestOutcomeByLead.has(outcome.leadId)) latestOutcomeByLead.set(outcome.leadId, outcome);
  }
  const completedOutcomes = [...latestOutcomeByLead.values()].filter((outcome) => outcome.outcome === 'recovered' || outcome.outcome === 'lost');
  const recoveredAccounts = completedOutcomes.filter((outcome) => outcome.outcome === 'recovered').length;

  return {
    generatedAt: now.toISOString(),
    queue,
    outcomes,
    metrics: {
      totalAccounts: activeLeads.length,
      atRiskAccounts: queue.filter((item) => item.level !== 'healthy').length,
      highRiskAccounts: queue.filter((item) => item.level === 'critical' || item.level === 'high').length,
      overdueFollowUps: queue.filter((item) => item.reasons.some((reason) => reason.code === 'overdue_follow_up')).length,
      waitingApproval: queue.filter((item) => item.approvalState === 'waiting_approval').length,
      recoveredAccounts,
      recoveryRate: completedOutcomes.length ? Math.round((recoveredAccounts / completedOutcomes.length) * 100) : 0,
    },
  };
}
