# ADR-0005: Use multi-source catalog fallback with catalog-independent installs

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Bifrost gateways vary in capabilities:

- The marketplace manifest may only be served when an external client URL is configured and
  `git` is available.
- The management skills API may require authentication and uses pagination.
- Public per-skill and all-skills zip routes are commonly available and sufficient for
  installing a known skill.

Catalog metadata (descriptions, versions) is useful for browsing but is not strictly required
to install. Partial failures (401/403/404/503, parsing issues, empty responses) should not
block core functionality.

## Decision

- Build the catalog by trying sources in order and returning the **first non-empty** result:
  1. **Marketplace manifest**
     `GET /api/skills/serve/claude-code/.claude-plugin/marketplace.json`
  2. **Management API**
     `GET /api/skills?limit=100&offset=…` (paginated, up to 50 pages)
  3. **All-skills bundle**
     `GET /api/skills/serve/all/download.zip` (metadata read from `SKILL.md` frontmatter)
- Collect non-fatal issues in `Catalog.warnings`; treat `unauthorized` (401/403) on the
  management API as a warning and fall back to the public bundle rather than failing.
- Deduplicate and sort catalog entries by name.
- **Installs are catalog-independent:**
  - A named install always uses the public per-skill route
    `GET /api/skills/serve/{skill}/download.zip`.
  - `/bifrost-install-all` prefers the all-skills bundle and falls back to the catalog plus
    per-skill downloads when the bundle is empty or unusable.
- If no catalog source is available, commands still allow `/bifrost-install <name>`; the
  download endpoint is authoritative.

## Consequences

- **Positive**
  - Works across heterogeneous gateway configurations and degraded states.
  - Users receive warnings instead of hard failures when richer catalog metadata is
    unavailable.
  - Core install capability remains available even when catalog endpoints are down.
- **Negative**
  - Metadata richness varies by source (versions and descriptions may be missing).
  - Probing multiple endpoints increases request volume and code complexity.
- **Notes**
  - The catalog `source` field (`marketplace`, `api`, `zip`) is surfaced in TUI titles and
    formatters so users can see which fallback was used.
