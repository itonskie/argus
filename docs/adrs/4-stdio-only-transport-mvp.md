# ADR 4: stdio-only transport in MVP; defer SSE / HTTP

**Status:** Accepted
**Date:** 2026-07-03

## Context

The original README v1 scope included both stdio and SSE transports. Local MCP server development is overwhelmingly stdio — the SDK examples, the reference servers, and the vast majority of published community servers all default to stdio. SSE / HTTP are used mostly for hosted / networked deployments, which are a different class of user with different needs (auth, TLS, timeouts).

Supporting multiple transports doubles the connection lifecycle test surface and forces UX decisions we don't have data for yet (do users want a URL entry mode? auth prompts? proxy config?).

## Decision

MVP supports stdio only. Launch is `argus ./path/to/server-binary-or-script` — the path must resolve to an executable on the local filesystem. SSE / HTTP are deferred.

## Alternatives Considered

- **Ship stdio + SSE at MVP.** Rejected: doubles the connection-lifecycle test matrix and drags in UX decisions (URL entry, auth) we're not ready to make.
- **stdio + SSE stub (SSE code exists but disabled behind a flag).** Rejected: half-finished code rots. If a user reports "SSE half-works," we own that.
- **HTTP-only for MVP.** Rejected: doesn't fit the target audience (local dev iteration on their own servers, which are almost always stdio).

## Consequences

- `mcp-client.connect(path)` takes a single path argument. When SSE / HTTP land, the interface grows to `connect(target)` where `target` is a discriminated union — the internal wiring changes but callers migrate mechanically.
- The connection pane in the design spec only shows `transport: stdio`; when other transports arrive, that line becomes a proper display of transport + endpoint.
- Users who want to inspect an SSE / HTTP MCP server today have to keep using the web Inspector. Explicitly acceptable for MVP.
