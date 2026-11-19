# devcrew v1 — Design

Date: 2026-11-19 · Status: draft

## Intent

`devcrew` is a personal, public-facing (portfolio) **Claude Code plugin** that brings the author's own agents,
skills and guardrails to any project with one install. Today every new project starts from zero: security
review is ad hoc, and when something breaks in production the author has to dig through the platform's logs
(Google Cloud Logging today; maybe Vercel tomorrow) by hand.

It is inspired by the `harness` template (agents + memory + hooks), but it is a **plugin, not a template**:
improvements pushed to the repo reach every project through `/plugin update`, nothing is copied by hand.

It **complements superpowers**, which keeps owning the workflow (brainstorm → spec → plan → implement →
review). devcrew adds specialists that plug into that workflow's key moments.

The lessons come from two real projects (a Spring Boot 3 / Java 21 hexagonal backend on Cloud Run and a
React 18 / Vite / Vitest frontend), generalized: no personal data, URLs, account names or emails in the repo.

## Goals

1. Install in any project with:
   ```
   /plugin marketplace add JesusFdezGallardo/devcrew
   /plugin install devcrew@devcrew
   ```
2. A **security reviewer** that audits like a cybersecurity expert and reports by severity.
3. A **production investigator** that finds production errors (Sentry first), maps them to code and proposes
   a cause and a fix — platform-agnostic.
4. A skill to **add Sentry** to a Spring Boot or React project with privacy defaults.
5. A skill to **bootstrap a new project** with the author's conventions.
6. A **secrets guard** hook that stops Claude from reading or committing secret files.
7. Repo presentable as a portfolio piece: English, clear README, real example reports.

## Non-goals (v1)

- Scheduled/periodic error monitoring (later, on top of the investigator once it proves reliable).
- Stack experts (Spring/hexagonal, React), docs auditor, release manager, other harness agents.
- An orchestrator/"architect" agent or any workflow of its own.
- Support for platforms other than Claude Code (OpenCode, Pi…).

## Anti-goals (failure even if it "works")

- Duplicating or fighting superpowers' flow (e.g. a second mandatory review loop, a competing "spec first" rule).
- Any personal or project-specific data in the public repo (emails, prod URLs, IBANs, real account codes, tokens).
- The review/investigation agents **changing code or production**. Both are read-only; fixes go through the
  normal superpowers flow after the user agrees.
- Leaking personal data from production into files, commits, issues or the chat beyond what is needed
  (summaries, masked values — never raw event payloads).
- A secrets guard so noisy it gets disabled (false positives on `.env.example`, docs that mention `.env`, etc.).

## Constraints

- Author works on **Windows 11** (PowerShell + Git Bash), also must work on macOS/Linux → hooks in **Node.js
  (ESM, no dependencies)**; Node is required anyway by Claude Code. No `jq`, no bash-only syntax.
- Repo is **private for now**, public later. Installing a private marketplace uses the user's git credentials.
- Sentry free Developer plan (1 user, ~5k errors/month, 30-day retention). Sentry org in the **EU data region**.
- Sentry MCP: official hosted server (`https://mcp.sentry.dev/mcp`, OAuth). No API token stored in the repo.
- SDKs must be a **no-op when the DSN is empty** (local dev, tests, build-time steps without network such as a
  CDS training run inside `docker build --network=none`).
- All content (README, agents, skills, code, CHANGELOG) in **English**. Agents answer in the user's language.

## Approaches considered

1. **Single repo that is both plugin and marketplace** — *chosen*. Official Claude Code format, installable from
   GitHub, updates via `/plugin update`, presentable as-is.
2. Clone-able template like `harness` — rejected: each project freezes a copy; improvements must be copied by
   hand, which is exactly the pain to remove.
3. Loose files in `~/.claude/` (user scope) — rejected: nothing to show or share, lost when changing machines.

On top of (1): devcrew **joins superpowers** instead of replacing it (user's decision). An own orchestrator was
rejected: it would rewrite what superpowers already does and both would conflict when enabled together.

## Repository layout

```
devcrew/
├── .claude-plugin/
│   ├── plugin.json            # name "devcrew", version, description, author, license, repository
│   └── marketplace.json       # marketplace "devcrew" listing one plugin "devcrew" with source "./"
├── agents/
│   ├── security-reviewer.md
│   └── production-investigator.md
├── skills/
│   ├── setup-observability/SKILL.md   (+ reference files per stack)
│   └── init-project/SKILL.md          (+ templates/)
├── hooks/
│   ├── hooks.json             # PreToolUse → node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-secrets.mjs"
│   ├── guard-secrets.mjs
│   └── guard-secrets.test.mjs # node:test
├── .mcp.json                  # "sentry": remote HTTP server, OAuth
├── docs/
│   ├── superpowers/specs|plans/
│   └── examples/              # sanitized example reports for the README
├── README.md
├── CHANGELOG.md
└── LICENSE                    # MIT
```

Versioning: SemVer in `plugin.json`, starting at `0.1.0`; `CHANGELOG.md` (Keep a Changelog style, English).

## Per-project configuration (shared contract)

Agents and skills read project facts from a **`## Production` section in the project's `CLAUDE.md`**, written by
`init-project` / `setup-observability` and editable by hand:

```markdown
## Production
- Platform: Cloud Run | Vercel | other — service name, region, project id (if any)
- Error tracking: Sentry — org `<org-slug>`, project `<project-slug>`, region EU
- Release identifier: git commit SHA
- Logs fallback: `gcloud logging read ...` | `vercel logs ...`
```

Optional `.devcrew.json` at the project root for the secrets guard allowlist (see hook). Nothing else.

## Components

### 1. Agent `security-reviewer`

- **Role:** senior application-security auditor / pentester mindset. Read-only.
- **Tools:** Read, Grep, Glob, Bash (read-only commands only: git log/diff/show, `npm audit`, listing files).
  Prompt forbids edits and mutating commands.
- **Scope:** by default the diff of the current branch against its base (or staged + unstaged changes if on the
  default branch). On request: a path or the whole project.
- **When it runs:** on demand ("review security"), and its `description` tells Claude to use it before finishing a
  development branch / before pushing changes that touch auth, input handling, config, dependencies or data sent
  to third parties. `init-project` adds one line to the project's `CLAUDE.md` asking to run it at
  superpowers' final review step. superpowers itself is not modified.
- **Checklist** (generic, informed by real incidents):
  - Secrets: committed secret files or values, secrets in history, defaults like `dev`/`changeme`, secrets in
    Docker images or build logs, `.gitignore` gaps.
  - AuthN: JWT validation completeness (issuer, signature, **audience**, expiry, `email_verified` for Google ID
    tokens), dev bypasses (API-key headers) that can be active in production.
  - AuthZ: per-user/tenant data access on every endpoint (IDOR), admin-only operations, 404-vs-403 policy.
  - Injection: SQL/JPQL, expression languages (SpEL/OGNL — evaluation context must be sandboxed), command,
    path traversal, XSS (`dangerouslySetInnerHTML`, unsanitized URLs), open redirects (only `https` URLs).
  - Web config: CORS origins, security headers (CSP, HSTS, X-Content-Type-Options, frame-ancestors), cookies.
  - Data protection: personal/financial data in logs, data sent to third parties (LLM prompts, error trackers)
    without masking, PII in error-tracker events.
  - Dependencies: `npm audit` when there is a `package.json`; for Maven/Gradle, flag outdated/known-vulnerable
    versions it can identify from the manifest (no heavy scanners in v1).
  - Infra files: Dockerfile (root user, secrets in layers), compose (ports bound to `0.0.0.0`), CI workflows
    (secrets exposure, `pull_request_target`).
- **Report:** findings ranked Critical / High / Medium / Low, each with `file:line`, what an attacker could do
  (concrete scenario), and the fix. Secret values are always masked. Ends with "what was not checked".
  Confidence stated per finding; unverified suspicions are labeled as such.

### 2. Agent `production-investigator`

- **Role:** SRE-style investigator. Read-only on code and on production.
- **Input:** a symptom ("bank sync failed this morning"), a Sentry issue ID/URL, or a time window.
- **Steps:**
  1. Read `## Production` from `CLAUDE.md`. If missing, say so and suggest `setup-observability`.
  2. Query Sentry via the plugin's MCP server: matching issues in the window, events, stack traces, release,
     tags, frequency, first/last seen.
  3. Group by root error; map stack frames to code **at the deployed release** (git SHA) when available.
  4. Produce: summary, timeline, affected scope (counts, not people), probable cause with evidence and
     confidence, proposed fix, and how to verify. It does **not** edit code; it suggests continuing with
     `superpowers:systematic-debugging` to fix.
  5. Fallback when there is no Sentry or the error isn't there: the platform CLI from `## Production`,
     **read-only commands only** (`gcloud logging read`, `vercel logs`). Never `deploy`, `delete`, `update`,
     `rollback` or similar.
- **Privacy:** summarizes; masks emails, IBANs/card numbers, tokens; never writes raw event payloads to files,
  commits or issues.

### 3. Skill `setup-observability`

- Detects stack: `pom.xml`/`build.gradle` with Spring Boot 3 → Java; `package.json` with React (Vite) → frontend.
  Both may exist in one repo; otherwise stops and says what it supports.
- **Spring Boot 3:** `sentry-spring-boot-starter-jakarta`; properties `sentry.dsn=${SENTRY_DSN:}`,
  `sentry.environment=${SENTRY_ENVIRONMENT:local}`, `sentry.release=${SENTRY_RELEASE:}`,
  `sentry.send-default-pii=false`, sensible traces sample rate; a `BeforeSendCallback` bean that masks emails,
  IBANs, card-like digit runs and bearer tokens in messages, exception values and breadcrumbs.
- **React (Vite):** `@sentry/react`, `Sentry.init` in the entry file with `VITE_SENTRY_DSN`, environment,
  release, `sendDefaultPii: false`, same masking in `beforeSend`, error boundary at the app root; source maps via
  `@sentry/vite-plugin` only when `SENTRY_AUTH_TOKEN` is present (CI), deleting `.map` files after upload.
- Adds variables (names only) to `.env.example`, writes/updates `## Production` in `CLAUDE.md`, adds a changelog
  entry (see init-project), and lists **manual steps** for the user: create Sentry org in EU region, create
  project, set DSN in the deployment platform, connect the MCP (`/mcp` → sentry → authenticate).
- Follows the project's existing test conventions: adds a test for the masking callback.
- Never commits by itself.

### 4. Skill `init-project`

- Asks (one at a time, with defaults): project name, one-line description, stack, deploy platform, changelog
  file name and language (default `CHANGELOG.md`, English; the author's own projects use `CAMBIOS.md`, Spanish).
- Creates or **merges into** (never overwrites; shows what it would add when a file exists):
  - `CLAUDE.md` skeleton: overview, commands, architecture, data model notes, `## Production` placeholder, and a
    `## devcrew` section: run `devcrew:security-reviewer` at superpowers' final review; log each change set in the
    changelog naming any secrets touched.
  - Changelog file with a first entry.
  - `.gitignore` block for secrets: `.env`, `.env.*` (keeping `!.env.example`), `*.pem`, `*.key`, `*.p12`,
    `*.pfx`, `credentials*.json`, `*-credentials.json`, `service-account*.json`, `tokens/`, `*.sql` dumps.
  - `.env.example` (names only).
  - `docs/superpowers/specs/` and `docs/superpowers/plans/` folders.
- Optionally chains into `setup-observability`.
- Never commits by itself.

### 5. Hook `guard-secrets` (PreToolUse)

- Matchers: `Read`, `Edit`, `Write`, `Grep`, `Bash`, `PowerShell`. Script reads the hook JSON from stdin; exit 2 with
  a clear stderr message blocks; exit 0 allows. Any internal error → allow (fail open) and print a warning, so a
  bug never blocks all work.
- **Secret patterns** (basename, case-insensitive): `.env`, `.env.*` except `.env.example|.sample|.template`;
  `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*` (not `.pub`); `credentials*.json`,
  `*-credentials.json`, `service-account*.json`; `StoredCredential`.
- **Read/Edit/Write/Grep:** block when the target path matches.
- **Bash/PowerShell:** block reading commands that reference a matching path (`cat`, `type`, `head`, `tail`,
  `less`, `more`, `grep`, `Get-Content`, `gc`, `Select-String`, `cp`/`Copy-Item` to stdout-like targets);
  block `git add` of matching paths; on `git commit`, check `git diff --cached --name-only` and block if any
  staged file matches.
- **Allowlist:** `.devcrew.json` → `{ "secretsGuard": { "allow": ["<glob>", ...] } }` for files that look secret
  but aren't (e.g. a committed `.env.production` holding only public build config).
- Unit tests with `node:test` covering each pattern, the exceptions, the allowlist and fail-open.

### 6. MCP `.mcp.json`

- One server `sentry`, remote HTTP, OAuth (no token in repo). Documented in README, including how to disable it.

## README (portfolio)

English. What devcrew is and how it fits with superpowers; install in two commands (plus the private-repo
note); one section per agent/skill/hook with a sanitized example report from `docs/examples/`; configuration
(`## Production`, `.devcrew.json`); roadmap (periodic monitoring, stack experts, docs auditor); credits
(`harness`, superpowers); license.

## Verification

- `node --test hooks/` passes.
- Plugin manifest validates (`claude plugin validate .` or equivalent).
- Dogfooding on the author's two projects (local install via `/plugin marketplace add <local path>`):
  - `security-reviewer` on each repo produces a sensible report (known past issues would be caught).
  - `guard-secrets` blocks reading the backend's `.env` and `credentials.json`, allows `.env.example`.
  - `init-project` on an empty scratch folder produces the expected files; on an existing repo it merges without
    overwriting.
  - `setup-observability` is used **for real on the backend project** (Spring Boot on Cloud Run — where the
    production-logs pain comes from), on a branch of that repo, following that repo's own workflow and
    changelog. The frontend can follow later with the same skill.
  - `production-investigator`: with the backend sending errors to Sentry, investigate a deliberately triggered
    test error end to end.
- **Example reports come from the real projects (user's decision).** Rule: **fix first, then publish.** Findings
  from the dogfooding reviews are fixed in their own repos (separate change sets, their own workflow) before any
  report derived from them is committed to devcrew. Reports in `docs/examples/` are sanitized: no URLs, emails,
  account codes, identifiers, or details of still-open weaknesses. If a finding can't be fixed before publishing,
  it is left out of the example.

## Publishing

Private GitHub repo `JesusFdezGallardo/devcrew` now; switch to public later (user's decision), after checking
history contains no personal data.

## Decisions taken after the builder check (designer's calls, user may override)

- **Read-only enforcement:** no agent-aware hook in v1. Agents get an explicit tool allowlist: the Sentry MCP is
  granted **only its read tools** by exact name (no update/resolve/create tools); Bash stays, guarded by the prompt
  plus Claude Code's normal permission prompts (a mutating `gcloud`/`vercel` call still asks the user unless they
  pre-allowed it). The README documents this. An enforcing hook is a roadmap item.
- **Release SHA:** `setup-observability` wires what lives in the repo (Vite `define`/env for the release, Dockerfile
  `ARG SENTRY_RELEASE`, GitHub Actions source-map upload) and lists as manual steps what lives in the platform
  (Cloud Run build/deploy config, Vercel env). The investigator copes with a missing release: it uses `HEAD`, says
  so, and lowers its confidence in line mapping.
- **Secrets guard is an accident guard, not a barrier** (documented as such). Reads of secret paths (tools and the
  listed commands) return **"ask"** with an explanation, so the user can approve a single case; `git add` of a secret
  path and `git commit` with a staged secret return **"deny"**. Exotic read paths (`node -e`, `git show HEAD:.env`,
  folder-wide Grep) are out of scope.
- **Sentry MCP fallback:** if the hosted MCP is unavailable, unauthenticated or doesn't support the org's region, the
  investigator falls back to the platform-logs path and says so. No Sentry API token is stored or required in v1.
  README explains how to disable the server in projects that don't use Sentry.

## Left to the builder

- Exact Claude Code plugin/marketplace manifest fields and whether `source: "./"` is valid (check current docs).
- Exact MCP tool names exposed to plugin agents and how to grant them in agent frontmatter.
- Wording of agent prompts and skill steps; reference files split per stack.
- Precise regexes for masking and for command parsing in the hook, within the behavior above.
- Sentry SDK versions (current stable at build time).
