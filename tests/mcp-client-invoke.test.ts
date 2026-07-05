import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpClient, type McpClient } from '../src/mcp-client.js';

const FIXTURE_ENTRY = fileURLToPath(new URL('../dist/test-server-fixture.js', import.meta.url));

describe('mcp-client.invoke', () => {
	let client: McpClient | undefined;

	afterEach(async () => {
		if (client) {
			try {
				await client.disconnect();
			} catch {
				// swallow — some tests leave the client in a broken state
			}
			client = undefined;
		}
	});

	it('returns { ok: true, result } for the fixture echo tool', async () => {
		client = createMcpClient();
		await client.connect(FIXTURE_ENTRY);

		const result = await client.invoke('echo', { message: 'hello' });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('expected ok');
		// Fixture returns { content: [{ type: 'text', text: 'hello' }] } — invoke passes
		// the raw MCP result through untouched.
		expect(JSON.stringify(result.result)).toContain('hello');
	});

	it('returns { ok: false, error: { kind: "server-error", code, message } } when the tool handler throws', async () => {
		client = createMcpClient();
		await client.connect(FIXTURE_ENTRY);

		const result = await client.invoke('boom', {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected error');
		expect(result.error.kind).toBe('server-error');
		if (result.error.kind !== 'server-error') throw new Error('expected server-error');
		expect(typeof result.error.code).toBe('number');
		expect(result.error.message.toLowerCase()).toContain('boom');
	});

	it('returns { ok: false, error: { kind: "server-error", ... } } when the tool name is unknown', async () => {
		client = createMcpClient();
		await client.connect(FIXTURE_ENTRY);

		const result = await client.invoke('does-not-exist', {});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected error');
		expect(result.error.kind).toBe('server-error');
	});

	it('returns { ok: false, error: { kind: "timeout" } } when the tool never responds within invokeTimeoutMs', async () => {
		client = createMcpClient({ invokeTimeoutMs: 500 });
		await client.connect(FIXTURE_ENTRY);

		const start = Date.now();
		const result = await client.invoke('slow', {});
		const elapsed = Date.now() - start;

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected error');
		expect(result.error).toEqual({ kind: 'timeout' });
		expect(elapsed).toBeGreaterThanOrEqual(400);
		expect(elapsed).toBeLessThan(3_000);
	}, 10_000);

	it('returns { ok: false, error: { kind: "disconnected" } } when invoke is called with no active connection', async () => {
		client = createMcpClient();
		const result = await client.invoke('echo', { message: 'x' });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected error');
		expect(result.error).toEqual({ kind: 'disconnected' });
	});
});
