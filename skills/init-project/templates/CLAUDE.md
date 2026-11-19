# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

{{PROJECT_NAME}}: {{DESCRIPTION}}

Stack: {{STACK}}.

## Commands

```bash
# build
# run tests
# run locally
```

## Architecture

Describe the main layers/modules and the key flows here.

## Data model notes

Describe the schema, migrations and conventions here.

## Production

- Platform: <Cloud Run | Vercel | other> — service name, region, project id (if any)
- Error tracking: Sentry — org `<org-slug>`, project `<project-slug>`, region EU
- Release identifier: git commit SHA
- Logs fallback: `<gcloud logging read ... | vercel logs ...>`

## devcrew

- At superpowers' final review, run the `devcrew:security-reviewer` agent on the change set.
- Log each change set in `{{CHANGELOG_FILE}}`, naming any secrets touched (names only, never values).
- Never commit secrets; use `.env` locally and keep `.env.example` names-only.
