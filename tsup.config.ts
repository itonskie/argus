import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		argus: 'src/argus.ts',
		'test-server-fixture': 'src/test-server-fixture.ts',
	},
	format: ['esm'],
	target: 'node20',
	platform: 'node',
	minify: true,
	clean: true,
	splitting: false,
	bundle: true,
	sourcemap: false,
	outExtension: () => ({ js: '.js' }),
	banner: { js: '#!/usr/bin/env node' },
	// The MCP SDK statically imports `ajv` inside its ESM output; tsup's default
	// externalized-dep shim uses CJS `require`, which is undefined in our ESM
	// bundle and throws at runtime. `shims: true` prepends a `createRequire` so
	// externalized deps (ajv, ajv-formats) resolve via node's real resolver.
	shims: true,
});
