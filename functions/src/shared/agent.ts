export type LeadInput = {
  name?: string;
  company?: string;
  service?: string;
  budget: string;
  urgency: string;
  pain: string;
  channel?: 'SMS' | 'Email' | 'Call';
};

export type LeadTemperature = 'Hot' | 'Warm' | 'Nurture';

export type LeadScore = {
  score: number;
  temperature: LeadTemperature;
  reasons: string[];
  nextAction: string;
};

export type FollowUpStep = {
  timing: string;
  goal: string;
  message: string;
};

export type FollowUpPlan = {
  summary: string;
  score: LeadScore;
  steps: FollowUpStep[];
};

export type AgentEvent = {
  label: string;
  detail: string;
  status: 'complete' | 'waiting';
};

export type AgentRun = {
  leadName: string;
  company: string;
  ownerDecision: string;
  memoryNote: string;
  draftMessage: string;
  escalation: string;
  events: AgentEvent[];
  plan: FollowUpPlan;
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function parseBudget(value: string | undefined | null): number {
  const safe = value ?? '';
  const digits = safe.replace(/[^0-9.]/g, '');
  return Number.parseFloat(digits || '0');
}

function hasAny(text: string | undefined | null, terms: string[]): boolean {
  const normalized = (text ?? '').toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

export function scoreLead(input: Pick<LeadInput, 'budget' | 'urgency' | 'pain'>): LeadScore {
  const reasons: string[] = [];
  let score = 35;
  const budget = parseBudget(input.budget);

  if (budget >= 2500) {
    score += 25;
    reasons.push('High stated budget');
  } else if (budget >= 750) {
    score += 15;
    reasons.push('Workable stated budget');
  } else if (budget > 0) {
    score += 5;
    reasons.push('Budget captured');
  }

  if (hasAny(input.urgency, ['asap', 'today', 'this week', 'urgent', 'now'])) {
    score += 25;
    reasons.push('Urgent timeline');
  } else if (hasAny(input.urgency, ['month', 'soon', 'next'])) {
    score += 10;
    reasons.push('Near-term timeline');
  }

  if (hasAny(input.pain, ['missed', 'losing', 'cold', 'follow up', 'follow-up', 'not answered', 'no response'])) {
    score += 20;
    reasons.push('Revenue leakage pain');
  } else if ((input.pain ?? '').trim().length > 20) {
    score += 8;
    reasons.push('Specific pain described');
  }

  const capped = Math.min(score, 100);
  const temperature: LeadTemperature = capped >= 80 ? 'Hot' : capped >= 55 ? 'Warm' : 'Nurture';
  const nextAction = temperature === 'Hot'
    ? 'Call or text within 5 minutes and offer two appointment times.'
    : temperature === 'Warm'
      ? 'Send proof, ask one qualifying question, and offer a booking link.'
      : 'Add to nurture sequence and ask permission to follow up later.';

  return { score: capped, temperature, reasons, nextAction };
}

export function buildFollowUpPlan(input: LeadInput, bookingLink?: string): FollowUpPlan {
  const name = input.name?.trim() || 'there';
  const company = input.company?.trim() || 'the business';
  const service = input.service?.trim() || 'your request';
  const channel = input.channel || 'SMS';
  const score = scoreLead(input);
  const budget = parseBudget(input.budget);
  const budgetPhrase = budget > 0 ? ` with a stated budget around ${money.format(budget)}` : '';

  return {
    summary: `${company} needs ${service}${budgetPhrase}. Priority: ${score.temperature} (${score.score}/100).`,
    score,
    steps: [
      {
        timing: '0-60 seconds',
        goal: 'Acknowledge instantly and prevent lead decay',
        message: `Hi ${name}, this is the Omoha Follow-Up Agent. I saw your request for ${service}. Are you available today for a quick 10-minute call so we can confirm fit and next steps?`,
      },
      {
        timing: '5 minutes',
        goal: 'Qualify pain, timeline, and decision path',
        message: `Quick question: what is the main issue you need solved first, and is this for ${company}? I can route this correctly once I know the priority.`,
      },
      {
        timing: '2 hours',
        goal: 'Offer booking without sounding desperate',
        message: bookingLink
          ? `I can hold two options for you: today at 3:30 PM or tomorrow at 10:00 AM. Alternatively, you can book a time directly here: ${bookingLink}. Which works better?`
          : 'I can hold two options for you: today at 3:30 PM or tomorrow at 10:00 AM. Which works better?',
      },
      {
        timing: '24 hours',
        goal: 'Revive the lead with value',
        message: `Still happy to help with ${service}. If timing changed, reply with "later" and I’ll check back. If it is urgent, reply "now" and I’ll escalate this to a human.`,
      },
      {
        timing: '72 hours',
        goal: 'Close the loop cleanly',
        message: `Last check-in from ${channel}: should we close this request, or do you still want help with ${service}?`,
      },
    ],
  };
}

export function buildAgentRun(input: LeadInput, bookingLink?: string): AgentRun {
  const plan = buildFollowUpPlan(input, bookingLink);
  const leadName = input.name?.trim() || 'New lead';
  const company = input.company?.trim() || 'Unknown company';
  const service = input.service?.trim() || 'requested service';
  const channel = input.channel || 'SMS';
  const reasons = plan.score.reasons.length ? plan.score.reasons.join(', ') : 'basic intake captured';

  return {
    leadName,
    company,
    plan,
    draftMessage: plan.steps[0].message,
    ownerDecision: `Approve ${channel} draft, edit it, or escalate to a human before anything sends.`,
    memoryNote: `${company}: ${leadName} asked about ${service}. Priority ${plan.score.temperature}; remember ${reasons}.`,
    escalation: plan.score.temperature === 'Hot'
      ? 'Escalate to owner if the lead replies yes, says now, asks price, or books a time.'
      : 'Keep in approval mode and move to nurture if there is no reply after 72 hours.',
    events: [
      {
        label: 'Inbound lead captured',
        detail: `${leadName} entered through website form / manual intake for ${service}.`,
        status: 'complete',
      },
      {
        label: 'Context checked',
        detail: `Agent looked for company, service, urgency, pain, budget, and preferred ${channel} follow-up path.`,
        status: 'complete',
      },
      {
        label: 'Lead scored',
        detail: `${plan.score.temperature} lead at ${plan.score.score}/100 because: ${reasons}.`,
        status: 'complete',
      },
      {
        label: 'Drafted first response',
        detail: plan.steps[0].message,
        status: 'complete',
      },
      {
        label: 'Waiting for owner approval',
        detail: 'Human approval gate is active. The demo shows agency without pretending messages have been sent.',
        status: 'waiting',
      },
    ],
  };
}
