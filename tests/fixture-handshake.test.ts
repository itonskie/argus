import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

type JsonRpcResponse = {
	jsonrpc: '2.0';
	id: number | string;
	result?: { protocolVersion?: string; capabilities?: unknown; serverInfo?: unknown };
	error?: { code: number; message: string };
};

function spawnFixture(): ChildProcessWithoutNullStreams {
	return spawn(process.execPath, [FIXTURE_ENTRY], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}

function sendJsonRpc(child: ChildProcessWithoutNullStreams, obj: unknown): void {
	child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function readFirstMessage(child: ChildProcessWithoutNullStreams): Promise<JsonRpcResponse> {
	return new Promise((resolveMsg, rejectMsg) => {
		const stderrChunks: string[] = [];
		child.stderr.on('data', (chunk: Buffer) => {
			stderrChunks.push(chunk.toString('utf8'));
		});
		const rl = createInterface({ input: child.stdout });
		rl.once('line', (line: string) => {
			rl.close();
			try {
				resolveMsg(JSON.parse(line) as JsonRpcResponse);
			} catch (err) {
				const cause = err instanceof Error ? err.message : String(err);
				rejectMsg(new Error(`invalid JSON from fixture: ${cause}\nline: ${line}`));
			}
		});
		child.once('exit', (code, signal) => {
			rl.close();
			rejectMsg(
				new Error(
					`fixture exited before responding (code=${code}, signal=${signal}). stderr:\n${stderrChunks.join('')}`,
				),
			);
		});
		child.once('error', (err) => {
			rl.close();
			rejectMsg(err);
		});
	});
}

async function killChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	child.kill('SIGTERM');
	await new Promise<void>((resolveKill) => {
		const done = () => resolveKill();
		child.once('exit', done);
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
			resolveKill();
		}, 1_000).unref();
	});
}

describe('test-server-fixture handshake', () => {
	let child: ChildProcessWithoutNullStreams | undefined;

	afterEach(async () => {
		if (child) {
			await killChild(child);
			child = undefined;
		}
	});

	it('responds to a JSON-RPC initialize request with a valid initialize result', async () => {
		child = spawnFixture();

		const initializeRequest = {
			jsonrpc: '2.0' as const,
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'argus-fixture-handshake-test', version: '0.0.0' },
			},
		};

		sendJsonRpc(child, initializeRequest);
		const response = await readFirstMessage(child);

		expect(response.jsonrpc).toBe('2.0');
		expect(response.id).toBe(1);
		expect(response.error).toBeUndefined();
		expect(response.result).toBeDefined();
		expect(typeof response.result?.protocolVersion).toBe('string');
		expect((response.result?.protocolVersion ?? '').length).toBeGreaterThan(0);
	});
});
