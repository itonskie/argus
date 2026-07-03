# argus

A keyboard-first TUI for inspecting and exercising Model Context Protocol (MCP) servers.

Connect to any MCP server, browse its tools / resources / prompts, invoke them with auto-generated forms, and replay sessions — without leaving the terminal.

## Why

Building MCP servers today usually means hand-rolling JSON-RPC payloads to test them, or living inside Anthropic's web inspector. Neither is built for power users iterating fast. `argus` is the tool MCP developers actually want at their fingertips: instant connection, schema-driven forms, session replay, vim-style navigation.

The name comes from Argus Panoptes — the many-eyed watcher of Greek myth. Fitting for a tool whose job is to see everything an MCP server exposes.

## Status

🚧 **In design / pre-alpha.** Public repo is up so the design can iterate in the open. Implementation begins shortly.

## v1 Scope

- Connect over **stdio** and **SSE** transports
- List **tools**, **resources**, and **prompts** from any connected server
- **Invoke** any capability with an auto-generated form driven by its JSON Schema
- **Save & replay** invocation sessions
- Local-only state under `~/.argus/` (servers, sessions, history)

Deferred to later: OAuth flows, multi-server-at-once, eval suites.

## Stack

- **Node 20+ / TypeScript** (strict)
- **[Ink](https://github.com/vadimdemedes/ink)** — React for terminals
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)** — official MCP client SDK
- **ajv** — JSON Schema validation for dynamic forms
- **tsup** — bundling
- **Vitest** + **ink-testing-library** — tests
- **Biome** — lint + format
- **pnpm** — package manager (dev)

## Install (when v1 ships)

```bash
npx @itonskie/argus <path-to-server>
# or
npm i -g @itonskie/argus
argus
```

## Development

```bash
pnpm install
pnpm dev
pnpm test
```

(Once scaffolded.)

### Form-engine coverage

The `form-engine` module (`src/form-engine.ts`) converts a JSON Schema into a `FormSpec` and validates submissions with ajv. **Current coverage (Slice 6): top-level primitives only** — `string`, `number`, `boolean`, and `enum` properties on the root object schema.

Non-primitive shapes throw a `not implemented in Slice 6` error: nested `object`, `array`, `oneOf` / `anyOf`, `$ref`, and binary strings. Slice 8 (issue #9) completes the graceful ladder by rendering nested objects, arrays of primitives, and raw-JSON textareas per [ADR 5](./docs/adrs/5-graceful-ladder-form-fallback.md). The public interface (`schemaToForm`, `submit`) stays stable across the upgrade.

### Startup budget

argus targets **< 200ms** cold-start-to-first-paint. `@modelcontextprotocol/sdk` and `ajv` must be loaded via dynamic `import()` inside the modules that use them, never at file top-level. See [ADR 2](./docs/adrs/2-lazy-load-heavyweight-deps.md).

Run the check locally:

```bash
pnpm startup-budget
```

It builds the bundle, spawns `dist/argus.js` against the fixture five times, and reports the median wall-clock time from spawn to first byte on stdout. Exits 1 if median > 200ms. CI runs the same check on every PR.

Debugging a regression:

- Grep the entry (`src/argus.ts`) and any file it statically imports for top-level `import` of a heavyweight dep. Move it to a dynamic `import()` inside the function that needs it.
- Use `import type { X }` for any type-only imports of a lazy-loaded module — otherwise TypeScript's emit pulls it in at runtime.
- Anything that runs before Ink's first render belongs on a strict diet: argv parse, `statSync`, mount. That's it.

## License

[MIT](./LICENSE)
