import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8')) as {
	version: string;
};

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
	process.stdout.write(`argus v${pkg.version}\n`);
	process.exit(0);
}

if (args.length === 0) {
	process.stderr.write(`argus v${pkg.version}\nusage: argus <path-to-mcp-server>\n`);
	process.exit(1);
}

const targetPath = args[0] as string;

try {
	statSync(targetPath);
} catch {
	process.stderr.write(`path not found: ${targetPath}\n`);
	process.exit(1);
}

const [{ render }, appShellMod, ReactMod] = await Promise.all([
	import('ink'),
	import('./app-shell.js'),
	import('react'),
]);

const { App } = appShellMod;
const React = ReactMod.default ?? ReactMod;

render(React.createElement(App, { path: targetPath }), { exitOnCtrlC: false });
