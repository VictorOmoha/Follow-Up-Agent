import { type AgentState } from '../agent-engine.js';

/**
 * Single gate for every future Phase 1 retention route, job, and mutation.
 * FU-RET-01 intentionally adds no runtime toggle: fresh and legacy state
 * normalize this flag to false, and existing config APIs do not modify it.
 */
export function isRetentionPhase1Enabled(state: AgentState): boolean {
  return state.config?.features?.retentionPhase1 === true;
}
