# Model Capability Identity Tasks

## Specification

- [x] Trace New API K3 capability matching through route and runtime request construction.
- [x] Verify the installed OpenAI-compatible adapter's provider-option serialization.
- [x] Record the two-phase endpoint/capability dependency and identity precedence.
- [x] Record K3, K2, Grok, unknown-model, renderer, and performance invariants.
- [x] Write the architecture `spec.md`, `plan.md`, and `tasks.md`.
- [x] Update the maintained provider runtime contract.
- [x] Review and commit the SDD slice.

## Capability identity

- [x] Add the main-process two-phase capability identity resolver.
- [x] Rename `capabilityProviderId` route hints to `capabilityFamilyHint`.
- [x] Move transport fallback and ZenMux override out of the shared renderer module.
- [x] Remove the unused BaseProvider capability resolver.
- [x] Resolve RouteDecision capability identity once and pass it through runtime context.
- [x] Add one ProviderSettings capability snapshot and compatibility wrappers.
- [x] Preserve temperature `true`, `false`, and `unknown` states.
- [x] Make a resolved identity select all capability fields from one catalog model.
- [x] Add New API K3, OpenCode Go, ZenMux, ambiguity, and unknown-model tests.
- [x] Review and commit the capability identity slice.

## Model request policy

- [x] Generalize the Kimi policy to pass through, fix, or omit generation parameters.
- [x] Preserve K2 fixed-temperature and thinking behavior.
- [x] Add K3 temperature/top-P omission, required reasoning, and legacy-thinking omission.
- [x] Serialize effective generation parameters once for trace, generate, and stream.
- [x] Preserve stored user settings without migration.
- [x] Add direct, aggregator, qualified-ID, missing-catalog, and K2 regression tests.
- [x] Review and commit the model request policy slice.

## Reasoning and consumers

- [x] Consume K3 effort options `low`, `high`, and `max` with default `max`.
- [ ] Restore Grok Mini final-body `reasoning_effort` through the standard AI SDK option.
- [ ] Add real-adapter request-capture tests for New API K3 and Grok.
- [x] Extend the typed capability route with identity and generation policy.
- [x] Remove local capability-provider resolution from ChatStatusBar.
- [x] Remove local capability-provider resolution from ModelConfigDialog.
- [ ] Update agent generation settings to consume the authoritative snapshot.
- [x] Add the narrow provider-model route metadata getter.
- [ ] Ensure each request resolves route, identity, and generation parameters once.
- [x] Add renderer control and complete Moonshot portrait regression tests.
- [ ] Review and commit the consumer and de-duplication slice.

## Final validation

- [ ] Run focused main, shared, agent, and renderer tests.
- [ ] Run `pnpm run format`, `pnpm run i18n`, and `pnpm run lint`.
- [ ] Run full type checking, the full test suite, and the production build.
- [ ] Review generated provider and ACP registry changes if the build refreshes them.
- [ ] Review the complete branch diff by severity and fix every finding.
- [ ] Confirm the worktree is clean, commits are local, and no push occurred.

## Validation Result

Pending implementation.
