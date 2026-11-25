# devcrew

[![CI](https://github.com/JesusFdezGallardo/devcrew/actions/workflows/ci.yml/badge.svg)](https://github.com/JesusFdezGallardo/devcrew/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**Your review standards, production instincts and guardrails — installed once, available in every project.**

`devcrew` is a personal **Claude Code plugin and marketplace** by [Jesús Fdez-Gallardo](https://github.com/JesusFdezGallardo). It adds a security reviewer, a production investigator, two setup skills, a secrets guard and a pre-push validation skill to any project. It plugs into the workflow you already use; it does not replace it.

## Why a plugin and not a template

A template freezes a copy in every repository: fixes have to be copied by hand and old projects drift. A plugin installs once at user scope and updates everywhere with `/plugin update`.

`devcrew` deliberately does **not** own a workflow. Your existing workflow (for example [superpowers](https://github.com/obra/superpowers)) keeps owning brainstorm → spec → plan → implement → review. devcrew only contributes specialists and guardrails at the moments that matter: project bootstrap, security review, validation before a push and investigation when production breaks.

## Install

```text
/plugin marketplace add JesusFdezGallardo/devcrew
/plugin install devcrew@devcrew
```

Restart Claude Code, then run `/skills` to confirm `devcrew:init-project`, `devcrew:ship` and `devcrew:mcp-check` are listed. The marketplace is public, so no special credentials are needed to install it.

## Use it in an existing project

Install once at user scope. Then, in each project:

```text
/devcrew:init-project     # merge a thin CLAUDE.md and conventions; never overwrites, never commits
/mcp                      # authenticate the sentry server once with OAuth; no token in the repo
/devcrew:mcp-check        # confirm the MCP connections before relying on them
/devcrew:ship             # run before committing or pushing; never commits or pushes
```

`init-project` asks a few questions with defaults. If the project already has a `CLAUDE.md` or a changelog, it only adds what is missing and shows the exact lines first. `ship` exits non-zero on a blocking finding; a secret-like file that is already tracked needs a human decision (allowlist it in `.devcrew.json` if it is a template, or remove and rotate it if it holds real values).

## What is inside

| Component | Name | What it does |
|---|---|---|
| Agent | `security-reviewer` | Read-only AppSec audit of a branch or path, ranked by severity |
| Agent | `production-investigator` | Read-only investigation of production errors via Sentry, with platform-log fallback |
| Skill | `init-project` | Creates or merges a thin `CLAUDE.md` and the per-project conventions, never overwriting |
| Skill | `setup-observability` | Adds Sentry with privacy defaults to Spring Boot or React/Vite |
| Skill | `ship` | Deterministic pre-push validation: secrets, docs, tests, build, MCP health |
| Skill | `mcp-check` | Headless MCP connectivity check plus interactive Inspector guidance |
| Hook | `guard-secrets` | PreToolUse guard: asks before reading a secret, denies staging or committing one |
| MCP | `sentry` | Hosted Sentry server, OAuth — no token is stored in the repo |

### Agents

Both agents are **read-only**. They never edit files, never mutate production and mask every secret value they see. Ask for them by name or let their `description` trigger them at the right moment.

- **`devcrew:security-reviewer`** — "review this branch for security", "is this safe to push?" It reviews the branch diff (or staged + unstaged changes on the default branch), follows untrusted input into the code, and reports Critical / High / Medium / Low findings with `file:line`, a concrete attacker scenario, a fix and a confidence level. It ends with a "Not checked" section.

  *Illustrative shape of a report (placeholder names, no real project data):*

  ```text
  ## High
  - src/api/route.ts:42 — a caller can read another tenant's record (IDOR).
    Attack: change the `id` query parameter to a known record id; the handler
    never checks ownership. Fix: scope the query by the authenticated tenant.
    Confidence: high.
  ```

- **`devcrew:production-investigator`** — "investigate this Sentry issue", "why did `<feature>` fail this morning?" It reads `## Production` from `CLAUDE.md`, queries Sentry through the plugin's MCP server, maps stack frames to the deployed git SHA, and returns Summary, Timeline, Scope, Probable cause, Proposed fix and How to verify. If Sentry is unavailable it falls back to read-only platform logs, says so and lowers its confidence.

### Skills

- **`devcrew:init-project`** — the answer to "I don't want to write `CLAUDE.md` in every repo". It asks a few questions with defaults, then creates or merges a small `CLAUDE.md` (Overview, Commands, Architecture, Data model, `## Production`, `## devcrew`), a changelog, a secrets block in `.gitignore`, a names-only `.env.example` and the `docs/superpowers/` folders. Existing files are never overwritten: it shows the exact lines it would add first. It never commits.

- **`devcrew:setup-observability`** — detects Spring Boot 3 or React/Vite, adds the Sentry SDK with `send-default-pii=false`, DSN from the environment, release from the git SHA and a masking `beforeSend` callback. It writes `## Production`, adds variable names to `.env.example`, follows the project's test conventions and lists the manual steps (Sentry org in the EU region, DSN in the deploy platform, MCP authentication).

- **`devcrew:ship`** — run it before committing or pushing. It executes `scripts/ship-check.mjs`, which reports PASS / WARN / FAIL for tracked or changed secret files, `CLAUDE.md` and changelog presence, and every `test`, `lint`, `typecheck` and `build` script declared in `package.json`. Use `--json` for CI. It does not commit or push, and it never prints secret values.

- **`devcrew:mcp-check`** — run it before a deploy or when an MCP "doesn't show up". It parses the configured servers, checks local binaries are on `PATH`, performs an `initialize` + `tools/list` handshake with local servers, probes remote endpoints, and reports status and tool counts. It also explains how to open `@modelcontextprotocol/inspector` for interactive debugging. Inspector is a human debugging tool; `mcp-check` is the gate you can automate.

### Hook

`guard-secrets` is an **accident guard, not a barrier**. On `Read`, `Edit`, `Write` or `Grep` of a path that looks secret it returns `ask` with an explanation, so you can approve a single case. `git add` of a secret path and `git commit` with a staged secret return `deny`. `.env.example`, `.env.sample`, `.env.template` and public keys are ignored. Any internal error fails open with one warning on stderr, so a bug in the hook never blocks work.

### MCP server

`.mcp.json` declares `sentry` as a remote HTTP server with OAuth. Authenticate once with `/mcp` → `sentry`; no token is written to the repo. Projects that do not use Sentry can disable the server.

## Configuration

devcrew keeps per-project state in two places, both optional:

**`## Production` in the project's `CLAUDE.md`** — read by `production-investigator`:

```markdown
## Production
- Platform: Cloud Run — service name, region, project id (if any)
- Error tracking: Sentry — org `<org-slug>`, project `<project-slug>`, region EU
- Release identifier: git commit SHA
- Logs fallback: `gcloud logging read ...` | `vercel logs ...`
```

**`.devcrew.json` at the project root** — allowlist for files that look secret but are not:

```json
{ "secretsGuard": { "allow": [".env.production"] }, "changelogFile": "CAMBIOS.md" }
```

Use placeholders for real values. Never commit DSNs, tokens, account identifiers or production URLs to this repository.

## Validation flow

1. `devcrew:init-project` gives the project a thin `CLAUDE.md` and a changelog.
2. During development, `devcrew:security-reviewer` runs at the final review step for changes touching auth, input, config, dependencies or third-party data.
3. Before pushing, `devcrew:ship` checks secrets, docs, tests and build; `devcrew:mcp-check` checks the MCP connections.
4. CI runs `npm test`, `node scripts/ship-check.mjs --no-scripts` and `node scripts/mcp-check.mjs`.

## Development

```bash
npm test                              # node:test, zero dependencies
node scripts/ship-check.mjs --json    # validation report
node scripts/mcp-check.mjs --json     # MCP health report
```

Hooks and scripts are Node.js ESM with no dependencies and work on Windows (PowerShell and Git Bash), macOS and Linux. All repository content is in English; agents answer in the user's language.

## Roadmap

- Enforced read-only agents (currently prompted, not hook-enforced).
- Periodic error monitoring on top of the investigator.
- Stack specialists and a docs/release reviewer.

## Credits

Inspired by an earlier SDD agent harness (shared agents, memory and hooks): the spec-first discipline, two-axis review and permission lessons were adapted as plugin skills rather than copied as a template. Workflow ownership stays with [superpowers](https://github.com/obra/superpowers).

## License

MIT © 2026 Jesús Fdez-Gallardo. See [LICENSE](LICENSE).
