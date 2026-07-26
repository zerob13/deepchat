# Agent Memory Evolution — Implementation Plan

## Delivery strategy

Implement the architecture in dependency order on one branch while keeping commits independently
reviewable and the repository green:

1. behavioral baseline and domain clock;
2. temporal claim persistence and interpretation;
3. exact deletion tombstones;
4. durable derivation and dirty-cluster consolidation;
5. directive plane;
6. working projection and budget allocation;
7. scope applicability;
8. maintained architecture and final validation.

Each slice includes its own tests. Before every commit, review the complete staged diff for hidden
side effects, compatibility, boundary behavior, performance, security, naming, test gaps, and future
maintenance cost.

## 1. Behavioral baseline

Add a deterministic behavior fixture and harness under `test/fixtures/memory` and `test/main/memory`.
The fixture measures observable selection/assembly behavior on four axes:

- carry-forward;
- preference/directive adherence;
- temporal correctness;
- correction/forgetting.

The CI gate must not require an external model. It evaluates stored rows, retrieval eligibility,
annotations, and assembled contributions. The existing optional model-backed persona evaluation
remains separate.

## 2. Domain clock

Add a narrow `MemoryDomainClock` to `MemoryRuntimeContextOptions`:

```ts
interface MemoryDomainClock {
  now(): number
  timeZone(): string
}
```

The production default uses wall time and the process IANA timezone. Tests inject a deterministic
clock. Replace business-time reads in memory services and row creation with the context clock.
Leave timeout measurement, retry deadlines, native-store leases, and performance observation on
their local infrastructure clocks.

This separation prevents tests from coupling temporal truth to scheduler timing.

## 3. Temporal persistence

### SQLite migration

Advance the global Agent Memory table migration and add:

```sql
temporal_kind TEXT NOT NULL DEFAULT 'atemporal'
valid_from INTEGER
valid_until INTEGER
temporal_confidence REAL
temporal_precision TEXT
temporal_timezone TEXT
```

Add CHECK constraints on fresh schema creation. Migration validation and row normalization enforce
the same rules for upgraded databases. Existing rows remain `atemporal`.

No vector rebuild is required because temporal metadata does not change embedding content.

### Domain and DTOs

Add closed unions and a `MemoryTemporalMetadata` object. Extend row, insert, recall, injection,
management, and route DTOs additively. Legacy callers may omit the metadata and receive atemporal
behavior.

### Extraction

Pass a clock snapshot (`now`, ISO timestamp, timezone) to extraction prompt construction. Request
temporal fields per candidate and accept both the new object shape and the historical array shape
during parser transition.

Normalize model output:

- finite epoch milliseconds only;
- confidence clamped to `[0, 1]`;
- half-open ordered intervals;
- IANA timezone syntax bounded in length;
- invalid temporal metadata degrades that candidate to atemporal rather than failing the batch.

Do not infer completion from an expired plan.

### Retrieval

Create pure temporal-policy functions:

- validate/normalize persisted metadata;
- compute eligibility and ranking factor;
- render a concise, sanitized temporal annotation.

Apply eligibility before final top-K and before access accounting. Candidate oversampling remains
bounded so filtered states do not starve the result set. Add `temporal` to trace breakdown without
changing existing score fields.

## 4. Exact tombstones

Add `agent_memory_tombstone` with owner-scoped unique hashes:

```sql
agent_id
identity_kind  -- provenance | content
identity_hash
created_at
reason
```

Hash with SHA-256 and domain separation. Never store plaintext or a reversible identity.

Extend the repository with:

- transactional selective delete with tombstone creation;
- exact suppression lookup;
- transactional clear that tombstones every cleared claim;
- Agent namespace cleanup that removes tombstones only when the Agent itself is retired.

Check suppression immediately before insert inside the same write transaction to close the race
between a concurrent delete and extraction. Return a typed `noop('forgotten')` outcome.

## 5. Durable lineage and dirty work

### Derivation relation

Add `agent_memory_derivation` with foreign-key-independent IDs so lineage remains readable when a
parent is later deleted. Insert edges in the same SQLite transaction as merge/reflection/supersede
outputs. Use a unique composite key for retry idempotency.

### Dirty queue

Add `agent_memory_dirty` keyed by `(agent_id, memory_id)`. Every relevant committed claim mutation
upserts a dirty seed. Maintenance claims a bounded ordered batch, retrieves a bounded neighbor set,
processes the resulting local clusters, and removes only successfully settled seeds.

The queue is a work index, not authoritative fact state. It covers episodic, semantic, and
reflection claims. Stale IDs are safely discarded. Failure leaves seeds retryable and rotates the
failed generation behind untouched work so a fixed failing prefix cannot starve the queue.

Replace the full-corpus pairwise consolidation loop after parity tests cover merge decisions and
maintenance budgets.

## 6. Directive plane

### Persistence

Add `agent_memory_directive` with typed kind/status/source fields and owner indexes. Keep directives
outside the vector store, FTS mirror, reflection, decay, and claim consolidation.

### Runtime

Add two operations:

1. pre-retrieval gating from active `suppress_topic` directives;
2. a separately typed directive contribution rendered outside `<context-data kind="memory">`.

The runtime coordinator composes both user-role contributions without modifying the base system
prompt. The directive contribution receives its own hard budget and policy version.

### Approval

Expose additive routes/client methods to list, create, approve, reject, and delete directives.
Model-derived suggestions are always drafts. Reuse the existing inbox interaction pattern and
shadcn primitives for approval UI.

## 7. Working projection and budget

Replace the opaque selection-only projection body with a deterministic structured projection:

- current high-confidence states;
- stable preferences/facts;
- recent events;
- future and previously planned items;
- high-level reflections.

Sort each section by explicit stable keys. Do not persist another claim summary.

Introduce a pure allocator over one configured total:

- directive ceiling;
- persona floor/ceiling;
- working floor/ceiling;
- query-recall reservation;
- bounded borrowing from unused shares.

The assembler remains the final hard ceiling and reports allocation decisions in its manifest.

## 8. Scope applicability

Add `scope_type` and `scope_id`; backfill existing rows to Agent scope so previously ignored
`user_scope` data does not suddenly narrow recall. Extend write options and query context with a
typed scope set. Keep `user_scope` only as a synchronized compatibility shadow for newly written
user-scoped rows.

Repository FTS queries filter applicability in SQL. Vector results are resolved and filtered by the
same predicate before ranking. Management APIs continue to list all rows owned by the Agent and
surface scope metadata.

Default callers use only Agent scope, preserving current behavior.

## Compatibility and rollback

- All schema changes are additive.
- Existing status/lifecycle compatibility shadows remain untouched.
- Existing API fields are not removed or retyped.
- New extraction parsing accepts the historical array.
- Existing rows are atemporal and Agent-scoped by default.
- Temporal metadata does not invalidate embeddings.
- A rollback binary ignores additive SQLite columns/tables. It may leave new rows present, but
  claims written by the new binary retain compatible core columns.
- Directive and lineage tables are isolated; an older binary simply does not consume them.

## Performance boundaries

- No new synchronous model call on the send path.
- Temporal policy is pure O(candidate count).
- Directive gating operates over a bounded active-directive set.
- FTS scope filtering remains indexed.
- Vector filtering uses bounded oversampling, never an unbounded refill loop.
- Dirty consolidation is bounded by seed, neighbor, LLM-call, and deadline budgets.
- Projection rebuilding paginates through the existing bounded candidate API.

## Security and privacy

- Treat extracted claims and directive suggestions as untrusted model output.
- Only explicit user action activates a directive.
- Continue sanitizing all claim/projection content.
- Use a distinct directive renderer; do not weaken the memory read-only notice.
- Tombstones contain hashes only.
- Scope predicates always include `agent_id`.
- Audit refs contain IDs/counts, not directive, claim, or forgotten plaintext.

## Validation

Per slice:

- focused Vitest suites;
- `pnpm run typecheck:node` when main/shared contracts change;
- `pnpm run typecheck:web` when renderer changes;
- affected architecture guard tests.

Before handoff:

- `pnpm run format`;
- `pnpm run i18n`;
- `pnpm run lint`;
- `pnpm run typecheck`;
- focused Memory tests;
- maintained retrieval and behavior gates;
- broader `pnpm run test:main` when runtime permits.

Failures must be classified as introduced, pre-existing, or environmental.
