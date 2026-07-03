import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpClient, type McpClient, type McpError } from '../src/mcp-client.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));
const HANG_FIXTURE = fileURLToPath(new URL('./fixtures/hang-init-server.mjs', import.meta.url));
const STUBBORN_FIXTURE = fileURLToPath(new URL('./fixtures/stubborn-server.mjs', import.meta.url));

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!pidAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !pidAlive(pid);
}

describe('mcp-client lifecycle', () => {
	let client: McpClient | undefined;

	afterEach(async () => {
		if (client) {
			try {
				await client.disconnect();
			} catch {
				// Some tests leave the client in a broken state — swallow.
			}
			client = undefined;
		}
	});

	it('rejects with a normalized error when connecting to a nonexistent path', async () => {
		client = createMcpClient();
		let caught: unknown;
		try {
			await client.connect('/definitely/not/a/real/binary/argus-nonexistent-xyz');
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(caught).not.toBeInstanceOf(Error); // must not surface raw Error/ENOENT
		expect((caught as McpError).kind).toBe('server-error');
		const message = (caught as { kind: 'server-error'; message: string }).message;
		expect(typeof message).toBe('string');
	});

	it('rejects with { kind: "timeout" } after ~5s when the server never responds to initialize', async () => {
		client = createMcpClient();
		let caught: unknown;
		const start = Date.now();
		try {
			await client.connect(HANG_FIXTURE);
		} catch (err) {
			caught = err;
		}
		const elapsed = Date.now() - start;
		expect(caught).toEqual({ kind: 'timeout' });
		expect(elapsed).toBeGreaterThanOrEqual(4_500);
		expect(elapsed).toBeLessThan(8_000);
	}, 15_000);

	it('fires onDisconnect once with { kind: "disconnected" } when the fixture is killed mid-session', async () => {
		client = createMcpClient();
		const info = await client.connect(FIXTURE_ENTRY);

		const events: McpError[] = [];
		client.onDisconnect((reason) => {
			events.push(reason);
		});

		process.kill(info.pid, 'SIGKILL');

		const start = Date.now();
		while (events.length === 0 && Date.now() - start < 3_000) {
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ kind: 'disconnected' });

		// Give it another beat and confirm no duplicate fires.
		await new Promise((r) => setTimeout(r, 100));
		expect(events).toHaveLength(1);
	});

	it('disconnect() escalates the shutdown ladder and eventually kills a stubborn server', async () => {
		client = createMcpClient();
		const info = await client.connect(STUBBORN_FIXTURE);
		expect(pidAlive(info.pid)).toBe(true);

		const start = Date.now();
		await client.disconnect();
		const elapsed = Date.now() - start;

		expect(await waitForExit(info.pid, 500)).toBe(true);
		expect(elapsed).toBeLessThan(6_000);
		client = undefined;
	}, 15_000);

	it('disconnect() on a well-behaved fixture leaves no orphan pid', async () => {
		client = createMcpClient();
		const info = await client.connect(FIXTURE_ENTRY);
		await client.disconnect();
		expect(await waitForExit(info.pid, 3_000)).toBe(true);
		client = undefined;
	});
});
