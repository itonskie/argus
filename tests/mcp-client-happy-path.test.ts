import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpClient, type McpClient } from '../src/mcp-client.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

function isAlive(pid: number): boolean {
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
		if (!isAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !isAlive(pid);
}

describe('mcp-client happy path', () => {
	let client: McpClient | undefined;

	afterEach(async () => {
		if (client) {
			try {
				await client.disconnect();
			} catch {
				// ignore — some tests intentionally leave the client in a broken state
			}
			client = undefined;
		}
	});

	it('connects to the fixture, lists the echo tool, and disconnects cleanly', async () => {
		client = createMcpClient();
		const info = await client.connect(FIXTURE_ENTRY);

		expect(info.transport).toBe('stdio');
		expect(info.path).toBe(FIXTURE_ENTRY);
		expect(typeof info.pid).toBe('number');
		expect(info.pid).toBeGreaterThan(0);

		const tools = await client.listTools();
		const echo = tools.find((t) => t.name === 'echo');
		expect(echo).toBeDefined();
		expect(typeof echo?.description).toBe('string');
		expect(echo?.schema).toBeDefined();

		const pid = info.pid;
		await client.disconnect();
		client = undefined;

		expect(await waitForExit(pid, 3_000)).toBe(true);
	});
});
