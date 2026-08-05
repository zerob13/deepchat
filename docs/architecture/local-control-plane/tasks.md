# Local Control Plane and Bundled CLI V1 Tasks

## Architecture and Scope

- [x] Verify the current route registry, provider runtime, detached session, event publication,
  permission broker, command signature, OCR runtime, and OCR cache behavior.
- [x] Freeze the V1 goals, exclusions, 14 capability groups, effect taxonomy, caller model, file-I/O
  split, benchmark semantics, and implementation order.
- [x] Specify `CLI_SURFACE_V1`, the ten-file `RouteCaller` migration, and `ApprovalBroker` adapters.
- [x] Specify transport, discovery, artifact, event, CLI grammar, packaging, and Agent-token contracts.
- [x] Complete the severity-ranked architecture-document review and resolve its findings.
- [x] Commit the accepted SDD locally.

## Typed Foundation

- [x] Add `RouteCaller` and migrate renderer-dependent integrations without behavior change.
- [ ] Add canonical local-control contracts and redacted public DTOs.
- [x] Define and test the deny-by-default versioned surface registry.
- [x] Add local-control error codes, request/result envelopes, and route limits.

## Local Transport and CLI

- [x] Implement atomic private descriptor creation, token rotation, and stale cleanup.
- [x] Implement UDS/named-pipe HTTP server lifecycle and authentication.
- [x] Implement fixed/chunked body bounds, spill-to-disk, abort handling, and cleanup.
- [x] Implement the bundled thin CLI, two-token grammar, version negotiation, output modes, signals,
  fail-closed Agent-token selection, timeouts, and exit codes.
- [x] Add descriptor, transport, auth, body-boundary, parser, and shutdown tests.

## Compute and Artifacts

- [x] Add raw `models.invoke` over `coreStream` with no Agent/session/tool side effects.
- [x] Add image and video standalone generation surfaces.
- [x] Add formal standalone speech generation and typed audio output.
- [x] Add upload and owned-artifact transcription inputs.
- [x] Implement output-only `ArtifactSpool` ownership, quotas, expiry, and cleanup.
- [ ] Add stream, media, speech, transcription, artifact, and quota tests.

## OCR

- [x] Add explicit upload and owned-artifact extraction contracts and handlers.
- [x] Preserve automatic-attachment-setting independence and background priority.
- [x] Enforce bounded text output and exclude layout/batch/model administration.
- [x] Classify cache clear as audited human-only `local-maintenance` without approval.
- [x] Report cache hit, warm-runtime miss, cold-runtime, and offline metrics accurately.
- [ ] Add OCR caller, input, cache, runtime-state, output-bound, and benchmark tests.

## Effects and Approval

- [x] Extract generic canonicalization/pending/timeout/consume mechanics into `ApprovalBroker`.
- [x] Preserve MCP, Agent pre-check, and live-delegation behavior through `ToolPermissionBroker`.
- [x] Add `CliMutationGuard` with unique live-request-bound approvals and no replay token.
- [x] Add targeted approval events and renderer-only `approvals.resolve` IPC.
- [x] Implement effect/caller/operation policy, scopes, quotas, rate limits, and redacted audit.
- [x] Add concurrent-identical-call, timeout, abort, cancellation, redaction, and compatibility tests.

## Administration Surface

- [x] Add public/redacted settings reads and allowlisted per-effect updates.
- [ ] Add public/redacted provider/model reads and separated credential mutations.
- [ ] Add reviewed Skill list/enable/install/uninstall operations.
- [ ] Add reviewed MCP list/add/update/remove/enable/start/stop operations.
- [ ] Prove raw MCP calls, arbitrary internal routes, secret reads, and Agent destructive operations are
  unreachable.

## Events and Agent Runs

- [ ] Add explicit renderer/connection/request/run Event Hub targets.
- [ ] Add bounded queues, ordering, overflow, disconnect, and recovery semantics.
- [ ] Compose detached session creation with initial-turn execution.
- [ ] Add owned status, event streaming, result recovery, and idempotent cancellation.
- [ ] Add event-isolation, backpressure, detached-recovery, recursion-denial, and cancellation tests.

## Packaging and Agent Use

- [x] Package the CLI with the bundled Node runtime on all supported targets.
- [ ] Add opt-in, reversible platform launcher/PATH integration.
- [ ] Add in-memory scoped Agent token issuance, expiry, revocation, and quotas.
- [ ] Harden shell permission checks for redirection and compound syntax before Agent enablement.
- [ ] Keep `deepchat` out of `SAFE_COMMANDS`, enforce domain/verb-first grammar, and deny Agent
  artifact-byte/output-path access.
- [ ] Add the bundled CLI Skill without exposing the human descriptor.
- [ ] Add packaged diagnostics/compute/artifact/OCR/Agent-policy smoke coverage.

## Validation and Delivery

- [ ] Run focused tests after each implementation slice.
- [ ] Run format and i18n validation.
- [ ] Run lint and typecheck.
- [ ] Run the full test suite and production build.
- [ ] Run current-platform unsigned packaging and packaged smoke where prerequisites allow.
- [ ] Complete a severity-ranked review before every commit and resolve findings.
- [ ] Commit all V1 work locally with behavior-specific messages.
- [ ] Do not push.

## Local Validation Evidence

Not yet recorded.
