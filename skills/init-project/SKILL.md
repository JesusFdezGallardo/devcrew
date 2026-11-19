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

Templates live in `${CLAUDE_PLUGIN_ROOT}/skills/init-project/templates/`. Read them, substitute the
placeholders (`{{PROJECT_NAME}}`, `{{DESCRIPTION}}`, `{{STACK}}`, `{{CHANGELOG_FILE}}`, `{{DATE}}` as today's
date), and fill the `## Production` fields from the deploy answer (leave `<placeholders>` for unknown values).

For each target below, check whether it exists first.

| Target | Template | If it does not exist | If it exists |
|---|---|---|---|
| `CLAUDE.md` | `templates/CLAUDE.md` | create it | append only the `##` sections whose heading is missing (compare headings, case-insensitive); keep existing ones untouched |
| changelog file | `templates/changelog-en.md` or `changelog-es.md` | create it with the first entry | leave it as is; if it lacks an entry for this setup, say so, do not add |
| `.gitignore` | `templates/gitignore-secrets.txt` | create it with the block | if the line `# devcrew: secrets` exists, add only the block lines missing from it; otherwise append the whole block after a blank line |
| `.env.example` | generated | create it | append only variable names not already present |
| `docs/superpowers/specs/.gitkeep`, `docs/superpowers/plans/.gitkeep` | none | create empty | skip |

Details:

- **`.env.example`**: generate names only, no values, from what you learned: e.g. `PORT=`, `DATABASE_URL=`
  for a service with a database, `SENTRY_DSN=` and `SENTRY_ENVIRONMENT=` if observability is planned, plus
  names typical of the stack or deploy platform. One `NAME=` per line, with a short `#` comment header.
- **`.gitignore`**: the block must keep `!.env.example`, `!.env.sample`, `!.env.template` after `.env.*`.
- When a file already exists, show the user exactly what you appended (a short diff or the added lines).

## Step 3: Offer observability

Offer to run `devcrew:setup-observability` next (Sentry, health check). Only chain into it if the user says yes.

## Step 4: Summarize

End with a summary listing each file as **created**, **appended** (what was added) or **skipped** (already
complete). Remind the user that nothing was committed and to review with `git status` / `git diff`.
