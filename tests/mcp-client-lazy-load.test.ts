import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/mcp-client.ts', import.meta.url));

describe('mcp-client lazy loading of @modelcontextprotocol/sdk', () => {
	it('does not statically import @modelcontextprotocol/sdk at module top-level (ADR 2)', () => {
		const source = readFileSync(SRC, 'utf8');

		// A top-level static value import from the SDK would cause the SDK to load
		// before Ink's first paint, blowing the 200ms startup budget. `import type`
		// is erased and therefore allowed.
		const staticValueImport = /^\s*import\s+(?!type\b)[^\n]*from\s+['"]@modelcontextprotocol\/sdk/m;
		expect(source).not.toMatch(staticValueImport);

		// The dynamic import inside connect() must still be present — otherwise
		// this test would be vacuously true.
		expect(source).toMatch(/import\(['"]@modelcontextprotocol\/sdk/);
	});
});
