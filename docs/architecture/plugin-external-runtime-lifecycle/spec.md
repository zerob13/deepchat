# Plugin External Runtime Lifecycle

## Status

Implementation in progress.

## Context

[GitHub issue #2039](https://github.com/ThinkInAIXYZ/deepchat/issues/2039) reports that enabling the
official CUA plugin on Arch Linux/X11 can black out the desktop until the X server or machine is
restarted. DeepChat 1.0.9 bundles CUA driver 0.7.1 and eagerly starts it while activating the
plugin.

The incident exposes a host-level ownership problem, not only an obsolete driver argument:

- plugin installation state and the persisted MCP `enabled` field both attempt to represent user
  intent;
- plugin activation writes `enabled: true` back to SQLite, so a direct database workaround is
  overwritten on a later activation;
- plugin-owned processes can be started, stopped, or restarted through at least six independent
  paths;
- the MCP service, rather than the plugin host, performs the effective startup during application
  initialization;
- a normal executable inherits the complete DeepChat environment;
- package checksums are verified when a plugin is installed, but not before a user-writable runtime
  is spawned.

The implementation must therefore upgrade CUA and establish one durable lifecycle boundary for all
plugin-owned external processes.

## Goals

1. Make a plugin runtime supervisor the sole owner of plugin-owned process lifecycle.
2. Separate capability, persistent user intent, persistent safety evidence, and transient process
   state.
3. Start CUA only when one of its tools is invoked, while keeping its tool catalog visible before
   process startup.
4. Upgrade the bundled driver to pinned upstream release `cua-driver-rs-v0.12.6` and adapt to its
   embedded daemon/proxy contract.
5. Fail closed on stale crash evidence, runtime integrity failures, incomplete packaged catalogs,
   and unsupported launch contracts.
6. Restrict the environment inherited by bundled native runtimes without changing legacy MCP
   server behavior.
7. Preserve current macOS helper signing/notarization, current unsigned Windows distribution, and
   the independent DeepChat application build matrix.

## Non-goals

- This change does not make on-demand startup a general MCP feature for prompts or resources.
- This change does not vendor the Feishu `npx` dependency closure.
- This change does not claim protection against an actively malicious process running as the same
  OS user or close the hash-to-spawn TOCTOU window with native APIs.
- This change does not add Windows Authenticode signing; DeepChat currently has no Windows signing
  certificate.
- This change does not add CUA to Linux arm64 until that target passes DeepChat native validation.
- This change does not add a temporary 0.7.1 command-line workaround.

## Invariants

### Four state layers

| Layer | Owns | Persistence | Mutation authority |
| --- | --- | --- | --- |
| Manifest | Capability: ownership, surfaces, start mode, catalog, runtime adapter | Packaged | Plugin release |
| Installation | Whether the user enabled the plugin | Persistent | Explicit user action |
| Sentinel / quarantine | Dirty-start evidence and a safety lock bound to a runtime fingerprint | Persistent | Supervisor safety policy |
| Supervisor | Starting, running, stopping, and error state | In-memory | Runtime supervisor |

The manifest defines capability, the installation record preserves user intent, and the supervisor
tracks process state. A persisted MCP `enabled` field is not an independent source of truth for a
plugin-owned server.

### One lifecycle gate

Every actual start, stop, restart, authentication recovery, configuration restart, renderer
request, and shutdown action for a plugin-owned server must pass the runtime supervisor. The
low-level MCP start/stop implementation remains private to an unforgeable host capability; it must
not be unlocked with a mutable global flag.

Ownership is established by trusted plugin registration. It is not inferred solely from
`manifest.runtime`, because Feishu also owns an external stdio process, and it is not trusted solely
from `source === "plugin"` in the user-writable SQLite database.

The supervisor must either receive every low-level lifecycle event or own both start and stop.
This implementation chooses symmetric ownership: external callers cannot directly stop a
plugin-owned client while leaving supervisor state stale.

### Startup phases

Application startup is ordered as:

1. discover enabled plugins, validate manifests, and register contributions without starting
   plugin-owned processes;
2. initialize the MCP service and start only non-plugin-owned servers;
3. reconcile plugin-owned servers through the supervisor, starting only `eager` servers.

The following current paths are all covered by the same gate:

1. plugin activation;
2. MCP initialization;
3. manual MCP enable/disable;
4. configuration-driven restart;
5. authentication-driven restart;
6. renderer `mcpStartServer` / `mcpStopServer`;
7. application shutdown and plugin disable.

### On-demand scope and discovery

`startMode: "onDemand"` is valid only when a server explicitly declares `surfaces: ["tools"]` and a
packaged immutable tool catalog. Absence of prompt/resource declarations must not be interpreted as
tool-only support.

DeepChat may expose catalog tools while the client is stopped. On the first tool call the
supervisor:

1. coalesces concurrent starts for the same runtime;
2. validates integrity and quarantine state;
3. starts and verifies the runtime;
4. resolves the live MCP client and revalidates that the requested tool exists;
5. dispatches the call.

The CUA daemon remains running after a successful first call until plugin disable or application
shutdown. Do not describe this tools-only mechanism as general MCP lazy activation.

Package verification fails if the catalog is missing, malformed, contains duplicate/empty names,
contains invalid input schemas, disagrees with the pinned runtime's generated catalog, lacks exact
tool-policy coverage, declares a non-tool surface, or cannot be resolved from the packaged plugin.
There is no eager-start or empty-catalog fallback.

### Sentinel and quarantine

A sentinel is evidence: it is persisted immediately before a risky runtime spawn and cleared only
after a verified clean stop. A quarantine is policy: on startup, a residual sentinel for the same
runtime fingerprint prevents automatic or on-demand restart.

The fingerprint includes `pluginId`, `runtimeId`, target, and the verified executable digest. A new
fingerprint is eligible for one controlled retry, which allows a repaired runtime release to
recover without silently clearing evidence for the old binary.

User intent remains enabled while quarantined. The user action is `runtime.retry`, not “enable
plugin.” Integrity mismatch is a hard block and cannot be bypassed with retry; repair or reinstall
is required.

### Migration

Plugin installation records are stored in ElectronStore while MCP configs are stored in SQLite, so
the migration cannot be transactional across both stores. It must be versioned, idempotent, and
safe-side first:

1. write the legacy CUA MCP record to a non-autostart state;
2. register the new ownership/start-mode contract;
3. clean obsolete runtime state only after the safe write succeeds.

The migration is explicitly for the one-to-one CUA server. It must not generalize “any disabled
plugin-owned server disables the whole plugin,” which would corrupt intent for multi-server
plugins.

## Manifest contract

Plugin MCP manifests gain these capability fields:

- `startMode`: `eager` by default; `onDemand` for CUA;
- `surfaces`: explicit subset of `tools`, `prompts`, and `resources`;
- `toolCatalog`: plugin-relative generated catalog, required for on-demand tools;
- `inheritEnv`: `legacy` by default; `minimal` for controlled native helpers.

Runtime manifests may select a closed host adapter. CUA uses `cua-embedded-v1`; other plugins
continue to use the direct stdio path. Adapter-specific state does not leak into the generic MCP
configuration persisted in SQLite.

## CUA 0.12.6 adapter

The CUA adapter starts two related processes:

- daemon:
  `serve --embedded --parent-liveness-stdio --no-permissions-gate --socket <private-endpoint>
  --host-bundle-id <id> --permission-mode standard`;
- stdio proxy:
  `mcp --embedded --socket <private-endpoint> --host-bundle-id <id>`.

The daemon stdin remains open for parent-liveness. Startup completes only after a newline-delimited
metadata response validates:

- driver version `0.12.6`;
- contract version `0.2.0`;
- tools-list schema version `1`;
- capability version `1`;
- MCP protocol version `2025-06-18`;
- child PID, embedded mode, and host bundle identifier.

The endpoint is unique per attempt, private to the user, persisted in the sentinel for exact stale
cleanup, and constrained to the platform path-length rules. Start requests are coalesced and stop
is idempotent.

## Controlled process environment

`inheritEnv: "minimal"` starts from an empty environment, copies only the platform baseline, and
then applies manifest-declared values. Missing variables are skipped.

Common baseline:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`;
- `TMPDIR`, `TMP`, `TEMP`;
- `LANG` and `LC_*`.

Linux/session additions:

- `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`;
- `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE`;
- `DBUS_SESSION_BUS_ADDRESS`.

Windows additions:

- `SystemRoot` / `SYSTEMROOT`, `windir` / `WINDIR`, `COMSPEC`, `PATHEXT`;
- `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `PROCESSOR_ARCHITECTURE`.

`CUA_LOG` may pass through for diagnostics. Existing user-managed MCP configs and plugin manifests
without `inheritEnv` retain legacy behavior for compatibility.

## Runtime integrity contract

Integrity is checked immediately before every CUA daemon spawn.

Windows and Linux validation:

- resolve within the registered runtime root;
- reject symlinks and non-regular files (and Windows reparse points where Node can identify them);
- compare the complete declared file set and executable digest against a release-generated
  descriptor obtained from the packaged official artifact, not from the writable installation;
- reject unexpected executable files.

macOS validation:

- resolve the expected `.app` and executable within the registered runtime root;
- run strict code-signature verification;
- verify the DeepChat bundle identifier and expected signing team/identity;
- require hardened runtime and the exact helper entitlement contract:
  `com.apple.security.automation.apple-events` and
  `com.apple.security.device.screen-capture`.

The digest is still used in the quarantine fingerprint after DeepChat re-signing, but the
code-signature identity is the trust decision on macOS.

These checks detect stable replacement, corruption, incomplete extraction, and AV
quarantine/deletion. Windows per-user installs and Linux AppImage/tar.gz locations are not strong
trust roots, and this contract does not claim to resist an active same-user attacker or the
hash-to-spawn race.

Feishu is an explicit exception to complete launch-artifact attestation: its packaged `serve.mjs`
invokes `npx -y @larksuiteoapi/lark-mcp@0.5.1`, so part of the execution closure is resolved at
runtime. The supervisor still owns its lifecycle; vendoring and lockfile attestation are a follow-up
security task and do not block CUA remediation.

## Platform distribution

| Target | CUA artifact policy | Signature/integrity policy |
| --- | --- | --- |
| macOS arm64/x64 | Bundle upstream `.app`, rebrand/sanitize, then DeepChat-sign | Verify helper, sign helper before parent app, preserve notarization |
| Windows x64/arm64 | Bundle only `cua-driver.exe`; omit UIA worker | Keep unsigned; checksum/file-set gate; set `CUA_DRIVER_RS_SPAWN_UIA_WORKER=0` |
| Linux x64 | Bundle executable | Checksum/file-set gate and executable mode |
| Linux arm64 | DeepChat still builds/releases; CUA remains unbundled until validated | Unsupported CUA target |

The upstream UIA worker is opt-in, requires a separate UIAccess signing/deployment contract, and is
not necessary for the standard CUA path. Omitting `cua-driver-uia.exe` is the primary defense; the
strictly-false environment flag is defense in depth.

## Acceptance and release gates

Automated gates:

- manifest schema and lifecycle ownership tests;
- all start/stop/restart entry-point tests;
- on-demand catalog discovery and concurrent first-call tests;
- migration idempotency and user-intent preservation tests;
- sentinel/quarantine/fingerprint tests;
- controlled-environment tests;
- integrity descriptor and platform package tests;
- exact CUA tool catalog/policy parity tests;
- macOS signing and entitlement contract tests.

Native release gates:

- macOS arm64 and x64 packaged helper, TCC, screen capture, input, restart, and notarized-app tests;
- Windows x64 and arm64 clean consumer-machine tests with Defender real-time protection enabled,
  recording `Get-MpComputerStatus`, installation, first launch, tool execution, restart, and
  protection history;
- Linux x64 X11 regression test that reproduces the #2039 activation path without desktop/session
  loss, plus Wayland validation where supported;
- disable, crash, stale-sentinel quarantine, retry, and upgrade recovery on every target.

CI runner success is not a substitute for Windows Defender or Linux desktop-session validation.
DeepChat Linux builds continue normally. Before this architecture lands, a release must not ship
another Linux CUA artifact that still bundles and auto-starts 0.7.1; if native CUA validation
fails, whether to omit that optional plugin artifact is a release decision, not a reason to stop
building the Linux application.
