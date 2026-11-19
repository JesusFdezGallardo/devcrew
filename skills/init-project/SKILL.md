---
name: init-project
description: Bootstrap a new or existing project with devcrew conventions (CLAUDE.md skeleton with Production and devcrew sections, changelog, secrets .gitignore block, .env.example, docs/superpowers folders). Use when the user wants to set up, initialize or bootstrap a project, or add devcrew conventions. Never overwrites files and never commits.
---

# init-project

Bootstrap the current directory with devcrew conventions. Works on empty folders and on existing repos.

## Hard rules

- **Never overwrite** an existing file. Merge: append only what is missing.
- **Never commit** and never run `git add`. Leave everything for the user to review.
- Never write secret values. `.env.example` contains names only.
- Never put real data (URLs, emails, keys) in the files unless the user typed it in answers.

## Step 1: Ask (one question at a time, with defaults)

Ask in this order, one per message, waiting for each answer. Skip any question already answered in the
user's request, and if the user says to use defaults, do not ask.

1. Project name (default: the current folder name).
2. One-line description.
3. Stack (default: infer from existing files such as `pom.xml`, `package.json`, `pyproject.toml`; else ask).
4. Deploy platform (Cloud Run, Vercel, other, none).
5. Changelog file name and language (default `CHANGELOG.md`, English). Spanish uses the Spanish template.

## Step 2: Create or merge

Templates live in the `templates/` folder next to this SKILL.md: resolve it against the "Base directory for
this skill" that Claude Code prints when the skill loads (fallback: `${CLAUDE_PLUGIN_ROOT}/skills/init-project/templates/`).
Files there: `CLAUDE.md` (Overview, Commands, Architecture, Data model notes), `changelog-en.md`,
`changelog-es.md`. If a template file cannot be read, do not stop: write equivalent content yourself from the
section list above and the inlined blocks below.

Substitute the placeholders (`{{PROJECT_NAME}}`, `{{DESCRIPTION}}`, `{{STACK}}`, `{{CHANGELOG_FILE}}`,
`{{DATE}}` = today's date). Fill the Production fields from the deploy answer (leave `<placeholders>` for
unknown values).

### Inlined: `## Production` and `## devcrew` sections

Append these two sections to `CLAUDE.md` (after the template skeleton), unless a heading is already present.
Field names are a contract read by the production-investigator agent: keep them exactly.

```markdown
## Production

- Platform: <Cloud Run | Vercel | other> — service name, region, project id (if any)
- Error tracking: Sentry — org `<org-slug>`, project `<project-slug>`, region EU
- Release identifier: git commit SHA
- Logs fallback: `<gcloud logging read ... | vercel logs ...>`

## devcrew

- At superpowers' final review, run the `devcrew:security-reviewer` agent on the change set.
- Log each change set in `{{CHANGELOG_FILE}}`, naming any secrets touched (names only, never values).
- Never commit secrets; use `.env` locally and keep `.env.example` names-only.
```

### Inlined: `.gitignore` secrets block

```gitignore
# devcrew: secrets
.env
.env.*
!.env.example
!.env.sample
!.env.template
*.pem
*.key
*.p12
*.pfx
credentials*.json
*-credentials.json
service-account*.json
tokens/
*.dump
*dump*.sql
backup*.sql
*.sql.gz
```

Do not ignore `*.sql` in general: that would hide database migrations.

### Targets

For each target, check whether it exists first.

| Target | Source | If it does not exist | If it exists |
|---|---|---|---|
| `CLAUDE.md` | template + inlined sections | create it | append only the `##` sections whose heading is missing (compare headings, case-insensitive); keep existing ones untouched |
| changelog file | `changelog-en.md` or `changelog-es.md` | create it with the first entry | leave it as is; if it lacks an entry for this setup, say so, do not add |
| `.gitignore` | inlined block | create it with the block | if the line `# devcrew: secrets` exists, add only the block lines missing from it; otherwise append the whole block after a blank line |
| `.env.example` | generated | create it | append only variable names not already present |
| `docs/superpowers/specs/.gitkeep`, `docs/superpowers/plans/.gitkeep` | none | create empty | skip |

Details:

- **`.env.example`**: generate names only, no values, from what you learned: e.g. `PORT=`, `DATABASE_URL=`
  for a service with a database, `SENTRY_DSN=` and `SENTRY_ENVIRONMENT=` if observability is planned, plus
  names typical of the stack or deploy platform. One `NAME=` per line, with a short `#` comment header.
- **Before appending to an existing file, show the user the exact lines you are about to add**, then append.

## Step 3: Offer observability

Offer to run `devcrew:setup-observability` next (Sentry, health check). Only chain into it if the user says yes.

## Step 4: Summarize

End with a summary listing each file as **created**, **appended** (what was added) or **skipped** (already
complete). Remind the user that nothing was committed. If the folder is a git repository, suggest reviewing with `git status` / `git diff`; if not, just list the files.
