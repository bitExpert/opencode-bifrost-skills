# ADR-0006: Validate archives and enforce bounded downloads

- **Status:** Proposed (implemented)
- **Date:** 2026-11-16
- **Deciders:** Maintainers of `@bitexpert/opencode-bifrost-skills`

## Context

Skill archives are untrusted network input and are unpacked to disk. The main risks are
path traversal (zip-slip), resource exhaustion (large or numerous entries), stalled
downloads, and corrupt or malformed archives.

The plugin must therefore validate archives and downloads before and during processing, and
must fail with clear, typed errors.

## Decision

- Decode ZIP archives using `fflate` and enforce hard limits:
  - **64 MiB** maximum archive/download body size.
  - **2,000** maximum entries.
  - **8 MiB** maximum size per file.
  - **64 MiB** maximum total uncompressed size.
- Validate entry names with `normalizeEntryName()`:
  - Reject NUL bytes.
  - Reject absolute paths and drive-letter prefixes.
  - Reject `..` traversal segments.
  - Normalize backslashes to forward slashes and strip empty segments.
  - Ignore directory entries.
- Download response bodies with streaming:
  - Apply the request timeout to both header retrieval and body reading.
  - Keep a running byte total and abort when it exceeds the 64 MiB cap.
  - Honor caller-provided `AbortSignal`s for cancellation.
- Require a `SKILL.md` file in a package; fail as `corrupt` when it is missing.
- Parse `SKILL.md` frontmatter leniently: invalid YAML is treated as no frontmatter, and the
  file still installs.
- Use typed errors with stable codes (`BifrostError` and `ZipError`) such as `network`,
  `timeout`, `cancelled`, `unauthorized`, `not-found`, `unavailable`, `http`, `corrupt`,
  `unsafe-path`, `too-large`, `too-many-files`, so UI and formatters can report consistent
  messages.

## Consequences

- **Positive**
  - Strong defense-in-depth against common zip-slip and DoS vectors.
  - Predictable failure modes with user-friendly error messages.
  - Stalled or oversized downloads cannot hang the command or exhaust memory before the caps
    apply.
- **Negative**
  - Legitimately large or unusually structured skills are rejected.
  - Some ZIP metadata (for example Unix permission bits) is not trusted or exposed; executable
    bits are derived from content (see ADR-0007).
- **Tradeoff**
  - Lenient frontmatter parsing favors availability over strict metadata correctness.
