# Durable Execution Journal Implementation Plan

## Architecture

The implementation adds a pure Execution Journal domain model, a strict Tape application service,
and narrow runtime capabilities. Context Tape and Execution Journal share the physical
`deepchat_tape_entries` table but have different persistence contracts.

```text
DeepChat loop / deferred executor
  -> ExecutionJournalWriter (strict, synchronous)
  -> TapeEntryStore transaction
  -> immutable execution/* event

Tool execution
  -> per-call commitDispatch callback
  -> final resolved Agent/MCP boundary
  -> target invocation

Startup
  -> ExecutionJournalRecoveryReader
  -> pure classifier
  -> diagnostic report and parked recovery
  -> existing interrupted-message projection
```

The application service owns identity-to-provenance derivation, canonical payload construction,
strict idempotency comparison, parsing, and classification. The generic `TapeEntryStore.append`
contract is not changed because existing Context Tape producers intentionally have different
idempotency and failure behavior.

## Domain Model

Create `src/main/tape/domain/executionJournal.ts` with:

- protocol and event-name constants;
- Run and operation identity types and validators;
- typed inputs and durable payload types for the four fact families;
- canonical operation identity hashing;
- row parsers that reject malformed or unsupported native facts;
- a pure recovery classifier and report types;
- typed persistence and corruption errors.

Operation provenance keys use a stable prefix plus a SHA-256 hash of the canonical identity tuple.
Run facts use the UUID run identity directly in their source and a hashed provenance key. Event
payloads repeat structured identity fields so rows remain self-describing and independently
auditable.

## Strict Writer

Create an Execution Journal application service over the existing Tape providers. Each commit:

1. validates and canonicalizes the typed input;
2. builds the exact expected event row fields and payload;
3. enters the existing synchronous SQLite transaction;
4. reads by provenance key;
5. returns `{ created: false }` only when every identity-bearing and payload field is canonically
   identical;
6. throws a typed corruption error when the key exists with different fields;
7. otherwise appends a non-idempotent event and returns `{ created: true }`.

An append/storage failure is wrapped with fact identity context and propagated. The service does not
log-and-continue.

Extend the Tape capability ports with:

- `ExecutionJournalWriter` for Run and operation commits;
- `ExecutionJournalRecoveryReader` for startup classification;
- `DeepChatLoopTapePort` composition of the writer capability.

`SessionTape` delegates these methods to the new application service. No tool handler receives the
facade or raw store.

## Storage Query

Add a `TapeEntryStore` query for journal event names and a partial index on event `name` plus
`entry_id`. The query returns only the four v1 journal names and orders rows deterministically.
Recovery parsing treats malformed rows as corruption instead of skipping them.

No operations table is introduced. If future scale measurements show that startup classification
needs mutable lookup state, that state must be a rebuildable projection of Tape facts.

## Run Identity And Lifecycle

Replace the loop runner's process-local sequence ID with `crypto.randomUUID()`.

Normal loop ordering becomes:

```text
local Run construction and preflight
  -> commit run_started
  -> register Run
  -> execute provider/tool loop
  -> commit run_terminal
  -> transcript/status/hooks/UI terminal projection
```

`processStream` receives the narrow writer through its I/O collaborators. Terminal settlement
commits exactly one of `completed`, `paused`, `aborted`, or `error` before calling the current
finalizers. If a post-terminal projection throws, the committed terminal fact is retained and no
conflicting terminal fact or ordinary error projection is attempted; the Run remains parked for
reconciliation.

## Tool Dispatch And Outcome Flow

Extend the internal `ToolCallOptions` with a per-call `commitDispatch` callback carrying:

- source (`agent` or `mcp`);
- normalized arguments;
- resolved tool name;
- resolved target metadata.

The loop creates the callback from the current operation identity. It marks the operation as
dispatched only after a newly created T1 receipt. An identical existing claim throws before target
invocation so an in-process retry cannot repeat the effect.

MCP invokes the callback after argument preparation and the final policy, server, binding, client,
target, and abort checks, immediately before `targetClient.callTool`.

Agent handlers invoke the callback after their local schema, permission, path, target, session, and
availability checks, immediately before a persistent mutation, process spawn, provider call,
browser call, scheduler mutation, or delegation mutation. Pure reads and local interaction tools do
not claim a dispatch.

After execution, the loop normalizes and prepares the result. If T1 was committed, it commits T2
before applying the staged result to conversation messages, assistant blocks, transcript, or UI.
Thrown target errors are known error outcomes and receive T2. Abort or process loss before a known
result intentionally leaves T1 without T2.

Journal errors bypass normal tool-error conversion and fail the Run closed.

## Deferred Execution

Approved deferred execution performs local tool/session resolution first, then creates a fresh UUID
Run with request sequence `1`. It commits `run_started`, passes the same real-boundary T1 callback,
commits a prepared T2 when dispatched, and commits a terminal fact before returning the result to
the interaction coordinator for transcript projection.

Permission responses that occur before dispatch terminate the physical deferred Run as `paused`
without fabricating T1 or T2. A later approval starts another physical Run.

## Startup Recovery

Harness construction reads and classifies journal facts before pending transcript messages are
recovered. Classification is deterministic and never calls a tool:

- `not_dispatched`: native Run start with no dispatch;
- `completed`: every native dispatch has exactly one matching native outcome;
- `indeterminate`: at least one dispatch has no outcome;
- `corruption`: malformed, unsupported, conflicting, or orphaned facts.

Only native v1 journal event names are inputs. Transcript rows, legacy backfill facts, tool block
facts, provider attempt events, and model text cannot raise the evidence level.

The first version logs structured recovery reports and retains the existing interrupted-message
projection. `indeterminate` and `corruption` remain parked; no replay or retry path is added.

## Test Strategy

### Pure Unit Tests

- operation identity validation and collision-safe key derivation;
- parser rejection for malformed and unsupported facts;
- all four recovery classifications;
- outcomes without dispatch, facts without Run start, duplicate terminals, and session mismatch;
- response/argument payload hashing and bounded data rules.

### Native SQLite Tests

- identical strict commit is idempotent;
- conflicting strict commit throws and preserves the original row;
- dispatch commit failure propagates and prevents the supplied target callback from running;
- journal name query uses the intended index and ignores Context Tape events;
- restart-style reconstruction from persisted rows.

### Runtime Tests

- UUID Run creation and run-start-before-registration ordering;
- MCP validation/policy/target failures produce no T1;
- MCP T1 precedes the target call and duplicate T1 prevents a second call;
- representative Agent mutation boundaries produce the same ordering;
- T2 precedes staged result projection for success and known failure;
- T2 failure prevents projection;
- terminal commit precedes every terminal projection and failure prevents projection;
- deferred approval uses a new Run and obeys the same ordering;
- startup classification runs before interrupted transcript recovery and never executes tools.

### Crash Tests

Add deterministic failpoints immediately inside/outside T1, T2, and terminal boundaries. A native
child-process test sends `SIGKILL`, reopens the same SQLite database, runs classification, and proves
the expected evidence state. Platform-gate the real signal test where necessary while keeping pure
and native SQLite coverage portable.

## Validation

Run the smallest relevant suites during implementation, then before handoff run:

```text
pnpm run format
pnpm run i18n
pnpm run lint
pnpm run typecheck
pnpm exec vitest run <relevant Tape, loop, tool, deferred, and harness suites>
```

Run native SQLite tests through the repository's documented native test command or environment
gate. Report any platform-gated crash test separately.

## Commit Strategy

1. Architecture SDD.
2. Execution Journal domain, strict Tape service, storage query, and focused tests.
3. UUID Run identity plus normal loop T1/T2/terminal integration and tests.
4. Agent/MCP resolved-boundary coverage and tests.
5. Deferred execution, startup classification, crash tests, and architecture documentation updates.

Before each commit, review unstaged and staged diffs for hidden side effects, compatibility,
boundary conditions, performance, security, naming, test gaps, and maintenance cost. Fix findings,
rerun relevant validation, then commit with a concrete Conventional Commit message. Do not push.
