import { type AgentState, type ConnectedInbox } from './agent-engine.js';
import { buildRetentionSnapshot, type RetentionSnapshot } from './retention.js';

type PublicInbox = Omit<ConnectedInbox, 'credentials'> & {
  credentials?: never;
};

export type PublicAgentState = Omit<AgentState, 'inboxes' | 'config'> & {
  inboxes: PublicInbox[];
  config?: {
    bookingLink: string;
    autopilotEnabled?: boolean;
    geminiApiKeyConfigured?: boolean;
    gmailSyncQuery?: string;
    features?: {
      retentionPhase1: boolean;
    };
  };
  retention: RetentionSnapshot;
};

export function toPublicInbox(inbox: ConnectedInbox): PublicInbox {
  const publicInbox: Partial<ConnectedInbox> = { ...inbox };
  delete publicInbox.credentials;
  return publicInbox as PublicInbox;
}

export function toPublicAgentState(state: AgentState, now: Date = new Date()): PublicAgentState {
  return {
    ...state,
    inboxes: state.inboxes.map(toPublicInbox),
    config: state.config
      ? {
          bookingLink: state.config.bookingLink,
          autopilotEnabled: state.config.autopilotEnabled,
          geminiApiKeyConfigured: Boolean(state.config.geminiApiKey?.trim()),
          gmailSyncQuery: state.config.gmailSyncQuery,
          features: {
            retentionPhase1: state.config.features?.retentionPhase1 ?? false,
          },
        }
      : undefined,
    retention: buildRetentionSnapshot(state, now),
  };
}
