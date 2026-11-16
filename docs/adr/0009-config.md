# ADR-0009: Resolve configuration with precedence, normalization, and secret handling

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Gateways differ per environment. Users need sensible defaults, per-install settings,
environment-based configuration for CI/development, and one-off command overrides.

Base URLs may be pasted in varying forms, and credentials must not leak into logs, output, or
non-secret configuration files.

## Decision

- **Precedence (highest → lowest):**
  1. Command/call overrides (passed by the TUI/RPC for a single invocation).
  2. Plugin storage (written by `/bifrost-config`).
  3. Plugin options (from the OpenCode `plugins` config).
  4. Environment variables (`BIFROST_URL`, `BIFROST_API_KEY`, `BIFROST_TIMEOUT_MS`).
  5. Defaults (`http://localhost:8080`, `20000` ms).
- **Persistence:**
  - Store mutable settings in plugin storage under a `settings` key:
    - `baseUrl` (string)
    - `apiKey` (string or cleared)
    - `timeoutMs` (number)
  - Support `--reset` to clear stored settings and `--clear-api-key` to remove only the key.
- **URL normalization:**
  - Trim input; infer `http://` when a scheme is missing.
  - Accept only `http:` and `https:`.
  - Reject URLs containing embedded credentials (use `apiKey` instead).
  - Remove trailing slashes and strip a trailing `/api` segment so a pasted
    `https://host/api` does not produce `https://host/api/api`.
- **Secrets:**
  - Mask API keys in summaries and output (`****` or `prefix…suffix` hint).
  - Never write API keys back to OpenCode's configuration.
  - Send authentication using both `x-bf-vk` and `Authorization: Bearer` headers for
    gateway compatibility.
- **Reporting:**
  - `/bifrost-config` and the TUI display the effective settings with source attribution
    (`command`, `storage`, `options`, `environment`, `default`, `none`) and the global skills
    directory path.
  - `timeoutMs` must be greater than zero; invalid values are rejected.

## Consequences

- **Positive**
  - Flexible, transparent configuration with safe defaults.
  - Reduced secret exposure in output and config files.
  - Tolerant of how users paste base URLs.
- **Negative**
  - Storing secrets in plugin storage relies on that storage's protection model; operators must
    secure the host and OpenCode config directory.
  - Dual auth header sending exists for compatibility and may be unnecessary for some gateways.
