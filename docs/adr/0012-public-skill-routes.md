# ADR-0012: Use only public skill routes; no management credentials

- **Status:** Proposed
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

The Bifrost gateway exposes two credential planes:

- **Inference** (`/v1/*`, `/openai/*`, `/anthropic/*`, …) — uses virtual keys (`sk-bf-…`) or
  provider keys. This is what users typically have in their `BIFROST_API_KEY` environment
  variable.
- **Management** (`/api/*`) — the dashboard/control plane: config, providers, virtual keys,
  teams/budgets, MCP servers, plugins, logs, governance, and the Skills Repository CRUD. Per
  Bifrost's docs it accepts a **management API key**, a **dashboard session token**, or
  **admin Basic auth** — and explicitly **not** virtual keys or `x-api-key`.

The plugin previously used the management API (`GET /api/skills`) as a catalog source to
obtain names, descriptions, versions and pagination. This required users to provide a
management key, which they would not do for a CLI feature that should work without dashboard
access.

## Decision

- **Remove all management API integration.** Only the public routes are used:
  - `GET /api/skills/serve/claude-code/.claude-plugin/marketplace.json` (optional, per-skill
    metadata with versions)
  - `GET /api/skills/serve/all/download.zip` (public, names and versions from `SKILL.md`)
  - `GET /api/skills/serve/{skill}/download.zip` (public, per-skill install)
- **Remove credentials handling entirely.** No `apiKey`, no `BIFROST_API_KEY`, no secret
  storage, no masking, no auth headers.
- **Legacy key scrub.** When reading plugin storage, any `apiKey` property is silently
  removed to avoid accumulation.
- **Tombstone for old commands.** `/bifrost-config` still parses `apiKey`, `--api-key`,
  `clearApiKey`, etc. as options, but fails with a clear message if any is present.

## Consequences

- **Positive**
  - No dashboard credentials required for any operation.
  - No credentials in plugin storage, environment variables, config files or logs.
  - Aligns with Bifrost's design: the public download routes exist so CLI agents can fetch
    skills without carrying dashboard credentials.
  - Eliminates the confusing 401/403 errors users encountered when their virtual key was
    rejected on management endpoints.
- **Negative**
  - Loss of server-side pagination (handled adequately client-side for normal sizes).
  - Loss of visibility into skills that exist in the repository but aren't served (which
    users generally can't install anyway).
- **Migration**
  - Users with `BIFROST_API_KEY` set can leave it; it simply becomes unused.
  - Plugin options that contain `apiKey` can be removed.
  - Legacy keys in plugin storage are automatically scrubbed on first read.

## Notes

- The plugin continues to provide the full feature set: catalog browsing, install,
  install-all, list, update, remove and config. The only difference is that no management
  credential is needed or accepted.
- This is a breaking change for any users who relied on the management API for catalog
  enrichment, but those cases are rare (the public bundle already provides names and
  descriptions).