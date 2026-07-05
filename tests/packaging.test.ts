import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

type Outcome = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

function run(cmd: string, args: string[], cwd: string): Promise<Outcome> {
	return new Promise((resolveOutcome, rejectOutcome) => {
		const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		const outChunks: string[] = [];
		const errChunks: string[] = [];
		child.stdout?.on('data', (b: Buffer) => outChunks.push(b.toString('utf8')));
		child.stderr?.on('data', (b: Buffer) => errChunks.push(b.toString('utf8')));
		child.once('error', rejectOutcome);
		child.once('exit', (code, signal) => {
			resolveOutcome({
				code,
				signal,
				stdout: outChunks.join(''),
				stderr: errChunks.join(''),
			});
		});
	});
}

describe('packaging: shipped tarball is zero-dep and self-contained', () => {
	let workDir: string;
	let tarball: string;

	beforeAll(async () => {
		workDir = mkdtempSync(join(tmpdir(), 'argus-pack-'));

		const packed = await run('pnpm', ['pack', '--pack-destination', workDir], REPO_ROOT);
		if (packed.code !== 0) {
			throw new Error(`pnpm pack failed:\n${packed.stderr}`);
		}
		const tarballs = readdirSync(workDir).filter((f) => f.endsWith('.tgz'));
		if (tarballs.length !== 1) {
			throw new Error(`expected exactly one tarball, got: ${tarballs.join(', ')}`);
		}
		tarball = join(workDir, tarballs[0]);

		const extracted = await run('tar', ['-xzf', tarball], workDir);
		if (extracted.code !== 0) {
			throw new Error(`tar extract failed:\n${extracted.stderr}`);
		}
	}, 60_000);

	afterAll(() => {
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it('the shipped package.json declares no runtime dependencies', async () => {
		const cat = await run('cat', ['package/package.json'], workDir);
		expect(cat.code).toBe(0);
		const shipped = JSON.parse(cat.stdout) as { dependencies?: Record<string, string> };
		expect(shipped.dependencies ?? {}).toEqual({});
	});

	it('dist/argus.js runs standalone with only Node — no node_modules present', async () => {
		const outcome = await run(process.execPath, ['package/dist/argus.js', '--version'], workDir);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toMatch(/^argus v\d+\.\d+\.\d+/);
	}, 15_000);
});
