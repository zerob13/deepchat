# Plugin External Runtime Lifecycle Plan

## 1. Freeze the contracts

- Extend plugin manifest types and validation for `startMode`, `surfaces`, `toolCatalog`,
  `inheritEnv`, and the closed runtime-adapter identifier.
- Require explicit tool-only declarations and a resolvable catalog for on-demand servers.
- Update the maintained CUA feature specification so 0.7.1/UIA-worker assumptions cannot remain a
  competing contract.

## 2. Establish trusted ownership

- Register plugin-owned server descriptors in memory from validated plugin manifests.
- Treat this registry as the authority for lifecycle ownership; SQLite `source` fields remain
  descriptive compatibility data.
- Reject collisions between plugin-owned and user-managed server names.
- Remove plugin registration's unconditional overwrite of persisted user state.

## 3. Introduce the supervisor and low-level process capability

- Add a plugin runtime supervisor that owns per-server transitions, start coalescing, stop
  idempotency, errors, and lifecycle notifications.
- Give it a private low-level MCP process port that cannot be invoked by renderer routes or ordinary
  callers.
- Gate public MCP start/stop at the service boundary and route plugin-owned requests through the
  supervisor.
- Cover initialization, manual toggles, configuration restarts, authentication recovery, renderer
  routes, disable, and shutdown.

## 4. Split application initialization

- Plugin discovery/activation registers capabilities without starting processes.
- MCP initialization starts only non-plugin-owned servers.
- A final supervisor reconcile starts enabled eager plugin servers.
- Preserve Feishu's eager behavior while changing CUA to on-demand.

## 5. Add static tool discovery

- Generate and package the pinned CUA catalog via upstream `dump-docs --type mcp --pretty`.
- Merge catalog definitions into `ToolManager` before a live client exists.
- Keep conflict renaming, access filtering, and exact plugin policies identical for catalog and
  live tools.
- On invocation, ensure the runtime, resolve the live client, verify the requested live tool, and
  dispatch.
- Fail packaging when catalog, runtime dump, and policies diverge.

## 6. Implement safety state and migration

- Persist versioned runtime sentinels/quarantines separately from installation intent.
- Write the sentinel before spawn; clear it only on verified clean stop.
- Bind recovery policy to the verified runtime fingerprint.
- Add an idempotent CUA migration that first prevents legacy MCP autostart, then registers the new
  contract.
- Add explicit `runtime.test` and `runtime.retry` plugin actions; do not overload plugin enable.

## 7. Upgrade and adapt CUA

- Pin `cua-driver-rs-v0.12.6` and exact release assets/checksums.
- Remove obsolete 0.7.1 `--no-daemon-relaunch` and MCP-mode environment assumptions.
- Implement the embedded daemon/proxy adapter, private endpoint generation, metadata handshake,
  parent-liveness stdin, timeout/cleanup, and protocol validation.
- Keep the daemon warm after first tool use until shutdown or disable.

## 8. Harden launch

- Add `inheritEnv: "minimal"` and platform baselines for the CUA daemon and proxy.
- Generate a release integrity descriptor during official plugin packaging.
- Verify the CUA runtime file set and identity immediately before spawn.
- On macOS, update the exact entitlement contract and preserve helper-before-parent signing and
  notarization.
- On Windows, switch to the binary-only archive, omit the unsigned UIA worker, and explicitly set
  its opt-in variable to false.

## 9. Adapt UI and diagnostics

- Show installation intent separately from running, quarantined, and integrity-error states.
- Replace any generic on-demand start control with “Test runtime”; expose “Retry runtime” only for
  recoverable quarantine.
- Surface actionable integrity/AV errors without recommending security exclusions.
- Keep plugin-owned servers hidden from generic MCP settings.

## 10. Validate and release

- Run targeted lifecycle, MCP, plugin, tool-manager, migration, packaging, signing, and workflow
  tests first.
- Run formatting, i18n, lint, node/web type checks, and the appropriate broader suites.
- Build and verify target-specific official plugin artifacts.
- Complete native macOS arm64/x64, Windows x64/arm64, and Linux x64/X11 release gates.
- Do not enable Linux arm64 CUA solely because upstream now publishes an artifact.

## Compatibility and rollback

- Omitted manifest fields default to eager, all existing MCP surfaces, and legacy environment
  inheritance.
- Feishu remains eager and lifecycle-managed, with its current `npx` closure explicitly outside CUA
  integrity attestation.
- Existing user-managed MCP servers retain their public start/stop and global MCP behavior.
- The database migration is forward-idempotent and never converts one server's boolean into plugin
  installation intent.
- Code rollback may restore the old host, but a release rollback must not redistribute CUA 0.7.1 on
  Linux. The optional CUA artifact can be withheld independently from the DeepChat application.
