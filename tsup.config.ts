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
});
