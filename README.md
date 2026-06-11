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

## License

[MIT](./LICENSE)
