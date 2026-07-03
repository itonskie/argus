#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const TARGET_MS = 200;
const SAMPLES = 5;
const RUN_TIMEOUT_MS = 10_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BIN = resolve(ROOT, 'dist/argus.js');
const FIXTURE = resolve(ROOT, 'dist/test-server-fixture.js');

for (const [label, path] of [
	['bundle', BIN],
	['fixture', FIXTURE],
]) {
	if (!existsSync(path)) {
		process.stderr.write(`startup-budget: ${label} not found at ${path} — run \`pnpm build\` first\n`);
		process.exit(2);
	}
}

function measureOnce() {
	return new Promise((resolvePromise, rejectPromise) => {
		const start = performance.now();
		const child = spawn(process.execPath, [BIN, FIXTURE], {
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill('SIGKILL');
			rejectPromise(new Error(`no stdout within ${RUN_TIMEOUT_MS}ms`));
		}, RUN_TIMEOUT_MS);

		child.stdout.once('data', () => {
			if (settled) return;
			settled = true;
			const elapsed = performance.now() - start;
			clearTimeout(timer);
			child.kill('SIGTERM');
			resolvePromise(elapsed);
		});

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectPromise(err);
		});

		child.on('exit', (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectPromise(
				new Error(`process exited before first stdout (code=${code}, signal=${signal})`),
			);
		});
	});
}

const samples = [];
for (let i = 0; i < SAMPLES; i++) {
	const t = await measureOnce();
	samples.push(t);
}

const sorted = [...samples].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];

const rendered = samples.map((s) => `${s.toFixed(1)}ms`).join(', ');
process.stdout.write(`samples: ${rendered}\n`);
process.stdout.write(
	`startup budget: median ${Math.round(median)}ms / target ${TARGET_MS}ms\n`,
);

if (median > TARGET_MS) {
	process.stdout.write(
		`FAIL: median exceeds budget by ${Math.round(median - TARGET_MS)}ms\n`,
	);
	process.exit(1);
}

process.exit(0);
