# ADR 6: Test against an in-repo MCP server fixture, not real published servers

**Status:** Accepted
**Date:** 2026-07-03

## Context

argus needs strong test coverage of the connect / list / invoke / disconnect lifecycle and the graceful-ladder form logic ([ADR 5](5-graceful-ladder-form-fallback.md)). Two options for the "server" side of those tests:

1. Use real published MCP servers (`@modelcontextprotocol/server-filesystem`, etc.) as counterparties in CI.
2. Ship an in-repo test-server fixture that exposes exactly the schema shapes we need to cover.

## Decision

Ship an in-repo `test-server-fixture` — a small MCP server that exposes tools / resources / prompts covering every supported schema shape (primitives, nested objects, arrays of primitives) and one of each fallback case (array of objects, `oneOf`, `$ref`, binary). It's the counterparty for both `form-engine` schema tests and `mcp-client` lifecycle tests.

Real servers get a **manual smoke test before each release**: run argus against `@modelcontextprotocol/server-filesystem`, do a list → invoke → view cycle, record in the release PR.

## Alternatives Considered

- **Real servers in CI.** Rejected: network dependency (some servers hit external APIs), moving targets (schemas change without our knowledge), flakiness (CI failures unrelated to argus). The grill session explicitly rejected this.
- **Recorded fixtures (VCR-style).** Rejected: MCP is bidirectional over stdio; recording / replaying JSON-RPC traffic is possible but adds a serialization layer we don't need. The in-repo server can be as fast as a recording without the format overhead.
- **Mock the SDK entirely.** Rejected: the SDK is what we're integrating with. Mocking it defeats the point of testing `mcp-client`.

## Consequences

- The fixture is a real MCP server in the same repo. It gets built alongside argus and runs as a child process during tests, exactly like a user's server would.
- Adding coverage for a new schema shape means adding a tool to the fixture — the same test file that adds the coverage adds the input.
- We commit to keeping the fixture in sync with the ladder rules ([ADR 5](5-graceful-ladder-form-fallback.md)) — if a fallback case gets upgraded to native rendering, the fixture stays but a new fallback case takes its place.
- Real-server drift (a real server changes its schema and argus regresses on it) is caught by the pre-release manual smoke test, not by CI. This is a deliberate cost: CI stays reliable, releases stay a little more manual.
