import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/form-engine.ts', import.meta.url));

describe('form-engine lazy loading of ajv (ADR 2)', () => {
	it('does not statically import ajv at module top-level', () => {
		const source = readFileSync(SRC, 'utf8');

		// A top-level static value import of ajv would pull it into the cold-start
		// path before Ink's first paint, blowing the 200ms startup budget.
		// `import type` is erased and therefore allowed.
		const staticValueImport = /^\s*import\s+(?!type\b)[^\n]*from\s+['"]ajv/m;
		expect(source).not.toMatch(staticValueImport);

		// The dynamic import inside submit() must be present — otherwise this test
		// would be vacuously true.
		expect(source).toMatch(/import\(['"]ajv/);
	});
});
