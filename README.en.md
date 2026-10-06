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
| Fingerprint binding | Approval is bound to the exact contents of `.mcp.json`, so a `git pull` that adds a server forces re-approval |
| A repository cannot approve itself | Approval records live only in `${DSH_HOME:-~/.dsh}`; the project has no writable approval channel |
| Approve from the session | `/mcp-project trust` mounts the servers into the current session immediately, with no restart |
| Two transports | `stdio` and `streamable-http` (`http` is an alias) |
| Variable expansion | `command` / `args` / `env` / `url` / `headers` support `${VAR}` and `${VAR:-default}` |
| Global name-collision guard | A project server sharing a name with a global profile MCP row is not mounted twice |
| No double mount for subagents | A subagent session (`origin === 'subagent'`) shares its parent's workspace, so no extra connection or child process is created; a forked session is an independent conversation and is mounted normally |
| Non-intrusive | With no `.mcp.json` the plugin stays completely silent; session notices appear only when you need to act |

## Requirements

- DeepSeek Harness 0.2.x (source-verified baseline 0.2.1-alpha.1)
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

This plugin is Host-side only and has no client settings form. The Host half has no hot channel:
getting a new build into a long-running process needs one `dsh web` restart from you.

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
| `type: "sse"` / `"ws"` / `"sdk"` | **Unsupported** — skipped with a reason (DSH's transport factory only has stdio and streamable-http branches) |
| `url` without `type` | **Skipped** — the transport cannot be determined |

A server's tools appear as `mcp__<serverName>__<toolName>`; for a renamed server the tool names use
the normalized name. Full semantics, skip reasons, and boundaries live in the
[behavior contract](docs/behavior.md).

## Trust and approval

1. Open a session in a project that has a `.mcp.json`.
2. If the file declares mountable servers that are not yet approved, the session gets a notice
   listing the servers **pending approval**.
3. Run, inside the session:

| Command | Behavior |
| --- | --- |
| `/mcp-project` | Lists project path, state, mounted, unapproved, skipped (with reasons), and normalized renames |
| `/mcp-project trust` | Approves the whole file (recording the current fingerprint) and mounts into the current session immediately |
| `/mcp-project trust <name>…` | Approves only the named servers; other approved entries are preserved |
| `/mcp-project untrust` | Revokes approval for the project and unmounts its servers from the current session |

Approving needs no session restart. Any change to `.mcp.json` (including added entries) invalidates
the fingerprint and forces re-approval — that is exactly the protection when a `git pull` brings in
a new server.

**Approval is persistent, not per-session.** The record lives in
`${DSH_HOME:-~/.dsh}/project-mcp-trust.json`, so once a project is approved every later session mounts
directly without asking. Only two situations require approving again:

- the project's **first** use;
- the contents of `.mcp.json` changed (for example a `git pull` brought in a new server).

Diagnostics (why each server was skipped, which name was normalized, "this file has no usable
server") live in `/mcp-project` output rather than session notices. Session notices appear only when
**you need to act**: the file cannot be used (unparsable, or over 1 MiB), or entries are pending
approval.

`/mcp-project` ends its output with the **exact next command to copy**, so you never have to remember
subcommand spellings.

## Data boundaries

| Data | Location | Contents |
| --- | --- | --- |
| Trust record | `${DSH_HOME:-~/.dsh}/project-mcp-trust.json` (mode `0600`) | Version, project root paths, approval timestamps, `.mcp.json` content fingerprints (`sha256:<hex>`), and the approved server names |

- The trust file contains **no** `.mcp.json` contents and **no** expanded environment values.
- `.mcp.json` is read-only: this plugin never writes or manages it.
- Expanded variable values are used in memory to launch servers only; they never reach logs, error
  messages, session records, or disk.
- When a variable is undefined with no default, that server is skipped and the diagnostic names the
  **variable**, never its value.
- The plugin makes no network requests of its own, collects no telemetry, and keeps no persistent
  data beyond the trust file.

## Known limitations

| Limitation | Detail |
| --- | --- |
| Per-session connections | A project server under N sessions means N connections and child processes (a global profile row has one) |
| First message may miss the tools | Mounting does not wait for the MCP connection; instant sessions cost the first message's tool visibility, which returns on the next turn |
| Unsupported transports | `sse` / `ws` / `sdk` are always skipped; SSE is deprecated in the MCP spec and mainstream servers offer `streamable-http` |
| Disabled global rows still claim the name | The collision check looks only at a row's module name and `serverName`, not at `disabled: true`; a disabled row therefore makes a same-named project server skip as "already provided globally" while the global side never connects |
| Global rows are out of scope | MCP rows in profile patches still connect at DSH startup; this plugin detects them (the name list feeds the collision check only) but **does not warn**, and cannot prevent them. Editing the profile patch is the only remedy and lies outside this plugin's scope, so it does not interrupt startup over something you cannot act on |
| Exact module-name match | Global-row detection requires the row's module name to be **exactly** `@deepseek-ai/dsh-mcp-client`; subpath or relative forms are missed |
| `.mcp.json` capped at 1 MiB | Anything larger is **refused unread** (never loaded into memory), with an "oversized" diagnostic. Reading happens on the synchronous session-creation path, and no cap would let an oversized file in an unfamiliar repo stall it; a real `.mcp.json` is far under 100 KiB |
| Profiles without a `commands` service | This plugin injects `commands` / `loader` / `systemPrompt`; on a profile lacking one (e.g. `sdk-minimal`) it stays inactive, so `/mcp-project` does not appear either |
| Mounting happens only at session creation or on this session's own approval | After another session approves, this session's plan already reads "approved" but the servers are not mounted into it automatically; `/mcp-project` lists them under "approved but not mounted in this session", and running `/mcp-project trust` mounts them |

## Uninstall

```powershell
dsh plugin --profile web remove deepseek-harness-project-mcp
```

Uninstalling reclaims the project-level MCP mounts and notice sections it created in live sessions,
and never deletes DSH session data. `${DSH_HOME:-~/.dsh}/project-mcp-trust.json` is kept, so
approvals survive a reinstall. To remove it too, delete that file yourself once no other project
still needs the record.

## Documentation

- [Behavior contract](docs/behavior.md): `.mcp.json` field semantics, transport matrix, name normalization, trust model, command output, failure modes
- [Design](docs/design.md): goals, architectural rationale, trade-offs
- [Development](docs/development.md): source map, dependency policy, build and test
- [Troubleshooting](docs/troubleshooting.md): diagnose by symptom

## License

[MIT](LICENSE)
