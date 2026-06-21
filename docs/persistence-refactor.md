# Persistence refactor: single-document → per-entity collections

## Why

Today the **entire** app state lives in one Firestore document, `settings/state`
([db.ts](../server/db.ts)). Every mutation does read-whole → mutate-in-memory →
write-whole. Three problems:

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

## Target data model

One document per entity, in top-level collections (Firestore docs cap at 1 MB
*each*, so per-entity docs never hit it):

```
config/global                       ← single doc (bookingLink, autopilotEnabled, geminiApiKey)
leads/{leadId}                      ← LeadRecord
leads/{leadId}/messages/{msgId}     ← MessageRecord   (subcollection: scoped reads + cascade delete)
leads/{leadId}/timeline/{eventId}   ← TimelineRecord
tasks/{taskId}                      ← TaskRecord       (top-level: queried by dueAt across all leads)
decisions/{decisionId}             ← AgentDecisionRecord
inboxes/{inboxId}                   ← ConnectedInbox
emailMessages/{id}                  ← EmailMessageRecord
```

Notes:
- `messages`/`timeline` as **subcollections** of a lead → deleting a lead cascades,
  and the per-lead reads in `recordReply`/`runDueTasks` become scoped queries.
- `tasks` stays **top-level** because the scheduler ([firebase.ts](../functions/src/firebase.ts)
  `runDueTasks`) queries due tasks across *all* leads: `where('status','==','scheduled').where('dueAt','<=', now)`.
- `decisions` and `timeline` are append-only logs → add a **TTL / cap** (see Phase 4).

## Concurrency: replace the in-memory lock with Firestore transactions

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

## What Phase 2 actually shipped

`functions/src/store/firestore-store.ts` implements a `StateStore` (`load` /
`save(fullState)`) selected by `AGENT_STORE`. It keeps the existing in-memory
engine but changes *how* state lands in Firestore:

- one document per entity in top-level collections (no 1 MB cap),
- **diff-based writes** — it remembers what it last persisted and only writes the
  docs that changed, plus deletes for entities that vanished, so two instances
  mutating *different* leads no longer clobber each other,
- **log pruning** — `timeline` and `decisions` are capped (1000 newest) on save.

Same-entity concurrent writes are still last-writer-wins; that's what Phase 3's
transactions close. The granular `Repo` below is the Phase 3 target.

## Repository layer (Phase 3 target)

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

## Required Firestore indexes

Add to [firestore.indexes.json](../firestore.indexes.json):
- `tasks`: composite (`status` ASC, `dueAt` ASC) — for `dueTasks`.
- `leads`: single-field `updatedAt` DESC — for the dashboard list.
- For dedup, store a normalized `contactKey` (digits-only phone OR lowercased email)
  on each lead and index it, so `findLeadByContact` is a point query instead of the
  current in-memory `.find()` scan ([agent-engine.ts:263](../server/agent-engine.ts)).

## Prerequisite: de-duplicate `server/` and `functions/src/`

These two trees are near-identical copies (`agent-engine.ts` is 32 KB in **both**).
Doing this refactor twice guarantees drift. **Before** Phase 2, extract the shared
logic into one module both import:

```
packages/core/        ← agent-engine, gemini, auth, db, email, voice, twilio,
                        lock, rate-limiter, public-state, gmail-oauth, shared types
server/index.ts       ← thin Node http adapter  → imports @core
functions/src/index.ts← thin Express adapter     → imports @core
```

(Or a simpler `shared/` dir + path alias if you don't want a workspace yet.)
The only real differences between the two `index.ts` files are the HTTP framework
(raw `http` vs Express) and the scheduler wiring — everything else should be shared.

## Phased rollout

| Phase | Change | Risk | Reversible? |
|-------|--------|------|-------------|
| 0 | ✅ gitignore the service-account key (done) | none | — |
| 1 | ✅ Extract shared source; `server/*` re-export from `functions/src/*` (done) | low | yes |
| 2 | ✅ Per-entity `collections` store behind `AGENT_STORE` flag; diff-writes + log pruning (done) | low | yes |
| 3 | Move per-lead mutations into `runTransaction`; make `collections` the default | med | yes (flag) |
| 4 | Add pruning/TTL on `timeline` + `decisions`; paginate `/api/state` | low | yes |
| 5 | Backfill: one-time script splits the existing `settings/state` blob into collections | med | snapshot first |
| 6 | Delete the blob path + in-memory `AsyncLock` | low | — |

Keep the local-file backend (`data/agent-state.json`) for dev — it can stay a
single file; the cap/concurrency issues only matter in the multi-instance cloud.

## Out of scope but related (track separately)

- **Multi-tenancy:** `tenantId` is hard-coded `'default'`. Real isolation means
  `tenants/{tenantId}/leads/...` and per-tenant auth — a separate effort.
- **Auth:** make `AGENT_API_KEY` required (fail closed) rather than optional.
- **Twilio inbound signature validation** on `/api/sms/inbound`.
</content>
