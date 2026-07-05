import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../dist/argus.js', import.meta.url));

type Outcome = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

function runBin(args: string[]): Promise<Outcome> {
	return new Promise((resolveOutcome, rejectOutcome) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		child.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b.toString('utf8')));
		child.stderr?.on('data', (b: Buffer) => stderrChunks.push(b.toString('utf8')));
		child.once('error', rejectOutcome);
		child.once('exit', (code, signal) => {
			resolveOutcome({
				code,
				signal,
				stdout: stdoutChunks.join(''),
				stderr: stderrChunks.join(''),
			});
		});
	});
}

describe('argus bin argv parsing', () => {
	it('bare argus prints usage to stderr and exits 1', async () => {
		const outcome = await runBin([]);
		expect(outcome.code).toBe(1);
		expect(outcome.stderr).toMatch(/usage:\s*argus\s+<path-to-mcp-server>/);
		expect(outcome.stdout).toBe('');
	});

	it('nonexistent path prints "path not found: <path>" to stderr and exits 1', async () => {
		const bogus = '/definitely/not/a/real/path/argus-nonexistent-xyz.js';
		const outcome = await runBin([bogus]);
		expect(outcome.code).toBe(1);
		expect(outcome.stderr).toContain(`path not found: ${bogus}`);
		expect(outcome.stdout).toBe('');
	});

	it('--version prints the version to stdout and exits 0', async () => {
		const outcome = await runBin(['--version']);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toMatch(/^argus v\d+\.\d+\.\d+/);
	});
});
