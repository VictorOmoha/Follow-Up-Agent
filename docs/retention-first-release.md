# Client Retention and Follow-Up System: First Release

This release extends the existing inbound-lead workflow without replacing it. A current `LeadRecord` acts as the first account-like record, while messages, tasks, timeline events, and decisions supply account-health evidence.

## What shipped

- A pure deterministic health evaluator in `functions/src/retention.ts`
- A retention queue derived from current application state and ordered by risk, then due date
- Risk reasons, weights, owner, recommended action, approval state, and due date
- Human-approved recovery drafts through the existing message and task flow
- Persisted retention outcomes: `recovered`, `monitoring`, `no_response`, and `lost`
- A retention workspace and basic recovery dashboard in the React application
- Cloud and local API routes for preparing drafts and recording outcomes

## Current component map

```text
Manual / CRM / Email / Gmail / Twilio intake
                    |
                    v
          GPT-5.6 -> Gemini -> rules
                    |
                    v
               Agent engine
        lead -> message -> task -> approval
                    |
          +---------+----------+
          |                    |
          v                    v
 Retention evaluator      Firestore state
 score + reasons          timeline + decisions
          |                    |
          +---------+----------+
                    v
       Lead workflow / Retention dashboard
```

The canonical workflow and state mutations remain in `functions/src/agent-engine.ts`. The Firebase API is in `functions/src/index.ts`; `server/index.ts` mirrors the new routes for local development. `functions/src/public-state.ts` computes the safe retention snapshot while continuing to redact inbox credentials and API keys.

## Risk model

The score is capped at 100. It is intended to prioritize owner attention, not predict churn.

| Signal | Weight | Evidence |
|---|---:|---|
| Overdue follow-up | 35 | An unfinished task has a due date in the past |
| Unanswered message, 1–2 days | 20 | Latest sent outbound message has no newer inbound reply |
| Unanswered message, 3+ days | 30 | Same condition after three days |
| Negative sentiment | 30 | Inbound text from the last 30 days contains an explicit dissatisfaction or cancellation term |
| Open issue | 30 | Lead needs human review, has an owner-review task, or has an explicit open issue |
| Renewal due in 15–30 days | 15 | Optional `renewalAt` field |
| Renewal due in 0–14 days | 25 | Optional `renewalAt` field |
| Renewal overdue | 35 | Optional `renewalAt` date is in the past |
| Account inactive for 14+ days | 15 | No newer lead, message, or timeline activity |

Bands are `healthy` below 25, `watch` from 25, `high` from 50, and `critical` from 75.

Negative sentiment is deliberately a transparent keyword signal in this first release. Model-routed sentiment analysis is deferred until evaluation data exists.

## Human approval boundary

`POST /api/retention/:leadId/draft` creates an outbound draft plus a waiting-approval task. It never calls an external delivery provider. This rule remains in force when lead autopilot is enabled. The existing `POST /api/messages/:messageId/approve` route is the only path that approves and sends the draft.

`POST /api/retention/:leadId/outcomes` records the owner-selected outcome. A recovered account returns to `contacted`; a lost account becomes `closed` and its pending tasks and drafts are cancelled. Monitoring and no-response outcomes do not send messages or silently close the account.

## Verification

```bash
npm run build
npm test
cd functions
npm run build
npm test
```

Focused coverage verifies transparent signal weights, queue bands and ordering, recovery metrics, public-state output, the human-approval boundary, outcome persistence, and the retention dashboard.

## Deferred work

- Luna, Terra, and Sol model routing
- Stateless MCP-style integrations
- Entity-level Firestore transactions after the versioned collection migration
- Multi-user role-based access
- Renewal-system integrations
- Cost, latency, correction-rate, and fallback dashboards
- Recovery ROI after real workflow baselines are collected
