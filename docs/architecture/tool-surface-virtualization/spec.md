# Tool Surface Virtualization Specification

## Status

The architecture decision is approved. Implementation is staged behind shadow measurement and an
explicit canary; neither virtualization nor a selector model is the default production path until
the Go/No-Go gates in this specification pass.

Last reviewed: 2026-08-10.

## Decision

DeepChat will virtualize the provider-visible tool surface without virtualizing tool identity.

```text
Owned capabilities
  -> frozen Run Tool Ceiling
  -> per-View Eligible Catalog
  -> provider-visible Active Surface
  -> native function call with the real tool identity
```

For a small eligible catalog, the Active Surface contains the complete eligible catalog. For a
large catalog, a deterministic policy selects an initial subset and adds one system-model
`tool_search` capability. `tool_search` returns bounded discovery metadata and activation
candidates. Successfully settled candidates may enter only a later provider View. Once active, a
target is exposed and dispatched as its real native function tool; there is no `tool_invoke`
wrapper and no wrapper-to-target identity mapping.

The Run freezes the maximum capability set that may participate. Each provider request freezes one
immutable `ToolSurfaceSnapshot`. The snapshot is a sibling of the provider payload and the existing
ViewManifest/ExecutionContract, not mutable Session-global state.

Tape records versioned facts about the catalog and selected surface. Runtime remains the online
authority for availability, permission, approval, target identity, and current revocation. Normal
dispatch never reads Tape.

## Motivation

DeepChat currently transmits every resolved tool definition on every provider request. As MCP,
Agent, Plugin, Skill, and system-model capabilities grow, ownership, discoverability, visibility,
and executability collapse into one unbounded set. This increases prompt size, can exceed provider
tool limits, and makes schema cost scale with every installed capability rather than the current
task.

Contract-bearing DeepChat child Views also cap an ExecutionContract at 256 tool identities and
64 KiB. An eligible catalog above that ceiling currently fails contract construction before the
provider request. Making the contract ceiling equal the Active Surface removes that cliff while
preserving the existing definition of a ceiling as provider-visible identities.

The optimization cannot be judged only by schema token reduction. Provider prompt caches commonly
treat the tools array as part of the reusable prefix. A surface that churns every View can save tool
schema tokens while increasing uncached input cost. Selection, ordering, activation, and rollout
therefore treat cache behavior, latency, success rate, and billed input cost as first-class gates.

## Design Principles

1. Virtualize visibility, not identity.
2. Hidden targets are neither provider-visible nor dispatchable in the current View.
3. Capability expansion takes effect only in a later View.
4. Runtime revocation may shrink authority immediately.
5. Tape preserves historical exposure facts and never becomes online permission authority.
6. Selector or search failure never falls back to transmitting the complete large catalog.
7. Ordinary V4 chat remains correct without constructing an ExecutionContract.
8. Provider-visible ordering is stable within a Run and catalog hashing is independent of that
   append history.
9. Rollout decisions use effective provider cost and task quality, not schema size alone.

## Scope

### P0-A: Shadow Measurement

P0-A computes catalog identity, definition hashes, candidate virtualization decisions, hypothetical
initial surfaces, schema-token estimates, and static surface overlap across consecutive requests. It
does not:

- change the provider-visible tools array;
- add `tool_search`;
- change an ExecutionContract ceiling;
- write tool-surface facts to Tape;
- persist raw schemas, descriptions, prompts, or provider payloads.

Measurements are bounded, content-free process diagnostics. A diagnostics failure is ignored and
must not affect generation.

### P0-B: Canary Virtualization

P0-B adds the native dynamic-activation path behind an explicit internal canary mode. The canary
persists the two View facts defined below and uses existing provider-attempt usage facts to measure
cache and request cost. Canary enablement is not a public setting and does not change existing
Agent configuration semantics.

### Explicitly Deferred

- `tool_inspect` and `tool_invoke` meta-tools;
- a mandatory pre-request selector model;
- programmatic tool calling or a general-purpose script sandbox;
- session-global schema-seen or discovery ledgers;
- cross-Run activation authority;
- deterministic search replay using copied schema or catalog bodies;
- provider-specific semantic ranking models;
- ACP tool-surface virtualization;
- default production enablement before the Go/No-Go gates pass.

## Domain Model

### Owned Capabilities

Owned capabilities are the tools associated with the current Agent, enabled MCP servers, Plugin
contributions, and system-model policy. Ownership is not provider visibility or dispatch authority.
Diagnostic and runtime-only Agent tools are never model-discoverable.

### Run Tool Ceiling

At Run creation DeepChat constructs an owned definition universe from current Agent policy, enabled
MCP and Plugin contributions, and the union of conditional definitions and declared tool
requirements that every currently valid and enabled Skill in that Agent's catalog may require. An
absent Skill `allowedTools` value declares no additional named requirement. Declared names resolve
through the same owned source-mapping and reserved-name rules used for execution. An unresolved or
ambiguous inactive-Skill requirement makes that Skill non-activatable for the Run and adds a bounded
degradation; the same problem in an initially active mandatory Skill fails Run admission. P0-A
records only unresolved counts and reason codes, never names or definitions.

The TaskContract meet is applied before DeepChat freezes the resulting maximum stable targets as the
Run Tool Ceiling. This is a new explicit representation of the Tool system's closed-Run requirement;
it is not the initially active Skill profile returned by the current resolver. The ceiling may never
gain a target after Run creation.

The ceiling includes stable target identity and definition identity, but it is not persisted as a
second online authority. Current runtime revocation may remove targets from subsequent Eligible
Catalogs or reject an already-active target before dispatch. A capability enabled after Run creation
waits for a new Run.

For a contract-bearing child, the TaskContract tool ceiling is met before this Run ceiling is
frozen. The provider-visible ExecutionContract ceiling remains a narrower per-View Active Surface.

### Eligible Catalog

Each provider View derives:

```text
Eligible Catalog =
  Run Tool Ceiling
  meet current runtime authority
  meet current Skill state
  minus current revocations
```

This derivation can only preserve or shrink the Run ceiling. A Skill activated in the middle of a
Run may reveal definitions already represented by the ceiling, but cannot import a target that was
outside it. Skill activation atomically preflights ceiling membership and mandatory-tool budget
before mutating Skill or prompt state. A newly installed, newly enabled, or definition-drifted Skill
target waits for a new Run. If current runtime state changes a target definition, the old definition
is stale rather than an expansion.

`tool_search` reads the frozen Eligible Catalog attached to its originating
`ToolSurfaceSnapshot`. It must not consult a process-global or Session-global latest catalog.

### Active Surface

The Active Surface is the ordered list of complete native tool definitions sent to the provider for
one View. It is immutable for that provider request and all of its transient physical retries. A
Run-scoped activation-order ledger retains the ordinal assigned when each target first becomes
active.

Without revocation, existing active entries retain their position for the rest of the Run and newly
activated entries append at the tail in one deterministic batch. The policy never evicts an active
entry to make room for a new search hit. Revocation is a mandatory shrink and is not considered an
append-only violation. Revocation filters the effective surface without deleting the ledger entry.
If authority returns within the same Run, the target resumes its original ordinal. Authority changes
may therefore churn the provider array; the no-reordering guarantee applies while authority is
stable.

The catalog hash uses a separate canonical stable-target order. It is not computed from the
provider-visible append order.

### Activation Candidates

A successful `tool_search` result creates bounded Run-scoped candidates identified by the
originating:

- `sessionId`;
- `messageId`;
- `runId`;
- `requestSeq`;
- tool-call ordinal within the assistant batch;
- result rank;
- stable target key.

Candidates are not authority and are not active in the originating View. Each result reports only
`candidate`/`pending`, or a static rejection that is knowable without competing for shared batch
budget; it never promises final activation. After the complete tool batch settles, DeepChat merges
candidate lists by `requestSeq`, `toolCallOrdinalWithinBatch`, result rank, and stable target key,
then deduplicates by stable target. Opaque provider `toolCallId` values may remain operation
identity but are never used as an ordering key.

Candidate release is an outcome projection: it occurs only after ToolSearch's durable
`tool_outcome`, is idempotent by operation identity, and waits for the complete batch settlement.
Before the next provider request, every released candidate is rechecked against the Run ceiling,
live authority, definition identity, and remaining activation budget. Accepted targets are staged
for the next Active Surface; rejected targets remain non-dispatchable. The Run activation ledger is
updated only when that View reaches provider admission. For strict V5 this is after required View
facts are durable; for fail-open V4 it is when the request is admitted after any bounded diagnostic.
In-process preflight recovery keeps candidates pending and rebuilds the View; recovery after a
provider call has started carries the already committed ledger. A process crash before admission
discards uncommitted candidates, and the new Run must perform ToolSearch again. Runtime must not
reconstruct them by reading Tape or rerunning search against a changed catalog. Candidates never
cross a Run, and an incomplete tool batch cannot start another provider View.

### Tool Surface Snapshot

One deeply immutable `ToolSurfaceSnapshot` binds:

- `sessionId`, `messageId`, `runId`, and `requestSeq`;
- policy and ordering versions;
- virtualization decision and budget;
- full catalog hash and bounded catalog entries;
- ordered active target entries and native definitions;
- per-target canonical DeepChat definition hashes;
- accepted activation provenance;
- bounded degradation codes.

The same value is used to construct the provider tools array, surface facts, V5
ExecutionContract, and dispatch guard. Reference or canonical identity must remain unchanged from
assembly through the corresponding tool batch. A Session-global latest snapshot is forbidden.

## View And Retry Semantics

One provider request sequence is one Tool Surface View.

| Transition | ToolSurface behavior |
| --- | --- |
| transient physical retry | reuse exact snapshot, manifest, contract, messages, and requestSeq |
| context-pressure recovery | create a new requestSeq and snapshot |
| search activation | create a new requestSeq and snapshot |
| effective Skill definition change | create a new requestSeq and snapshot |
| current revocation | shrink next View; reject immediately if dispatch is pending |
| new capability enabled mid-Run | unavailable until a new Run |

If one assistant batch calls `tool_search` and also guesses a hidden target name, the guessed call
fails closed. The search result cannot authorize any call in the same batch.

## Selection Policy

### Virtualization Trigger

Virtualization is evaluated once at Run creation against the complete Run Tool Ceiling and remains
fixed for the Run. A versioned policy uses both ceiling tool count and estimated provider-visible
definition tokens. The estimate reuses `estimateToolDefinitionTokens` and includes the
`tool_search` definition and prompt overhead.

A ceiling below both thresholds remains fully active as tools become eligible and does not receive
`tool_search`. A ceiling above either enter threshold is virtualized. Cross-Run exit thresholds are
lower than enter thresholds so ceilings near a threshold do not alternate modes. Any remembered
hysteresis input is a bounded selection hint, not dispatch authority, and is always recomputed
against the newly constructed ceiling.

P0-A calibrates concrete threshold values. P0-B stores them in a versioned internal policy rather
than user preferences. Changing a threshold, ranking rule, budget, or mandatory set increments the
policy version.

### Initial Surface

The deterministic initial surface is composed from:

1. policy-required system-model tools;
2. the Agent profile's bounded core working set;
3. tools required by Skills active at Run creation;
4. a bounded recent-use hint intersected with current eligibility;
5. `tool_search` only when virtualization is triggered.

`deepchat_question` is user-configurable and is not treated as an unconditionally mandatory host
tool. Disabled or ineligible user-configurable tools are never forced into the surface.

The recent-use hint affects only deterministic selection. It cannot make a target eligible, cannot
survive target definition drift, and is not a sticky authority record.

### Budgets

The policy defines separate bounded values for:

- initial active tool count and definition tokens;
- activation reserve count and definition tokens;
- search result count;
- one settled batch's activation count;
- per-Run activation batches and appended targets;
- total provider-specific tool count and definition tokens;
- contract-bearing V5 identity count.

The initial surface must leave the activation reserve available. Search results report pending
candidates, not final acceptance. A candidate that cannot fit remains absent from the next native
tools list, and the next surface provenance records the bounded rejection reason. It is never
silently activated, never evicts an existing target, and never triggers a full-catalog fallback.

All contract-bearing V5 surfaces remain within 256 tool identities and the ExecutionContract's
64 KiB canonical limit. The 256-identity rule is not imposed on ordinary V4 chat unless a provider
has an equal or lower limit.

If mandatory tools exceed the budget at Run creation, request admission fails closed with a bounded
configuration diagnostic. Skill activation must preflight before mutating the active Skill set or
prompt. If its required tools are outside the Run ceiling or do not fit the remaining budget, that
Skill activation call returns a bounded error and the Run continues; it does not partially activate
the Skill, fail the next provider request, or evict active tools.

### Skill Activation Settlement

Skill activation is a serialized staged settlement rather than a warning-only refresh after a
successful tool outcome:

1. validate the Skill and resolve all requirements through the frozen ceiling;
2. compute the cumulative budget effect and exact next active-Skill, tool-definition, and prompt
   resource bundle without mutating Run state;
3. commit a bounded failure outcome if preflight fails, or commit the successful Skill tool outcome;
4. apply the already-computed immutable resource bundle before another provider View can begin.

Applying a successful staged bundle performs no I/O and must not fail. If success outcome
persistence fails, the bundle is discarded. If the process stops after success persistence but
before bundle application, no provider request may observe partial state; a new Run resolves its
own state and may invoke the Skill again. Multiple Skill activation intents in one batch are
serialized by tool-call ordinal and preflight cumulatively against the same remaining budget.

## `tool_search`

`tool_search` is a reserved Agent capability with `system-model` exposure and a read effect. MCP,
Plugin, or user-defined tools cannot shadow it. It appears only in a virtualized Run.

The input contains a bounded natural-language query and an optional bounded result limit. The
implementation searches only model-discoverable entries in the originating frozen catalog.
Diagnostic, runtime-only, ineligible, secret-bearing, and policy-excluded targets never enter the
index.

Each result contains bounded, explicitly model-discoverable metadata sufficient to choose a
capability:

- stable model-visible tool name;
- reviewed source label or namespace;
- one-line bounded description;
- optional reviewed effect class and bounded tags;
- candidate/pending state or a static rejection reason.

Stable target keys, binding hashes, server UUIDs, and raw source IDs remain internal to the snapshot
and candidate projection. Search does not return raw JSON Schema, raw MCP `_meta`, handlers,
provider payloads, secrets, arbitrary MCP metadata, or unbounded descriptions. The full native
schema appears only when the target is active in the next provider View; that native definition is
the inspection step.

`tool_search` executes as a normal read tool and follows existing tool output normalization,
preparation, fitting, cancellation, `dispatch_committed`, and `tool_outcome` disciplines. It never
dispatches a hidden target itself.

Parallel search calls in one assistant batch are allowed. Candidate merge uses the persisted
`toolCallOrdinalWithinBatch`, not provider call-ID lexical order.

ToolSearch is one statically registered Agent tool. The originating snapshot and a batch-owned
candidate sink travel through typed tool execution options. The handler never installs a per-View
closure in shared ToolService state and never reads a Session-global latest snapshot. Duplicate
operation identity may reproduce the same result but cannot release a second candidate.

## Dispatch Enforcement

Active membership is checked before target-specific dispatch. A name that was not active in the
originating snapshot receives the same bounded unavailable response whether the target is hidden,
ineligible, revoked before the View, or nonexistent. This prevents guessed calls from becoming a
catalog oracle and produces no target side effect or target `dispatch_committed` fact.

An active target may still fail with the existing specific runtime error if live authority,
permission, approval, Session state, or target binding changed after View assembly. This preserves
diagnostic value for a capability the model legitimately saw.

The request-scoped snapshot carries a stable target key and a per-target
`canonicalToolDefinitionHash`. Before a target `dispatch_committed`, ToolService compares both
against the current resolved target. A mismatch rejects the call and requires a new View. This
guard applies to V4 and V5 without changing the ExecutionContract schema or its historical hash
recipes.

The canonical Tool definition hash is computed at the same semantic layer as the existing
`toolDefinitionsHash`: canonical JSON of the complete `MCPToolDefinition` after
`stripToolExecutionContract`. Its recipe includes the function, server, and raw fields and excludes
only the execution policy. Metadata-only changes intentionally fail closed. Provider-adapter
normalization below that layer is explicitly outside the drift guard, so this value does not claim
to hash exact provider-wire JSON. The canonicalization version is recorded with the hash recipe.

Every live permission, approval, contract, stable-target, effect, workdir, depth, and definition
drift gate remains before target `dispatch_committed`. Typed TaskContract definition meet remains an
assembly-time operation rather than being misrepresented as a dispatch-stage gate.

## Tape Facts

Tool-surface provenance is stored as two append-only facts in the existing View family. Neither fact
changes `view/assembled`, ViewManifest schemas 1 through 5, or their hash recipes.

### `view/tool_catalog`

Within one Tape incarnation, this fact is idempotently keyed by `fullCatalogHash` and contains:

- fact schema, full-catalog hash recipe, and retained-projection hash recipe versions;
- canonicalization version;
- `fullCatalogHash` over every canonical catalog entry;
- `catalogProjectionHash` over the retained bounded projection;
- retained stable target identities and canonical Tool definition hashes;
- retained exposure classes and reviewed effect classes;
- total and retained counts;
- bounded truncation/degradation codes.

It does not store raw schema bodies, raw MCP `_meta`, handlers, provider payloads, secrets, or full
descriptions. A truncated projection does not claim that its entries can reconstruct the full
`fullCatalogHash`; its independent projection hash proves only the retained bounded evidence. The
fact supports audit of identity and definition version, not deterministic search replay.

### `view/tool_surface`

This fact is idempotently keyed by `sessionId`, `messageId`, `runId`, and `requestSeq` and contains:

- fact schema, surface hash recipe, and canonicalization versions;
- `surfaceHash`;
- View identity and `manifestHash`;
- full catalog hash and physical catalog fact reference;
- selection policy and ordering versions;
- virtualization decision;
- ordered active target, canonical definition hash, activation ordinal, and reason entries;
- count/token budget observations;
- bounded search-result fact references that caused activation;
- bounded candidate rejection reasons;
- bounded degradation codes.

The ordered active entry list is complete for strict V5 and therefore bounded by its 256-identity
ceiling. A V4 holdout surface that exceeds the fact's bounded projection limit records a
deterministically truncated active projection and an explicit degradation code; every newly paused
V4 action still stores its own exact target/hash binding for restart enforcement.

The provider-visible `tool_search` result already enters Context Tape through the normal tool-result
projection. The surface fact references that evidence rather than copying the result body.

Both facts are bounded and use canonical conflict checking: the same idempotency identity with the
same payload reuses the fact, while a different payload is corruption. A Tape reset starts a new
incarnation, so deduplication never creates a cross-incarnation physical reference.

Both facts are excluded from the effective conversation View, Memory ingestion, and ordinary Tape
search. They are available only to explicit audit and recovery readers.

### Write Discipline

For every contract-bearing V5 DeepChat child provider View, both facts are required even when
virtualization is not triggered. One dedicated application service performs the following logical
steps in a single SQLite transaction before provider admission:

1. append the existing `view/assembled` manifest;
2. idempotently append or validate `view/tool_catalog`;
3. append or validate `view/tool_surface`, which references the manifest and catalog fact;
4. start the provider request.

Before transaction commit the service requires one canonical manifest and one canonical surface for
the complete request identity. An existing identity with different canonical content, including a
different manifest or surface hash, is corruption. The surface stores a complete physical catalog
fact reference containing Tape identity, entry ID, and fact hash, so Tape reset/incarnation is
explicit. Any missing, malformed, conflicting, or failed write is fail-closed for the strict child.
Ordinary interactive V4 chat invokes the same transaction but remains fail-open, emits a bounded
diagnostic, and never reports unpersisted surface provenance as verified. The bounded diagnostic is
new work; the current implementation's warning log alone is not described as durable or verified
evidence.

Normal dispatch does not read these facts. Process-restart recovery is the narrow exception:

- strict V5 deferred dispatch must resolve exactly one hash-valid `view/tool_surface`, validate its
  manifest identity and exact active target/hash pair, and match current runtime target identity;
  missing, duplicate, malformed, conflicting, or mismatched evidence fails closed;
- every new canary V4 permission pause stores the originating surface hash, stable target key, and
  canonical definition hash in its durable action projection. Restart enforces that binding even if
  fail-open View fact persistence failed. Only historical V4 projections without the binding keep
  legacy behavior.

## Prompt Cache And Ordering

In canary mode, provider-visible tool order is deterministic. At Run creation the policy establishes
a stable initial order. Existing entries retain their activation ordinals; accepted activation
entries append in one deterministically sorted batch. Mid-Run reranking or budget eviction is
forbidden. Revocation filters this ledger and re-enablement restores the original ordinal.

Catalog hashing uses canonical stable-target order, so equal catalogs receive equal hashes even when
provider append histories differ. Definition hashes and ordering recipes are independently
versioned.

Canary cohort assignment is computed once before Run ceiling and ordering construction, using a
privacy-preserving hash of an internal rollout seed and stable installation or Session bucket. The
bounded `canary` or `holdout` label is frozen in `LoopRun.resources`; the raw assignment key is not
persisted. A View, retry, provider-state refresh, or model-state refresh cannot reassign an existing
Run.

P0-A correlates baseline cache fields already available from provider attempt usage with static
hypothetical surface hashes and overlap; absent provider metrics are reported as unavailable. It
cannot measure activation churn, repeated search, extra rounds, quality, or effective-cost delta
without changing the payload. P0-B canary measures the actual delta against a contemporaneous,
deterministically assigned non-virtualized control cohort in the same release. Cohort keys include
provider, model, policy version, and catalog-size band. A versioned pricing source and
provider-specific cache token semantics are required before calculating effective cost. The canary
records:

- cache-read and cache-write input tokens;
- uncached input tokens;
- provider requests and logical rounds;
- search invocations and repeated searches;
- tool-schema definition tokens;
- time to first token and end-to-end latency;
- task/tool success and failure categories;
- provider-billed effective input cost when pricing is known.

Providers without usable cache metrics or pricing are separate cohorts. Their results are not mixed
with providers for which effective input cost can be calculated.

## Compatibility

- Existing tools, approval UI, permission flow, Journal target identity, native provider calls, and
  tool-result projection remain native after activation.
- Small catalogs preserve the eligible tool set and call semantics. Provider-order changes remain
  canary-scoped until default enablement. P0-A and rollback preserve legacy provider order while
  still computing a separate canonical catalog order for hashing.
- Ordinary V4 chat does not construct an ExecutionContract. Its existing
  `toolDefinitionsHash` continues to describe the exact Active Surface sent to the provider.
- Contract-bearing V5 ceilings contain only the exact provider-visible Active Surface.
- ViewManifest schemas and historical hash recipes remain unchanged.
- ACP resolves its existing externally owned tool plane and is excluded from P0.
- Disabled `deepchat_question` and other user-configurable tools are not reintroduced as mandatory.
- Initial selection errors in a canary degrade to the bounded core plus `tool_search`. An individual
  search error returns a bounded failure and never exposes the full large catalog.
- Rollback never mutates the frozen mode or surface of an existing Run. It prevents new canary Runs;
  an emergency stop may abort an active canary Run, whose explicit retry or resume receives a new
  Run identity on the holdout path. Previously appended View facts are never deleted or rewritten.

## Security And Privacy

- Search cannot enumerate diagnostic, runtime-only, ineligible, or policy-excluded capabilities.
- Hidden-name dispatch errors do not reveal whether a target exists.
- Runtime rechecks current authority immediately before dispatch.
- Definition drift is rejected before target side effects.
- Catalog and surface facts contain hashes, stable bounded references, and reason codes, not raw
  schemas, prompts, headers, credentials, provider payloads, handlers, or MCP metadata.
- Queries, descriptions, IDs, and errors are bounded before model output, logs, or persistence.
- Search is read-only and cannot invoke a candidate target.
- A search result is not permission, approval, or authority.

## Performance Bounds

Canonicalization enforces versioned input byte, nesting-depth, entry-count, and output byte limits
in addition to estimated provider tokens. P0-A reports a content-free
`surface_hash_input_exceeded` degradation and omits the hypothetical surface when a Run exceeds
those limits. P0-B assigns such a Run to a pre-admission ineligible/control cohort before changing
tool order or provider payload; this is not a post-selection full-catalog fallback. Default
enablement cannot proceed until the oversized-definition rate and production rejection policy have
an explicit accepted threshold.

Canonical Tool definition hashes may use a bounded process cache only when the source exposes an
immutable definition revision or binding identity. Request-scoped membership and current authority
are always rebuilt. A cache key that cannot prove definition identity is forbidden.

## Required Invariants

1. Every provider request uses exactly one immutable ToolSurfaceSnapshot.
2. A Run Tool Ceiling never expands after Run creation; current revocation may shrink it.
3. `tool_search` reads only its originating View's frozen eligible catalog.
4. A search hit can enter only a later View.
5. An unactivated guessed call fails closed without target side effects or target
   `dispatch_committed`.
6. A transient physical retry reuses the exact snapshot, manifest, contract, messages, and
   requestSeq.
7. Context recovery, search activation, or an effective surface change creates a new View.
8. V5 ExecutionContract ceilings equal the current provider-visible Active Surface.
9. Ordinary V4 chat remains valid without an ExecutionContract.
10. Runtime, not Tape, is online authority; normal dispatch never reads Tape.
11. Every runtime, permission, approval, contract, target, and drift gate completes before target
    `dispatch_committed`.
12. Execution, approval, Journal, UI, and outcome always use the real target identity.
13. Diagnostic, runtime-only, and ineligible tools never enter model search.
14. Search or selection failure never falls back to the complete large catalog.
15. Existing ViewManifest and ExecutionContract schemas and hash recipes do not change in place.
16. The Active Surface never exceeds provider limits or the V5 limits applicable to a
    contract-bearing request.
17. Active tools are not evicted for ranking or budget; current revocation remains effective.
18. Surface fact conflicts fail closed for strict V5 and never masquerade as verified V4 evidence.
19. ACP remains outside P0.
20. Provider-visible ordering is deterministic and new activations append without reordering prior
    entries.

## Acceptance Criteria

### P0-A

1. Shadow mode changes no provider-visible message, tool set, tool order, ExecutionContract, or Tape
   fact.
2. Shadow diagnostics report ceiling/eligible counts, hypothetical active counts, schema-token
   estimates, trigger decisions, static surface overlap, and available baseline cache fields without
   retaining raw tool definitions or user text or fabricating unavailable values.
3. Definition and full catalog hashes are deterministic across catalog enumeration order.
4. Diagnostic failure is bounded and fail-open.

### P0-B

1. A large catalog produces a smaller initial provider-visible schema surface; a small catalog keeps
   the eligible tool set.
2. `tool_search` appears only in a virtualized Run and returns no complete input schema.
3. Search activation changes only the next View, where the target uses its real native name.
4. Hidden guessed calls and stale definitions fail closed without target side effects; over-budget
   candidates remain absent and are recorded with bounded surface rejection provenance.
5. Transient retries preserve snapshot identity; recovery and activation create a new snapshot.
6. Approval UI, Execution Journal, provider payload, and tool outcome identify the real target.
7. Strict V5 atomically persists valid manifest/catalog/surface facts before provider admission and
   restores deferred dispatch only from unique hash-valid active-target evidence.
8. V4 persistence failure remains fail-open with an honest bounded diagnostic.
9. Active ordering is stable within a Run, accepted candidates append deterministically, and
   revocation still removes authority.
10. ACP behavior is unchanged.
11. A process crash before activation admission loses pending candidates and never reconstructs them
    from mutable catalog state.
12. An inactive Skill with a ceilinged requirement may activate, while unresolved, ambiguous,
    newly installed, or definition-drifted requirements cannot partially mutate the Run.
13. Canary assignment and virtualization mode are frozen for the Run; rollback does not rewrite an
    active Run's surface.

### Default-Enable Go/No-Go

Default enablement requires all of the following across representative provider cohorts:

1. virtualization triggers often enough to justify its complexity;
2. effective provider input cost, including provider-specific cache-read/write pricing and extra
   search rounds, is lower than the contemporaneous control;
3. task and tool success rates are non-inferior to the control within the recorded confidence bound;
4. p95 latency and extra provider rounds remain within the recorded rollout budget;
5. unauthorized, same-View activated, or stale-definition target dispatch count is zero;
6. repeated-search and Skill-budget failures remain below the rollout threshold.
7. oversized canonicalization inputs remain below the accepted cohort threshold and have an explicit
   production policy.

Failure of any gate keeps virtualization in canary or rolls it back. A selector model may be
evaluated later only if deterministic initial selection plus native `tool_search` cannot meet these
gates.

## Open Questions

None block P0-A. Concrete threshold, budget, and hysteresis values are calibration outputs that must
be recorded with the P0-B policy version before canary activation.
