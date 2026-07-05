# ADR 1: Use Ink (React for terminals) over an imperative TUI library

**Status:** Accepted
**Date:** 2026-07-03

## Context

argus's core interaction is a dynamic, schema-driven form. Form state, field-level focus, per-field validation errors, conditional fallback rendering (raw-JSON textarea for one field but not others), and mode-switching in the right pane (Preview / Form / Result) all need to update independently in response to user input.

Terminal UIs can be built either declaratively (Ink, React-style component tree with reconciliation) or imperatively (blessed / neo-blessed / raw ANSI, direct control over the screen buffer). The imperative route has lower runtime overhead — no virtual DOM, no reconciliation — which matters given the sub-200ms cold-start target.

## Decision

Use Ink. The form engine drives this choice: React's declarative model makes per-field state and conditional rendering tractable in a way that imperative TUI code notoriously isn't.

The startup-latency concern is real but addressable at the packaging layer, not by dropping Ink. See [ADR 2](2-lazy-load-heavyweight-deps.md).

## Alternatives Considered

- **blessed / neo-blessed** — mature imperative TUI. Rejected: form-state management would be manual and error-prone; the graceful-ladder logic (see [ADR 5](5-graceful-ladder-form-fallback.md)) would double the code volume.
- **Raw ANSI escapes + manual redraw** — lowest overhead, highest control. Rejected: same reason as blessed, more so. Undifferentiated infrastructure work.
- **A web UI in Electron** — trivially rejected: the entire point of argus is to stay in the terminal.

## Consequences

- Startup cost of loading React + Ink is non-trivial. Mitigated by lazy-loading everything else so the first-paint budget stays under 200ms — see [ADR 2](2-lazy-load-heavyweight-deps.md).
- Ink's ecosystem (ink-testing-library, ink-select-input, etc.) gives us tested primitives.
- If Ink is later abandoned or a serious perf ceiling appears, migrating the form engine to another framework is bounded — `form-engine` is a deep module with a stable interface (`schemaToForm`, `submit`) that doesn't depend on Ink at all. Only `app-shell` and `result-view` would need to move.
