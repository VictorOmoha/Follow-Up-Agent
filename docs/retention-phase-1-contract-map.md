# Follow-Up Agent — Retention Phase 1 Contract Map

Status: FU-RET-01 foundation

Date: 2026-08-06

> Historical contract: this document records the disabled, read-only foundation. It was superseded by the owner-approved first release in `retention-first-release.md`. The temporary `retentionPhase1` isolation flag was removed when the retention workspace and approval-gated mutations shipped together.

## Safety contract

The retention upgrade is additive and disabled by default through `config.features.retentionPhase1`.

When the flag is absent or false:

- existing lead creation, deduplication, scoring, follow-up planning, reply handling, inbox sync, dashboard state, and delivery behavior remain unchanged;
- no retention route, background sweep, case creation, draft request, approval action, or external send is enabled;
- retention code may read existing records only through the adapter in `functions/src/retention/contracts.ts`;
- retention code must not mutate `LeadRecord.status`, lead contact fields, tasks, messages, timeline, decisions, inboxes, or existing config fields;
- missing source data remains unavailable. It must not be reconstructed from free text or model inference.

## Runtime and persistence architecture

The canonical backend source is `functions/src`. Files in `server` are thin re-export shims for shared modules plus a local Node HTTP adapter in `server/index.ts`. Firebase uses the Express adapter in `functions/src/index.ts`.

Current persistence is one `AgentState` blob:

- local development: `data/agent-state.json` in `server/index.ts`;
- production: Firestore document `settings/state` in `functions/src/db.ts`.

`createAgentEngine` holds state in memory and serializes operations through `AsyncLock`. This lock is process-local, not cross-instance. FU-RET-01 does not change persistence or concurrency. FU-RET-02 must add retention records additively and idempotently rather than extending unsafe whole-blob mutation indefinitely.

## Existing source contracts

### Account candidate

Current source: `LeadRecord` in `functions/src/agent-engine.ts`.

Available fields:

- `id`: only stable entity identifier;
- `tenantId`: defaults to `default`;
- `name`, `company`, `service`;
- `contact`: one mixed email-or-phone value;
- `channel`: SMS, Email, or Call;
- `status`: new, waiting_approval, contacted, needs_human, nurture, or closed;
- `createdAt`, `updatedAt`.

Temporary Phase 1 rule: an eligible non-closed lead may be exposed as an account candidate. This is an adapter, not a claim that lead and customer are the same domain entity. A future account/customer model should replace it without changing retention service consumers.

### Contact

Current source: `LeadRecord.contact` and `LeadRecord.channel`.

Constraints:

- there is no contact ID, primary-contact selection, verification timestamp, consent model, communication preference, opt-out record independent from lead status, or multiple-contact support;
- the adapter reports a synthetic read identifier and always marks the contact `verified: false`;
- draft or send eligibility must remain blocked in later tickets until recipient verification and communication eligibility are modeled.

### Task

Current source: `TaskRecord` in `functions/src/agent-engine.ts`.

Task types:

- `approve_message`;
- `follow_up`;
- `owner_review`.

Task states:

- `scheduled`;
- `waiting_approval`;
- `done`.

Available fields include lead ID, optional message ID, due date, note, and created date. There is no assignee, completion timestamp, client-facing classification, structured commitment link, or reason code.

### Timeline and meaningful interaction

Current source: `TimelineRecord` plus `MessageRecord`.

Timeline entries are free-form labels and details. Messages record direction, status, body, creation time, and optional sent time. Existing flows add timeline entries for lead intake, context checks, drafts, sends, replies, inbox imports, and delivery results.

There is no normalized event taxonomy or explicit `meaningfulInteractionAt`. Until one exists, Phase 1 may display raw evidence but must not score missed contact or commitments from arbitrary timeline text.

### Commitments, milestones, renewal, payment, and delivery

Structured source: unavailable.

The repository has no client commitment, milestone, renewal date, invoice, payment state, delivery blocker, complaint, cancellation intent, legal hold, or account-level communication eligibility model. Every retention signal that depends on these sources must be suppressed and shown as unavailable.

### Messaging, drafting, approval, and sending

Current sources:

- `MessageRecord` and `TaskRecord` in `functions/src/agent-engine.ts`;
- `deliverOutboundMessage`, `approveMessage`, `runDueTasks`, and `recordReply` in the same file;
- channel adapters in `functions/src/email.ts`, `twilio.ts`, and `voice.ts`;
- API routes in `functions/src/index.ts` and `server/index.ts`.

Existing draft-only mode creates a draft plus an approval task. `approveMessage` changes the message to sent and invokes the external channel. Autopilot may send initial messages and later follow-ups without owner approval when enabled.

Retention Phase 1 must not reuse these methods directly for an external send. Later retention tickets need separate draft, approval, final-content hash, eligibility recheck, idempotency, cooldown, and explicit-send contracts.

### Dashboard and public state

Current source: `GET /api/state` calling `toPublicAgentState`.

The dashboard receives the whole `AgentState` after inbox credentials and the Gemini key are redacted. `src/App.tsx` derives active tasks, timeline, messages, decisions, and aggregate counts client-side.

FU-RET-01 exposes only the boolean `retentionPhase1` flag in public config. It does not add retention data or UI.

### Authorization

Current source: `functions/src/auth.ts`.

`AGENT_API_KEY` protects non-webhook APIs only when configured. Webhook auth is optional through `WEBHOOK_API_KEY`. The current model has no authenticated user identity, roles, per-account authorization, owner ID, approver ID, or actor ID.

Retention mutating operations must not ship until authenticated actor and authorization contracts exist. The read adapter itself has no route in FU-RET-01.

### Audit and decision history

Current sources:

- `AgentDecisionRecord`;
- `TimelineRecord`;
- outbound channel result timeline entries.

They provide useful operational evidence but are not a compliant append-only audit log. Missing fields include actor, request and idempotency IDs, previous/new state, source record IDs, final-content hash, model route, tool trace, and immutable storage guarantees.

FU-RET-02 should introduce a dedicated additive `RetentionAuditEvent` rather than overloading decisions or timeline records.

## Source availability policy

`createRetentionReadAdapter` returns explicit availability metadata:

- available: account candidates, one unverified contact value, tasks, timeline, messages, and decision history;
- unavailable: commitments, milestones, renewal, payment, invoices, structured delivery status, and other customer-success sources not represented in the current repository.

A missing source suppresses only its associated future signal. Missing data never contributes a risk score, creates a case, or enables drafting or sending.

## Regression baseline

The existing verification contract is:

```bash
npm test
npm run lint
npm run build
npm run build:functions
```

Existing tests cover lead scoring and planning, lead creation and deduplication, cadence, approval, autopilot, opt-out behavior, reply analysis, inbox and webhook intake, public-state redaction, Gmail OAuth readiness, dashboard flow, and shared frontend/backend domain-copy drift.

FU-RET-01 adds tests that prove:

- the retention adapter reads a retention-shaped snapshot without mutating `AgentState`;
- unavailable commitments are reported and suppressed;
- closed leads are excluded from eligible account candidates;
- the feature flag defaults false, survives state normalization, and is safe for public exposure.

## FU-RET-02 entry condition

Proceed to persistence and audit primitives only after:

1. the untouched baseline and FU-RET-01 tests, lint, frontend build, and Functions build pass;
2. `retentionPhase1` is false by default in fresh and legacy state;
3. the read adapter remains the only retention dependency on current lead records;
4. no retention endpoint or background job can mutate current lead workflows;
5. the additive persistence design includes one-active-case-per-account idempotency and a dedicated append-only retention audit contract;
6. authenticated actor and permission gaps are explicitly addressed before any owner action or external-send capability.
