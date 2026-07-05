# argus

A keyboard-first TUI for inspecting and exercising Model Context Protocol (MCP) servers over stdio.

Point argus at any MCP server, browse its tools / resources / prompts, and invoke them with auto-generated forms — without leaving the terminal.

## Why

Building MCP servers today usually means hand-rolling JSON-RPC payloads to test them, or living inside Anthropic's web inspector. Neither is built for power users iterating fast. `argus` is the tool MCP developers actually want at their fingertips: instant connection, schema-driven forms, vim-style navigation.

The name comes from Argus Panoptes — the many-eyed watcher of Greek myth. Fitting for a tool whose job is to see everything an MCP server exposes.

## Status

🚧 **MVP feature-complete, pre-release.** All implementation tickets under [PRD #1](https://github.com/itonskie/argus/issues/1) are landed on `prd-1-argus-mvp`. Release cutting shortly.

## MVP scope

- Connect to any MCP server over **stdio** (SSE/HTTP transports are post-MVP — see [ADR 4](./docs/adrs/4-stdio-only-transport-mvp.md))
- List **tools**, **resources**, and **prompts** from the connected server
- **Invoke** any tool with an auto-generated form driven by its JSON Schema (graceful ladder from primitive fields to raw-JSON textarea — see [ADR 5](./docs/adrs/5-graceful-ladder-form-fallback.md))
- Open large responses in `$PAGER`
- Zero on-disk state — see [ADR 3](./docs/adrs/3-zero-disk-state-mvp.md)

Deferred to later: SSE / HTTP transports, save-and-replay sessions, OAuth flows, multi-server-at-once, eval suites.

## Stack

- **Node 20+ / TypeScript** (strict)
- **[Ink](https://github.com/vadimdemedes/ink)** — React for terminals
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)** — official MCP client SDK
- **ajv** — JSON Schema validation for dynamic forms
- **tsup** — bundling
- **Vitest** + **ink-testing-library** — tests
- **Biome** — lint + format
- **pnpm** — package manager (dev)

## Install

Requires **Node 20+**. Once the first release is published:

```bash
# One-shot — fetches, runs, discards.
npx @itonskie/argus <path-to-mcp-server-script>

# Or install globally.
npm i -g @itonskie/argus
argus <path-to-mcp-server-script>
```

`<path-to-mcp-server-script>` is a JavaScript entry point (`.js` / `.mjs` / `.cjs`) or an executable that speaks MCP over stdio. argus stats the path, spawns the server as a child process, and connects over stdio.

## Development

```bash
pnpm install       # first-time setup
pnpm build         # bundle dist/argus.js + dist/test-server-fixture.js
pnpm test          # build + full Vitest suite
pnpm typecheck     # tsc --noEmit
pnpm lint          # biome check
pnpm startup-budget  # cold-start-to-first-paint (target <200ms)
pnpm smoke         # boot argus against @modelcontextprotocol/server-filesystem
```

### Manual smoke test

`pnpm smoke` is the release gate (engineering-spec §7.3). It installs `@modelcontextprotocol/server-filesystem` into a throwaway temp dir, seeds two sample files, and launches argus wired to it. Walk the golden path: highlight `read_file` → Enter → type `hello.txt` → submit → response renders → `q` exits cleanly. The temp dir is deleted on exit.

### Terminal-size + accessibility modes

argus supports three environment overrides for a11y and terminal compat (design-spec §1, §2.3, §6):

```bash
# Force ASCII borders + spinner (| / - \) — no Unicode required.
ARGUS_ASCII=1 argus <path>

# Drop all color; focus indicator falls back to a bold Unicode border.
NO_COLOR=1 argus <path>

# Static "…" spinner instead of the braille dot rotation.
PREFERS_REDUCED_MOTION=1 argus <path>
```

Below 80×24 argus swaps the three-pane layout for a single-line
`argus requires 80×24 terminal — current: NxN` message. Resize the terminal
back up and the layout returns automatically — focus and selection are
preserved across the resize.

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

### Release

Cutting a release publishes `@itonskie/argus` to the npm registry.

1. Bump `version` in `package.json` (e.g. `0.1.0`).
2. Commit and push.
3. Tag the commit `vX.Y.Z` and push the tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. `.github/workflows/publish.yml` runs on the `v*` tag: full CI on Node 20 + 22, then `pnpm publish --access public` using the `NPM_TOKEN` repo secret. The workflow refuses to publish if the tag version and `package.json` version disagree.

The shipped tarball is a **single-file, zero-runtime-dep bundle** — tsup inlines `@modelcontextprotocol/sdk`, `ajv`, `ink`, `react`, and everything else. Users only need Node 20+. See engineering-spec §8 and `tests/packaging.test.ts` for the guarantee.

## License

[MIT](./LICENSE)
