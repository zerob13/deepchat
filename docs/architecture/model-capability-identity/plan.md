# Model Capability Identity Implementation Plan

## Architecture and contracts

Add a main-process capability identity module that owns both phases of New API capability
resolution. Phase 1 accepts only model ID and owner metadata and returns only an Anthropic or Gemini
family hint. It may query provider-db family evidence by those inputs, but cannot consume an
endpoint or any Phase 2 result. Shared endpoint routing consumes the renamed
`capabilityFamilyHint`. Phase 2 accepts the selected endpoint and returns a resolved
provider/catalog model identity plus an optional diagnostic source.

Split the current shared helper by responsibility. Keep endpoint selection utilities in
`@shared/model`; move the transport capability fallback and ZenMux explicit override into the
main-process capability identity module. Remove `BaseProvider.getCapabilityProviderId`, which has no
callers and represents a third resolution rule.

Audit every current `resolveProviderCapabilityProviderId` caller. Main-process model configuration,
provider model mapping, New API discovery, route decisions, settings getters, and agent generation
defaults must either consume the authoritative identity or use an explicitly named transport-only
fallback. Renderer imports are removed.

## Capability snapshot

Introduce a typed resolved capability snapshot in the provider settings port. ProviderSettings
collects effective route metadata without cloning the complete provider model list, resolves
identity once, and reads all capabilities from that identity. Existing field-level methods delegate
to the snapshot during migration.

Extend the existing models capability route and schema with:

- resolved capability provider and catalog model identity;
- optional resolution source for request diagnostics;
- temperature's tri-state value;
- generic generation-parameter policies for temperature and top P;
- required or optional reasoning state and legacy thinking behavior.

ChatStatusBar and ModelConfigDialog consume these fields and remove their local capability routing.
The renderer keeps user values in state but hides or locks controls according to effective policy.
Agent generation settings obtain identity and reasoning defaults from the main-process snapshot
instead of independently deriving endpoint capability semantics.

## Runtime integration

Resolve a route decision exactly once in `buildRuntimeContext`. Pass that decision to model-config
patching instead of recalculating it. RouteDecision carries the resolved capability identity, and
AiSdkRuntimeContext receives the same immutable request-local value.

Remove runtime calls that ask ProviderSettings to derive capability ownership again. Prompt/provider
options, reasoning, temperature, top P, and request tracing consume the context identity.

Preserve tri-state temperature capability through policy resolution. Unknown remains pass-through
for compatibility. Delete the dead branch that attempts to recover tri-state after
`supportsTemperatureControl` has already returned a boolean.

## Model request policy

Generalize the existing Moonshot Kimi policy types to support pass-through, fixed, and omitted
parameters. Preserve the existing K2 temperature/reasoning contract. Add exact canonical K3 policy:

- omit temperature;
- omit top P;
- require reasoning;
- omit legacy `thinking`.

Build one effective generation-parameter object for each request and reuse it for request tracing
and the AI SDK call in both generate and stream paths. Do not clear or rewrite persisted model or
session settings.

Expose the generic policy through the capability snapshot. Replace Kimi-specific renderer control
logic only where the generic policy provides the same or stronger behavior; retain K2-specific
copy only if it remains necessary to explain its two fixed values.

## Reasoning effort and provider metadata

Consume K3 reasoning metadata with effort mode, options `low`, `high`, and `max`, and default `max`.
If the generated provider-db resource does not yet contain the upstream change, add focused
DeepChat tests using a catalog fixture while keeping the runtime compatible with a later background
catalog refresh.

Replace Grok's custom snake-case provider option with the standard `reasoningEffort` option, guarded
by the existing Grok Mini family check. The installed OpenAI-compatible adapter maps the standard
option to the final snake-case body field. Add real-adapter fetch-capture tests for both New API K3
and Grok so mapper-only tests cannot pass while the wire field is lost.

## Performance and compatibility

Add a narrow provider-model route metadata getter backed by the existing model storage/cache rather
than calling `getProviderModels().find()` from capability resolution. It returns only endpoint,
supported endpoints, model type, and owner metadata.

Do not add a new catalog snapshot, resolution memo, LRU, or persistent cache. Existing provider-db
indexes and catalog-change rebuilds remain in place. Focused tests assert single route/capability
resolution and final wire output rather than unstable wall-clock thresholds.

No database migration is required. Existing provider-level `capabilityProviderId` values remain
valid explicit overrides. Existing capability route response fields remain during migration so
older renderer call sites and tests can be updated incrementally.

## Review and commit slices

1. Write and review the architecture SDD and maintained provider runtime contract.
2. Implement and review two-phase capability identity plus capability snapshot.
3. Implement and review generic generation policy and K3 wire behavior.
4. Implement and review K3 effort consumption, Grok wire behavior, renderer convergence, and
   route-resolution de-duplication.
5. Run final validation and a complete severity-ordered branch review before the final commit.

Each review checks hidden side effects, backward compatibility, boundary cases, performance,
security, misleading names, missing tests, and maintenance cost. Findings are fixed before the
corresponding commit and commit messages describe the concrete change rather than the review.

## Validation

Run focused tests after each slice:

- `test/main/provider/modelCapabilities.test.ts`
- `test/main/provider/providerModelCapabilityMapping.test.ts`
- `test/main/provider/newApiProvider.test.ts`
- `test/main/provider/aiSdkRuntime.test.ts`
- `test/main/provider/aiSdkProviderOptionsMapper.test.ts`
- real OpenAI-compatible provider factory request-capture tests
- `test/main/shared/moonshotKimiPolicy.test.ts`
- ChatStatusBar and ModelConfigDialog renderer tests
- agent generation settings tests

Before handoff run `pnpm run format`, `pnpm run i18n`, `pnpm run lint`, full type checking, the
relevant provider and renderer suites, the full test suite, and the production build when the
environment permits. Review and retain expected generated provider/ACP registry refreshes according
to repository policy.
