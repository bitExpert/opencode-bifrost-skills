# ADR-0009: Resolve configuration with precedence, normalization, and secret handling

- **Status:** Superseded by ADR-0012
- **Amended:** 2026-11-16
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Gateways differ per environment. Users need sensible defaults, per-install settings,
environment-based configuration for CI/development, and one-off command overrides.

Base URLs may be pasted in varying forms.

## Decision

- **Precedence (highest → lowest):**
  1. Command/call overrides (passed by the TUI/RPC for a single invocation).
  2. Plugin storage (written by `/bifrost-config`).
  3. Plugin options (from the OpenCode `plugins` config).
  4. Environment variables (`BIFROST_URL`, `BIFROST_TIMEOUT_MS`).
  5. Defaults (`http://localhost:8080`, `20000` ms).
- **Persistence:**
  - Store mutable settings in plugin storage under a `settings` key:
    - `baseUrl` (string)
    - `timeoutMs` (number)
  - Support `--reset` to clear stored settings.
- **URL normalization:**
  - Trim input; infer `http://` when a scheme is missing.
  - Accept only `http:` and `https:`.
  - Reject URLs containing embedded credentials (use `baseUrl` instead).
  - Remove trailing slashes and strip a trailing `/api` segment so a pasted
    `https://host/api` does not produce `https://host/api/api`.
- **Reporting:**
  - `/bifrost-config` and the TUI display the effective settings with source attribution
    (`command`, `storage`, `options`, `environment`, `default`) and the global skills
    directory path.
  - `timeoutMs` must be greater than zero; invalid values are rejected.

## Consequences

- **Positive**
  - Flexible, transparent configuration with safe defaults.
  - No secret exposure in output and config files.
  - Tolerant of how users paste base URLs.
- **Negative**
  - Legacy management keys stored in plugin storage are automatically scrubbed on first read.
