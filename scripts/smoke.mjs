#!/usr/bin/env node
// Manual release-gate smoke test (engineering-spec §7.3).
//
// Boots argus against @modelcontextprotocol/server-filesystem in a throwaway
// temp dir with one sample file. The human then walks the golden path:
// list → invoke read_file → view result → q to quit. Records the outcome in
// issue #14's comments.
//
// Not run in CI — it's an interactive TUI session. `pnpm smoke` is the entry.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'dist/argus.js');
const SERVER_PKG = '@modelcontextprotocol/server-filesystem';

if (!existsSync(BIN)) {
	process.stderr.write(`smoke: ${BIN} missing — run \`pnpm build\` first\n`);
	process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), 'argus-smoke-'));
const sandbox = join(workDir, 'sandbox');
mkdirSync(sandbox);
writeFileSync(join(sandbox, 'hello.txt'), 'hello from argus smoke test\n');
writeFileSync(join(sandbox, 'notes.md'), '# smoke test notes\n\nedit me.\n');

process.stdout.write(`smoke: workdir  = ${workDir}\n`);
process.stdout.write(`smoke: sandbox  = ${sandbox}\n`);
process.stdout.write(`smoke: installing ${SERVER_PKG} …\n`);

const install = spawnSync(
	'npm',
	[
		'install',
		'--prefix',
		workDir,
		'--silent',
		'--no-save',
		'--no-fund',
		'--no-audit',
		`${SERVER_PKG}@latest`,
	],
	{ stdio: ['ignore', 'inherit', 'inherit'] },
);
if (install.status !== 0) {
	process.stderr.write(`smoke: npm install failed (status ${install.status})\n`);
	rmSync(workDir, { recursive: true, force: true });
	process.exit(1);
}

const serverPkgJsonPath = join(workDir, 'node_modules', SERVER_PKG, 'package.json');
if (!existsSync(serverPkgJsonPath)) {
	process.stderr.write(`smoke: ${serverPkgJsonPath} not found after install\n`);
	rmSync(workDir, { recursive: true, force: true });
	process.exit(1);
}
const serverPkg = JSON.parse(readFileSync(serverPkgJsonPath, 'utf8'));
const binField =
	typeof serverPkg.bin === 'string'
		? serverPkg.bin
		: Object.values(serverPkg.bin ?? {})[0];
const entryRel = binField ?? serverPkg.main;
if (!entryRel) {
	process.stderr.write(`smoke: ${SERVER_PKG} declares neither bin nor main\n`);
	rmSync(workDir, { recursive: true, force: true });
	process.exit(1);
}
const serverEntry = resolve(dirname(serverPkgJsonPath), entryRel);

// argus takes a single positional argument — the MCP server script — and does
// not forward extra CLI args to the server. The filesystem server expects an
// allowed-root path as argv[2]. Bridge the gap with a tiny launcher that
// injects the sandbox path before importing the server.
const launcher = join(workDir, 'launcher.mjs');
writeFileSync(
	launcher,
	`process.argv.push(${JSON.stringify(sandbox)});\nawait import(${JSON.stringify(serverEntry)});\n`,
);

process.stdout.write('smoke: launching argus …\n');
process.stdout.write('  ↑↓ to navigate  ·  Enter to invoke  ·  o to open in $PAGER  ·  q to quit\n\n');

const child = spawn(process.execPath, [BIN, launcher], {
	stdio: 'inherit',
	env: { ...process.env, ARGUS_SMOKE_WORKDIR: workDir },
});

const cleanup = () => {
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
};

child.on('exit', (code, signal) => {
	process.stdout.write(`\nsmoke: argus exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`);
	cleanup();
	process.exit(code ?? 0);
});

process.on('SIGINT', () => {
	child.kill('SIGINT');
});
