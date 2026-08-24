import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot, Brain, CalendarCheck, CheckCircle2, CircleDollarSign, ClipboardCheck, Clock,
  Flame, Link, MessageSquareReply, Moon, PhoneCall, Play, RefreshCw, Send,
  Settings, ShieldAlert, Sun, X, Plus, Inbox, Zap, HeartHandshake,
} from 'lucide-react';
import { type LeadInput, scoreLead } from './lib/agent';
import { api, ApiError, webhookEndpoint } from './lib/api';
import { SignInScreen } from './components/SignInScreen';
import './styles.css';

type LeadRecord = LeadInput & {
  id: string;
  contact?: string;
  status: 'new' | 'waiting_approval' | 'contacted' | 'needs_human' | 'nurture' | 'closed';
  createdAt: string;
  updatedAt: string;
  owner?: string;
  renewalAt?: string;
  openIssues?: string[];
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
  type: 'triage' | 'draft' | 'schedule' | 'inbox_sync' | 'reply_analysis' | 'autopilot' | 'retention';
  observation: string;
  reasoning: string;
  action: string;
  confidence: number;
  createdAt: string;
};

type RetentionRiskReason = {
  code: string;
  label: string;
  detail: string;
  weight: number;
};

type RetentionQueueItem = {
  leadId: string;
  name: string;
  company: string;
  owner: string;
  score: number;
  level: 'critical' | 'high' | 'watch' | 'healthy';
  reasons: RetentionRiskReason[];
  recommendedAction: string;
  approvalState: 'waiting_approval' | 'scheduled' | 'none';
  dueAt?: string;
  draftMessageId?: string;
  lastActivityAt: string;
};

type RetentionSnapshot = {
  generatedAt: string;
  queue: RetentionQueueItem[];
  metrics: {
    totalAccounts: number;
    atRiskAccounts: number;
    highRiskAccounts: number;
    overdueFollowUps: number;
    waitingApproval: number;
    recoveredAccounts: number;
    recoveryRate: number;
  };
  outcomes: Array<{
    id: string;
    leadId: string;
    outcome: 'recovered' | 'monitoring' | 'lost' | 'no_response';
    note?: string;
    recordedAt: string;
  }>;
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
  retention?: RetentionSnapshot;
  config?: {
    bookingLink: string;
    autopilotEnabled?: boolean;
    geminiApiKeyConfigured?: boolean;
    gmailSyncQuery?: string;
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

const emptyRetention: RetentionSnapshot = {
  generatedAt: '',
  queue: [],
  metrics: { totalAccounts: 0, atRiskAccounts: 0, highRiskAccounts: 0, overdueFollowUps: 0, waitingApproval: 0, recoveredAccounts: 0, recoveryRate: 0 },
  outcomes: [],
};

const emptyState: AgentState = { leads: [], messages: [], tasks: [], timeline: [], decisions: [], inboxes: [], emailMessages: [], retention: emptyRetention };

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

function tempBadgeClass(temp: 'Hot' | 'Warm' | 'Nurture') {
  return temp === 'Hot' ? 'hot' : temp === 'Warm' ? 'warm' : 'nurture';
}

function formatBudget(budget?: string) {
  const digits = (budget || '').replace(/[^0-9.]/g, '');
  const amount = Number.parseFloat(digits);
  if (!digits || Number.isNaN(amount) || amount <= 0) return budget?.trim() || 'unknown';
  return `$${amount.toLocaleString()}`;
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
  const [gmailSyncQuery, setGmailSyncQuery] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewLeadForm, setShowNewLeadForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [leadFilter, setLeadFilter] = useState<'all' | 'action' | 'stalled'>('all');
  const [mobileView, setMobileView] = useState<'leads' | 'conversation' | 'activity'>('leads');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<'leads' | 'retention'>('leads');

  useEffect(() => {
    function closeOverlay(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setShowSettings(false);
        setShowNewLeadForm(false);
      }
    }
    window.addEventListener('keydown', closeOverlay);
    return () => window.removeEventListener('keydown', closeOverlay);
  }, []);

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
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [], retention: nextState.retention ?? emptyRetention });
      setBookingLink((current) => current || nextState.config?.bookingLink || '');
      setGmailSyncQuery((current) => current || nextState.config?.gmailSyncQuery || '');
      // Auto-select the most recent lead if none selected or selected lead no longer exists
      if (nextState.leads.length > 0) {
        const stillExists = nextState.leads.find((l) => l.id === selectedLeadId);
        if (!stillExists) {
          setSelectedLeadId(nextState.leads[0].id);
        }
      } else {
        setSelectedLeadId(null);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNeedsSignIn(true);
        setError('');
      } else {
        setError('API offline or unavailable.');
      }
    } finally {
      setLoading(false);
    }
  }, [selectedLeadId]);

  useEffect(() => {
    void refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [refresh]);

  const selectedLead = state.leads.find((l) => l.id === selectedLeadId) ?? null;
  const actionableLeadIds = new Set(state.leads.filter((leadRecord) => {
    const hasDraft = state.messages.some((message) => message.leadId === leadRecord.id && message.direction === 'outbound' && message.status === 'draft');
    return hasDraft || leadRecord.status === 'waiting_approval' || leadRecord.status === 'needs_human';
  }).map((leadRecord) => leadRecord.id));
  const stalledLeadIds = new Set(state.leads.filter((leadRecord) => {
    if (leadRecord.status === 'closed' || leadRecord.status === 'nurture') return false;
    return Date.now() - new Date(leadRecord.updatedAt).getTime() > 24 * 60 * 60 * 1000;
  }).map((leadRecord) => leadRecord.id));
  const visibleLeads = state.leads
    .filter((leadRecord) => leadFilter === 'all' || (leadFilter === 'action' ? actionableLeadIds.has(leadRecord.id) : stalledLeadIds.has(leadRecord.id)))
    .sort((left, right) => Number(actionableLeadIds.has(right.id)) - Number(actionableLeadIds.has(left.id)) || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const selectedRetention = state.retention?.queue.find((item) => item.leadId === selectedLeadId);
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
    if (workspaceMode === 'retention' && selectedLead && selectedRetention && selectedRetention.score > 0) {
      return {
        label: 'Prepare Retention Draft',
        icon: <HeartHandshake size={16} />,
        onClick: () => void prepareRetentionDraft(),
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
    setPendingAction('approve');
    try {
      await api(`/messages/${draft.id}/approve`, { method: 'POST' });
      await refresh();
    } finally {
      setPendingAction(null);
    }
  }

  async function runWorker({ force = false }: { force?: boolean } = {}) {
    setPendingAction('worker');
    try {
      await api('/worker/run', { method: 'POST', body: JSON.stringify({ force }) });
      await refresh();
    } finally {
      setPendingAction(null);
    }
  }

  async function runAgentCycle() {
    setPendingAction('cycle');
    try {
      setCycleReport(await api<AgentCycleReport>('/agent/cycle', { method: 'POST' }));
      await refresh();
    } finally {
      setPendingAction(null);
    }
  }

  async function recordReply() {
    if (!selectedLead) return;
    await api(`/leads/${selectedLead.id}/replies`, { method: 'POST', body: JSON.stringify({ body: reply }) });
    await refresh();
  }

  async function prepareRetentionDraft() {
    if (!selectedLead) return;
    await api(`/retention/${selectedLead.id}/draft`, { method: 'POST' });
    await refresh();
  }

  async function recordRetentionOutcome(outcome: 'recovered' | 'monitoring' | 'lost' | 'no_response') {
    if (!selectedLead) return;
    await api(`/retention/${selectedLead.id}/outcomes`, {
      method: 'POST',
      body: JSON.stringify({ outcome }),
    });
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
      if (!current && !window.confirm('Enable Autopilot? The agent may send follow-ups without per-message approval.')) return;
      const nextState = await api<AgentState>('/config', {
        method: 'POST',
        body: JSON.stringify({ autopilotEnabled: !current, confirmAutopilot: !current }),
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

  async function saveGmailSyncQuery() {
    try {
      const nextState = await api<AgentState>('/config', {
        method: 'POST',
        body: JSON.stringify({ gmailSyncQuery: gmailSyncQuery.trim() }),
      });
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
    } catch (err) {
      console.error('Failed to save Gmail sync query:', err);
      alert('Failed to save Gmail sync filter.');
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

  function changeLeadFilter(nextFilter: 'all' | 'action' | 'stalled') {
    setLeadFilter(nextFilter);
    const matches = state.leads.filter((leadRecord) => nextFilter === 'all'
      || (nextFilter === 'action' ? actionableLeadIds.has(leadRecord.id) : stalledLeadIds.has(leadRecord.id)));
    if (!selectedLeadId || !matches.some((leadRecord) => leadRecord.id === selectedLeadId)) {
      setSelectedLeadId(matches[0]?.id ?? null);
      if (matches.length === 0) setMobileView('leads');
    }
  }

  async function logout() {
    await api<void>('/session/logout', { method: 'POST' });
    setState(emptyState);
    setSelectedLeadId(null);
    setNeedsSignIn(true);
  }

  async function reset() {
    if (!window.confirm('Clear every lead, message, task, and timeline entry? This cannot be undone.')) return;
    await api('/reset', { method: 'POST', body: JSON.stringify({ confirmation: 'CLEAR ALL DATA' }) });
    setSelectedLeadId(null);
    await refresh();
  }

  if (needsSignIn) {
    return <SignInScreen onSignedIn={async () => { setNeedsSignIn(false); await refresh(); }} />;
  }

  const webhookUrl = webhookEndpoint();

  return (
    <div className="app-container">
      {/* Header - slim, no metrics crammed in */}
      <header className="app-header">
        <div className="header-brand">
          <span className="eyebrow">Omoha Solutions</span>
          <div className="brand-title-row">
            <h1>Follow-Up Agent</h1>
            {error && <span className="error-badge">{error}</span>}
          </div>
        </div>

        <div className="header-status">
          <button
            className={`button sm ${workspaceMode === 'retention' ? 'primary' : 'secondary'}`}
            type="button"
            onClick={() => setWorkspaceMode(workspaceMode === 'retention' ? 'leads' : 'retention')}
          >
            <ShieldAlert size={14} /> {workspaceMode === 'retention' ? 'Lead workflow' : 'Retention'}
          </button>
          <a href="/demo-guide.html" className="button secondary sm" target="_blank" rel="noreferrer">Demo guide</a>
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
          <button onClick={() => void logout()} className="button secondary sm" type="button">Sign out</button>
          <span className="status-dot-wrapper">
            <span className={`status-dot ${loading ? 'connecting' : 'online'}`} />
            <span className="api-status">{loading ? 'Connecting' : 'Online'}</span>
          </span>
        </div>
      </header>

      {state.config?.autopilotEnabled && (
        <div className="autopilot-banner" role="status">
          <div><Zap size={16} /><strong>Autopilot is on</strong><span>Messages may send without per-message approval.</span></div>
          <button className="button secondary sm" type="button" onClick={toggleAutopilot}>Pause autopilot</button>
        </div>
      )}

      <nav className="mobile-workspace-nav" aria-label="Workspace views">
        <button className={mobileView === 'leads' ? 'active' : ''} onClick={() => setMobileView('leads')} type="button">Leads</button>
        <button className={mobileView === 'conversation' ? 'active' : ''} onClick={() => setMobileView('conversation')} type="button">Conversation</button>
        <button className={mobileView === 'activity' ? 'active' : ''} onClick={() => setMobileView('activity')} type="button">Activity</button>
      </nav>

      {/* Main Workspace: 3 columns - Lead List | Workbench | Agent Activity */}
      <div className={`workspace mobile-view-${mobileView}`}>
        {/* Column 1: Lead List + Stats */}
        <aside className="workspace-column lead-list-column">
          <div className="lead-list-header">
            <h2>{workspaceMode === 'retention' ? 'Retention Queue' : 'Leads'}</h2>
            <button
              className="button primary sm"
              type="button"
              onClick={() => setShowNewLeadForm(true)}
            >
              <Plus size={14} /> New
            </button>
          </div>

          {/* Stat cards replacing the old header metrics + digest */}
          {workspaceMode === 'retention' ? (
            <div className="sidebar-stats">
              <div className="stat-card stat-money">
                <ShieldAlert size={14} />
                <div><strong>{state.retention?.metrics.atRiskAccounts ?? 0}</strong><span>accounts at risk</span></div>
              </div>
              <div className="stat-card-row">
                <div className="stat-card stat-hot"><Flame size={12} /><strong>{state.retention?.metrics.highRiskAccounts ?? 0}</strong><span>high risk</span></div>
                <div className="stat-card stat-stalled"><Clock size={12} /><strong>{state.retention?.metrics.overdueFollowUps ?? 0}</strong><span>overdue</span></div>
              </div>
              <div className="stat-card-row">
                <div className="stat-card stat-approval"><PhoneCall size={12} /><strong>{state.retention?.metrics.waitingApproval ?? 0}</strong><span>approval</span></div>
                <div className="stat-card stat-scheduled"><HeartHandshake size={12} /><strong>{state.retention?.metrics.recoveryRate ?? 0}%</strong><span>recovery</span></div>
              </div>
            </div>
          ) : (
            <div className="sidebar-stats">
              <div className="stat-card stat-money">
                <CircleDollarSign size={14} />
                <div><strong>${stats.moneyOnTable.toLocaleString()}</strong><span>on table</span></div>
              </div>
              <div className="stat-card-row">
                <div className="stat-card stat-hot"><Flame size={12} /><strong>{stats.hotLeadsCount}</strong><span>hot</span></div>
                <div className="stat-card stat-stalled"><Clock size={12} /><strong>{stats.stalledLeadsCount}</strong><span>stalled</span></div>
              </div>
              <div className="stat-card-row">
                <div className="stat-card stat-approval"><PhoneCall size={12} /><strong>{stats.waitingApproval}</strong><span>approval</span></div>
                <div className="stat-card stat-scheduled"><CalendarCheck size={12} /><strong>{stats.scheduled}</strong><span>scheduled</span></div>
              </div>
            </div>
          )}

          <div className="lead-filters" role="group" aria-label="Filter leads">
            <button className={leadFilter === 'all' ? 'active' : ''} type="button" onClick={() => changeLeadFilter('all')}>All <span>{state.leads.length}</span></button>
            <button className={leadFilter === 'action' ? 'active' : ''} type="button" onClick={() => changeLeadFilter('action')}>Action <span>{actionableLeadIds.size}</span></button>
            <button className={leadFilter === 'stalled' ? 'active' : ''} type="button" onClick={() => changeLeadFilter('stalled')}>Stalled <span>{stalledLeadIds.size}</span></button>
          </div>
          <div className="lead-list">
            {(workspaceMode === 'retention' ? state.retention?.queue.length === 0 : state.leads.length === 0) ? (
              <div className="lead-list-empty">
                <Bot size={28} />
                <p>{workspaceMode === 'retention' ? 'No active accounts' : 'No leads yet'}</p>
                <small>{workspaceMode === 'retention' ? 'Active leads will appear here with transparent health scores' : 'Create a lead to see the agent in action'}</small>
              </div>
            ) : workspaceMode === 'retention' ? (
              state.retention?.queue.map((item) => (
                <button
                  key={item.leadId}
                  className={`lead-list-item retention-queue-item ${selectedLeadId === item.leadId ? 'selected' : ''}`}
                  onClick={() => { setSelectedLeadId(item.leadId); setMobileView('conversation'); }}
                  type="button"
                >
                  <div className="lead-list-item-row">
                    <strong>{item.company}</strong>
                    <span className={`risk-score ${item.level}`}>{item.score}</span>
                  </div>
                  <div className="lead-list-item-meta">
                    <span className={`badge risk-${item.level}`}>{item.level}</span>
                    <span className="retention-owner">{item.owner}</span>
                  </div>
                  <small>{item.reasons[0]?.label || 'Healthy - monitoring'}</small>
                </button>
              ))
            ) : visibleLeads.length === 0 ? (
              <div className="lead-list-empty"><p>No leads match this filter.</p><small>Try another queue.</small></div>
            ) : (
              visibleLeads.map((l) => {
                const temp = scoreLead(l).temperature;
                const hasDraft = state.messages.some((m) => m.leadId === l.id && m.direction === 'outbound' && m.status === 'draft');
                const needsAction = l.status === 'waiting_approval' || l.status === 'needs_human' || hasDraft;
                return (
                  <button
                    key={l.id}
                    className={`lead-list-item ${selectedLeadId === l.id ? 'selected' : ''}`}
                    onClick={() => { setSelectedLeadId(l.id); setMobileView('conversation'); }}
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
                    {needsAction && <span className="lead-action-label">{hasDraft ? 'Draft awaiting approval' : l.status === 'needs_human' ? 'Owner review needed' : 'Action required'}</span>}
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
                {/* Lead header bar - compact, sticky */}
                <div className="lead-header-bar">
                  <div className="lead-header-left">
                    <span className={`badge ${selectedLead.status}`}>{selectedLead.status.replace('_', ' ')}</span>
                    <strong className="lead-name">{selectedLead.name}</strong>
                    <span className="lead-company">{selectedLead.company}</span>
                  </div>
                  <div className="lead-header-pills">
                    <span className="lead-pill"><span>Need</span><strong>{selectedLead.service}</strong></span>
                    <span className="lead-pill"><span>Budget</span><strong>{formatBudget(selectedLead.budget)}</strong></span>
                    <span className="lead-pill"><span>Urgency</span><strong>{selectedLead.urgency}</strong></span>
                    <span className="lead-pill"><span>Channel</span><strong>{selectedLead.channel}</strong></span>
                  </div>
                </div>

                {workspaceMode === 'retention' && selectedRetention && (
                  <section className={`account-health-card risk-${selectedRetention.level}`}>
                    <div className="account-health-heading">
                      <div>
                        <span>Account health</span>
                        <strong>{selectedRetention.level} risk · {selectedRetention.score}/100</strong>
                      </div>
                      <small>Owner: {selectedRetention.owner}</small>
                    </div>
                    <div className="risk-reason-chips">
                      {selectedRetention.reasons.length ? selectedRetention.reasons.map((reason) => (
                        <span key={reason.code} title={reason.detail}>{reason.label} +{reason.weight}</span>
                      )) : <span className="healthy-chip">No active risk signals</span>}
                    </div>
                    <p>{selectedRetention.recommendedAction}</p>
                    <div className="retention-outcomes">
                      <span>Record outcome:</span>
                      <button type="button" onClick={() => void recordRetentionOutcome('recovered')}>Recovered</button>
                      <button type="button" onClick={() => void recordRetentionOutcome('monitoring')}>Monitoring</button>
                      <button type="button" onClick={() => void recordRetentionOutcome('no_response')}>No response</button>
                      <button type="button" onClick={() => void recordRetentionOutcome('lost')}>Lost</button>
                    </div>
                  </section>
                )}

                {/* Conversation thread - full width */}
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
                         selectedLead.status === 'nurture' ? 'Follow-up sequence complete' :
                         selectedLead.status === 'closed' ? 'Lead closed' :
                         'All caught up'}
                      </strong>
                      <p>
                        {draft?.body || scheduledFollowUp?.note ||
                          (selectedLead.status === 'nurture'
                            ? 'All five plan steps were sent. The lead is parked in nurture; the agent re-engages automatically if they reply.'
                            : selectedLead.status === 'closed'
                              ? 'This lead opted out. Follow-ups are cancelled.'
                              : 'Run the agent cycle to check for new inbox leads and due follow-ups.')}
                      </p>
                    </div>
                    <button
                      className={`button ${primaryAction.variant}`}
                      type="button"
                      disabled={primaryAction.disabled || pendingAction !== null}
                      onClick={primaryAction.onClick}
                    >
                      {primaryAction.icon}
                      {pendingAction ? 'Working…' : draft ? `Approve & send via ${selectedLead.channel}` : primaryAction.label}
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

        {/* Column 3: Agent Activity (reasoning + timeline + decisions merged) */}
        <aside className="workspace-column activity-column">
          <div className="panel fill-height flex-layout">
            <div className="panel-heading">
              <Brain size={16} />
              <h2>Agent Activity</h2>
            </div>

            <div className="activity-stream">
              {/* Reasoning for selected lead */}
              {selectedLeadDecision && (
                <div className="activity-section">
                  <span className="activity-section-label">Reasoning</span>
                  <div className="reasoning-card">
                    <strong>{selectedLeadDecision.observation}</strong>
                    <p>{selectedLeadDecision.reasoning}</p>
                    <small>{selectedLeadDecision.action}</small>
                  </div>
                </div>
              )}

              {workspaceMode === 'retention' && selectedRetention && (
                <div className="activity-section">
                  <span className="activity-section-label">Retention Risk</span>
                  <div className="timeline-list">
                    {selectedRetention.reasons.length ? selectedRetention.reasons.map((reason) => (
                      <div key={reason.code} className="timeline-item risk-timeline-item">
                        <ShieldAlert size={14} />
                        <div><strong>{reason.label} (+{reason.weight})</strong><p>{reason.detail}</p></div>
                      </div>
                    )) : <p className="empty-state">No current retention risk signals.</p>}
                  </div>
                </div>
              )}

              {/* Tasks + Timeline for selected lead */}
              {(activeTasks.length > 0 || activeTimeline.length > 0) && (
                <div className="activity-section">
                  <span className="activity-section-label">Timeline & Tasks</span>
                  <div className="timeline-list">
                    {activeTasks.map((task) => (
                      <div key={task.id} className="timeline-item task-item">
                        <ClipboardCheck size={14} />
                        <div>
                          <strong>{task.type.replace('_', ' ')} - {task.status.replace('_', ' ')}</strong>
                          <p>{task.note}</p>
                          <small>Due: {new Date(task.dueAt).toLocaleTimeString()}</small>
                        </div>
                      </div>
                    ))}
                    {activeTimeline.map((event) => (
                      <div key={event.id} className="timeline-item">
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
              )}

              {/* Global decision log */}
              <div className="activity-section activity-section-global">
                <span className="activity-section-label">Decision Log</span>
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
            </div>
          </div>
        </aside>
      </div>

      {/* New Lead Modal */}
      {showNewLeadForm && (
        <div className="modal-overlay" onClick={() => setShowNewLeadForm(false)}>
          <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="new-lead-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 id="new-lead-title">Create a Lead</h2>
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
          <div className="drawer-content" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h2 id="settings-title">Settings</h2>
              <button className="button secondary sm icon-btn" aria-label="Close settings" type="button" onClick={() => setShowSettings(false)}>
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
                <p className="drawer-desc" style={{ marginTop: '10px' }}>
                  Gmail sync filter. Default <code>is:unread</code> imports every unread email — set e.g.{' '}
                  <code>is:unread label:leads</code> so only labeled intake mail becomes leads.
                </p>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    aria-label="Gmail sync filter"
                    value={gmailSyncQuery}
                    onChange={(e) => setGmailSyncQuery(e.target.value)}
                    placeholder="is:unread label:leads"
                    style={{ fontSize: '0.8rem', padding: '8px 10px', flex: 1 }}
                  />
                  <button className="button primary sm" type="button" aria-label="Save Gmail sync filter" onClick={saveGmailSyncQuery}>Save</button>
                </div>
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
                  <code>{webhookUrl}</code>
                  <button
                    className="button secondary sm"
                    type="button"
                    style={{ padding: '4px 8px', fontSize: '0.65rem', flexShrink: 0 }}
                    onClick={() => {
                      navigator.clipboard.writeText(webhookUrl);
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
