import { type AgentState, type ConnectedInbox } from './agent-engine';

type PublicInbox = Omit<ConnectedInbox, 'credentials'> & {
  credentials?: never;
};

export type PublicAgentState = Omit<AgentState, 'inboxes' | 'config'> & {
  inboxes: PublicInbox[];
  config?: {
    bookingLink: string;
    autopilotEnabled?: boolean;
    geminiApiKeyConfigured?: boolean;
  };
};

export function toPublicInbox(inbox: ConnectedInbox): PublicInbox {
  const publicInbox: Partial<ConnectedInbox> = { ...inbox };
  delete publicInbox.credentials;
  return publicInbox as PublicInbox;
}

export function toPublicAgentState(state: AgentState): PublicAgentState {
  return {
    ...state,
    inboxes: state.inboxes.map(toPublicInbox),
    config: state.config
      ? {
          bookingLink: state.config.bookingLink,
          autopilotEnabled: state.config.autopilotEnabled,
          geminiApiKeyConfigured: Boolean(state.config.geminiApiKey?.trim()),
        }
      : undefined,
  };
}
