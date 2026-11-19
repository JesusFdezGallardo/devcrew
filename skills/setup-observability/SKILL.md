---
name: setup-observability
description: Add Sentry error tracking to a Spring Boot 3 or React (Vite) project, with EU region, no default personal data, masking of emails, IBANs, card numbers and tokens, a Production section in CLAUDE.md and a list of manual steps. Use when the user wants to add Sentry, error tracking, monitoring or observability. Never overwrites files and never commits.
---

# setup-observability

Wire Sentry into the current project so that production errors can be investigated, without leaking personal data.

## Hard rules

1. **Never overwrite** an existing file. Merge: add only what is missing, and **show the user the exact lines**
   before appending to an existing file.
2. **Never commit** and never run `git add`. Leave everything for the user to review.
3. **Never write real secrets or identifiers.** DSNs, auth tokens, org and project slugs are placeholders
   (`<org-slug>`, `<project-slug>`) unless the user typed them in this conversation. `.env.example` has names only.
4. **The SDK must be a no-op with an empty DSN**, including during builds without network. Never add a default
   DSN, never initialize Sentry with a hard-coded value.
5. **EU region, no default personal data** (`send-default-pii=false` or its equivalent), masking applied as the
   references say, in the order they say.
6. `SENTRY_AUTH_TOKEN` exists only as a CI secret: never in the repo, in `.env.example` as a value, or in code.

## Step 1: Detect the stack

Look at the project root (and one level down for monorepos):

- **Spring Boot 3 (Java):** `pom.xml` or `build.gradle(.kts)` with Spring Boot 3 (parent
  `spring-boot-starter-parent` 3.x, or the `org.springframework.boot` plugin / BOM at 3.x). Boot 2 is not
  supported: say so and stop for that part.
- **React (Vite):** `package.json` with `react` and `vite` in its dependencies. Other bundlers are not supported.

Both may be present in one repo: set up each one. If neither is found, stop and say what is supported. Do not
guess a stack.

Also read the existing `CLAUDE.md`, any `.env.example`, `Dockerfile` and `.github/workflows/` so you can merge
instead of duplicating, and check whether Sentry is already configured (dependency or `sentry.*` keys). If it is,
report what exists and add only what is missing.

## Step 2: Apply the reference for each stack

The references live in `references/` next to this SKILL.md: resolve them against the "Base directory for this
skill" that Claude Code prints when the skill loads (fallback:
`${CLAUDE_PLUGIN_ROOT}/skills/setup-observability/references/`). If a reference cannot be read, stop and tell the
user instead of improvising the masking rules.

- Spring Boot 3: `references/spring-boot.md`
- React (Vite): `references/react-vite.md`

Each reference has the dependency, the configuration, the masking code, the tests and the release wiring.
Follow it, with these points:

- **SDK versions:** the references name the versions they were verified with. Check whether a newer stable
  version exists (Maven Central for `io.sentry:sentry-spring-boot-starter-jakarta`, npm for `@sentry/react` and
  `@sentry/vite-plugin`) and use it only if the code in the reference still compiles; otherwise keep the verified
  version.
- **Masking rules** are identical in both stacks and run in this order on messages (and Spring's message
  parameters), exception values, string values of the event `extra`, and breadcrumb messages and string `data`
  values: JWT, then `Bearer` token, then email, then IBAN, then card-like digit runs. Copy the regexes verbatim.
- **Tests:** add the masking tests in the project's test style (framework, folder, naming). They must cover each
  rule and the order. Run the project's test command and the build afterwards, with no DSN set, and report the
  result. If a command cannot run here, say so.
- **Release wiring in the repo:** Spring: `ARG SENTRY_RELEASE` in the Dockerfile runtime stage, turned into an
  env var; React: release from `VITE_SENTRY_RELEASE`, falling back to `VITE_VERCEL_GIT_COMMIT_SHA` (exposed by
  Vercel to Vite builds), source maps uploaded only when `SENTRY_AUTH_TOKEN` is set.
  In GitHub Actions pass `${{ github.sha }}` as the release, and only extend a workflow that already builds the
  project. Never create a workflow.

## Step 3: Environment variable names

Add the names from the references to `.env.example` (create it if missing, append only names not already
present): `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE` for Spring;
`VITE_SENTRY_DSN`, `VITE_SENTRY_ENVIRONMENT`, `VITE_SENTRY_RELEASE` for React. Names only. Make sure `.env` stays
ignored by `.gitignore`; if it is not, tell the user (the `init-project` skill adds the secrets block).

## Step 4: Write `## Production` in `CLAUDE.md`

The section is a contract read by the `production-investigator` agent. Keep these field names exactly:

```markdown
## Production

- Platform: <Cloud Run | Vercel | other> — service name, region, project id (if any)
- Error tracking: Sentry — org `<org-slug>`, project `<project-slug>`, region EU
- Release identifier: git commit SHA
- Logs fallback: `<gcloud logging read ... | vercel logs ...>`
```

- No `CLAUDE.md`: create one containing just this section and tell the user to run `devcrew:init-project` for the
  full skeleton.
- `CLAUDE.md` without a `## Production` heading (case-insensitive): append the section after a blank line.
- Section already present: leave existing lines untouched; add only a missing field line. If the
  `Error tracking` line holds placeholders or another value, show it to the user and ask before changing it.
- Fill what you know (platform from the Dockerfile, `vercel.json`, workflows or what the user says). Leave
  `<placeholders>` for the rest, including org and project slugs. For a repo with both stacks, add one
  `Error tracking` line per project, naming the stack in the project placeholder (`<project-slug-api>`,
  `<project-slug-web>`).

## Step 5: Changelog entry

Find the project's changelog (the one named in the `CLAUDE.md` `## devcrew` section, else `CHANGELOG.md`). If it
exists, add an entry in its language and format, dated today, saying that Sentry was added, naming the variables
touched (names only, never values) and noting that `SENTRY_AUTH_TOKEN` is a CI-only secret. Show the entry
before appending. If no changelog exists, do not create one: mention it in the summary.

## Step 6: Manual steps for the user

List these at the end, adapted to the stacks found. They need the user's accounts and cannot be done from the repo:

1. Create the Sentry organization in the **EU data region** (the region is chosen at sign-up and cannot be
   changed later).
2. Create the project(s): one per stack (Spring Boot / Java, React). Copy each DSN.
3. Set the variables in the deployment platform, not in the repo: `SENTRY_DSN` and `SENTRY_ENVIRONMENT`
   (production) on Cloud Run; `VITE_SENTRY_DSN` and `VITE_SENTRY_ENVIRONMENT` on Vercel (or the frontend
   host). The DSN is not a secret in the browser, but keep it out of the repo.
4. Release identifier: make the platform pass the commit SHA. Cloud Run with Cloud Build: pass the commit SHA
   substitution as `--build-arg SENTRY_RELEASE=...` in the build step. Vercel: nothing to map; Vite builds get
   `VITE_VERCEL_GIT_COMMIT_SHA`, which the app and the plugin use when `VITE_SENTRY_RELEASE` is empty (keep the
   project setting that exposes system environment variables on). Without a release the investigator falls back
   to `HEAD`.
5. Source maps (React): create an organization auth token with release and source map upload scope and store it
   **only as the CI secret `SENTRY_AUTH_TOKEN`** (GitHub Actions secret), plus `SENTRY_ORG` / `SENTRY_PROJECT`.
6. Connect the Sentry MCP for the investigator agent: run `/mcp` in Claude Code, choose `sentry`, authenticate.
7. Check it works: deploy, trigger a test error, and confirm it arrives masked (no emails, IBANs or tokens).

## Step 7: Summarize

End with a summary listing each file as **created**, **appended** (what was added) or **skipped** (already
present), the SDK versions used, the test and build results, and the manual steps above. Remind the user that
nothing was committed and suggest reviewing with `git status` / `git diff`.
