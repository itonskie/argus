import { readFileSync } from 'node:fs';
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

process.stdout.write(`argus v${pkg.version}\nusage: argus <path-to-mcp-server>\n`);
process.exit(0);
