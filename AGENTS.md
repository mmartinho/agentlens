# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the CLI locally
node cli.js
node cli.js /path/to/repo
node cli.js --path . --path ../other-repo
node cli.js --stdout   # print JSON to stdout
node cli.js --version

# Tests (node:test, no framework)
npm test
node --test test/core.test.js                       # single file
node --test --test-name-pattern="parseReferences" test/*.test.js   # single test

# HTTP API + SQLite history (port 3000, or PORT=...)
npm run server

# Test the npm-published version locally
npm exec --yes --force --package . agentlens -- --version

# Install globally for local development
npm link
agentlens --version
```

`test/api.test.js` exercises `server.js` (needs `better-sqlite3`, the only dependency; DB path via `AGENTLENS_DB`). Also smoke-test changes by running `node cli.js` on this repo itself.

## Architecture

The CLI and core are dependency-free; only the optional history server uses `better-sqlite3`. Four files do real work:

**`agentlens-core.js`** — Universal UMD module. Runs in both Node.js (`require()`) and the browser (`window.AgentLensCore`). Contains:
- `AGENT_TOOLS` registry: the 7 supported tools and which files each uses
- `PRICING` table: token costs per model across 20+ LLMs
- `HEALTH_LIMITS`: per-tool ideal/warn/max token thresholds
- `parseReferences(content)`: extracts file references from `@import`, `!include`, markdown links, and inline code paths
- `analyzeLocalRepo(localPath, name)`: Node.js-only function that walks the filesystem (skips `SKIP_DIRS`, files over 512KB are truncated, `.gitignore`d references are filtered out), finds agent config files, resolves all referenced files, deduplicates them, counts tokens, and returns a structured result object
- `analyzeGitHubRepo(owner, repo, token)`: browser-only function that does the same via the GitHub API

**`cli.js`** — CLI entry point. Parses args, loads `.agentlens.json` config, calls `analyzeLocalRepo`, builds a report data object, writes two sibling output files: `agentlens-report.html` and `agentlens-report.json`.

**`server.js` + `db.js`** — Optional HTTP API (`POST /analyze`, `GET/DELETE /history[/:id]`) that runs `analyzeLocalRepo` and persists results as JSON in SQLite (`agentlens-history.db` in cwd). User-facing messages/errors are in Portuguese.

**`agentlens.html`** — The complete web app and HTML report viewer in a single self-contained file. When the CLI generates a report, it injects a bootstrap `<script>` tag into a copy of this template pointing to the sibling JSON file. The viewer also supports loading public GitHub repos live via the GitHub API, the Compare tab for multi-repo comparison, and an English/Portuguese language toggle.

### Report data flow

```
analyzeLocalRepo() → result object
  → buildReportData() → reportData (agentlens-report.json)
  → inject bootstrap tag into agentlens.html → agentlens-report.html
```

The HTML viewer reads the sibling JSON on load, then renders everything client-side.

### Config resolution priority in CLI

1. `--path` flags (skips config file)
2. `.agentlens.json` in current directory (or `--config` path)
3. Default: scan current directory
