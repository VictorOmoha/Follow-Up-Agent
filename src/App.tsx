import { useEffect, useMemo, useState } from 'react';
import { Bot, Brain, CalendarCheck, CheckCircle2, CircleDollarSign, ClipboardCheck, Flame, Mail, MessageSquareReply, PhoneCall, Play, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { type LeadInput } from './lib/agent';
import './styles.css';

const API_BASE = 'http://127.0.0.1:8787/api';

type LeadRecord = LeadInput & {
  id: string;
  contact?: string;
  status: 'new' | 'waiting_approval' | 'contacted' | 'needs_human' | 'nurture' | 'closed';
  createdAt: string;
  updatedAt: string;
};

type MessageRecord = {
  id: string;
  leadId: string;
  direction: 'outbound' | 'inbound';
  status: 'draft' | 'sent' | 'received';
  body: string;
  createdAt: string;
  sentAt?: string;
};

type TaskRecord = {
  id: string;
  leadId: string;
  messageId?: string;
  type: 'approve_message' | 'follow_up' | 'owner_review';
  status: 'scheduled' | 'waiting_approval' | 'done';
  dueAt: string;
  note: string;
  createdAt: string;
};

type TimelineRecord = {
  id: string;
  leadId: string;
  label: string;
  detail: string;
  createdAt: string;
};

type AgentDecisionRecord = {
  id: string;
  leadId?: string;
  type: 'triage' | 'draft' | 'schedule' | 'inbox_sync' | 'reply_analysis' | 'autopilot';
  observation: string;
  reasoning: string;
  action: string;
  confidence: number;
  createdAt: string;
};

type ConnectedInbox = {
  id: string;
  provider: 'demo' | 'gmail' | 'outlook' | 'imap';
  email: string;
  status: 'connected' | 'needs_auth' | 'disconnected';
  scopes: string[];
  connectedAt: string;
  lastSyncAt?: string;
};

type EmailMessageRecord = {
  id: string;
  inboxId: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  importedAt?: string;
  leadId?: string;
};

type AgentState = {
  leads: LeadRecord[];
  messages: MessageRecord[];
  tasks: TaskRecord[];
  timeline: TimelineRecord[];
  decisions: AgentDecisionRecord[];
  inboxes: ConnectedInbox[];
  emailMessages: EmailMessageRecord[];
};

type GmailOAuthStart = {
  status: 'setup_required' | 'ready';
  provider: 'gmail';
  missing?: string[];
  message: string;
  scopes: string[];
  authUrl?: string;
  redirectUri?: string;
};

type AgentCycleReport = {
  startedAt: string;
  imported: number;
  createdDrafts: number;
  waitingApproval: number;
  needsHuman: number;
};

const emptyState: AgentState = { leads: [], messages: [], tasks: [], timeline: [], decisions: [], inboxes: [], emailMessages: [] };

const emptyLead: LeadInput & { contact?: string } = {
  name: '',
  company: '',
  service: '',
  budget: '',
  urgency: '',
  pain: '',
  channel: 'SMS',
  contact: '',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export default function App() {
  const [lead, setLead] = useState(emptyLead);
  const [reply, setReply] = useState('Yes, tomorrow at 10 works for me.');
  const [state, setState] = useState<AgentState>(emptyState);
  const [gmailStart, setGmailStart] = useState<GmailOAuthStart | null>(null);
  const [cycleReport, setCycleReport] = useState<AgentCycleReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      setError('');
      const nextState = await api<AgentState>('/state');
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
    } catch {
      setError('API offline. Start it with npm run dev:api or npm run dev.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  const activeLead = state.leads[0];
  const activeInbox = state.inboxes[0];
  const inboxEmails = activeInbox ? state.emailMessages.filter((email) => email.inboxId === activeInbox.id) : [];
  const unsyncedEmailCount = inboxEmails.filter((email) => !email.importedAt).length;
  const activeMessages = activeLead ? state.messages.filter((message) => message.leadId === activeLead.id) : [];
  const activeTasks = activeLead ? state.tasks.filter((task) => task.leadId === activeLead.id && task.status !== 'done') : [];
  const activeTimeline = activeLead ? state.timeline.filter((event) => event.leadId === activeLead.id) : [];
  const latestDecisions = state.decisions.slice(0, 6);
  const activeLeadDecision = activeLead ? state.decisions.find((decision) => decision.leadId === activeLead.id) : undefined;
  const draft = activeMessages.find((message) => message.direction === 'outbound' && message.status === 'draft');
  const scheduledFollowUp = activeTasks.find((task) => task.type === 'follow_up' && task.status === 'scheduled');
  const nextMove = draft
    ? 'Review the drafted message, then approve it to simulate sending.'
    : scheduledFollowUp
      ? 'A follow-up is scheduled. For a live demo, force the worker to draft it now instead of waiting.'
      : activeLead?.status === 'needs_human'
        ? 'The lead replied with booking intent. A human should take over.'
        : 'Create a lead to start the workflow.';

  const stats = useMemo(() => {
    const waitingApproval = state.tasks.filter((task) => task.status === 'waiting_approval').length;
    const scheduled = state.tasks.filter((task) => task.status === 'scheduled').length;
    const hot = state.leads.filter((item) => item.status === 'waiting_approval' || item.status === 'needs_human').length;
    const pipeline = state.leads.reduce((sum, item) => sum + Number.parseFloat((item.budget || '0').replace(/[^0-9.]/g, '') || '0'), 0);
    return { waitingApproval, scheduled, hot, pipeline };
  }, [state]);

  function update<K extends keyof typeof lead>(key: K, value: (typeof lead)[K]) {
    setLead((current) => ({ ...current, [key]: value }));
  }

  async function createLead(event: React.FormEvent) {
    event.preventDefault();
    await api('/leads', { method: 'POST', body: JSON.stringify(lead) });
    setLead(emptyLead);
    await refresh();
  }

  async function approveDraft() {
    if (!draft) return;
    await api(`/messages/${draft.id}/approve`, { method: 'POST' });
    await refresh();
  }

  async function runWorker({ force = false }: { force?: boolean } = {}) {
    await api('/worker/run', { method: 'POST', body: JSON.stringify({ force }) });
    await refresh();
  }

  async function runAgentCycle() {
    setCycleReport(await api<AgentCycleReport>('/agent/cycle', { method: 'POST' }));
    await refresh();
  }

  async function recordReply() {
    if (!activeLead) return;
    await api(`/leads/${activeLead.id}/replies`, { method: 'POST', body: JSON.stringify({ body: reply }) });
    await refresh();
  }

  async function connectDemoInbox() {
    await api('/inboxes', { method: 'POST', body: JSON.stringify({ provider: 'demo', email: 'owner@omohasolutions.demo' }) });
    await refresh();
  }

  async function syncInbox() {
    if (!activeInbox) return;
    await api(`/inboxes/${activeInbox.id}/sync`, { method: 'POST' });
    await refresh();
  }

  async function checkGmailReadiness() {
    setGmailStart(await api<GmailOAuthStart>('/inboxes/gmail/start'));
  }

  async function reset() {
    await api('/reset', { method: 'POST' });
    await refresh();
  }

  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Omoha Solutions</p>
          <h1>Omoha Follow-Up Agent</h1>
          <p className="subhead">A real local agent loop: backend receives leads, creates approval tasks, simulates sends, schedules follow-ups, watches replies, and persists state to disk.</p>
          <div className="hero-actions">
            <a href="#lead-intake" className="button primary">Create real lead</a>
            <button className="button secondary" type="button" onClick={() => void runAgentCycle()}><Bot size={16} /> Run autonomous cycle</button>
            <button className="button secondary" type="button" onClick={() => void runWorker()}><Play size={16} /> Run due worker</button>
          </div>
          {error && <p className="error-banner">{error}</p>}
        </div>
        <div className="agent-card">
          <Bot size={34} />
          <h2>{loading ? 'Connecting to agent API' : 'Agent API online'}</h2>
          <p>Next move: {nextMove}</p>
          <span className="trust"><ShieldCheck size={16} /> Backend persistence · Human approval gate</span>
        </div>
      </section>

      <section className="metrics" aria-label="Dashboard metrics">
        <article><CircleDollarSign /><span>Pipeline captured</span><strong>${stats.pipeline.toLocaleString()}</strong></article>
        <article><Flame /><span>Needs action</span><strong>{stats.hot}</strong></article>
        <article><PhoneCall /><span>Waiting approval</span><strong>{stats.waitingApproval}</strong></article>
        <article><CalendarCheck /><span>Scheduled tasks</span><strong>{stats.scheduled}</strong></article>
      </section>

      <section className="panel cockpit-panel">
        <div className="panel-heading">
          <Brain />
          <div>
            <h2>Autonomous agent cockpit</h2>
            <p>The agent now shows what it observed, why it chose an action, what it did, and what still needs owner approval.</p>
          </div>
        </div>
        <div className="cockpit-grid">
          <div className="autopilot-card">
            <span>Autopilot cycle</span>
            <strong>{cycleReport ? `Last ran ${new Date(cycleReport.startedAt).toLocaleTimeString()}` : 'Ready to run'}</strong>
            <p>{cycleReport ? `Imported ${cycleReport.imported}, drafted ${cycleReport.createdDrafts}, waiting approvals ${cycleReport.waitingApproval}, human handoffs ${cycleReport.needsHuman}.` : 'One click checks connected inboxes, imports new leads, drafts due follow-ups, and summarizes human decisions.'}</p>
            <button className="button primary" type="button" onClick={() => void runAgentCycle()}><Bot size={16} /> Run autonomous cycle</button>
          </div>
          <div className="decision-stream">
            {latestDecisions.length ? latestDecisions.map((decision) => (
              <article key={decision.id}>
                <span>{decision.type.replace('_', ' ')} · {decision.confidence}% confidence</span>
                <strong>{decision.observation}</strong>
                <p>{decision.reasoning}</p>
                <small>{decision.action}</small>
              </article>
            )) : <p className="empty-state">No decisions yet. Connect the demo inbox or create a lead, then run an autonomous cycle.</p>}
          </div>
        </div>
      </section>

      <section className="panel email-panel">
        <div className="panel-heading">
          <Mail />
          <div>
            <h2>Connected email inbox</h2>
            <p>Demo connector proves the workflow first. Gmail readiness checks the OAuth setup without collecting credentials in the browser.</p>
          </div>
        </div>
        <div className="email-actions">
          <button className="button primary" type="button" onClick={connectDemoInbox}>Connect demo inbox</button>
          <button className="button secondary" type="button" onClick={checkGmailReadiness}>Check Gmail readiness</button>
          <button className="button secondary" type="button" disabled={!activeInbox || unsyncedEmailCount === 0} onClick={syncInbox}><RefreshCw size={16} /> Sync inbox now</button>
        </div>
        {gmailStart && (
          <div className={`gmail-summary ${gmailStart.status}`}>
            <strong>{gmailStart.status === 'ready' ? 'Gmail OAuth ready' : 'Gmail setup required'}</strong>
            <span>{gmailStart.message}</span>
            <small>Scopes: {gmailStart.scopes.join(', ')}</small>
            {gmailStart.missing?.length ? <small>Missing: {gmailStart.missing.join(', ')}</small> : null}
            {gmailStart.authUrl ? <a href={gmailStart.authUrl} target="_blank" rel="noreferrer">Open Google consent screen</a> : null}
          </div>
        )}
        {activeInbox ? (
          <div className="inbox-summary">
            <strong>{activeInbox.email}</strong>
            <span>{activeInbox.provider} · {activeInbox.status} · {unsyncedEmailCount} unsynced emails</span>
            <small>{activeInbox.lastSyncAt ? `Last synced ${new Date(activeInbox.lastSyncAt).toLocaleString()}` : 'Not synced yet'}</small>
          </div>
        ) : <p className="empty-state">Connect the demo inbox to prove the agent can import email leads before we wire Gmail OAuth.</p>}
      </section>

      <section className="grid">
        <form id="lead-intake" className="panel" onSubmit={createLead}>
          <div className="panel-heading">
            <ClipboardCheck />
            <div>
              <h2>Inbound lead trigger</h2>
              <p>This POSTs to the backend and creates a persistent agent run.</p>
            </div>
          </div>

          <Field label="Lead name"><input required value={lead.name} onChange={(event) => update('name', event.target.value)} placeholder="Ada Okafor" /></Field>
          <Field label="Company"><input required value={lead.company} onChange={(event) => update('company', event.target.value)} placeholder="Ada Legal Group" /></Field>
          <Field label="Contact"><input value={lead.contact} onChange={(event) => update('contact', event.target.value)} placeholder="+1 555 123 4567" /></Field>
          <Field label="Service requested"><input required value={lead.service} onChange={(event) => update('service', event.target.value)} placeholder="Immigration consultation" /></Field>
          <div className="two-column">
            <Field label="Budget"><input required value={lead.budget} onChange={(event) => update('budget', event.target.value)} placeholder="2500" /></Field>
            <Field label="Urgency"><input required value={lead.urgency} onChange={(event) => update('urgency', event.target.value)} placeholder="ASAP" /></Field>
          </div>
          <Field label="Pain"><textarea required value={lead.pain} onChange={(event) => update('pain', event.target.value)} placeholder="Missing website leads after hours" /></Field>
          <Field label="Preferred channel">
            <select value={lead.channel} onChange={(event) => update('channel', event.target.value as LeadInput['channel'])}>
              <option>SMS</option><option>Email</option><option>Call</option>
            </select>
          </Field>
          <button className="button primary full" type="submit"><Send size={16} /> Create lead and draft response</button>
          <button className="button secondary full" type="button" onClick={reset}>Clear backend state</button>
        </form>

        <section className="panel" id="agent-run">
          <div className="panel-heading">
            <Brain />
            <div>
              <h2>Live agent workbench</h2>
              <p>{activeLead ? `${activeLead.company} · ${activeLead.status}` : 'No leads yet. Create one to start the loop.'}</p>
            </div>
          </div>

          {activeLead ? (
            <>
              <div className="lead-summary">
                <span className={`badge ${activeLead.status}`}>{activeLead.status.replace('_', ' ')}</span>
                <strong>{activeLead.company} needs {activeLead.service}</strong>
                <small>Budget {activeLead.budget} · Urgency {activeLead.urgency} · Channel {activeLead.channel}</small>
              </div>

              {activeLeadDecision && (
                <div className="reasoning-box">
                  <span>Latest agent reasoning</span>
                  <strong>{activeLeadDecision.observation}</strong>
                  <p>{activeLeadDecision.reasoning}</p>
                  <small>{activeLeadDecision.action}</small>
                </div>
              )}

              <div className="chat-thread">
                <span>Conversation Thread</span>
                <div className="chat-history">
                  {activeMessages.length ? activeMessages.slice().reverse().map((message) => (
                    <div key={message.id} className={`chat-message ${message.direction} ${message.status}`}>
                      <div className="message-content">{message.body}</div>
                      <div className="message-meta">
                        {message.status === 'draft' ? 'Draft' : message.status} · {new Date(message.createdAt).toLocaleTimeString()}
                      </div>
                    </div>
                  )) : <p className="empty-chat">No messages sent or received yet.</p>}
                </div>
              </div>

              <div className="approval-box">
                <span>{draft ? 'Draft waiting for owner approval' : scheduledFollowUp ? 'Follow-up scheduled' : 'No draft waiting'}</span>
                <p>{draft?.body || (scheduledFollowUp ? `Scheduled for ${new Date(scheduledFollowUp.dueAt).toLocaleString()}. Use the demo worker to draft it now.` : 'Approve sent drafts, run the worker, or simulate a reply to move the workflow.')}</p>
                <div className="action-row">
                  <button className="button primary" type="button" disabled={!draft} onClick={approveDraft}>Approve and mark sent</button>
                  <button className="button secondary" type="button" disabled={!scheduledFollowUp} onClick={() => void runWorker({ force: true })}>Draft next follow-up now</button>
                </div>
              </div>

              <div className="reply-box">
                <Field label="Simulate inbound reply">
                  <textarea value={reply} onChange={(event) => setReply(event.target.value)} />
                </Field>
                <button className="button secondary" type="button" onClick={recordReply}><MessageSquareReply size={16} /> Record reply</button>
              </div>

              <div className="agent-events">
                {activeTimeline.map((event) => (
                  <article key={event.id} className="complete">
                    <CheckCircle2 size={18} />
                    <div><strong>{event.label}</strong><p>{event.detail}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div>
                  </article>
                ))}
              </div>
            </>
          ) : <p className="empty-state">The backend is alive. The agent is waiting for the first inbound lead.</p>}
        </section>
      </section>

      <section className="panel sequence-panel">
        <div className="panel-heading"><Bot /><div><h2>Task queue and message ledger</h2><p>These are real records from the backend state file.</p></div></div>
        <div className="queue-grid">
          <div>
            <h3>Open tasks</h3>
            <div className="steps">{activeTasks.map((task) => <article key={task.id}><span>{task.type} · {task.status}</span><strong>{new Date(task.dueAt).toLocaleString()}</strong><p>{task.note}</p></article>)}</div>
          </div>
          <div>
            <h3>Messages</h3>
            <div className="steps">{activeMessages.map((message) => <article key={message.id}><span>{message.direction} · {message.status}</span><strong>{new Date(message.createdAt).toLocaleString()}</strong><p>{message.body}</p></article>)}</div>
          </div>
        </div>
      </section>
    </main>
  );
}
