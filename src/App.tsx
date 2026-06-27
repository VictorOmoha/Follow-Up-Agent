import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot, Brain, CalendarCheck, CheckCircle2, CircleDollarSign, ClipboardCheck, Clock,
  Flame, Link, MessageSquareReply, Moon, PhoneCall, Play, RefreshCw, Send,
  Settings, Sun, X, Plus, Inbox, Zap,
} from 'lucide-react';
import { type LeadInput, scoreLead } from './lib/agent';
import './styles.css';

const defaultApiBase = (() => {
  const { protocol, hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${protocol}//127.0.0.1:8787/api`;
  }
  return '/api';
})();

const API_BASE = import.meta.env.VITE_API_BASE_URL || defaultApiBase;

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

function tempBadgeClass(temp: 'Hot' | 'Warm' | 'Nurture') {
  return temp === 'Hot' ? 'hot' : temp === 'Warm' ? 'warm' : 'nurture';
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
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewLeadForm, setShowNewLeadForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (theme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const refresh = useCallback(async () => {
    try {
      setError('');
      const nextState = await api<AgentState>('/state');
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
      setBookingLink((current) => current || nextState.config?.bookingLink || '');
      // Auto-select the most recent lead if none selected or selected lead no longer exists
      if (nextState.leads.length > 0) {
        const stillExists = nextState.leads.find((l) => l.id === selectedLeadId);
        if (!stillExists) {
          setSelectedLeadId(nextState.leads[0].id);
        }
      } else {
        setSelectedLeadId(null);
      }
    } catch {
      setError('API offline. Start it with npm run dev.');
    } finally {
      setLoading(false);
    }
  }, [selectedLeadId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const selectedLead = state.leads.find((l) => l.id === selectedLeadId) ?? null;
  const activeInbox = state.inboxes[0];
  const unsyncedEmailCount = activeInbox
    ? state.emailMessages.filter((e) => e.inboxId === activeInbox.id && !e.importedAt).length
    : 0;
  const activeMessages = selectedLead ? state.messages.filter((m) => m.leadId === selectedLead.id) : [];
  const activeTasks = selectedLead ? state.tasks.filter((t) => t.leadId === selectedLead.id && t.status !== 'done') : [];
  const activeTimeline = selectedLead ? state.timeline.filter((e) => e.leadId === selectedLead.id) : [];
  const latestDecisions = state.decisions.slice(0, 8);
  const selectedLeadDecision = selectedLead ? state.decisions.find((d) => d.leadId === selectedLead.id) : undefined;
  const draft = activeMessages.find((m) => m.direction === 'outbound' && m.status === 'draft');
  const scheduledFollowUp = activeTasks.find((t) => t.type === 'follow_up' && t.status === 'scheduled');

  // Adaptive primary action: one button that changes based on state.
  // This is cheap to derive each render; keeping it out of useMemo avoids stale callback/dependency churn.
  const primaryAction = (() => {
    if (draft) {
      return {
        label: 'Approve & Send Draft',
        icon: <Send size={16} />,
        onClick: () => void approveDraft(),
        disabled: false,
        variant: 'primary' as const,
      };
    }
    if (scheduledFollowUp) {
      return {
        label: 'Draft Next Follow-Up',
        icon: <Plus size={16} />,
        onClick: () => void runWorker({ force: true }),
        disabled: false,
        variant: 'primary' as const,
      };
    }
    if (selectedLead?.status === 'needs_human') {
      return {
        label: 'Lead Needs Your Review',
        icon: <ClipboardCheck size={16} />,
        onClick: () => {},
        disabled: true,
        variant: 'secondary' as const,
      };
    }
    if (state.leads.length === 0) {
      return {
        label: 'Create Your First Lead',
        icon: <Plus size={16} />,
        onClick: () => setShowNewLeadForm(true),
        disabled: false,
        variant: 'primary' as const,
      };
    }
    return {
      label: 'Run Agent Cycle',
      icon: <Zap size={16} />,
      onClick: () => void runAgentCycle(),
      disabled: false,
      variant: 'primary' as const,
    };
  })();

  const stats = useMemo(() => {
    const waitingApproval = state.tasks.filter((t) => t.status === 'waiting_approval').length;
    const scheduled = state.tasks.filter((t) => t.status === 'scheduled').length;
    const hot = state.leads.filter((l) => l.status === 'waiting_approval' || l.status === 'needs_human').length;
    const pipeline = state.leads.reduce((sum, l) => sum + Number.parseFloat((l.budget || '0').replace(/[^0-9.]/g, '') || '0'), 0);
    const activeLeads = state.leads.filter((l) => l.status !== 'closed' && l.status !== 'nurture');
    const moneyOnTable = activeLeads.reduce((sum, l) => sum + Number.parseFloat((l.budget || '0').replace(/[^0-9.]/g, '') || '0'), 0);
    const hotLeadsCount = activeLeads.filter((l) => scoreLead(l).temperature === 'Hot').length;
    const stalledLeadsCount = activeLeads.filter((l) => {
      const lastUpdateMs = new Date(l.updatedAt).getTime();
      return new Date().getTime() - lastUpdateMs > 24 * 60 * 60 * 1000;
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
    setShowNewLeadForm(false);
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
    if (!selectedLead) return;
    await api(`/leads/${selectedLead.id}/replies`, { method: 'POST', body: JSON.stringify({ body: reply }) });
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
      alert('Gemini API Key saved.');
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
    setSelectedLeadId(null);
    await refresh();
  }

  return (
    <div className="app-container">
      {/* Header */}
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
            <span>Hot</span>
            <strong>{stats.hot}</strong>
          </div>
          <div className="metric-item">
            <PhoneCall size={16} />
            <span>Approval</span>
            <strong>{stats.waitingApproval}</strong>
          </div>
          <div className="metric-item">
            <CalendarCheck size={16} />
            <span>Scheduled</span>
            <strong>{stats.scheduled}</strong>
          </div>
        </div>

        <div className="header-status">
          <a href="/demo-guide.html" className="button secondary sm" target="_blank" rel="noreferrer">Open demo guide</a>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="button secondary sm icon-btn"
            type="button"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="button secondary sm icon-btn"
            type="button"
            aria-label="Open settings"
          >
            <Settings size={14} />
          </button>
          <Bot size={16} />
          <span className="api-status">{loading ? 'Connecting' : 'Online'}</span>
        </div>
      </header>

      {/* Main Workspace: 3 columns - Lead List | Workbench | Decision Log */}
      <div className="workspace">
        {/* Column 1: Lead List */}
        <aside className="workspace-column lead-list-column">
          <div className="lead-list-header">
            <h2>Leads</h2>
            <button
              className="button primary sm"
              type="button"
              onClick={() => setShowNewLeadForm(true)}
            >
              <Plus size={14} /> New
            </button>
          </div>

          <div className="lead-list-summary">
            <div className="digest-mini">
              <CircleDollarSign size={12} />
              <span>${stats.moneyOnTable.toLocaleString()} on table</span>
            </div>
            <div className="digest-mini">
              <Flame size={12} />
              <span>{stats.hotLeadsCount} hot</span>
            </div>
            <div className="digest-mini">
              <Clock size={12} />
              <span>{stats.stalledLeadsCount} stalled</span>
            </div>
          </div>

          <div className="lead-list">
            {state.leads.length === 0 ? (
              <div className="lead-list-empty">
                <Bot size={28} />
                <p>No leads yet</p>
                <small>Create a lead to see the agent in action</small>
              </div>
            ) : (
              state.leads.map((l) => {
                const temp = scoreLead(l).temperature;
                const hasDraft = state.messages.some((m) => m.leadId === l.id && m.direction === 'outbound' && m.status === 'draft');
                const needsAction = l.status === 'waiting_approval' || l.status === 'needs_human' || hasDraft;
                return (
                  <button
                    key={l.id}
                    className={`lead-list-item ${selectedLeadId === l.id ? 'selected' : ''}`}
                    onClick={() => setSelectedLeadId(l.id)}
                    type="button"
                  >
                    <div className="lead-list-item-row">
                      <strong>{l.name || 'Unknown'}</strong>
                      {needsAction && <span className="action-dot" />}
                    </div>
                    <div className="lead-list-item-meta">
                      <span className={`badge ${tempBadgeClass(temp)}`}>{temp}</span>
                      <span className={`badge ${l.status}`}>{l.status.replace('_', ' ')}</span>
                    </div>
                    <small>{l.service} - {l.company}</small>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Column 2: Workbench (center, primary focus) */}
        <section className="workspace-column workbench">
          <div className="panel fill-height flex-layout">
            {selectedLead ? (
              <div className="workbench-content">
                {/* Lead summary */}
                <div className="lead-summary-badge">
                  <div className="lead-summary-top">
                    <span className={`badge ${selectedLead.status}`}>{selectedLead.status.replace('_', ' ')}</span>
                    <strong>{selectedLead.name} ({selectedLead.company})</strong>
                  </div>
                  <p>Needs: {selectedLead.service} - Budget: {selectedLead.budget} - Urgency: {selectedLead.urgency} - Channel: {selectedLead.channel}</p>
                </div>

                {/* Reasoning + Timeline */}
                <div className="workbench-middle-section">
                  {selectedLeadDecision && (
                    <div className="reasoning-box-compact">
                      <span>Agent Reasoning</span>
                      <strong>{selectedLeadDecision.observation}</strong>
                      <p>{selectedLeadDecision.reasoning}</p>
                      <small>{selectedLeadDecision.action}</small>
                    </div>
                  )}
                  <div className="agent-timeline-compact">
                    <span>Timeline & Tasks</span>
                    <div className="timeline-scroll">
                      {activeTasks.map((task) => (
                        <div key={task.id} className="timeline-event-item task-item">
                          <ClipboardCheck size={14} />
                          <div>
                            <strong>{task.type.replace('_', ' ')} - {task.status.replace('_', ' ')}</strong>
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

                {/* Conversation thread */}
                <div className="chat-thread-section">
                  <span>Conversation Thread</span>
                  <div className="chat-history">
                    {activeMessages.length ? activeMessages.slice().reverse().map((message) => (
                      <div key={message.id} className={`chat-message ${message.direction} ${message.status}`}>
                        <div className="message-content">{message.body}</div>
                        <div className="message-meta">
                          {message.status === 'draft' ? 'Draft' : message.status} - {new Date(message.createdAt).toLocaleTimeString()}
                        </div>
                      </div>
                    )) : <p className="empty-chat">No messages yet. The agent will draft the first response once a lead is created.</p>}
                  </div>
                </div>

                {/* Primary action area */}
                <div className="workbench-actions">
                  <div className="primary-action-row">
                    <div className="draft-preview-note">
                      <strong>
                        {draft ? 'Draft waiting for approval' :
                         scheduledFollowUp ? `Follow-up scheduled for ${new Date(scheduledFollowUp.dueAt).toLocaleTimeString()}` :
                         selectedLead.status === 'needs_human' ? 'This lead needs your review' :
                         'All caught up'}
                      </strong>
                      <p>{draft?.body || scheduledFollowUp?.note || 'Run the agent cycle to check for new inbox leads and due follow-ups.'}</p>
                    </div>
                    <button
                      className={`button ${primaryAction.variant}`}
                      type="button"
                      disabled={primaryAction.disabled}
                      onClick={primaryAction.onClick}
                    >
                      {primaryAction.icon}
                      {primaryAction.label}
                    </button>
                  </div>

                  {/* Reply simulation */}
                  <div className="reply-sim-row">
                    <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Simulate a lead reply..." />
                    <button className="button secondary" type="button" onClick={recordReply}>
                      <MessageSquareReply size={16} /> Record Reply
                    </button>
                  </div>

                  {/* Advanced controls collapsed by default */}
                  <button
                    className="advanced-toggle"
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                  >
                    {showAdvanced ? 'Hide' : 'Show'} advanced controls
                  </button>
                  {showAdvanced && (
                    <div className="advanced-controls">
                      <button className="button secondary sm" type="button" onClick={() => void runAgentCycle()}>
                        <Zap size={12} /> Run agent cycle
                      </button>
                      <button className="button secondary sm" type="button" onClick={() => void runWorker()}>
                        <Play size={12} /> Run worker
                      </button>
                      <button className="button secondary sm" type="button" onClick={() => void toggleAutopilot()}>
                        {state.config?.autopilotEnabled ? 'Pause autopilot' : 'Enable autopilot'}
                      </button>
                      {cycleReport && (
                        <span className="cycle-report-mini">
                          Last cycle: {cycleReport.imported} imported, {cycleReport.createdDrafts} drafted
                        </span>
                      )}
                      <button className="button secondary sm danger" type="button" onClick={reset}>
                        Clear all data
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              /* Guided empty state */
              <div className="guided-empty">
                <Bot size={48} />
                <h2>The agent is ready and waiting</h2>
                <p>This is your Follow-Up Agent dashboard. It will automatically triage inbound leads, draft responses, and schedule follow-ups.</p>
                <div className="empty-steps">
                  <div className="empty-step">
                    <span className="step-number">1</span>
                    <div>
                      <strong>Create a test lead</strong>
                      <p>Add a lead manually to see how the agent scores, drafts, and schedules follow-ups.</p>
                    </div>
                  </div>
                  <div className="empty-step">
                    <span className="step-number">2</span>
                    <div>
                      <strong>Approve the draft</strong>
                      <p>The agent will draft a first response. Review it and approve to send via SMS, email, or call.</p>
                    </div>
                  </div>
                  <div className="empty-step">
                    <span className="step-number">3</span>
                    <div>
                      <strong>Watch the follow-up sequence</strong>
                      <p>The agent schedules the next follow-up automatically. Use "Draft Next Follow-Up" to advance it.</p>
                    </div>
                  </div>
                </div>
                <button className="button primary" type="button" onClick={() => setShowNewLeadForm(true)}>
                  <Plus size={18} /> Create Your First Lead
                </button>
                <button className="button secondary" type="button" onClick={() => setShowSettings(true)}>
                  <Settings size={16} /> Configure inbox, AI, and integrations
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Column 3: Decision Log */}
        <aside className="workspace-column decision-column">
          <div className="panel fill-height flex-layout">
            <div className="panel-heading">
              <Brain size={16} />
              <h2>Agent Decisions</h2>
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
              )) : (
                <p className="empty-state">No decisions logged yet. The agent starts reasoning once a lead comes in.</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* New Lead Modal */}
      {showNewLeadForm && (
        <div className="modal-overlay" onClick={() => setShowNewLeadForm(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Create a Lead</h2>
            </div>
            <form onSubmit={createLead}>
              <div className="scrollable-form-fields">
                <Field label="Lead name"><input required value={lead.name} onChange={(e) => update('name', e.target.value)} placeholder="Ada Okafor" /></Field>
                <Field label="Company"><input required value={lead.company} onChange={(e) => update('company', e.target.value)} placeholder="Ada Legal Group" /></Field>
                <Field label="Contact (phone or email)"><input value={lead.contact} onChange={(e) => update('contact', e.target.value)} placeholder="+1 555 123 4567" /></Field>
                <Field label="Service requested"><input required value={lead.service} onChange={(e) => update('service', e.target.value)} placeholder="Immigration consultation" /></Field>
                <div className="two-column">
                  <Field label="Budget"><input required value={lead.budget} onChange={(e) => update('budget', e.target.value)} placeholder="2500" /></Field>
                  <Field label="Urgency"><input required value={lead.urgency} onChange={(e) => update('urgency', e.target.value)} placeholder="ASAP" /></Field>
                </div>
                <Field label="Pain point"><textarea required value={lead.pain} onChange={(e) => update('pain', e.target.value)} placeholder="Missing website leads after hours" /></Field>
                <Field label="Preferred channel">
                  <select value={lead.channel} onChange={(e) => update('channel', e.target.value as LeadInput['channel'])}>
                    <option>SMS</option><option>Email</option><option>Call</option>
                  </select>
                </Field>
              </div>
              <div className="modal-actions">
                <button className="button secondary" type="button" onClick={() => setShowNewLeadForm(false)}>Cancel</button>
                <button className="button primary" type="submit"><Send size={14} /> Create lead</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Settings Drawer */}
      {showSettings && (
        <div className="drawer-overlay" onClick={() => setShowSettings(false)}>
          <div className="drawer-content" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h2>Settings</h2>
              <button className="button secondary sm icon-btn" type="button" onClick={() => setShowSettings(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="drawer-body">
              {/* Autopilot */}
              <section className="panel drawer-panel">
                <div className="panel-heading">
                  <Zap size={16} />
                  <h2>Autopilot Mode</h2>
                </div>
                <div className="autopilot-card-compact">
                  <div className="autopilot-header">
                    <strong>{state.config?.autopilotEnabled ? 'ACTIVE (Auto-Send)' : 'PAUSED (Draft-Only)'}</strong>
                    <button
                      className={`button sm ${state.config?.autopilotEnabled ? 'secondary' : 'primary'}`}
                      type="button"
                      onClick={toggleAutopilot}
                    >
                      {state.config?.autopilotEnabled ? 'Pause' : 'Enable'}
                    </button>
                  </div>
                  <p className="autopilot-summary">
                    {state.config?.autopilotEnabled
                      ? 'Agent autonomously triages leads and sends follow-ups without manual approval.'
                      : 'Agent runs in draft-only mode. All responses require owner approval before sending.'}
                  </p>
                </div>
              </section>

              {/* Inbox Connection */}
              <section className="panel drawer-panel">
                <div className="panel-heading">
                  <Inbox size={16} />
                  <h2>Connected Inbox</h2>
                </div>
                <p className="drawer-desc">Connect an inbox so the agent can import leads from email automatically. Use a .demo email for testing.</p>
                <input
                  type="email"
                  placeholder="owner@omohasolutions.demo"
                  aria-label="Inbox email"
                  value={inboxEmail}
                  onChange={(e) => setInboxEmail(e.target.value)}
                  style={{ fontSize: '0.8rem', padding: '8px 10px', marginBottom: '8px' }}
                />
                <div className="email-actions">
                  <button className="button primary sm" type="button" onClick={connectDemoInbox}>Connect</button>
                  <button className="button secondary sm" type="button" onClick={checkGmailReadiness}>Check Gmail</button>
                  <button className="button secondary sm icon-btn" type="button" aria-label="Sync inbox" disabled={!activeInbox || unsyncedEmailCount === 0} onClick={syncInbox}>
                    <RefreshCw size={14} />
                  </button>
                </div>
                {gmailStart && (
                  <div className={`gmail-summary ${gmailStart.status}`}>
                    <strong>{gmailStart.status === 'ready' ? 'Gmail OAuth ready' : 'Setup required'}</strong>
                    <p style={{ margin: '2px 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{gmailStart.message}</p>
                    <small style={{ display: 'block', fontSize: '0.65rem', color: '#64748b' }}>Scopes: {gmailStart.scopes.join(', ')}</small>
                    {gmailStart.authUrl ? <a href={gmailStart.authUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: '4px' }}>Open consent screen</a> : null}
                  </div>
                )}
                {activeInbox ? (
                  <div className="inbox-summary">
                    <strong>{activeInbox.email}</strong>
                    <span>{activeInbox.provider} - {unsyncedEmailCount} unsynced</span>
                  </div>
                ) : <p className="empty-state">No inbox connected.</p>}
              </section>

              {/* Calendar Link */}
              <section className="panel drawer-panel">
                <div className="panel-heading">
                  <CalendarCheck size={16} />
                  <h2>Calendar Link</h2>
                </div>
                <p className="drawer-desc">This booking link is embedded in follow-up messages to leads.</p>
                {state.config?.bookingLink && (
                  <div className="calendar-link-wrapper" style={{ marginBottom: '8px' }}>
                    <a href={state.config.bookingLink} target="_blank" rel="noreferrer" className="calendar-link">
                      {state.config.bookingLink}
                    </a>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    aria-label="Booking link"
                    value={bookingLink}
                    onChange={(e) => setBookingLink(e.target.value)}
                    placeholder="https://cal.com/your-link"
                    style={{ fontSize: '0.8rem', padding: '8px 10px', flex: 1 }}
                  />
                  <button className="button primary sm" type="button" onClick={saveBookingLink}>Save</button>
                </div>
              </section>

              {/* Gemini AI */}
              <section className="panel drawer-panel">
                <div className="panel-heading">
                  <Brain size={16} />
                  <h2>Gemini AI</h2>
                </div>
                <p className="drawer-desc">Add a Gemini API key to enable AI-powered lead scoring and conversational follow-up drafting. Without it, the agent uses rules-based logic.</p>
                {state.config?.geminiApiKeyConfigured ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#4ade80' }}>
                      Live Gemini AI (configured server-side)
                    </span>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        placeholder="Enter Gemini API Key"
                        aria-label="Gemini API Key"
                        value={geminiApiKey}
                        onChange={(e) => setGeminiApiKey(e.target.value)}
                        style={{ fontSize: '0.8rem', padding: '8px 10px', flex: 1 }}
                      />
                      <button className="button secondary sm" type="button" style={{ padding: '4px 10px' }} onClick={() => setShowApiKey(!showApiKey)}>
                        {showApiKey ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#f59e0b' }}>
                        Rules Fallback
                      </span>
                      <button className="button primary sm" type="button" onClick={saveGeminiKey}>Save</button>
                    </div>
                  </>
                )}
              </section>

              {/* Webhook Intake */}
              <section className="panel drawer-panel">
                <div className="panel-heading">
                  <Link size={16} />
                  <h2>Webhook Intake</h2>
                </div>
                <p className="drawer-desc">Push inbound leads automatically from external CRMs or form webhooks to this endpoint.</p>
                <div className="webhook-url-box">
                  <code>{window.location.protocol}//{window.location.hostname}:8787/api/webhooks/lead</code>
                  <button
                    className="button secondary sm"
                    type="button"
                    style={{ padding: '4px 8px', fontSize: '0.65rem', flexShrink: 0 }}
                    onClick={() => {
                      navigator.clipboard.writeText(`${window.location.protocol}//${window.location.hostname}:8787/api/webhooks/lead`);
                      alert('Webhook URL copied.');
                    }}
                  >
                    Copy
                  </button>
                </div>
                <details style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '8px' }}>
                  <summary style={{ cursor: 'pointer', color: '#38bdf8' }}>Payload schema</summary>
                  <pre style={{ background: 'var(--bg-darkest)', padding: '8px', borderRadius: '4px', marginTop: '4px', overflowX: 'auto', fontSize: '0.6rem', color: '#94a3b8' }}>
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

              {/* Danger zone */}
              <section className="panel drawer-panel">
                <div className="panel-heading">
                  <X size={16} />
                  <h2>Reset Data</h2>
                </div>
                <p className="drawer-desc">Clear all leads, messages, tasks, and timeline. Useful for starting a fresh demo.</p>
                <button className="button secondary sm danger" type="button" onClick={reset}>
                  Clear all data
                </button>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}