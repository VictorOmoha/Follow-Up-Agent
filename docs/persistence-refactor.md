# Persistence refactor: single-document → per-entity collections

## Why

The legacy deployment stored the **entire** app state in one Firestore document,
`settings/state` ([db.ts](../server/db.ts)). Every mutation performed a
read-whole → mutate-in-memory → write-whole cycle. That created three problems:

1. **1 MB hard cap.** `leads`, `messages`, `timeline`, and `decisions` are all
   `unshift`-ed and never pruned ([agent-engine.ts](../server/agent-engine.ts)).
   The doc grows unbounded and will eventually fail to write — silently, inside a
   `try/catch` that only `console.error`s.
2. **Lost updates.** The `AsyncLock` ([lock.ts](../server/lock.ts)) and rate
   limiter ([rate-limiter.ts](../server/rate-limiter.ts)) are **in-memory and
   per-instance**. With `maxInstances: 10` ([functions/src/firebase.ts](../functions/src/firebase.ts)),
   two instances each load full state and the last writer wins — concurrent leads
   clobber each other.
3. **Cold-start cost.** `minInstances: 0` means each cold instance reads the whole
   blob and writes it back on first change.

## Implemented data model

State is now persisted as versioned generations containing one document per
entity. The active generation changes only after every entity write succeeds, so
readers never observe a partially written snapshot:

```
stateMetadata/default                              ← active generation and revision
stateSnapshots/{generation}/config/global          ← application configuration
stateSnapshots/{generation}/leads/{id}             ← LeadRecord
stateSnapshots/{generation}/messages/{id}          ← MessageRecord
stateSnapshots/{generation}/tasks/{id}             ← TaskRecord
stateSnapshots/{generation}/timeline/{id}           ← TimelineRecord
stateSnapshots/{generation}/decisions/{id}          ← AgentDecisionRecord
stateSnapshots/{generation}/inboxes/{id}            ← ConnectedInbox
stateSnapshots/{generation}/emailMessages/{id}      ← EmailMessageRecord
stateSnapshots/{generation}/retentionOutcomes/{id}  ← RetentionOutcomeRecord
```

The loader prefers the active entity generation and falls back to the legacy
`settings/state` document for a zero-downtime first deployment. The first
successful write migrates that state. A revision compare-and-swap prevents two
Cloud Function instances from silently making different snapshots active. The
active and immediately previous generations are retained for rollback; older
generations are removed after a successful switch.

## Concurrency

The implemented revision compare-and-swap prevents stale snapshots from silently
overwriting a newer active generation. The next hardening stage is moving the
individual engine operations below into entity-level Firestore transactions.

The per-lead read-modify-write paths (`createLead` dedup, `approveMessage`,
`recordReply`) must run inside `db.runTransaction()` so two instances can't clobber
the same lead. The in-memory `AsyncLock` only serializes within one process and
gives a false sense of safety in serverless.

```ts
await db.runTransaction(async (tx) => {
  const ref = db.collection('leads').doc(leadId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw notFound(leadId);
  const lead = snap.data() as LeadRecord;
  // ...mutate...
  tx.set(ref, lead);
  tx.set(db.collection('leads').doc(leadId).collection('messages').doc(msg.id), msg);
});
```

For cross-lead rate limiting, move the limiter to Firestore (a `ratelimits/{ip}`
doc with a transaction) or Firebase App Check — the in-memory one is ineffective
across instances.

## Repository layer

Introduce a `repo` that the engine calls instead of holding the whole `AgentState`
in RAM. This is the core change — the engine stops being a giant in-memory blob and
becomes a set of operations over the repo.

```ts
// db.ts (new shape)
export interface Repo {
  getConfig(): Promise<Config>;
  setConfig(c: Partial<Config>): Promise<void>;

  getLead(id: string): Promise<LeadRecord | undefined>;
  findLeadByContact(contact: string): Promise<LeadRecord | undefined>; // dedup
  listLeads(opts?: { limit?: number }): Promise<LeadRecord[]>;
  upsertLead(l: LeadRecord): Promise<void>;

  addMessage(m: MessageRecord): Promise<void>;
  listMessages(leadId: string): Promise<MessageRecord[]>;

  dueTasks(now: Date): Promise<TaskRecord[]>;   // indexed query, not full scan
  addTask(t: TaskRecord): Promise<void>;
  completeTask(id: string): Promise<void>;

  addTimeline(e: TimelineRecord): Promise<void>;
  addDecision(d: AgentDecisionRecord): Promise<void>;

  withLeadLock<T>(leadId: string, fn: (tx) => Promise<T>): Promise<T>; // transaction
}
```

For `/api/state` (the dashboard), add a single `getSnapshot()` that fan-out reads
the recent slices (e.g. last 100 leads, last 200 timeline events) — paginated, not
"everything". The current `toPublicAgentState` redaction
([public-state.ts](../server/public-state.ts)) is kept as-is on top of the snapshot.

## Firestore indexes

The versioned snapshot implementation reads each active entity collection
directly and requires no new composite indexes. Entity-level task queries and
normalized-contact deduplication will add indexes when Phase 5 moves individual
engine operations into Firestore transactions.

## Shared core

The duplicate backend modules have already been removed. `functions/src/` is the
canonical implementation and the matching files in `server/` are thin re-export
shims used by the local Node adapter and test suite.

## Phased rollout

| Phase | Change | Risk | Reversible? |
|-------|--------|------|-------------|
| 0 | ✅ gitignore the service-account key (done) | none | — |
| 1 | ✅ Use one canonical backend core with local re-export shims | low | yes |
| 2 | ✅ Write versioned per-entity Firestore generations | low | yes |
| 3 | ✅ Fall back to the legacy blob and migrate on first write | low | yes |
| 4 | ✅ Protect the active generation with revision compare-and-swap | low | yes |
| 5 | Move per-lead mutations into entity transactions | med | yes |
| 6 | Add pruning/TTL and paginate `/api/state` | low | yes |

Keep the local-file backend (`data/agent-state.json`) for dev — it can stay a
single file; the cap/concurrency issues only matter in the multi-instance cloud.

## Out of scope but related (track separately)

- **Multi-tenancy:** `tenantId` is hard-coded `'default'`. Real isolation means
  `tenants/{tenantId}/leads/...` and per-tenant auth — a separate effort.
- **Entity transactions:** revision conflicts fail safely, but individual engine
  operations should ultimately execute directly against Firestore transactions.
