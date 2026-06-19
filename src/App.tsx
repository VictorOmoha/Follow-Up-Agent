import { useEffect, useMemo, useState } from 'react';
import { Bot, Brain, CalendarCheck, CheckCircle2, CircleDollarSign, ClipboardCheck, Clock, Flame, Link, Mail, MessageSquareReply, PhoneCall, Play, RefreshCw, Send } from 'lucide-react';
import { type LeadInput, scoreLead } from './lib/agent';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || `${window.location.protocol}//${window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname}:8787/api`;

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
  config?: {
    bookingLink: string;
    autopilotEnabled?: boolean;
    geminiApiKeyConfigured?: boolean;
  };
};

type GmailOAuthStart = {
  status: 'setup_required' | 'ready';
  provider: 'gmail';
  missing?: string[];
  message: string;
  scopes: string[];
  authUrl?: string;
  redirectUri?: string;
  state?: string;
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
  const [inboxEmail, setInboxEmail] = useState('');
  const [state, setState] = useState<AgentState>(emptyState);
  const [gmailStart, setGmailStart] = useState<GmailOAuthStart | null>(null);
  const [cycleReport, setCycleReport] = useState<AgentCycleReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [bookingLink, setBookingLink] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  async function refresh() {
    try {
      setError('');
      const nextState = await api<AgentState>('/state');
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
      setBookingLink((current) => current || nextState.config?.bookingLink || '');
    } catch {
      setError('API offline. Start it with npm run dev.');
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
  const latestDecisions = state.decisions.slice(0, 8);
  const activeLeadDecision = activeLead ? state.decisions.find((decision) => decision.leadId === activeLead.id) : undefined;
  const draft = activeMessages.find((message) => message.direction === 'outbound' && message.status === 'draft');
  const scheduledFollowUp = activeTasks.find((task) => task.type === 'follow_up' && task.status === 'scheduled');
  const nextMove = draft
    ? 'Approve draft message'
    : scheduledFollowUp
      ? 'Awaiting next milestone'
      : activeLead?.status === 'needs_human'
        ? 'Lead needs human review'
        : 'Trigger a new lead';

  const stats = useMemo(() => {
    const waitingApproval = state.tasks.filter((task) => task.status === 'waiting_approval').length;
    const scheduled = state.tasks.filter((task) => task.status === 'scheduled').length;
    const hot = state.leads.filter((item) => item.status === 'waiting_approval' || item.status === 'needs_human').length;
    const pipeline = state.leads.reduce((sum, item) => sum + Number.parseFloat((item.budget || '0').replace(/[^0-9.]/g, '') || '0'), 0);

    const activeLeads = state.leads.filter((lead) => lead.status !== 'closed' && lead.status !== 'nurture');
    const moneyOnTable = activeLeads.reduce((sum, lead) => sum + Number.parseFloat((lead.budget || '0').replace(/[^0-9.]/g, '') || '0'), 0);
    const hotLeadsCount = activeLeads.filter((lead) => scoreLead(lead).temperature === 'Hot').length;
    const stalledLeadsCount = activeLeads.filter((lead) => {
      const lastUpdateMs = new Date(lead.updatedAt).getTime();
      return (new Date().getTime() - lastUpdateMs) > 24 * 60 * 60 * 1000;
    }).length;

    return { waitingApproval, scheduled, hot, pipeline, moneyOnTable, hotLeadsCount, stalledLeadsCount };
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
    const emailToConnect = inboxEmail.trim() || 'owner@omohasolutions.demo';
    if (emailToConnect.endsWith('.demo')) {
      await api('/inboxes', { method: 'POST', body: JSON.stringify({ provider: 'demo', email: emailToConnect }) });
      setInboxEmail('');
      await refresh();
    } else {
      const startResult = await api<GmailOAuthStart>(`/inboxes/gmail/start?email=${encodeURIComponent(emailToConnect)}`);
      if (startResult.authUrl) {
        window.location.href = startResult.authUrl;
      } else {
        alert(startResult.message || 'Setup required for Gmail.');
      }
    }
  }

  async function syncInbox() {
    if (!activeInbox) return;
    await api(`/inboxes/${activeInbox.id}/sync`, { method: 'POST' });
    await refresh();
  }

  async function checkGmailReadiness() {
    setGmailStart(await api<GmailOAuthStart>('/inboxes/gmail/start'));
  }

  async function toggleAutopilot() {
    try {
      const current = !!state.config?.autopilotEnabled;
      const nextState = await api<AgentState>('/config', {
        method: 'POST',
        body: JSON.stringify({ autopilotEnabled: !current }),
      });
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
    } catch (err) {
      console.error('Failed to toggle autopilot:', err);
    }
  }

  async function saveGeminiKey() {
    try {
      const nextState = await api<AgentState>('/config', {
        method: 'POST',
        body: JSON.stringify({ geminiApiKey: geminiApiKey.trim() }),
      });
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
      setGeminiApiKey('');
      alert('Gemini API Key saved successfully!');
    } catch (err) {
      console.error('Failed to save Gemini key:', err);
      alert('Failed to save Gemini API key.');
    }
  }

  async function saveBookingLink() {
    try {
      const nextState = await api<AgentState>('/config', {
        method: 'POST',
        body: JSON.stringify({ bookingLink: bookingLink.trim() }),
      });
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
    } catch (err) {
      console.error('Failed to save booking link:', err);
      alert('Failed to save booking link.');
    }
  }

  async function reset() {
    await api('/reset', { method: 'POST' });
    await refresh();
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-brand">
          <span className="eyebrow">Omoha Solutions</span>
          <h1>Follow-Up Agent</h1>
          {error && <span className="error-badge">{error}</span>}
        </div>

        <div className="header-metrics">
          <div className="metric-item">
            <CircleDollarSign size={16} />
            <span>Pipeline</span>
            <strong>${stats.pipeline.toLocaleString()}</strong>
          </div>
          <div className="metric-item">
            <Flame size={16} />
            <span>Hot Leads</span>
            <strong>{stats.hot}</strong>
          </div>
          <div className="metric-item">
            <PhoneCall size={16} />
            <span>Waiting Approval</span>
            <strong>{stats.waitingApproval}</strong>
          </div>
          <div className="metric-item">
            <CalendarCheck size={16} />
            <span>Scheduled</span>
            <strong>{stats.scheduled}</strong>
          </div>
        </div>

        <div className="header-status">
          <Bot size={16} />
          <span className="api-status">{loading ? 'Connecting' : 'API Online'}</span>
          <span className="next-move">Next: {nextMove}</span>
        </div>
      </header>

      <div className="workspace">
        {/* Column 1: Setup & Intake */}
        <aside className="workspace-column sidebar">
          {/* Inbox connection card */}
          <section className="panel email-panel">
            <div className="panel-heading">
              <Mail size={16} />
              <h2>Connected inbox</h2>
            </div>
            <div style={{ marginBottom: '8px' }}>
              <input 
                type="email" 
                placeholder="Enter your email (e.g. victor@example.com)" 
                aria-label="Inbox email"
                value={inboxEmail} 
                onChange={(event) => setInboxEmail(event.target.value)}
                style={{ fontSize: '0.75rem', padding: '6px 8px' }}
              />
            </div>
            <div className="email-actions">
              <button className="button primary sm" type="button" onClick={connectDemoInbox}>Connect</button>
              <button className="button secondary sm" type="button" onClick={checkGmailReadiness}>Check Gmail</button>
              <button className="button secondary sm" type="button" aria-label="Sync inbox now" disabled={!activeInbox || unsyncedEmailCount === 0} onClick={syncInbox}><RefreshCw size={14} /></button>
            </div>
            {gmailStart && (
              <div className={`gmail-summary ${gmailStart.status}`}>
                <strong>{gmailStart.status === 'ready' ? 'Gmail OAuth ready' : 'Setup required'}</strong>
                <p style={{ margin: '2px 0', fontSize: '0.7rem', color: '#94a3b8', lineHeight: 1.25 }}>{gmailStart.message}</p>
                <small style={{ display: 'block', fontSize: '0.65rem', color: '#64748b' }}>Scopes: {gmailStart.scopes.join(', ')}</small>
                {gmailStart.authUrl ? <a href={gmailStart.authUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: '4px' }}>Open consent screen</a> : null}
              </div>
            )}
            {activeInbox ? (
              <div className="inbox-summary">
                <strong>{activeInbox.email}</strong>
                <span>{activeInbox.provider} · {unsyncedEmailCount} unsynced emails</span>
              </div>
            ) : <p className="empty-state">No inbox connected.</p>}
          </section>

          {/* Owner Daily Digest card */}
          <section className="panel digest-panel" style={{ flexShrink: 0 }}>
            <div className="panel-heading">
              <Brain size={16} />
              <h2>Owner Daily Digest</h2>
            </div>
            <div className="digest-list">
              <div className="digest-item">
                <div className="digest-label-group">
                  <CircleDollarSign size={14} />
                  <span className="digest-label">Money on Table</span>
                </div>
                <strong className="digest-val">${stats.moneyOnTable.toLocaleString()}</strong>
              </div>
              <div className="digest-item">
                <div className="digest-label-group">
                  <Flame size={14} />
                  <span className="digest-label">Hot Leads</span>
                </div>
                <strong className="digest-val">{stats.hotLeadsCount}</strong>
              </div>
              <div className="digest-item">
                <div className="digest-label-group">
                  <Clock size={14} />
                  <span className="digest-label">Stalled Leads</span>
                </div>
                <strong className="digest-val">{stats.stalledLeadsCount}</strong>
              </div>
            </div>
          </section>

          {/* Calendar Integration card */}
          <section className="panel calendar-panel" style={{ flexShrink: 0 }}>
            <div className="panel-heading">
              <CalendarCheck size={16} />
              <h2>Calendar Link</h2>
            </div>
            {state.config?.bookingLink ? (
              <div className="calendar-content">
                <p className="calendar-desc">Active scheduling link used in follow-ups:</p>
                <div className="calendar-link-wrapper">
                  <a href={state.config.bookingLink} target="_blank" rel="noreferrer" className="calendar-link">
                    {state.config.bookingLink}
                  </a>
                </div>
              </div>
            ) : (
              <p className="empty-state">No booking link configured.</p>
            )}
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
              <input
                aria-label="Booking link"
                value={bookingLink}
                onChange={(event) => setBookingLink(event.target.value)}
                placeholder="https://cal.com/your-link"
                style={{ fontSize: '0.72rem', padding: '6px 8px', flex: 1 }}
              />
              <button className="button primary sm" type="button" onClick={saveBookingLink}>Save</button>
            </div>
          </section>

          {/* Gemini AI Config card */}
          <section className="panel gemini-panel" style={{ flexShrink: 0 }}>
            <div className="panel-heading">
              <Brain size={16} />
              <h2>Gemini AI Config</h2>
            </div>
            <p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '2px 0 8px 0', lineHeight: 1.3 }}>
              Configure your API key to enable dynamic LLM scoring and conversational replies.
            </p>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              <input
                type={showApiKey ? "text" : "password"}
                placeholder="Enter Gemini API Key"
                aria-label="Gemini API Key"
                value={geminiApiKey}
                onChange={(event) => setGeminiApiKey(event.target.value)}
                style={{ fontSize: '0.72rem', padding: '6px 8px', flex: 1 }}
              />
              <button
                className="button secondary sm"
                type="button"
                style={{ padding: '2px 8px' }}
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? "Hide" : "Show"}
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.68rem', fontWeight: 700, color: state.config?.geminiApiKeyConfigured ? '#4ade80' : '#f59e0b' }}>
                Mode: {state.config?.geminiApiKeyConfigured ? 'Live Gemini AI' : 'Rules Fallback'}
              </span>
              <button
                className="button primary sm"
                type="button"
                onClick={saveGeminiKey}
              >
                Save
              </button>
            </div>
          </section>

          {/* Webhook Intake card */}
          <section className="panel webhook-panel" style={{ flexShrink: 0 }}>
            <div className="panel-heading">
              <Link size={16} />
              <h2>Webhook Intake</h2>
            </div>
            <p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '2px 0 8px 0', lineHeight: 1.3 }}>
              Push inbound leads automatically from external CRMs or form webhooks.
            </p>
            <div style={{ 
              background: 'rgba(0, 0, 0, 0.2)', 
              border: '1px solid rgba(255, 255, 255, 0.05)', 
              borderRadius: '6px', 
              padding: '6px 8px', 
              marginBottom: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px'
            }}>
              <code style={{ fontSize: '0.62rem', color: '#4ade80', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                {window.location.protocol}//{window.location.hostname}:8787/api/webhooks/lead
              </code>
              <button 
                className="button secondary sm" 
                type="button"
                style={{ padding: '2px 6px', fontSize: '0.6rem', flexShrink: 0 }}
                onClick={() => {
                  navigator.clipboard.writeText(`${window.location.protocol}//${window.location.hostname}:8787/api/webhooks/lead`);
                  alert('Webhook URL copied to clipboard!');
                }}
              >
                Copy
              </button>
            </div>
            <details style={{ fontSize: '0.68rem', color: '#64748b' }}>
              <summary style={{ cursor: 'pointer', outline: 'none', userSelect: 'none', color: '#3b82f6' }}>Payload Schema</summary>
              <pre style={{ 
                background: '#020617', 
                padding: '6px', 
                borderRadius: '4px', 
                marginTop: '4px', 
                overflowX: 'auto',
                fontSize: '0.58rem',
                color: '#94a3b8',
                border: '1px solid rgba(255, 255, 255, 0.02)',
                fontFamily: 'monospace'
              }}>
{`{
  "name": "Jane Doe",
  "company": "Doe Corp",
  "email": "jane@example.com",
  "service": "roofing",
  "budget": "5000",
  "urgency": "ASAP",
  "pain": "roof leaks",
  "channel": "SMS"
}`}
              </pre>
            </details>
          </section>

          {/* Lead Intake trigger form */}
          <form className="panel lead-form" onSubmit={createLead}>
            <div className="panel-heading">
              <ClipboardCheck size={16} />
              <h2>Lead trigger</h2>
            </div>
            <div className="scrollable-form-fields">
              <Field label="Lead name"><input required value={lead.name} onChange={(event) => update('name', event.target.value)} placeholder="Ada Okafor" /></Field>
              <Field label="Company"><input required value={lead.company} onChange={(event) => update('company', event.target.value)} placeholder="Ada Legal Group" /></Field>
              <Field label="Contact"><input value={lead.contact} onChange={(event) => update('contact', event.target.value)} placeholder="+1 555 123 4567" /></Field>
              <Field label="Service requested"><input required value={lead.service} onChange={(event) => update('service', event.target.value)} placeholder="Immigration" /></Field>
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
            </div>
            <button className="button primary full" type="submit"><Send size={14} /> Create lead</button>
            <button className="button secondary full" type="button" onClick={reset}>Clear backend state</button>
          </form>
        </aside>

        {/* Column 2: Autopilot Cockpit */}
        <section className="workspace-column cockpit">
          <div className="panel fill-height flex-layout">
            <div className="panel-heading">
              <Brain size={16} />
              <h2>Autopilot cockpit</h2>
            </div>
            <div className="autopilot-card-compact">
              <div className="autopilot-header">
                <strong>Autopilot: {state.config?.autopilotEnabled ? 'ACTIVE (Auto-Send)' : 'PAUSED (Draft-Only)'}</strong>
                <div className="autopilot-buttons">
                  <button 
                    className={`button sm ${state.config?.autopilotEnabled ? 'secondary' : 'primary'}`} 
                    type="button" 
                    onClick={toggleAutopilot}
                  >
                    {state.config?.autopilotEnabled ? 'Pause Autopilot' : 'Enable Autopilot'}
                  </button>
                </div>
              </div>
              <p className="autopilot-summary">
                {state.config?.autopilotEnabled 
                  ? 'Agent autonomously triages inbound leads and sends due follow-up messages without manual approval.' 
                  : 'Agent runs in draft-only mode. All outbound responses require owner approval before sending.'}
              </p>
              {cycleReport && (
                <p className="autopilot-summary" style={{ marginTop: '4px', color: 'var(--accent-color)', fontWeight: 600 }}>
                  Last run: Imported {cycleReport.imported}, drafted {cycleReport.createdDrafts}, approvals {cycleReport.waitingApproval}, handoffs {cycleReport.needsHuman}.
                </p>
              )}
              <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.7rem', color: '#94a3b8', fontWeight: 600 }}>Demo controls:</span>
                <div className="autopilot-buttons">
                  <button className="button secondary sm" type="button" style={{ padding: '3px 8px', fontSize: '0.7rem' }} onClick={() => void runAgentCycle()}><Bot size={12} /> Run cycle</button>
                  <button className="button secondary sm" type="button" style={{ padding: '3px 8px', fontSize: '0.7rem' }} onClick={() => void runWorker()}><Play size={12} /> Run worker</button>
                </div>
              </div>
            </div>
            <div className="decision-stream-header">
              <span>Agent Decision log</span>
            </div>
            <div className="decision-stream">
              {latestDecisions.length ? latestDecisions.map((decision) => (
                <article key={decision.id} className="decision-log-item">
                  <div className="decision-meta">
                    <span className="decision-tag">{decision.type}</span>
                    <span className="decision-conf">{decision.confidence}% conf</span>
                  </div>
                  <strong>{decision.observation}</strong>
                  <p>{decision.reasoning}</p>
                  <small>{decision.action}</small>
                </article>
              )) : <p className="empty-state">No decisions logged yet.</p>}
            </div>
          </div>
        </section>

        {/* Column 3: Live Agent Workbench */}
        <section className="workspace-column workbench">
          <div className="panel fill-height flex-layout">
            <div className="panel-heading">
              <Bot size={16} />
              <h2>Live agent workbench</h2>
            </div>

            {activeLead ? (
              <div className="workbench-content">
                <div className="lead-summary-badge">
                  <span className={`badge ${activeLead.status}`}>{activeLead.status.replace('_', ' ')}</span>
                  <strong>{activeLead.name} ({activeLead.company})</strong>
                  <p>Needs: {activeLead.service} · Budget: {activeLead.budget} · Urgency: {activeLead.urgency} · Channel: {activeLead.channel}</p>
                </div>

                <div className="workbench-middle-section">
                  {activeLeadDecision && (
                    <div className="reasoning-box-compact">
                      <span>Reasoning</span>
                      <strong>{activeLeadDecision.observation}</strong>
                      <p>{activeLeadDecision.reasoning}</p>
                      <small>{activeLeadDecision.action}</small>
                    </div>
                  )}

                  <div className="agent-timeline-compact">
                    <span>Timeline & Tasks</span>
                    <div className="timeline-scroll">
                      {activeTasks.map((task) => (
                        <div key={task.id} className="timeline-event-item task-item">
                          <ClipboardCheck size={14} />
                          <div>
                            <strong>{task.type} · {task.status}</strong>
                            <p>{task.note}</p>
                            <small>Due: {new Date(task.dueAt).toLocaleTimeString()}</small>
                          </div>
                        </div>
                      ))}
                      {activeTimeline.map((event) => (
                        <div key={event.id} className="timeline-event-item">
                          <CheckCircle2 size={14} />
                          <div>
                            <strong>{event.label}</strong>
                            <p>{event.detail}</p>
                            <small>{new Date(event.createdAt).toLocaleTimeString()}</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="chat-thread-section">
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

                <div className="workbench-actions">
                  <div className="approval-row">
                    <div className="draft-preview-note">
                      <strong>{draft ? 'Draft waiting for owner approval' : scheduledFollowUp ? 'Follow-up scheduled' : 'No draft waiting'}</strong>
                      <p>{draft?.body || (scheduledFollowUp ? `Scheduled for ${new Date(scheduledFollowUp.dueAt).toLocaleString()}. Use the worker button to force draft it now.` : 'Approve sent drafts, run the worker, or simulate a reply to move the workflow.')}</p>
                    </div>
                    <div className="approval-buttons">
                      <button className="button primary" type="button" disabled={!draft} onClick={approveDraft}>Approve & Send</button>
                      <button className="button secondary" type="button" disabled={!scheduledFollowUp} onClick={() => void runWorker({ force: true })}>Draft next follow-up now</button>
                    </div>
                  </div>

                  <div className="reply-sim-row">
                    <input value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Type simulated lead reply here..." />
                    <button className="button secondary" type="button" onClick={recordReply}><MessageSquareReply size={16} /> Record reply</button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="empty-state">The backend is alive. The agent is waiting for the first inbound lead.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
