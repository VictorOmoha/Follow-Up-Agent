// Re-export shim. Canonical source lives in functions/src so it ships with the
// Cloud Function (Firebase only uploads the functions/ directory at deploy).
// The local dev server (tsx) and tests import from here unchanged.
// See docs/persistence-refactor.md (Phase 1).
export * from '../functions/src/agent-engine';
