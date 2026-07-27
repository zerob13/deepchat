# Model Capability Identity Specification

## Background

DeepChat serves models through provider profiles such as Moonshot, New API, OpenCode Go, and
ZenMux. A provider profile identifies credentials and a service endpoint, while an effective
transport identifies the HTTP protocol used for one model. Neither identity necessarily names the
provider-db entry that owns the model's capabilities.

The current runtime conflates these identities. New API correctly matches `kimi-k3` to
`moonshot/kimi-k3` while resolving its route, but the AI SDK runtime later derives capability
ownership from the OpenAI-compatible endpoint and replaces `moonshot` with `openai`. The resulting
`openai/kimi-k3` lookup is unknown, unknown temperature support is flattened to `true`, and the
request sends the stored default temperature. Kimi K3 rejects that request.

The same duplicated resolution affects OpenCode Go's Anthropic routes. Renderer settings also
derive capability ownership locally, so fixing only the request path would leave controls and
effective wire behavior inconsistent. Reasoning portraits currently have an independent
cross-provider fallback; for `openai/kimi-k3` it deterministically selects the incomplete
`aihubmix/kimi-k3` portrait instead of Moonshot's complete record.

## Goals

1. Model service identity, transport identity, and provider-db capability identity as separate
   concepts.
2. Make one main-process resolver the authoritative producer of capability identity.
3. Resolve New API routes in two acyclic phases:
   - derive a coarse model-family hint from model ID and owner metadata, then choose the endpoint;
   - resolve the complete capability identity using model ID, owner metadata, and the selected
     endpoint.
4. Make runtime, settings, agent generation defaults, and renderer capability controls consume the
   same resolved identity and capability snapshot.
5. Preserve `true`, `false`, and `unknown` capability states until request policy chooses a wire
   behavior.
6. Generalize the existing Kimi fixed-temperature policy into a model request policy that can pass
   through, fix, or omit generation parameters.
7. Support Kimi K3 through Moonshot direct and aggregator routes without sending unsupported
   sampling or legacy thinking controls.
8. Restore Grok reasoning effort in the final OpenAI-compatible request body.
9. Remove repeated route and capability work without adding a new memoization or cache-invalidation
   subsystem.

## Required Invariants

### Identity boundaries

For every model execution:

- service identity owns credentials, base URL, rate limits, and provider-level configuration;
- transport identity owns the AI SDK provider kind and effective endpoint;
- capability identity owns the provider-db model record used for all model capabilities.

For New API Kimi K3 the identities are:

```text
service provider:    new-api
transport endpoint:  openai
capability provider: moonshot
capability model:    kimi-k3
```

An OpenAI-compatible endpoint is not evidence that the model belongs to OpenAI. Transport fallback
may be used only after explicit, provider-local, owner, family, and catalog matches fail.

`LLM_PROVIDER.capabilityProviderId` remains a provider-level explicit override for compatibility
with existing profiles and imports. A per-model New API resolution is request-local and is not
written into provider persistence or model configuration.

### Two-phase New API resolution

Phase 1 accepts only model ID and owner metadata and returns a coarse family hint used to choose an
Anthropic or Gemini endpoint when appropriate. The hint type is closed and narrow:

```text
anthropic | gemini | undefined
```

Phase 1 never consumes a Phase 2 result. `NewApiRouteMeta.capabilityProviderId` is replaced by
`capabilityFamilyHint` so the field cannot be mistaken for an authoritative override.

Phase 2 accepts the selected endpoint in addition to model ID and owner metadata. It resolves one
capability identity using this precedence:

1. explicit provider-level capability override;
2. explicit main-process route override;
3. provider-local exact or canonical provider-db match;
4. qualified model namespace;
5. recognized owner;
6. recognized model family;
7. transport-provider match;
8. unique global exact or canonical match;
9. transport fallback with an unknown catalog model.

An ambiguous global match is not selected by provider iteration order. All capabilities for a
resolved model use the same provider and catalog model identity.

### Capability snapshots

The main process returns one capability snapshot per provider/model selection. The snapshot contains
the resolved identity, reasoning portrait, sampling capability, search defaults, and effective
generation-parameter policy. Existing convenience getters may remain as compatibility wrappers,
but they delegate to the same resolution and are not composed independently in hot paths.

Renderer components do not import or execute capability-provider routing rules. ChatStatusBar and
ModelConfigDialog consume the snapshot returned by the typed models capability route. Agent
generation settings consume the same main-process resolution contract.

The optional resolution source is retained only because request tracing consumes it to explain
which catalog identity and policy produced the final body.

### Generation parameter policy

Model request policy uses a discriminated union:

```text
passthrough
fixed(value)
omit
```

Stored session and model generation settings remain user intent. Policy is applied only when
constructing effective UI controls and the final wire request; switching to another model restores
the stored values without migration or destructive normalization.

Kimi behavior is:

| Model family | Temperature | Top P | Reasoning | Legacy `thinking` |
| --- | --- | --- | --- | --- |
| K2 fixed-temperature models | Fixed by existing reasoning state | Passthrough | Existing behavior | Existing behavior |
| K3 | Omit | Omit | Required | Omit |

K3 matching uses exact canonical model identities rather than substring matching. It remains safe
when provider-db is unavailable or an aggregator exposes a recognized K3-qualified model ID.

Unknown model capabilities retain the current compatibility behavior: user-provided parameters
pass through unless an explicit model request policy says otherwise. Unknown does not become
`true` inside the capability layer.

Streaming, non-streaming, and request tracing use one effective generation-parameter serialization
per physical request.

### Reasoning effort

Kimi K3 reasoning effort has options `low`, `high`, and `max`, defaulting to `max`. Until
provider-db publishes those fields, DeepChat supplies that exact model fallback; later explicit
catalog fields override the fallback. `medium` is not offered for K3.

DeepChat supplies the standard AI SDK `reasoningEffort` provider option. The installed
`@ai-sdk/openai-compatible` adapter serializes that option as `reasoning_effort`. DeepChat does not
add a duplicate New API snake-case path.

Grok Mini models use the same standard option while retaining the existing model-family guard.
The former custom `reasoning_effort` provider option is removed because the adapter's later
standard-field assignment overwrites it.

### Performance and state

The implementation removes repeated work rather than introducing speculative caching:

- one route decision per request;
- one capability identity per request;
- one capability snapshot per settings query;
- one effective parameter serialization per request;
- no capability lookup through a cloned full provider-model array.

The existing provider-db indexes remain the catalog lookup mechanism. No revision snapshot, LRU,
new persistent cache, or benchmark gate is introduced. No request-path disk or network access is
added.

## Acceptance Criteria

1. New API `kimi-k3` resolves capability identity to `moonshot/kimi-k3`, not
   `openai/kimi-k3`.
2. New API K3 reasoning uses Moonshot's complete portrait, preserving `interleaved`, `summaries`,
   `visibility: summary`, and `continuation: [thinking_blocks]`; it does not use the incomplete
   Aihubmix portrait.
3. Moonshot direct K3, New API `kimi-k3`, and qualified K3 aliases omit temperature and top P from
   streaming, non-streaming, and traced request bodies.
4. K3 does not emit the legacy Kimi `thinking` object and reasoning cannot be disabled in the
   effective UI policy.
5. K2 fixed-temperature and thinking behavior remains unchanged.
6. OpenCode Go Anthropic routes retain Anthropic capability identity through final request
   construction.
7. ZenMux Anthropic behavior remains correct without a duplicate shared routing rule.
8. Unknown custom OpenAI-compatible models retain pass-through generation behavior.
9. K3 effort controls expose exactly `low`, `high`, and `max`, defaulting to `max`; later explicit
   provider-db metadata overrides the local fallback.
10. New API K3 `reasoningEffort: max` produces final wire field `reasoning_effort: "max"`.
11. Grok Mini `reasoningEffort: high` produces final wire field `reasoning_effort: "high"`;
    unsupported Grok models do not gain reasoning-effort behavior.
12. ChatStatusBar and ModelConfigDialog show generation controls from the main-process policy and
    contain no local capability-provider resolver.
13. A request calculates its route, capability identity, and effective generation parameters once
    each.
14. Capability resolution performs no full provider-model clone and requires no new persistent
    data or migration.
15. Existing provider, model import/export, renderer, agent, and direct-provider behavior remains
    compatible unless explicitly changed above.

## Constraints

- The implementation targets the provider packages pinned by the current lockfile.
- The provider-db cache may refresh while the application is running; existing catalog-change
  rebuilding remains authoritative.
- Provider IDs, API keys, base URLs, and model settings remain backward compatible.
- New user-facing policy descriptions use typed renderer contracts and i18n keys.
- Every local commit requires a severity-ordered review covering hidden side effects,
  compatibility, boundary cases, performance, security, naming, tests, and maintenance cost.
- No branch push, pull request, or GitHub issue is created as part of this work.
- SDD artifacts in this directory use English prose.

## Non-Goals

- Adding New API itself to provider-db.
- Selecting an arbitrary provider from ambiguous global same-model matches.
- Replacing the existing provider-db loader or index with a new caching architecture.
- Changing Moonshot's connection-check model.
- Removing support for provider-level capability overrides.
- Fixing OpenAI-compatible deprecation warnings caused by hyphenated provider option names.
- Broadly redesigning all provider-specific request options.

## Open Questions

None. The identity precedence, two-phase dependency, policy semantics, compatibility behavior, and
validation requirements are fixed by this specification.
