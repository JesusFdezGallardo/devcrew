---
name: mcp-check
description: Check MCP servers and their local connections before a deploy or when a server does not show up. Use when the user says "check MCP", "validate MCP connections", "why is this MCP failing", "is Sentry connected" or "review MCP servers". Runs a headless health check and, when needed, explains how to inspect a server interactively with MCP Inspector. Never stores tokens.
---

# mcp-check

Verify that the MCP servers declared in a project are configured correctly and reachable. This is the automated gate; MCP Inspector is the interactive debugger. They are not interchangeable.

## Hard rules

- **Never ask the user to paste a token into chat or into a file.** OAuth servers authenticate through `/mcp` in the client.
- **Never print header or environment values**, only variable names and HTTP status codes.
- A remote server that requires authentication or is unreachable from this machine is a **warning**, not a failure: the user decides. An invalid configuration or a missing local binary is a **failure**.
- **Answer in the user's language.** Server names and codes stay as they are.

## Step 1: Run the headless check

From the target project root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-check.mjs" --json
```

The script reads `.mcp.json` and `.claude/settings.json` (project root wins on name clashes), then:

| Server type | What is checked |
|---|---|
| Local (`command` + `args`) | Binary on `PATH`, MCP `initialize` handshake over stdio, `tools/list` and tool count |
| Remote (`url`) | URL syntax, scheme and an HTTP probe with a short timeout |
| Invalid | No `command` and no `url` → FAIL |

Typical results: `pass` = healthy, `warn` = needs authentication or unreachable, `fail` = broken config or missing binary.

Use `--root <path>` when the target is not the current directory. Exit code is 1 only when something actually fails.

## Step 2: Explain failures concretely

- **`Local binary not found on PATH`** — install the binary or use a portable name such as `npx`; check with `where <binary>` on Windows or `which <binary>` on macOS/Linux.
- **`exited with code … before responding` / `no response after …ms`** — the command is not an MCP stdio server, crashed on startup, or needs a first-run download. Pre-warm `npx` servers once with network access.
- **`HTTP 401/403`** — run `/mcp` in the client and authenticate the server. No token belongs in the repo.
- **`unreachable from this machine`** — check the network, VPN or firewall; do not treat it as a broken configuration.
- **`invalid URL` / `unsupported URL scheme`** — fix the `url` field in `.mcp.json`.

## Step 3: Interactive debugging with MCP Inspector (development only)

When the headless check is not enough — for example to inspect the exact tool schemas or call a tool by hand — use the official Inspector:

```bash
npx -y @modelcontextprotocol/inspector
```

Open the URL printed in the terminal. In the UI:

1. Choose **STDIO** and enter the local `command` and `args` from `.mcp.json` to attach to a local server, or choose **Streamable HTTP** and enter the remote `url` to attach to a hosted one.
2. Click **Connect**, then inspect **Tools**, **Resources** and **Prompts**. Call a read-only tool to confirm the connection end to end.
3. Use the **Configuration** panel to review environment variables and headers. Keep real values in the tool, never in a file or a commit.

Remind the user: Inspector is a human debugging tool and must not be part of CI. `mcp-check` is the automated gate.

## Step 4: Report

```text
devcrew mcp-check — <project>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Healthy
- <server>: <n> tools

Needs attention
- <server>: <reason and next step>

Broken
- <server>: <reason and next step>

### Verdict
✅ PASS | ⚠️ PASS WITH WARNINGS | ❌ FAIL
```

Close with the exact command to re-run after fixing the issue.
