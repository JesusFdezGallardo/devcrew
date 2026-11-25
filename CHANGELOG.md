# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Portfolio README: install commands, component guide, configuration, validation flow and sanitized illustrative reports.
- `devcrew:ship` skill and `scripts/ship-check.mjs`: pre-push validation of secret-like files, `CLAUDE.md`, changelog and declared npm scripts, with masked output and `--json` for CI.
- `init-project` now asks new projects to run `devcrew:ship` before committing or pushing.
- `devcrew:mcp-check` skill and `scripts/mcp-check.mjs`: headless MCP health check (stdio `initialize` + `tools/list` handshake for local servers, HTTP probe for remote ones) with MCP Inspector guidance for interactive debugging.
- `npm run check` and `npm run mcp-check` scripts.
- GitHub Actions CI on Node 20 and 22: unit tests, pre-push gate, MCP connections and best-effort plugin validation; CI badge in the README.
