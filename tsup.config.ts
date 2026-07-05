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
	// Bundled CJS deps use `require()` at runtime (e.g. React's cjs modules
	// pulling in `assert`, the MCP SDK's ajv path). Preload createRequire so
	// esbuild's dynamic-require calls resolve against Node's real module loader
	// instead of hitting the "Dynamic require of X is not supported" shim.
	banner: {
		js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
	},
	// Ship a truly standalone binary: inline every runtime dep so the published
	// package.json declares zero `dependencies` and users only need Node 20+
	// (engineering-spec §8).
	noExternal: [/.*/],
	// Force React onto its production bundle so its dev-only branches (which do
	// `require('assert')` and similar Node built-in requires) are dead-code
	// eliminated — otherwise those calls hit esbuild's dynamic-require shim at
	// runtime and blow up as "Dynamic require of X is not supported".
	define: {
		'process.env.NODE_ENV': '"production"',
	},
	// Ink statically imports `react-devtools-core` inside its devtools module,
	// but only calls into it when `process.env.DEV === 'true'` — dev-only opt-in.
	// Node still tries to resolve the top-level import at bundle-load time, so
	// replace it with a no-op shim during bundling. The runtime never touches
	// the shim (DEV is unset in production), and users don't need the package.
	esbuildPlugins: [
		{
			name: 'stub-react-devtools-core',
			setup(build) {
				build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
					path: 'react-devtools-core',
					namespace: 'stub',
				}));
				build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
					contents: 'export default { initialize(){}, connectToDevTools(){} };',
					loader: 'js',
				}));
			},
		},
	],
});
