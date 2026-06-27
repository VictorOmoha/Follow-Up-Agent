import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Bot, CalendarCheck, CheckCircle2, Clock, DollarSign, Flame, Inbox, Link2,
  Phone, Plus, Reply, Send, Settings, Sparkles, ClipboardList, Trash2, X, Zap,
} from 'lucide-react';
import { type LeadInput, scoreLead } from './lib/agent';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

type LeadRecord = LeadInput & {
  id: string;
  contact?: string;
  status: 'new' | 'waiting_approval' | 'contacted' | 'needs_human' | 'nurture' | 'closed';
  createdAt: string;
  updatedAt: string;
};
type MessageRecord = {
  id: string; leadId: string; direction: 'outbound' | 'inbound';
  status: 'draft' | 'sent' | 'received'; body: string; createdAt: string; sentAt?: string;
};
type TaskRecord = {
  id: string; leadId: string; messageId?: string;
  type: 'approve_message' | 'follow_up' | 'owner_review';
  status: 'scheduled' | 'waiting_approval' | 'done'; dueAt: string; note: string; createdAt: string;
};
type TimelineRecord = { id: string; leadId: string; label: string; detail: string; createdAt: string };
type AgentDecisionRecord = {
  id: string; leadId?: string;
  type: 'triage' | 'draft' | 'schedule' | 'inbox_sync' | 'reply_analysis' | 'autopilot';
  observation: string; reasoning: string; action: string; confidence: number; createdAt: string;
};
type ConnectedInbox = {
  id: string; provider: 'demo' | 'gmail' | 'outlook' | 'imap'; email: string;
  status: 'connected' | 'needs_auth' | 'disconnected'; scopes: string[]; connectedAt: string; lastSyncAt?: string;
};
type EmailMessageRecord = {
  id: string; inboxId: string; from: string; subject: string; body: string; receivedAt: string; importedAt?: string; leadId?: string;
};
type AgentState = {
  leads: LeadRecord[]; messages: MessageRecord[]; tasks: TaskRecord[]; timeline: TimelineRecord[];
  decisions: AgentDecisionRecord[]; inboxes: ConnectedInbox[]; emailMessages: EmailMessageRecord[];
  config?: { bookingLink: string; autopilotEnabled?: boolean; geminiApiKeyConfigured?: boolean };
};
type GmailOAuthStart = {
  status: 'setup_required' | 'ready'; provider: 'gmail'; missing?: string[]; message: string;
  scopes: string[]; authUrl?: string; redirectUri?: string; state?: string;
};
type AgentCycleReport = { startedAt: string; imported: number; createdDrafts: number; waitingApproval: number; needsHuman: number };

const emptyState: AgentState = { leads: [], messages: [], tasks: [], timeline: [], decisions: [], inboxes: [], emailMessages: [] };
const emptyLead: LeadInput & { contact?: string } = { name: '', company: '', service: '', budget: '', urgency: '', pain: '', channel: 'SMS', contact: '' };

// ─── design tokens ───────────────────────────────────────────
const C = {
  bg: '#0c0d10', panel: '#131419', deep: '#07080a', card: '#18191e', hover: '#202228',
  border: '#1e2026', text: '#e3e3e7', dim: '#8b8f9a', faint: '#7f8593', mute: '#64748b',
  blue: '#3b82f6', gold: '#d4a72c', green: '#4ade80',
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

function badgeStyle(kind: string): CSSProperties {
  const map: Record<string, [string, string, string]> = {
    hot: ['rgba(239,68,68,.09)', '#fca5a5', 'rgba(239,68,68,.16)'],
    waiting_approval: ['rgba(239,68,68,.09)', '#fca5a5', 'rgba(239,68,68,.16)'],
    warm: ['rgba(245,158,11,.09)', '#fde047', 'rgba(245,158,11,.16)'],
    contacted: ['rgba(245,158,11,.09)', '#fde047', 'rgba(245,158,11,.16)'],
    nurture: ['rgba(59,130,246,.09)', '#93c5fd', 'rgba(59,130,246,.16)'],
    closed: ['rgba(59,130,246,.09)', '#93c5fd', 'rgba(59,130,246,.16)'],
    new: ['rgba(59,130,246,.09)', '#93c5fd', 'rgba(59,130,246,.16)'],
    needs_human: ['rgba(168,85,247,.09)', '#e9d5ff', 'rgba(168,85,247,.16)'],
  };
  const [bg, c, b] = map[kind] || map.nurture;
  return { display: 'inline-block', borderRadius: 6, padding: '2px 7px', fontWeight: 700, fontSize: '.62rem', textTransform: 'uppercase', letterSpacing: '.04em', background: bg, color: c, border: `1px solid ${b}`, whiteSpace: 'nowrap' };
}

const money = (v: string | number) => '$' + Number(Number.parseFloat(String(v || '0').replace(/[^0-9.]/g, '')) || 0).toLocaleString('en-US');
const sumBudgets = (arr: LeadRecord[]) => arr.reduce((s, l) => s + (Number.parseFloat((l.budget || '0').replace(/[^0-9.]/g, '')) || 0), 0);

const btnPrimary: CSSProperties = { background: C.blue, color: '#fff', border: 0, borderRadius: 8, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, justifyContent: 'center' };
const btnGhost: CSSProperties = { background: C.card, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' };
const inputStyle: CSSProperties = { width: '100%', borderRadius: 6, border: `1px solid ${C.border}`, background: C.deep, color: C.text, padding: '8px 10px', fontSize: '.84rem', outline: 'none' };
const sectionLabel: CSSProperties = { fontSize: '.64rem', color: C.faint, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.09em' };
const chip: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.05)', padding: '5px 13px', borderRadius: 8 };

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
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewLeadForm, setShowNewLeadForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const toastTimer = useRef<number | undefined>(undefined);
  function showToast(msg: string) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }

  async function refresh() {
    try {
      setError('');
      const nextState = await api<AgentState>('/state');
      setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
      setBookingLink((current) => current || nextState.config?.bookingLink || '');
      if (nextState.leads.length > 0) {
        if (!nextState.leads.find((l) => l.id === selectedLeadId)) setSelectedLeadId(nextState.leads[0].id);
      } else {
        setSelectedLeadId(null);
      }
    } catch {
      setError('API offline. Start it with npm run dev.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLeadId]);

  // ─── derived data ──────────────────────────────────────────
  const selectedLead = state.leads.find((l) => l.id === selectedLeadId) ?? null;
  const activeInbox = state.inboxes[0];
  const unsyncedEmailCount = activeInbox ? state.emailMessages.filter((e) => e.inboxId === activeInbox.id && !e.importedAt).length : 0;
  const activeMessages = selectedLead ? state.messages.filter((m) => m.leadId === selectedLead.id) : [];
  const activeTasks = selectedLead ? state.tasks.filter((t) => t.leadId === selectedLead.id && t.status !== 'done') : [];
  const activeTimeline = selectedLead ? state.timeline.filter((e) => e.leadId === selectedLead.id) : [];
  const latestDecisions = state.decisions.slice(0, 10);
  const selectedDecision = selectedLead ? state.decisions.find((d) => d.leadId === selectedLead.id) : undefined;
  const draft = activeMessages.find((m) => m.direction === 'outbound' && m.status === 'draft');
  const scheduledFollowUp = activeTasks.find((t) => t.type === 'follow_up' && t.status === 'scheduled');

  const stats = useMemo(() => {
    const active = state.leads.filter((l) => l.status !== 'closed' && l.status !== 'nurture');
    return {
      pipeline: money(sumBudgets(state.leads)),
      hot: state.leads.filter((l) => l.status === 'waiting_approval' || l.status === 'needs_human').length,
      waitingApproval: state.tasks.filter((t) => t.status === 'waiting_approval').length,
      scheduled: state.tasks.filter((t) => t.status === 'scheduled').length,
      moneyOnTable: money(sumBudgets(active)),
      hotLeadsCount: active.filter((l) => scoreLead(l).temperature === 'Hot').length,
      stalledLeadsCount: active.filter((l) => Date.now() - new Date(l.updatedAt).getTime() > 24 * 60 * 60 * 1000).length,
    };
  }, [state]);

  const selectedSummary = useMemo(() => {
    if (!selectedLead) return '';
    const sc = scoreLead(selectedLead);
    return `Needs: ${selectedLead.service || 'service'} · Budget: ${money(selectedLead.budget)} · Urgency: ${selectedLead.urgency || 'unknown'} · ${sc.temperature} (${sc.score}/100) · Channel: ${selectedLead.channel || 'SMS'}`;
  }, [selectedLead]);

  const primary = useMemo(() => {
    if (draft) return { label: 'Approve & Send', icon: <Send size={15} />, onClick: () => void approveDraft(), disabled: false, title: 'Draft waiting for approval', body: draft.body };
    if (scheduledFollowUp) return { label: 'Draft Next Follow-Up', icon: <Plus size={15} />, onClick: () => void runWorker({ force: true }), disabled: false, title: `Follow-up scheduled · ${new Date(scheduledFollowUp.dueAt).toLocaleTimeString()}`, body: scheduledFollowUp.note };
    if (selectedLead?.status === 'needs_human') return { label: 'Lead Needs Your Review', icon: <ClipboardList size={15} />, onClick: () => {}, disabled: true, title: 'This lead needs your review', body: 'The lead asked for immediate human contact. Reach out directly, then continue the sequence.' };
    if (state.leads.length === 0) return { label: 'Create Your First Lead', icon: <Plus size={15} />, onClick: () => setShowNewLeadForm(true), disabled: false, title: 'No leads yet', body: 'Create a lead to watch the agent triage it and draft a first response.' };
    return { label: 'Run Agent Cycle', icon: <Zap size={15} />, onClick: () => void runAgentCycle(), disabled: false, title: 'All caught up', body: 'Run the agent cycle to check for new inbox leads and due follow-ups.' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, scheduledFollowUp, selectedLead, state.leads.length]);

  // ─── API actions (wired to the live backend) ───────────────
  function update<K extends keyof typeof lead>(key: K, value: (typeof lead)[K]) { setLead((c) => ({ ...c, [key]: value })); }

  async function createLead(event?: React.FormEvent) {
    event?.preventDefault();
    if (!lead.name || !lead.company || !lead.service) { showToast('Name, company and service are required'); return; }
    await api('/leads', { method: 'POST', body: JSON.stringify(lead) });
    setLead(emptyLead); setShowNewLeadForm(false); await refresh(); showToast('Lead created · agent is triaging it');
  }
  async function approveDraft() { if (!draft) return; await api(`/messages/${draft.id}/approve`, { method: 'POST' }); await refresh(); showToast('Approved & sent · follow-up scheduled'); }
  async function runWorker({ force = false }: { force?: boolean } = {}) { await api('/worker/run', { method: 'POST', body: JSON.stringify({ force }) }); await refresh(); showToast('Next follow-up drafted'); }
  async function runAgentCycle() { setCycleReport(await api<AgentCycleReport>('/agent/cycle', { method: 'POST' })); await refresh(); showToast('Agent cycle complete'); }
  async function recordReply() {
    if (!selectedLead) return;
    if (!reply.trim()) { showToast('Type a reply to simulate'); return; }
    await api(`/leads/${selectedLead.id}/replies`, { method: 'POST', body: JSON.stringify({ body: reply }) });
    await refresh(); showToast('Reply recorded · agent analyzed it');
  }
  async function connectInbox() {
    const emailToConnect = inboxEmail.trim() || 'owner@omohasolutions.demo';
    if (emailToConnect.endsWith('.demo')) {
      await api('/inboxes', { method: 'POST', body: JSON.stringify({ provider: 'demo', email: emailToConnect }) });
      setInboxEmail(''); await refresh(); showToast('Inbox connected: ' + emailToConnect);
    } else {
      const startResult = await api<GmailOAuthStart>(`/inboxes/gmail/start?email=${encodeURIComponent(emailToConnect)}`);
      setGmailStart(startResult);
      if (startResult.authUrl) window.location.href = startResult.authUrl;
      else showToast(startResult.message || 'Gmail setup required');
    }
  }
  async function syncInbox() { if (!activeInbox) { showToast('Connect an inbox first'); return; } await api(`/inboxes/${activeInbox.id}/sync`, { method: 'POST' }); await refresh(); showToast('Inbox synced'); }
  async function toggleAutopilot() {
    const next = !state.config?.autopilotEnabled;
    const nextState = await api<AgentState>('/config', { method: 'POST', body: JSON.stringify({ autopilotEnabled: next }) });
    setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] });
    showToast(next ? 'Autopilot enabled (auto-send)' : 'Autopilot paused (draft-only)');
  }
  async function saveGeminiKey() {
    if (!geminiApiKey.trim()) { showToast('Enter a key first'); return; }
    const nextState = await api<AgentState>('/config', { method: 'POST', body: JSON.stringify({ geminiApiKey: geminiApiKey.trim() }) });
    setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] }); setGeminiApiKey(''); showToast('Gemini API key saved · live AI enabled');
  }
  async function saveBookingLink() {
    if (!bookingLink.trim()) { showToast('Enter a link first'); return; }
    const nextState = await api<AgentState>('/config', { method: 'POST', body: JSON.stringify({ bookingLink: bookingLink.trim() }) });
    setState({ ...emptyState, ...nextState, decisions: nextState.decisions ?? [] }); showToast('Booking link saved');
  }
  const webhookUrl = `${window.location.origin}/api/webhooks/lead`;
  function copyWebhook() { try { void navigator.clipboard.writeText(webhookUrl); } catch { /* ignore */ } showToast('Webhook URL copied'); }
  async function reset() { await api('/reset', { method: 'POST' }); setSelectedLeadId(null); setShowSettings(false); await refresh(); showToast('All data cleared'); }
  async function deleteLead(id: string) {
    const target = state.leads.find((l) => l.id === id);
    if (!window.confirm(`Delete ${target?.name || 'this lead'} and all its messages, tasks, and history? This can't be undone.`)) return;
    await api(`/leads/${id}/delete`, { method: 'POST' });
    setSelectedLeadId(null);
    await refresh();
    showToast('Lead deleted');
  }

  const autopilot = !!state.config?.autopilotEnabled;
  const geminiConfigured = !!state.config?.geminiApiKeyConfigured;

  // ─── render ────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: C.bg, color: C.text }}>
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', background: C.deep, borderBottom: `1px solid ${C.border}`, height: 64, flexShrink: 0, zIndex: 10 }}>
        <div data-tour="brand" style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
          <span style={{ color: C.blue, textTransform: 'uppercase', letterSpacing: '.2em', fontWeight: 800, fontSize: '.62rem', whiteSpace: 'nowrap' }}>Omoha Solutions</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#fff', lineHeight: 1.1, letterSpacing: '-.01em', whiteSpace: 'nowrap' }}>Follow-Up Agent</h1>
            {error && <span style={{ fontSize: '.66rem', color: '#fca5a5', background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.2)', padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>{error}</span>}
          </div>
        </div>

        <div data-tour="metrics" style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 1, overflow: 'hidden' }}>
          <div style={chip}><DollarSign size={15} color={C.mute} /><span style={statChipLabel}>Pipeline</span><strong style={statChipVal}>{stats.pipeline}</strong></div>
          <div style={chip}><Flame size={15} color={C.mute} /><span style={statChipLabel}>Hot</span><strong style={statChipVal}>{stats.hot}</strong></div>
          <div style={chip}><Phone size={15} color={C.mute} /><span style={statChipLabel}>Approval</span><strong style={statChipVal}>{stats.waitingApproval}</strong></div>
          <div style={chip}><CalendarCheck size={15} color={C.mute} /><span style={statChipLabel}>Scheduled</span><strong style={statChipVal}>{stats.scheduled}</strong></div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <button onClick={() => setShowSettings(true)} type="button" aria-label="Settings" style={{ ...btnGhost, padding: 7, borderRadius: 7 }}><Settings size={15} /></button>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#9aa0ac', fontWeight: 700, background: 'rgba(255,255,255,.03)', padding: '4px 9px', borderRadius: 6, border: '1px solid rgba(255,255,255,.06)', textTransform: 'uppercase', fontSize: '.66rem', letterSpacing: '.05em' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.green, animation: 'pulseDot 2.4s infinite' }} />
            {loading ? 'Connecting' : autopilot ? 'Autopilot' : 'Online'}
          </span>
        </div>
      </header>

      {/* Workspace */}
      <div style={{ display: 'flex', flex: 1, height: 'calc(100vh - 64px)', overflow: 'hidden', background: C.bg }}>
        {/* Column 1 — Leads */}
        <aside style={{ display: 'flex', flexDirection: 'column', width: 268, flexShrink: 0, background: C.deep, borderRight: `1px solid ${C.border}`, height: '100%', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 14px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            <h2 style={{ margin: 0, fontSize: '.82rem', fontWeight: 800, color: '#fff', textTransform: 'uppercase', letterSpacing: '.1em' }}>Leads</h2>
            <button data-tour="newlead" onClick={() => setShowNewLeadForm(true)} type="button" style={{ ...btnPrimary, padding: '6px 11px', fontSize: '.74rem', borderRadius: 6 }}><Plus size={13} /> New</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '9px 14px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            <span style={summaryChip}><DollarSign size={12} color={C.mute} /> {stats.moneyOnTable} on table</span>
            <span style={summaryChip}><Flame size={12} color={C.mute} /> {stats.hotLeadsCount} hot</span>
            <span style={summaryChip}><Clock size={12} color={C.mute} /> {stats.stalledLeadsCount} stalled</span>
          </div>
          <div data-tour="leadlist" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0', minHeight: 0 }}>
            {state.leads.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 16px', textAlign: 'center', color: C.dim }}>
                <Bot size={26} color={C.mute} /><p style={{ margin: 0, fontSize: '.82rem', fontWeight: 600 }}>No leads yet</p>
                <small style={{ fontSize: '.7rem', color: C.mute }}>Create a lead to see the agent in action</small>
              </div>
            ) : state.leads.map((l) => {
              const temp = scoreLead(l).temperature;
              const needsAction = l.status === 'waiting_approval' || l.status === 'needs_human' || state.messages.some((m) => m.leadId === l.id && m.status === 'draft');
              const sel = l.id === selectedLeadId;
              return (
                <button key={l.id} onClick={() => setSelectedLeadId(l.id)} type="button" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 14px', background: sel ? C.hover : 'transparent', border: 'none', borderLeft: `3px solid ${sel ? C.blue : 'transparent'}`, cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <strong style={{ fontSize: '.84rem', color: '#fff', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name || 'Unknown'}</strong>
                    {needsAction && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, animation: 'pulseDot 2s infinite' }} />}
                  </div>
                  <div style={{ display: 'flex', gap: 5 }}>
                    <span style={badgeStyle(temp.toLowerCase())}>{temp}</span>
                    <span style={badgeStyle(l.status)}>{l.status.replace(/_/g, ' ')}</span>
                  </div>
                  <small style={{ fontSize: '.69rem', color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.service} · {l.company}</small>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Column 2 — Workbench */}
        <section style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', overflow: 'hidden', borderRight: `1px solid ${C.border}`, background: C.panel }}>
          {selectedLead ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: 16 }}>
              <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '11px 13px', marginBottom: 10, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={badgeStyle(selectedLead.status)}>{selectedLead.status.replace(/_/g, ' ')}</span>
                    <strong style={{ fontSize: '.96rem', color: '#fff' }}>{selectedLead.name} · {selectedLead.company}</strong>
                  </div>
                  <button onClick={() => deleteLead(selectedLead.id)} type="button" aria-label="Delete lead" title="Delete lead" style={{ background: 'rgba(239,68,68,.08)', color: '#fca5a5', border: '1px solid rgba(239,68,68,.18)', borderRadius: 7, padding: 6, cursor: 'pointer', display: 'inline-flex', flexShrink: 0 }}><Trash2 size={14} /></button>
                </div>
                <p style={{ margin: '4px 0 0 0', fontSize: '.79rem', color: C.dim }}>{selectedSummary}</p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, flexShrink: 0, marginBottom: 12, height: 176 }}>
                <div data-tour="reasoning" style={{ background: C.deep, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 11px', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <span style={{ ...sectionLabel, marginBottom: 5, display: 'block' }}>Agent Reasoning</span>
                  <strong style={{ fontSize: '.79rem', color: '#fff', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.3 }}>{selectedDecision?.observation ?? 'Awaiting first agent action'}</strong>
                  <p style={{ fontSize: '.74rem', color: C.dim, margin: '4px 0 0 0', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{selectedDecision?.reasoning ?? 'The agent will reason about this lead on the next cycle.'}</p>
                  <small style={{ marginTop: 'auto', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: '.7rem', color: C.gold, fontWeight: 600, paddingTop: 6, lineHeight: 1.3 }}>{selectedDecision?.action ?? ''}</small>
                </div>
                <div style={{ background: C.deep, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 11px', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <span style={{ ...sectionLabel, marginBottom: 5, display: 'block' }}>Timeline &amp; Tasks</span>
                  <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 7, paddingRight: 2 }}>
                    {activeTasks.map((t) => (
                      <div key={t.id} style={tlRow}>
                        <ClipboardList size={14} color={C.mute} style={{ marginTop: 1 }} />
                        <div><strong style={tlTitle}>{t.type.replace(/_/g, ' ')} · {t.status.replace(/_/g, ' ')}</strong><p style={tlBody}>{t.note}</p><small style={tlTime}>Due: {new Date(t.dueAt).toLocaleTimeString()}</small></div>
                      </div>
                    ))}
                    {activeTimeline.map((e) => (
                      <div key={e.id} style={tlRow}>
                        <CheckCircle2 size={14} color={C.mute} style={{ marginTop: 1 }} />
                        <div><strong style={tlTitle}>{e.label}</strong><p style={tlBody}>{e.detail}</p><small style={tlTime}>{new Date(e.createdAt).toLocaleTimeString()}</small></div>
                      </div>
                    ))}
                    {activeTasks.length === 0 && activeTimeline.length === 0 && <p style={{ fontSize: '.72rem', color: C.mute, margin: 0 }}>No activity yet.</p>}
                  </div>
                </div>
              </div>

              <div data-tour="thread" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5, overflow: 'hidden', marginBottom: 10, minHeight: 0 }}>
                <span style={sectionLabel}>Conversation Thread</span>
                <div style={{ flex: 1, overflowY: 'auto', background: C.deep, border: `1px solid ${C.border}`, borderRadius: 6, padding: 11, display: 'flex', flexDirection: 'column', gap: 9, minHeight: 0 }}>
                  {activeMessages.length ? activeMessages.slice().reverse().map((m) => {
                    const out = m.direction === 'outbound';
                    const bubble: CSSProperties = out && m.status === 'draft'
                      ? { background: 'rgba(59,130,246,.12)', border: '1.5px dashed rgba(59,130,246,.45)', color: '#e2e8f0', borderBottomRightRadius: 3 }
                      : out ? { background: '#2563eb', color: '#fff', borderBottomRightRadius: 3 }
                      : { background: 'rgba(255,255,255,.06)', color: '#f3f4f6', border: `1px solid ${C.border}`, borderBottomLeftRadius: 3 };
                    return (
                      <div key={m.id} style={{ display: 'flex', flexDirection: 'column', maxWidth: '86%', alignSelf: out ? 'flex-end' : 'flex-start' }}>
                        <div style={{ padding: '8px 12px', borderRadius: 12, fontSize: '.85rem', lineHeight: 1.4, ...bubble }}>{m.body}</div>
                        <div style={{ fontSize: '.63rem', color: out ? 'rgba(255,255,255,.45)' : C.mute, marginTop: 3, alignSelf: out ? 'flex-end' : 'flex-start', textTransform: 'uppercase', letterSpacing: '.03em' }}>{m.status === 'draft' ? 'Draft' : m.status} · {new Date(m.createdAt).toLocaleTimeString()}</div>
                      </div>
                    );
                  }) : <p style={{ textAlign: 'center', color: C.dim, fontStyle: 'italic', fontSize: '.8rem', margin: '15px auto' }}>No messages yet. The agent drafts the first response once a lead is created.</p>}
                </div>
              </div>

              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${C.border}`, paddingTop: 11 }}>
                <div data-tour="primary" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: 'rgba(59,130,246,.04)', border: '1px solid rgba(59,130,246,.1)', padding: '11px 13px', borderRadius: 8 }}>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <strong style={{ fontSize: '.7rem', color: '#9aa0ac', textTransform: 'uppercase', display: 'block', letterSpacing: '.06em' }}>{primary.title}</strong>
                    <p style={{ fontSize: '.8rem', color: C.text, margin: '2px 0 0 0', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{primary.body}</p>
                  </div>
                  <button onClick={primary.onClick} type="button" disabled={primary.disabled} style={{ ...btnPrimary, padding: '10px 16px', fontSize: '.85rem', flexShrink: 0, opacity: primary.disabled ? 0.6 : 1, cursor: primary.disabled ? 'not-allowed' : 'pointer', ...(primary.disabled ? { background: C.card, border: `1px solid ${C.border}` } : {}) }}>{primary.icon} {primary.label}</button>
                </div>
                <div data-tour="reply" style={{ display: 'flex', gap: 8 }}>
                  <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Simulate a lead reply..." style={{ ...inputStyle, flex: 1, borderRadius: 8, fontSize: '.8rem', padding: '8px 11px' }} />
                  <button onClick={recordReply} type="button" style={{ ...btnGhost, padding: '8px 13px', fontSize: '.8rem', flexShrink: 0 }}><Reply size={15} /> Record Reply</button>
                </div>
                <button onClick={() => setShowAdvanced((v) => !v)} type="button" style={{ background: 'none', border: 'none', color: C.dim, fontSize: '.72rem', cursor: 'pointer', textAlign: 'center', padding: 2, fontWeight: 600 }}>{showAdvanced ? 'Hide' : 'Show'} advanced controls</button>
                {showAdvanced && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: 9, background: C.deep, border: `1px solid ${C.border}`, borderRadius: 8 }}>
                    <button onClick={() => void runAgentCycle()} type="button" style={{ ...btnGhost, padding: '5px 10px', fontSize: '.72rem', borderRadius: 6 }}><Zap size={12} /> Run agent cycle</button>
                    <button onClick={() => void toggleAutopilot()} type="button" style={{ ...btnGhost, padding: '5px 10px', fontSize: '.72rem', borderRadius: 6 }}>{autopilot ? 'Pause autopilot' : 'Enable autopilot'}</button>
                    {cycleReport && <span style={{ fontSize: '.65rem', color: C.dim, fontWeight: 600, marginLeft: 'auto' }}>Last cycle: {cycleReport.imported} imported, {cycleReport.createdDrafts} drafted</span>}
                    <button onClick={reset} type="button" style={{ background: 'rgba(239,68,68,.1)', color: '#fca5a5', border: '1px solid rgba(239,68,68,.2)', borderRadius: 6, padding: '5px 10px', fontWeight: 700, fontSize: '.72rem', cursor: 'pointer' }}>Clear all data</button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', height: '100%', padding: 32, gap: 12 }}>
              <Bot size={48} color={C.blue} strokeWidth={1.6} />
              <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 800, color: '#fff' }}>The agent is ready and waiting</h2>
              <p style={{ margin: '0 0 8px 0', fontSize: '.88rem', color: C.dim, maxWidth: 440, lineHeight: 1.5 }}>Create a lead to watch the agent triage it, draft a first response, and schedule follow-ups automatically.</p>
              <button onClick={() => setShowNewLeadForm(true)} type="button" style={{ ...btnPrimary, padding: '11px 20px', fontSize: '.9rem', minWidth: 200 }}><Plus size={18} /> Create Your First Lead</button>
            </div>
          )}
        </section>

        {/* Column 3 — Agent Decisions */}
        <aside data-tour="decisions" style={{ display: 'flex', flexDirection: 'column', width: 348, flexShrink: 0, height: '100%', overflow: 'hidden', background: C.panel }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 16, flexShrink: 0, borderBottom: `1px solid ${C.border}` }}>
            <Sparkles size={16} color={C.blue} />
            <h2 style={{ margin: 0, fontSize: '.88rem', fontWeight: 800, color: '#fff', textTransform: 'uppercase', letterSpacing: '.08em' }}>Agent Decisions</h2>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 9, padding: 14, minHeight: 0 }}>
            {latestDecisions.length ? latestDecisions.map((d) => (
              <article key={d.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: 11, fontSize: '.8rem', animation: 'fadeIn .3s ease' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.64rem', marginBottom: 5 }}>
                  <span style={{ color: C.faint, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{d.type.replace(/_/g, ' ')}</span>
                  <span style={{ color: C.mute }}>{d.confidence}% conf</span>
                </div>
                <strong style={{ display: 'block', fontSize: '.79rem', color: '#fff', marginBottom: 3 }}>{d.observation}</strong>
                <p style={{ color: C.dim, margin: '0 0 5px 0', lineHeight: 1.35 }}>{d.reasoning}</p>
                <small style={{ display: 'block', fontSize: '.71rem', color: C.gold, fontWeight: 600 }}>{d.action}</small>
              </article>
            )) : <p style={{ fontSize: '.78rem', color: C.mute, textAlign: 'center', margin: '20px auto' }}>No decisions logged yet. The agent starts reasoning once a lead comes in.</p>}
          </div>
        </aside>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: C.card, border: '1px solid #2c2f3a', color: '#fff', padding: '11px 18px', borderRadius: 9, fontSize: '.82rem', fontWeight: 600, zIndex: 120, boxShadow: '0 10px 30px rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', gap: 9, animation: 'tipIn .25s ease' }}>
          <CheckCircle2 size={16} color={C.green} /> {toast}
        </div>
      )}

      {/* New Lead modal */}
      {showNewLeadForm && (
        <div onClick={() => setShowNewLeadForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.5)' }}>
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: '#fff' }}>Create a Lead</h2>
              <p style={{ margin: '5px 0 0 0', fontSize: '.78rem', color: C.dim }}>The agent will score it and draft a first response instantly.</p>
            </div>
            <form onSubmit={createLead}>
              <FormField label="Lead name"><input required value={lead.name} onChange={(e) => update('name', e.target.value)} placeholder="Ada Okafor" style={inputStyle} /></FormField>
              <FormField label="Company"><input required value={lead.company} onChange={(e) => update('company', e.target.value)} placeholder="Ada Legal Group" style={inputStyle} /></FormField>
              <FormField label="Service requested"><input required value={lead.service} onChange={(e) => update('service', e.target.value)} placeholder="Immigration consultation" style={inputStyle} /></FormField>
              <FormField label="Contact (phone or email)"><input value={lead.contact} onChange={(e) => update('contact', e.target.value)} placeholder="+1 555 123 4567" style={inputStyle} /></FormField>
              <div style={{ display: 'flex', gap: 10 }}>
                <FormField label="Budget" flex><input value={lead.budget} onChange={(e) => update('budget', e.target.value)} placeholder="2500" style={inputStyle} /></FormField>
                <FormField label="Urgency" flex><input value={lead.urgency} onChange={(e) => update('urgency', e.target.value)} placeholder="ASAP" style={inputStyle} /></FormField>
              </div>
              <FormField label="Pain point"><textarea value={lead.pain} onChange={(e) => update('pain', e.target.value)} placeholder="Missing website leads after hours" style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} /></FormField>
              <FormField label="Preferred channel">
                <select value={lead.channel} onChange={(e) => update('channel', e.target.value as LeadInput['channel'])} style={inputStyle}><option>SMS</option><option>Email</option><option>Call</option></select>
              </FormField>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button onClick={() => setShowNewLeadForm(false)} type="button" style={{ ...btnGhost, padding: '9px 15px', fontSize: '.84rem' }}>Cancel</button>
                <button type="submit" style={{ ...btnPrimary, padding: '9px 15px', fontSize: '.84rem' }}><Send size={14} /> Create lead</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Settings drawer */}
      {showSettings && (
        <div onClick={() => setShowSettings(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 90 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 430, maxWidth: '92vw', background: C.panel, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '-10px 0 40px rgba(0,0,0,.4)', animation: 'slideInRight .25s ease' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
              <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 800, color: '#fff' }}>Settings</h2>
              <button onClick={() => setShowSettings(false)} type="button" style={{ ...btnGhost, padding: 7, borderRadius: 7 }}><X size={15} /></button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <SettingsSection icon={<Zap size={16} color={C.blue} />} title="Autopilot Mode" tour="autopilot">
                <div style={{ background: 'rgba(59,130,246,.03)', border: '1px solid rgba(59,130,246,.15)', borderRadius: 8, padding: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 }}>
                    <strong style={{ fontSize: '.8rem', color: '#fff' }}>{autopilot ? 'ACTIVE (Auto-Send)' : 'PAUSED (Draft-Only)'}</strong>
                    <button onClick={toggleAutopilot} type="button" style={{ ...(autopilot ? btnGhost : btnPrimary), padding: '5px 12px', fontSize: '.74rem', borderRadius: 6 }}>{autopilot ? 'Pause' : 'Enable'}</button>
                  </div>
                  <p style={{ fontSize: '.75rem', color: C.dim, margin: 0, lineHeight: 1.4 }}>{autopilot ? 'Agent autonomously triages leads and sends follow-ups without manual approval.' : 'Agent runs in draft-only mode. All responses require owner approval before sending.'}</p>
                </div>
              </SettingsSection>

              <SettingsSection icon={<Inbox size={16} color={C.blue} />} title="Connected Inbox">
                <p style={drawerDesc}>Connect an inbox so the agent imports leads from email automatically. Use a .demo email for testing.</p>
                <input value={inboxEmail} onChange={(e) => setInboxEmail(e.target.value)} placeholder="owner@omohasolutions.demo" style={{ ...inputStyle, marginBottom: 8, fontSize: '.8rem' }} />
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  <button onClick={connectInbox} type="button" style={{ ...btnPrimary, flex: 1, padding: '6px 10px', fontSize: '.74rem', borderRadius: 6 }}>Connect</button>
                  <button onClick={syncInbox} type="button" style={{ ...btnGhost, flex: 1, padding: '6px 10px', fontSize: '.74rem', borderRadius: 6 }}>Sync inbox</button>
                </div>
                {gmailStart && <p style={{ ...drawerDesc, color: gmailStart.status === 'ready' ? C.green : '#f59e0b' }}>{gmailStart.message}</p>}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, padding: '9px 11px', borderRadius: 8, fontSize: '.76rem' }}>
                  <strong style={{ display: 'block', color: '#fff' }}>{activeInbox?.email ?? 'No inbox connected'}</strong>
                  <span style={{ color: '#eab308', fontWeight: 600 }}>{activeInbox ? `${activeInbox.provider} · ${unsyncedEmailCount} unsynced` : 'Connect a .demo inbox to test'}</span>
                </div>
              </SettingsSection>

              <SettingsSection icon={<CalendarCheck size={16} color={C.blue} />} title="Calendar Link">
                <p style={drawerDesc}>This booking link is embedded in follow-up messages to leads.</p>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={bookingLink} onChange={(e) => setBookingLink(e.target.value)} placeholder="https://cal.com/your-link" style={{ ...inputStyle, flex: 1, fontSize: '.8rem' }} />
                  <button onClick={saveBookingLink} type="button" style={{ ...btnPrimary, padding: '6px 12px', fontSize: '.74rem', borderRadius: 6 }}>Save</button>
                </div>
              </SettingsSection>

              <SettingsSection icon={<Sparkles size={16} color={C.blue} />} title="Gemini AI">
                <p style={drawerDesc}>Add a Gemini API key for AI-powered scoring and conversational drafting. Without it, the agent uses rules-based logic.</p>
                {geminiConfigured ? (
                  <span style={{ fontSize: '.72rem', fontWeight: 700, color: C.green }}>Live Gemini AI (configured server-side)</span>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 9 }}>
                      <input type="password" value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} placeholder="Enter Gemini API Key" style={{ ...inputStyle, flex: 1, fontSize: '.8rem' }} />
                      <button onClick={saveGeminiKey} type="button" style={{ ...btnPrimary, padding: '6px 12px', fontSize: '.74rem', borderRadius: 6 }}>Save</button>
                    </div>
                    <span style={{ fontSize: '.72rem', fontWeight: 700, color: '#f59e0b' }}>Rules Fallback active</span>
                  </>
                )}
              </SettingsSection>

              <SettingsSection icon={<Link2 size={16} color={C.blue} />} title="Webhook Intake">
                <p style={drawerDesc}>Push inbound leads automatically from external CRMs or form webhooks to this endpoint.</p>
                <div style={{ background: C.deep, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <code style={{ fontSize: '.64rem', color: C.green, wordBreak: 'break-all', fontFamily: 'Consolas,Monaco,monospace' }}>{webhookUrl}</code>
                  <button onClick={copyWebhook} type="button" style={{ ...btnGhost, padding: '5px 9px', fontSize: '.66rem', borderRadius: 6, flexShrink: 0 }}>Copy</button>
                </div>
              </SettingsSection>

              <SettingsSection icon={<X size={16} color="#fca5a5" />} title="Reset Data" last>
                <p style={drawerDesc}>Clear all leads, messages, tasks, and timeline. Useful for starting a fresh demo.</p>
                <button onClick={reset} type="button" style={{ background: 'rgba(239,68,68,.1)', color: '#fca5a5', border: '1px solid rgba(239,68,68,.2)', borderRadius: 6, padding: '7px 12px', fontWeight: 700, fontSize: '.74rem', cursor: 'pointer' }}>Clear all data</button>
              </SettingsSection>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

const statChipLabel: CSSProperties = { fontSize: '.66rem', color: '#8b8f9a', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const statChipVal: CSSProperties = { fontWeight: 800, color: '#fff', fontSize: '.92rem' };
const summaryChip: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: '.65rem', color: '#8b8f9a', fontWeight: 600 };
const tlRow: CSSProperties = { display: 'grid', gridTemplateColumns: '14px 1fr', gap: 7, fontSize: '.72rem', lineHeight: 1.25 };
const tlTitle: CSSProperties = { color: '#fff', display: 'block', fontSize: '.74rem' };
const tlBody: CSSProperties = { margin: 0, color: '#8b8f9a' };
const tlTime: CSSProperties = { display: 'block', color: '#4b5563', fontSize: '.65rem', marginTop: 1 };
const drawerDesc: CSSProperties = { fontSize: '.76rem', color: '#8b8f9a', margin: '0 0 10px 0', lineHeight: 1.4 };

function FormField({ label, children, flex }: { label: string; children: React.ReactNode; flex?: boolean }) {
  return (
    <label style={{ display: 'grid', gap: 4, marginBottom: 10, color: '#e3e3e7', fontWeight: 600, fontSize: '.78rem', flex: flex ? 1 : undefined }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function SettingsSection({ icon, title, children, last, tour }: { icon: React.ReactNode; title: string; children: React.ReactNode; last?: boolean; tour?: string }) {
  return (
    <section data-tour={tour} style={{ borderBottom: last ? 'none' : `1px solid ${C.border}`, padding: '16px 20px' }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center', marginBottom: 11 }}>
        {icon}
        <h3 style={{ margin: 0, fontSize: '.84rem', fontWeight: 800, color: '#fff', textTransform: 'uppercase', letterSpacing: '.08em' }}>{title}</h3>
      </div>
      {children}
    </section>
  );
}
