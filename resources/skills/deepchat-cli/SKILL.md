---
name: deepchat-cli
description: Use DeepChat's bundled CLI control plane for model inference, image/video/speech generation, transcription, OCR, artifact inspection, public configuration, Skills, and MCP operations. Activate when a user asks to invoke DeepChat capabilities that are not already exposed as a more specific tool, compare models, run a benchmark, inspect DeepChat runtime state, or manage DeepChat through the CLI.
allowedTools:
  - exec
  - process
---

# DeepChat CLI

Use the bundled `deepchat` command to ask the running DeepChat main process to perform supported
operations. The main process remains the sole owner of providers, credentials, Skills, MCP servers,
artifacts, Agent runs, and approvals.

## Command rules

- Every command must begin exactly with `deepchat <domain> <verb>`. Put `--json`, `--jsonl`,
  `--timeout`, and all domain options after the domain and verb.
- Execute one standalone command per `exec` call. Do not use pipes, redirection, command separators,
  command substitution, environment assignments, or shell wrappers around `deepchat`.
- Quote every user-controlled argument for the current shell. Never interpolate untrusted text into
  an unquoted command.
- Prefer `--json` for one result and `--jsonl` for streaming or benchmark collection. Use text mode
  only when its output will be returned directly to the user.
- Do not inspect authentication environment variables or DeepChat's local descriptor. Authorization
  is injected only after the command has passed the normal shell permission check.
- A shell approval authorizes command execution. Sensitive mutations can additionally pause for a
  renderer approval; wait for that decision and never attempt to manufacture confirmation data.
- Use `deepchat help commands` or `deepchat <domain> <verb> --help` only when the options below are
  insufficient. Do not probe undocumented routes.

## Agent file and recursion boundaries

- Agent callers may consume a DeepChat-owned artifact with `--artifact <id>` and inspect metadata
  with `artifact describe`.
- Do not use `--file`, `--out`, `--overwrite`, `artifact get`, or `artifact delete`. Agent callers
  cannot upload arbitrary local bytes, download artifact bytes, or choose output paths.
- Do not call `agent run`; an Agent cannot recursively create a detached Agent run.
- Generated media remains in DeepChat's artifact spool. Return the artifact metadata or ID so the
  application can render or reuse it.

## Discovery and model calls

```text
deepchat system status --json
deepchat system capabilities --json
deepchat system doctor --json
deepchat provider list --enabled-only --json
deepchat model list --provider <provider-id> --json
deepchat model config-get --provider <provider-id> --model <model-id> --json
deepchat model invoke --provider <provider-id> --model <model-id> --prompt <quoted-text> --jsonl
```

Always discover provider and model IDs rather than guessing them. `model invoke` is a raw provider
call: it does not create a chat session, run tools, or start an Agent loop.

## Media, transcription, and OCR

```text
deepchat image generate --provider <provider-id> --model <model-id> --prompt <quoted-text> --jsonl
deepchat video generate --provider <provider-id> --model <model-id> --prompt <quoted-text> --jsonl
deepchat audio speak --provider <provider-id> --model <model-id> --text <quoted-text> --jsonl
deepchat audio transcribe --provider <provider-id> --model <model-id> --artifact <artifact-id> --json
deepchat ocr status --json
deepchat ocr extract --artifact <artifact-id> --json
deepchat artifact describe --id <artifact-id> --json
```

Use the provider/model lists to choose a compatible runtime. OCR is local and does not require a
provider. OCR text is returned inline and is not written to the artifact spool.

## Public configuration and management

Read-only operations:

```text
deepchat settings get --json
deepchat skill list --json
deepchat mcp list --json
```

Only perform a mutation when it directly satisfies the user's request. Supported examples include:

```text
deepchat settings set --key <public-key> --value <json-scalar> --json
deepchat model enable --provider <provider-id> --model <model-id> --json
deepchat model disable --provider <provider-id> --model <model-id> --json
deepchat skill enable --name <skill-name> --json
deepchat skill disable --name <skill-name> --json
deepchat skill remove --name <skill-name> --json
deepchat mcp enable --name <server-name> --json
deepchat mcp disable --name <server-name> --json
deepchat mcp start --name <server-name> --json
deepchat mcp stop --name <server-name> --json
deepchat mcp remove --name <server-name> --json
```

Credential writes, local Skill archives, and MCP JSON installation require stdin or local-file input
and are intentionally unavailable through Agent shell execution. Ask the user to complete those
operations through the DeepChat UI or a human terminal.

## Benchmark discipline

- Pin provider/model IDs and pass per-invocation options; do not mutate global defaults to prepare a
  benchmark.
- Record structured output, exit status, wall time, and errors. Preserve failed samples.
- For OCR, distinguish cache hit, cache miss with warm runtime, cold runtime after app restart, and
  offline availability. `ocr clear-cache` warms resources before clearing, so the next extraction is
  not a cold-runtime sample.
- Run samples sequentially unless the benchmark explicitly measures concurrency; Agent compute is
  rate-limited and bounded by the main process.
