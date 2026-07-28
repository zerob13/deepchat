# Plugin External Runtime Lifecycle Tasks

## Contract and ownership

- [ ] Add and validate manifest lifecycle, surface, catalog, environment, and adapter fields.
- [ ] Add an in-memory trusted registry for plugin-owned servers.
- [ ] Remove persisted MCP `enabled` as a second source of plugin user intent.
- [ ] Reject server-name ownership collisions and untrusted lifecycle bypasses.

## Supervisor and startup

- [ ] Implement coalesced start, idempotent stop, symmetric ownership, and transient status.
- [ ] Gate all public MCP lifecycle methods at the service boundary.
- [ ] Route initialization, manual toggle, config restart, auth restart, renderer, disable, and
      shutdown paths through the supervisor.
- [ ] Split startup into plugin registration, non-plugin MCP initialization, and supervisor
      reconcile.
- [ ] Keep Feishu eager and set CUA to on-demand.

## Discovery and dispatch

- [ ] Generate and package the CUA static MCP tool catalog.
- [ ] Merge catalog definitions with live client definitions without duplicate or unstable names.
- [ ] Ensure runtime on first tool call, then verify the live tool before dispatch.
- [ ] Reject on-demand prompt/resource manifests and every silent catalog fallback.

## Migration and safety state

- [ ] Add the versioned, safe-side-first legacy CUA migration and idempotency tests.
- [ ] Persist pre-spawn sentinels and clear them only after clean stop.
- [ ] Derive quarantine from stale evidence and a verified runtime fingerprint.
- [ ] Add controlled retry for a changed fingerprint and explicit user retry for the same one.
- [ ] Treat integrity mismatch as non-bypassable and keep installation intent unchanged.

## CUA 0.12.6

- [ ] Pin tag, commit, assets, checksums, and exact protocol versions.
- [ ] Implement private endpoint generation and daemon metadata handshake.
- [ ] Keep daemon stdin open for parent-liveness and guarantee timeout/failure cleanup.
- [ ] Remove obsolete 0.7.1 launch flags and environment variables.
- [ ] Keep the daemon warm after first use and stop it on disable/shutdown.

## Environment and integrity

- [ ] Add legacy-compatible `inheritEnv` and the explicit cross-platform minimal baseline.
- [ ] Generate a packaged CUA integrity descriptor and verify it before every spawn.
- [ ] Reject path escape, symlink/non-regular runtime files, missing files, and unexpected
      executables.
- [ ] Update the macOS signature/identity/hardened-runtime/exact-entitlement contract.
- [ ] Package only the Windows primary executable and disable UIA-worker opt-in.
- [ ] Document Feishu's `npx` artifact-closure exception and create a follow-up task after P1.

## UX and diagnostics

- [ ] Expose installation intent, runtime state, quarantine, and integrity errors separately.
- [ ] Add “Test runtime” and recoverable “Retry runtime” actions for on-demand CUA.
- [ ] Keep generic MCP controls from directly starting/stopping plugin-owned servers.
- [ ] Provide actionable Windows Security guidance without suggesting exclusions.

## Automated validation

- [ ] Cover all lifecycle entry points and unauthorized low-level access.
- [ ] Cover concurrent first call, disable-during-start, shutdown, and failed-start cleanup.
- [ ] Cover catalog/policy parity, live-tool revalidation, prompts/resources scope, and name
      conflicts.
- [ ] Cover migration re-entry, stale sentinel, changed fingerprint, retry, and integrity failure.
- [ ] Cover environment allowlists and preservation of legacy MCP inheritance.
- [ ] Cover per-target package layout, exact runtime files, checksums, and unsupported targets.
- [ ] Run `pnpm run format`, `pnpm run i18n`, `pnpm run lint`, and `pnpm run typecheck`.
- [ ] Run focused plugin, MCP, ToolManager, package, signing, and workflow tests.

## Native release gates

- [ ] macOS arm64: signed/notarized app, TCC, screen capture, input, restart, crash/recovery.
- [ ] macOS x64: signed/notarized app, TCC, screen capture, input, restart, crash/recovery.
- [ ] Windows x64: clean consumer install with Defender enabled and protection status/history
      recorded.
- [ ] Windows arm64: clean consumer install with Defender enabled and protection status/history
      recorded.
- [ ] Linux x64 X11: reproduce the #2039 activation path with no desktop/session loss.
- [ ] Linux x64 Wayland: validate discovery, input, capture, restart, and known limitations.
- [ ] Confirm DeepChat Linux application releases remain independent from optional CUA artifacts.
