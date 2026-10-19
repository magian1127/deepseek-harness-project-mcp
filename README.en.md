# deepseek-harness-project-mcp

[中文](README.md) · [English](README.en.md)

**Let a project's root `.mcp.json` decide which MCP servers its sessions enable — and make every
unapproved server never connect and never spawn a process.**

DSH configures MCP at profile (process) scope: a server declared in a profile patch connects and
spawns its child process at DSH startup, long before any session exists. This plugin moves the
project-specific part into the repository itself — the config travels with the project, and you
approve it per project.

## Features

| Capability | Description |
| --- | --- |
| Project-level config | A `.mcp.json` at the project root (Claude Code convention) declares the MCP servers specific to that project |
| No approval, no connection | Unapproved servers spawn no process and open no connection; cloning an unknown repository and opening it executes nothing from it |
| Config-hash binding | Approval is bound to **each server's current configuration**, so a `git pull` only forces re-approval for the servers it changed |
| A repository cannot approve itself | Approval records live only in `${DSH_HOME:-~/.dsh}`; the project has no writable approval channel |
| Approve from the UI | A composer button plus a popup: pressing [Start] approves and mounts into the current session immediately, with no restart |
| Two transports | `stdio` and `streamable-http` (`http` is an alias) |
| On-demand HTTP server startup | An HTTP entry can declare `serve`: how to start the server when it is not running. If the health check fails, the plugin starts it and waits for readiness before connecting |
| Variable expansion | `command` / `args` / `env` / `url` / `headers` / `serve.*` support `${VAR}` and `${VAR:-default}` |
| Global name-collision guard | A project server sharing a name with a global profile MCP row is not mounted twice |
| No double mount for subagents | A subagent session (`origin === 'subagent'`) shares its parent's workspace, so no extra connection or child process is created; a forked session is an independent conversation and is mounted normally |
| Non-intrusive | With no `.mcp.json` the plugin stays completely silent, and it **never writes into the system prompt**; needing action only shows as a state label on the button |

## Requirements

- **DeepSeek Harness `>=0.2.0-rc.2 <0.3.0-0`** (the `engines.dsh` field in `package.json`, enforced by the host on install and profile startup; 0.1.x and earlier are rejected as incompatible)
- Verified baseline: DSH 0.2.1-rc.2 (`@deepseek-ai/dsh-mcp-client` and `@deepseek-ai/dsh-atomic-write` are both `0.2.1-rc.2`)
- Node.js `^22.19.0 || >=24.0.0`
- Host side only: no web settings form, and no model tools of its own

## Install

```powershell
dsh plugin --profile web add "link:<path-to-this-repo>"
```

Replace `<path-to-this-repo>` with this plugin's source directory. Build once first:

```powershell
npm install
npm run build
```

`--profile web` is the profile used by the Web GUI; substitute the profile you actually run (the
desktop app uses `desktop`). With a `link:` install, re-run `npm run build` after source changes.

Afterwards the profile's bundle list should contain `deepseek-harness-project-mcp` and the Loader
should show a `dsh-project-mcp` row:

```powershell
dsh plugin --profile web list
```

The Host half has no settings form; the Client half is only the composer button and its popup.
Getting a new build into a long-running process needs **no restart**: remove and reinstall the
bundle from the Plugins page (measured). The Client half hot-reloads on its own, without a page
refresh. Only the very **first** supply of the Client half needs one DSH restart, because the
host's module table caches "not a client package" per process.

## `.mcp.json` format

Place it at the **project root** (the first ancestor of the session workspace containing `.git`;
if no `.git` is found all the way up, the workspace directory itself):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN:-}" }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| Key (`github` / `docs`) | Server name. Legal characters are `[A-Za-z0-9_-]`, length 1–32; anything else is normalized and renamed |
| `command` + `args` + `env` | stdio server. `env` holds extra environment variables; `cwd` is the session workspace |
| `type: "http"` or `"streamable-http"` + `url` + `headers` | HTTP server |
| `serve` (optional on HTTP entries) | How to start the server when it is not running — see below |
| `type: "sse"` / `"ws"` / `"sdk"` | **Unsupported** — skipped with a reason (DSH's transport factory only has stdio and streamable-http branches) |
| `url` without `type` | **Skipped** — the transport cannot be determined |

A server's tools appear as `mcp__<serverName>__<toolName>`; for a renamed server the tool names use
the normalized name. Full semantics, skip reasons, and boundaries live in the
[behavior contract](docs/behavior.md).

### On-demand HTTP server startup (`serve`)

In HTTP mode DSH **spawns no child process** — it only sends requests to `url`, so the server must
already be running. If it is not, DSH cannot connect and the tools are unavailable. `serve` lets
the plugin **start the server** in that case and wait for readiness before connecting:

```json
{
  "mcpServers": {
    "mudblazor": {
      "type": "http",
      "url": "http://127.0.0.1:19701/mcp",
      "serve": {
        "command": "dotnet",
        "args": ["<path-to-MudBlazor.Mcp.dll>", "--version", "9.10.0"],
        "env": { "ASPNETCORE_URLS": "http://127.0.0.1:19701" },
        "health": "http://127.0.0.1:19701/health/ready",
        "readyTimeoutMs": 120000
      }
    }
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `command` | ✅ | Executable (or absolute path). Same semantics as the stdio `command`, and **not** interpreted by a shell |
| `args` | ❌ | Argument array, default `[]` |
| `env` | ❌ | **Extra** environment variables (layered on top of the host environment) |
| `health` | ❌ | Readiness URL (only `http://` / `https://`). When omitted, the `url`'s origin + `/health/ready` |
| `readyTimeoutMs` | ❌ | Readiness deadline in milliseconds, default `120000` |

Behavior:

- **A running server is never touched**: one health check (2 s timeout) runs first; on success the
  entry is handed straight to DSH with no extra action.
- **The server is started only when that check fails**, then `health` is polled every 250 ms and the
  entry is handed over once ready.
- **Your first message waits for readiness** (at most `readyTimeoutMs`). This is the only
  user-visible cost: the wait happens on the session-creation path, so the tools are registered
  before the first request. The wait affects **only that entry** — other servers in the same
  session are mounted immediately.
- **A timeout still connects**: one log line is written and DSH retries on its own (tools register
  but stay unavailable for a while).
- **A started server outlives DSH**: it inherits no pipes and the reference is dropped immediately.
  On POSIX it also gets its own process group. On Windows it depends on the command: PowerShell gets
  no `detached` (there `detached` means `DETACHED_PROCESS`, and PowerShell then exits without running
  a single line), while everything else keeps it — otherwise the server stays attached to the host
  console and dies together with DSH. The plugin never kills, monitors, or restarts it — several
  DSH instances (or a DSH restart) share one server, and the server decides when to exit. To stop
  it, end the process yourself.
- **Two sessions mounting the same `url` start it only once** (deduplicated by `url`).
- **A malformed `serve` does not break anything**: only `serve` is dropped, one log line is written,
  and the server is mounted as usual.

Full semantics: [behavior contract §3.2](docs/behavior.md#32-servehttp-条目的按需拉起可选).
Diagnosing "the server was not started" and "why is it taking so long":
[troubleshooting](docs/troubleshooting.md).

## Trust and approval

1. Open a session in a project that has a `.mcp.json`. A plug icon appears in the composer tool row,
   with a state label that follows the status（"Detecting" / "N pending" / "MCP ready"）. With no `.mcp.json` the button is not rendered at all.
2. Click it to open the popup, read each server's state and reason, and press **[Start]**:

| Action | Behavior |
| --- | --- |
| [Start] | Approves **that server's current configuration** and mounts it into the current session immediately |
| [Retry] | Mounts a failed server again (without rewriting the approval when the config is unchanged) |
| [Revoke] | Deletes that server's approval record and unmounts it from the current session |

Approving needs no session restart. Changing a server's configuration invalidates **its** hash and
forces re-approval — that is exactly the protection when a `git pull` brings in a new server, and
servers you did not touch keep their approval.

**Approval is persistent, not per-session.** The record lives in
`${DSH_HOME:-~/.dsh}/project-mcp-trust.json`, so once a project is approved every later session mounts
directly without asking. Only two situations require approving again:

- the project's **first** use;
- a server's configuration changed (for example a `git pull` rewrote it).

Diagnostics (why each server was skipped, which name was normalized, "this file has no usable
server") live in the popup. **The plugin never writes anything into the system prompt** — anything
that needs your attention shows up on the button.

On profiles without a Web UI (headless / SDK) there is no console and therefore **no way to approve**;
only Host logs remain there.

## Data boundaries

| Data | Location | Contents |
| --- | --- | --- |
| Trust record | `${DSH_HOME:-~/.dsh}/project-mcp-trust.json` (mode `0600`) | Version, project root paths, and per-server approval timestamps plus configuration hashes (`sha256:<hex>`) |

- The trust file contains **no** `.mcp.json` contents and **no** expanded environment values.
- `.mcp.json` is read-only: this plugin never writes or manages it.
- Expanded variable values are used in memory to launch servers only; they never reach logs, error
  messages, session records, or disk.
- When a variable is undefined with no default, that server is skipped and the diagnostic names the
  **variable**, never its value.
- The plugin collects no telemetry and keeps no persistent data beyond the trust file.
- **Network requests**: the plugin issues exactly one kind of request of its own — a readiness probe
  against `serve`'s `health` (or the `/health/ready` derived from `url`), and only over
  `http://` / `https://`. Every other connection is made by DSH's own MCP client (to the `url` you
  approved).
- **Process startup**: the plugin starts a process only when `serve` is declared and the health
  check failed, and only ever starts `serve.command` — with no shell interpretation, so `&&`,
  pipes, redirection, and globs do not apply. Without approval it neither spawns nor connects.

## Known limitations

| Limitation | Detail |
| --- | --- |
| Per-session connections | A project server under N sessions means N connections and child processes (a global profile row has one). A stdio server gets `--project-mcp-session <session id>` appended after the `args` from `.mcp.json`, so you can tell which session owns a process — the rest of the command line is byte-identical across sessions for the same `.mcp.json`. The marker carries the session id only, never any configuration content, and servers ignore unknown arguments, so it does not affect runtime |
| First message may miss the tools | Mounting does not wait for the MCP connection; instant sessions cost the first message's tool visibility, which returns on the next turn. **Exception**: an HTTP entry with `serve` waits for the health check first (bounded, never throws) — see above |
| Unsupported transports | `sse` / `ws` / `sdk` are always skipped; SSE is deprecated in the MCP spec and mainstream servers offer `streamable-http` |
| Disabled global rows still claim the name | The collision check looks only at a row's module name and `serverName`, not at `disabled: true`; a disabled row therefore makes a same-named project server skip as "already provided globally" while the global side never connects |
| Global rows are out of scope | MCP rows in profile patches still connect at DSH startup; this plugin detects them (the name list feeds the collision check only) but **does not warn**, and cannot prevent them. Editing the profile patch is the only remedy and lies outside this plugin's scope, so it does not interrupt startup over something you cannot act on |
| Exact module-name match | Global-row detection requires the row's module name to be **exactly** `@deepseek-ai/dsh-mcp-client`; subpath or relative forms are missed |
| `.mcp.json` capped at 1 MiB | Anything larger is **refused unread** (never loaded into memory), with an "oversized" diagnostic. Reading happens on the synchronous session-creation path, and no cap would let an oversized file in an unfamiliar repo stall it; a real `.mcp.json` is far under 100 KiB |
| Profiles without a Web UI | This plugin injects only `loader`, so it still activates on headless / SDK profiles; but with no `webServer` there is no console and therefore **no way to approve** — only Host logs remain |
| Mounting happens only at session creation or on this session's own approval | After another session approves, this session's plan already reads "approved" but the servers are not mounted into it automatically; the console lists them as `not mounted here` and counts them in the button label, and pressing [Start] mounts them |
| `serve` does not manage the server's lifetime | A started server outlives DSH: the plugin never kills, monitors, or restarts it. That is what lets several instances share one server; the cost is that a mistyped `serve` leaves a resident process you must end yourself |
| On Windows, "outlives DSH" also depends on how the server is launched | When `serve.command` is PowerShell the plugin does not use `detached` (with it, PowerShell would not run a single line). Whether the server then outlives DSH depends on how that script creates it: a process created by `Start-Process -WindowStyle Hidden` has no console and survives, while one running in the script's foreground dies with the host console. Any other command keeps `detached` and survives independently |
| `serve` does not check port ownership | If the port is taken by something else, one log line is written; nothing is preempted or retried, and the entry is handed to DSH as usual (it may connect to that other instance) |
| `serve`'s wait is bounded | Default 120 s (configurable, hard-capped at 30 min). After a timeout the entry is still mounted, the tools stay unavailable for a while, and DSH retries on its own |

## Uninstall

```powershell
dsh plugin --profile web remove deepseek-harness-project-mcp
```

Uninstalling reclaims the project-level MCP mounts and every console registration it created in
live sessions (routes, page injection, listeners), and never deletes DSH session data. `${DSH_HOME:-~/.dsh}/project-mcp-trust.json` is kept, so
approvals survive a reinstall. To remove it too, delete that file yourself once no other project
still needs the record.

## Documentation

- [Behavior contract](docs/behavior.md): `.mcp.json` field semantics, transport matrix, name normalization, trust model, console (button and popup), failure modes
- [Design](docs/design.md): goals, architectural rationale, trade-offs
- [Development](docs/development.md): source map, dependency policy, build and test
- [Troubleshooting](docs/troubleshooting.md): diagnose by symptom

## License

[MIT](LICENSE)
