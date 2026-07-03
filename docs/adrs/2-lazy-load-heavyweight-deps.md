# ADR 2: Lazy-load `@modelcontextprotocol/sdk` and `ajv`; bundle with tsup

**Status:** Accepted
**Date:** 2026-07-03

## Context

argus targets cold-start-to-first-paint under 200ms so the vim / tmux crowd doesn't reach for the browser tab instead. Ink itself is heavy — pulling in React reconciliation on cold start already spends most of the budget. Adding `@modelcontextprotocol/sdk` (and its transitive deps) and `ajv` at module top-level pushes cold start well past 200ms in measurement.

Neither of those two deps is needed to render the initial "connecting…" frame. The MCP SDK is only used inside `mcp-client.connect()`; ajv is only used inside `form-engine.submit()` and on first `schemaToForm()` call.

## Decision

- Import `@modelcontextprotocol/sdk` and `ajv` via dynamic `import()` inside the module functions that use them, not at file top-level.
- The main entry parses argv, mounts Ink with a "connecting…" state, then triggers the SDK import. First paint precedes the SDK load.
- Bundle with tsup into a single-file minified ESM output. Single-file bundling avoids per-file module resolution cost at startup.
- Add a CI job `startup-budget` that measures cold-start-to-first-paint on the bundled entry and fails at > 200ms. Regressions get caught in the PR, not in the wild.

## Alternatives Considered

- **Top-level imports everywhere.** Rejected: measurement shows > 200ms cold start.
- **Preload SDK in a worker thread.** Rejected for MVP: adds complexity, marginal win over lazy import when the user's first meaningful action (browsing capabilities) already depends on the SDK anyway.
- **Drop Ink to save its startup cost.** Rejected — see [ADR 1](1-ink-over-imperative-tui.md).
- **No startup budget enforcement.** Rejected: without CI enforcement, a stray top-level import silently regresses the property that justifies the whole approach.

## Consequences

- Any new heavyweight dep needs the same treatment. Codified in the engineering spec and enforced by the startup-budget CI job.
- Lazy imports slightly complicate error handling — an import failure surfaces at first-use, not at boot. Handled by the mcp-client and form-engine returning typed errors.
- Module boundaries have to keep the lazy-loaded deps out of top-level type imports too — otherwise TypeScript's emit pulls them in. Use `import type` for anything that would otherwise leak.
